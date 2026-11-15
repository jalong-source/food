<#
.SYNOPSIS
    Script 1 cham khoi chay toan bo he thong JaLong Food Live Database Demo.

.DESCRIPTION
    Tu dong thuc hien:
      1. Kiem tra Docker Desktop (tu dong bat Docker Desktop neu dang tat)
      2. Khoi chay `docker compose up -d --build` (PostgreSQL 16 + Node.js/Express + UI)
      3. Cho Healthcheck cua `jalong_postgres` va `jalong_webapp` (/api/db/status) chuyen sang HEALTHY
      4. In bang tong hop duong dan Local & Production (https://jalong.io.vn)
      5. Tu dong mo trinh duyet o che do chia man hinh `/split` phuc vu bao cao truc tiep!

.EXAMPLE
    .\deploy\start-demo.ps1
    .\deploy\start-demo.ps1 -ResetDb
    .\deploy\start-demo.ps1 -WithCloudflare
#>

[CmdletBinding()]
param(
    [switch]$ResetDb,
    [switch]$WithCloudflare,
    [switch]$NoBrowser,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host "`n[$Step] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  JALONG FOOD - 1-CLICK LIVE DATABASE DEMO LAUNCHER" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green

# ------------------------------------------------------------------------------
# Buoc 1: Kiem tra Docker CLI & Docker Desktop Daemon
# ------------------------------------------------------------------------------
Write-Step "1/4" "Kiem tra trang thai Docker Desktop..."

$DockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCmd) {
    Write-Error "Khong tim thay 'docker' trong PATH. Vui long cai dat Docker Desktop truoc khi chay!"
    exit 1
}

$DockerReady = $false
try {
    $ErrorActionPreference = "Continue"
    $null = & docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        $DockerReady = $true
    }
    $ErrorActionPreference = "Stop"
} catch {
    $DockerReady = $false
}

if (-not $DockerReady) {
    $CandidatePaths = @(
        "C:\Program Files\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe",
        (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $DockerCmd.Source))) "Docker Desktop.exe")
    )
    $DockerDesktopExe = $CandidatePaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if ($DockerDesktopExe) {
        Write-Warn "Docker Engine chua chay. Dang tu dong khoi dong Docker Desktop ($DockerDesktopExe)..."
        Start-Process -FilePath $DockerDesktopExe
        $WaitDocker = 0
        while ($WaitDocker -lt 90) {
            Start-Sleep -Seconds 3
            $WaitDocker += 3
            $ErrorActionPreference = "Continue"
            $null = & docker info 2>$null
            $Code = $LASTEXITCODE
            $ErrorActionPreference = "Stop"
            if ($Code -eq 0) {
                $DockerReady = $true
                break
            }
            Write-Host "  ... Dang doi Docker Engine khoi dong ($WaitDocker/90s)" -ForegroundColor Gray
        }
    }

    if (-not $DockerReady) {
        Write-Error "Docker Desktop chua san sang. Vui long mo Docker Desktop cho den khi bieu tuong ca voi xanh on dinh roi chay lai!"
        exit 1
    }
}
Write-Success "Docker Desktop dang hoat dong tot."

Push-Location $ProjectRoot
try {
    # --------------------------------------------------------------------------
    # Buoc 2: Build & Khoi chay Docker Compose
    # --------------------------------------------------------------------------
    if ($ResetDb) {
        Write-Step "RESET" "Dang xoa volume cu de khoi tao lai Schema 3NF + Trigger + Seed Data..."
        & docker compose down -v --remove-orphans
    }

    Write-Step "2/4" "Khoi chay he thong bang Docker Compose (up -d --build)..."
    if ($WithCloudflare) {
        & docker compose --profile cloudflare up -d --build
    } else {
        & docker compose up -d --build
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Lenh 'docker compose up -d --build' gap loi. Vui long kiem tra log phia tren."
        exit 1
    }

    # --------------------------------------------------------------------------
    # Buoc 3: Cho Healthcheck Xanh (jalong_postgres & jalong_webapp)
    # --------------------------------------------------------------------------
    Write-Step "3/4" "Dang cho Healthcheck XANH tu PostgreSQL 16 va WebApp (/api/db/status)..."

    $Elapsed = 0
    $AllHealthy = $false

    while ($Elapsed -lt $TimeoutSeconds) {
        $ErrorActionPreference = "Continue"
        $PgHealth = (& docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}" jalong_postgres 2>$null)
        $AppHealth = (& docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}" jalong_webapp 2>$null)
        $ErrorActionPreference = "Stop"

        $PgHealth = "$PgHealth".Trim()
        $AppHealth = "$AppHealth".Trim()

        $ApiOk = $false
        if ($PgHealth -eq "healthy") {
            try {
                $Resp = Invoke-WebRequest -Uri "http://localhost:3000/api/db/status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($Resp.StatusCode -eq 200) {
                    $ApiOk = $true
                }
            } catch {
                $ApiOk = $false
            }
        }

        if ($PgHealth -eq "healthy" -and ($AppHealth -eq "healthy" -or $ApiOk)) {
            $AllHealthy = $true
            break
        }

        Write-Host ("  [{0,3}s/{1}s] postgres: {2,-10} | webapp: {3,-10}" -f $Elapsed, $TimeoutSeconds, $PgHealth, $AppHealth) -ForegroundColor Gray
        Start-Sleep -Seconds 2
        $Elapsed += 2
    }

    if (-not $AllHealthy) {
        Write-Warn "Het thoi gian cho Healthcheck ($TimeoutSeconds giay). Trang thai container hien tai:"
        & docker compose ps
        Write-Host "`n--- Log moi nhat cua jalong_webapp ---" -ForegroundColor Yellow
        & docker compose logs --tail=30 app
        exit 1
    }

    Write-Success "PostgreSQL 16 (jalong_postgres) : HEALTHY"
    Write-Success "Web Application (jalong_webapp) : HEALTHY (/api/db/status = 200 OK)"

    # --------------------------------------------------------------------------
    # Buoc 4: In thong tin truy cap & Mo trinh duyet che do /split
    # --------------------------------------------------------------------------
    Write-Step "4/4" "He thong da san sang 100% cho buoi Demo Truc Quan!"

    $SplitUrl = "http://localhost:3000/split"

    Write-Host ""
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Green
    Write-Host "  |  1. DUONG DAN LOCAL (TRINH CHIEU TRUC TIEP TREN MAY)                     |" -ForegroundColor Green
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Green
    Write-Host "  |  * Split-Screen Live Demo : http://localhost:3000/split                  |" -ForegroundColor White
    Write-Host "  |  * Storefront (Khach hang): http://localhost:3000/                       |" -ForegroundColor White
    Write-Host "  |  * Admin & Chaos Panel    : http://localhost:3000/admin                  |" -ForegroundColor White
    Write-Host "  |  * DB Live Inspector 3NF  : http://localhost:3000/inspector              |" -ForegroundColor White
    Write-Host "  |  * Health & Pool Status   : http://localhost:3000/api/db/status          |" -ForegroundColor White
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Green
    Write-Host "  |  2. DUONG DAN CLOUDFLARE PRODUCTION (DIEN THOAI GIANG VIEN / SINH VIEN)  |" -ForegroundColor Cyan
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |  * Split-Screen Public    : https://jalong.io.vn/split                   |" -ForegroundColor White
    Write-Host "  |  * Storefront Public      : https://project.jalong.io.vn                 |" -ForegroundColor White
    Write-Host "  |  * Admin & Chaos Public   : https://project.jalong.io.vn/admin           |" -ForegroundColor White
    Write-Host "  |  * DB Inspector Subdomain : https://inspector.jalong.io.vn               |" -ForegroundColor White
    Write-Host "  |  (Bat Tunnel: .\deploy\setup-cloudflare-tunnel.ps1)                      |" -ForegroundColor Gray
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |  3. THONG TIN KET NOI POSTGRESQL 16 (DBeaver / pgAdmin / DataGrip)       |" -ForegroundColor Yellow
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Yellow
    Write-Host "  |  * Host: localhost  | Port: 5432 | DB: jalong_food_db                    |" -ForegroundColor White
    Write-Host "  |  * User: jalong_admin            | Pass: jalong_secret_2026              |" -ForegroundColor White
    Write-Host "  |  * Reset DB sach 100% truoc gio bao cao: .\deploy\start-demo.ps1 -ResetDb|" -ForegroundColor Gray
    Write-Host "  +--------------------------------------------------------------------------+" -ForegroundColor Yellow
    Write-Host ""

    if (-not $NoBrowser) {
        Write-Host "  -> Dang mo trinh duyet tai che do Split-Screen: $SplitUrl" -ForegroundColor Green
        Start-Process $SplitUrl
    }
} finally {
    Pop-Location
}
