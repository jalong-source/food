<#
.SYNOPSIS
    Tu dong thiet lap va khoi chay Cloudflare Tunnel cho ten mien jalong.io.vn.

.DESCRIPTION
    Script tu dong hoa quy trinh (khuyen dung chay qua wrapper `.\setup-cloudflare.cmd` tren Windows):
      1. Kiem tra (va huong dan cai dat) cong cu CLI `cloudflared`
      2. Xac thuc tai khoan Cloudflare (`cloudflared tunnel login`) hoac chon Quick Tunnel mien phi
      3. Khoi tao Tunnel `jalongfood-demo` (hoac tai su dung neu da ton tai)
      4. Tro CNAME DNS tren Cloudflare cho `jalong.io.vn`, `www.jalong.io.vn`, `inspector.jalong.io.vn`
      5. Sinh file cau hinh `deploy/cloudflare/config.yml` toi uu cho SSE & WebSocket
      6. Chay Tunnel ket noi truc tiep ve `http://localhost:3000`

.EXAMPLE
    .\setup-cloudflare.cmd
    .\setup-cloudflare.cmd -QuickTunnel
    .\setup-cloudflare.cmd -CheckOnly
    .\setup-cloudflare.cmd -SetupOnly
#>

[CmdletBinding()]
param(
    [string]$TunnelName = "jalongfood-app",
    [string]$Domain = "jalong.io.vn",
    [string]$LocalUrl = "http://localhost:3000",
    [switch]$QuickTunnel,
    [switch]$SetupOnly,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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

function Exit-FriendlyError {
    param(
        [string]$Title,
        [string[]]$Hints = @()
    )
    Write-Host ""
    Write-Host "  +------------------------------------------------------------------+" -ForegroundColor Red
    Write-Host "  |  [CHUA HOAN TAT] $Title" -ForegroundColor Red
    Write-Host "  +------------------------------------------------------------------+" -ForegroundColor Red
    foreach ($Hint in $Hints) {
        Write-Host "  $Hint" -ForegroundColor Yellow
    }
    Write-Host ""
    exit 1
}

function Start-QuickTunnelMode {
    param([string]$TargetUrl)
    Write-Step "QUICK" "Khoi chay Cloudflare Quick Tunnel (HTTPS tam thoi *.trycloudflare.com)..."
    Write-Host "  -> Ket noi ve Local App: $TargetUrl" -ForegroundColor White
    Write-Host "  -> Cho 3-5 giay de Cloudflare cap duong dan https://....trycloudflare.com trong khung ben duoi!" -ForegroundColor Green
    Write-Host "  -> Nhan Ctrl+C de dung Tunnel khi ket thuc demo.`n" -ForegroundColor Gray

    $ErrorActionPreference = "Continue"
    & cloudflared tunnel --no-autoupdate --url $TargetUrl
    exit $LASTEXITCODE
}

Write-Host "======================================================================" -ForegroundColor Magenta
Write-Host "  JALONG FOOD - CLOUDFLARE TUNNEL AUTOMATION ($Domain)" -ForegroundColor Magenta
Write-Host "======================================================================" -ForegroundColor Magenta

# ------------------------------------------------------------------------------
# Buoc 1: Kiem tra cong cu cloudflared
# ------------------------------------------------------------------------------
Write-Step "1/6" "Kiem tra cong cu Cloudflare Tunnel CLI (cloudflared)..."

$CloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $CloudflaredCmd) {
    $CandidatePaths = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
        "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe"
    )
    $WinGetPkgDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
    if (Test-Path $WinGetPkgDir) {
        $WinGetBin = Get-ChildItem -Path $WinGetPkgDir -Filter "cloudflared.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($WinGetBin) {
            $CandidatePaths += $WinGetBin.FullName
        }
    }

    foreach ($PathItem in $CandidatePaths) {
        if ($PathItem -and (Test-Path $PathItem)) {
            $env:Path = "$(Split-Path $PathItem);$env:Path"
            $CloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
            break
        }
    }
}

if (-not $CloudflaredCmd) {
    Write-Warn "Chua tim thay 'cloudflared' tren he thong."
    Write-Host "  Ban co the cai dat nhanh bang WinGet:" -ForegroundColor White
    Write-Host "    winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow

    if (-not $CheckOnly) {
        $InstallChoice = Read-Host "  Ban co muon cai dat tu dong qua WinGet ngay bay gio khong? (Y/N)"
        if ($InstallChoice -match "^[Yy]$") {
            $ErrorActionPreference = "Continue"
            & winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements
            $ErrorActionPreference = "Stop"

            $env:Path = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:ProgramFiles\cloudflared;${env:ProgramFiles(x86)}\cloudflared;$env:Path"
            $CloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
        }
    }

    if (-not $CloudflaredCmd) {
        Exit-FriendlyError -Title "Chua cai dat cong cu 'cloudflared'." -Hints @(
            "1. Chay lenh: winget install --id Cloudflare.cloudflared",
            "2. Mo lai cua so Terminal va chay lai: .\setup-cloudflare.cmd"
        )
    }
}

$ErrorActionPreference = "Continue"
$CfVersion = (& cloudflared --version 2>&1 | Out-String).Trim()
$ErrorActionPreference = "Stop"
Write-Success "Da san sang: $CfVersion"

# Kiem tra nhanh server local tren cong 3000 ngay tu dau de thong bao ro rang
$LocalAppHealthy = $false
try {
    $HealthResp = Invoke-WebRequest -Uri "$LocalUrl/api/db/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($HealthResp.StatusCode -eq 200) {
        $LocalAppHealthy = $true
        Write-Success "Ung dung Local tai $LocalUrl dang hoat dong tot (HTTP 200)."
    }
} catch {
    Write-Warn "Ung dung Local tai $LocalUrl chua phan hoi (hoac dang o che do Chaos Test)."
    Write-Host "      Goi y: Chay '.\start-demo.cmd' o mot cua so Terminal khac neu chua bat Docker!" -ForegroundColor Gray
}

# Che do kiem tra moi truong (-CheckOnly): khong chan luong, in ket qua chan doan ro rang
$CloudflaredDir = Join-Path $HOME ".cloudflared"
$CertPath = Join-Path $CloudflaredDir "cert.pem"

if ($CheckOnly) {
    Write-Step "CHECK" "Ket qua chan doan moi truong Cloudflare Tunnel:"
    Write-Host "  * cloudflared CLI  : SAN SANG ($($CloudflaredCmd.Source))" -ForegroundColor Green
    Write-Host "  * Local App (3000) : $(if ($LocalAppHealthy) { 'ONLINE (HTTP 200)' } else { 'CHUA PHAN HOI' })" -ForegroundColor $(if ($LocalAppHealthy) { "Green" } else { "Yellow" })
    if (Test-Path $CertPath) {
        Write-Host "  * Chung chi Domain : DA DANG NHAP ($CertPath)" -ForegroundColor Green
        Write-Host "  -> San sang chay '.\setup-cloudflare.cmd' cho ten mien https://$Domain !" -ForegroundColor Green
    } else {
        Write-Host "  * Chung chi Domain : CHUA CO ($CertPath)" -ForegroundColor Yellow
        Write-Host "  -> Chay '.\setup-cloudflare.cmd' de dang nhap Cloudflare cho $Domain," -ForegroundColor White
        Write-Host "     HOAC chay '.\setup-cloudflare.cmd -QuickTunnel' de lay link HTTPS mien phi ngay lap tuc!" -ForegroundColor Cyan
    }
    exit 0
}

# Che do Quick Tunnel (khong can ten mien / tai khoan Cloudflare)
if ($QuickTunnel) {
    Start-QuickTunnelMode -TargetUrl $LocalUrl
}

# ------------------------------------------------------------------------------
# Buoc 2: Dang nhap & Xac thuc Cloudflare (cert.pem)
# ------------------------------------------------------------------------------
Write-Step "2/6" "Kiem tra chung chi xac thuc Cloudflare (~/.cloudflared/cert.pem)..."

if (-not (Test-Path $CertPath)) {
    Write-Warn "Chua tim thay chung chi dang nhap Cloudflare tai: $CertPath"
    Write-Host ""
    Write-Host "  Ban hay chon 1 trong 2 phuong an sau:" -ForegroundColor White
    Write-Host "    [1] Dang nhap Cloudflare Dashboard de dung ten mien chinh thuc https://$Domain" -ForegroundColor Green
    Write-Host "    [2] Dung ngay Quick Tunnel mien phi (https://*.trycloudflare.com - khong can tai khoan!)" -ForegroundColor Cyan
    Write-Host "    [Q] Thoat" -ForegroundColor Gray
    Write-Host ""

    $ModeChoice = Read-Host "  Nhap lua chon cua ban (1 / 2 / Q) [Mac dinh: 1]"
    if ([string]::IsNullOrWhiteSpace($ModeChoice)) {
        $ModeChoice = "1"
    }

    if ($ModeChoice -eq "2") {
        Start-QuickTunnelMode -TargetUrl $LocalUrl
    }
    if ($ModeChoice -match "^[Qq]$") {
        Write-Host "  Da huy thao tac theo yeu cau." -ForegroundColor Gray
        exit 0
    }

    Write-Host "`n  Trinh duyet se mo trang dang nhap Cloudflare Dashboard..." -ForegroundColor White
    Write-Host "  -> Buoc A: Dang nhap tai khoan Cloudflare quan ly ten mien '$Domain'." -ForegroundColor Yellow
    Write-Host "  -> Buoc B: Chon Zone '$Domain' va nhan nut [Authorize]!" -ForegroundColor Yellow

    $ErrorActionPreference = "Continue"
    & cloudflared tunnel login
    $LoginCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"

    if ($LoginCode -ne 0 -or -not (Test-Path $CertPath)) {
        Exit-FriendlyError -Title "Chua hoan tat xac thuc Cloudflare Tunnel (chua co cert.pem)." -Hints @(
            "-> Neu ban co quyen quan tri ten mien '$Domain' tren Cloudflare: hay chay lai '.\setup-cloudflare.cmd' va nhan [Authorize] tren trinh duyet.",
            "-> Neu ban muon lay link HTTPS cong khai NGAY LAP TUC ma khong can tai khoan Cloudflare, hay chay:",
            "     .\setup-cloudflare.cmd -QuickTunnel"
        )
    }
}
Write-Success "Da xac thuc Cloudflare ($CertPath)"

# ------------------------------------------------------------------------------
# Buoc 3: Khoi tao hoac lay thong tin Tunnel 'jalongfood-demo'
# ------------------------------------------------------------------------------
Write-Step "3/6" "Kiem tra / Khoi tao Tunnel '$TunnelName'..."

$ErrorActionPreference = "Continue"
$TunnelListRaw = & cloudflared tunnel list --output json 2>$null
$ListExitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

$Tunnels = @()
if ($ListExitCode -eq 0 -and $TunnelListRaw) {
    try {
        $Parsed = ($TunnelListRaw | Out-String) | ConvertFrom-Json
        if ($Parsed) {
            $Tunnels = @($Parsed | Where-Object { $_.name -eq $TunnelName -and (-not $_.deleted_at -or $_.deleted_at -eq "0001-01-01T00:00:00Z") })
        }
    } catch {
        $Tunnels = @()
    }
}

if ($Tunnels.Count -eq 0) {
    Write-Host "  Dang tao Tunnel moi mang ten '$TunnelName'..." -ForegroundColor White
    $ErrorActionPreference = "Continue"
    & cloudflared tunnel create $TunnelName
    $CreateCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"

    if ($CreateCode -ne 0) {
        Exit-FriendlyError -Title "Khong the tao Tunnel '$TunnelName'." -Hints @(
            "-> Kiem tra ket noi Internet hoac thu chay voi ten Tunnel moi: .\setup-cloudflare.cmd -TunnelName jalongfood-live",
            "-> Hoac dung Quick Tunnel tuc thi: .\setup-cloudflare.cmd -QuickTunnel"
        )
    }

    $ErrorActionPreference = "Continue"
    $TunnelListRaw = & cloudflared tunnel list --output json 2>$null
    $ErrorActionPreference = "Stop"
    $Parsed = ($TunnelListRaw | Out-String) | ConvertFrom-Json
    $Tunnels = @($Parsed | Where-Object { $_.name -eq $TunnelName -and (-not $_.deleted_at -or $_.deleted_at -eq "0001-01-01T00:00:00Z") })
}

if ($Tunnels.Count -eq 0) {
    Exit-FriendlyError -Title "Khong doc duoc UUID cua Tunnel '$TunnelName'." -Hints @(
        "-> Hay kiem tra danh sach Tunnel bang lenh: cloudflared tunnel list"
    )
}

$TunnelId = $Tunnels[0].id
$CredentialsFile = Join-Path $CloudflaredDir "$TunnelId.json"
Write-Success "Tunnel '$TunnelName' san sang (UUID: $TunnelId)"

if (-not (Test-Path $CredentialsFile)) {
    Write-Warn "Khong tim thay file credential local '$CredentialsFile' (Tunnel co the da duoc tao tren mot may khac)."
    Write-Host "      Goi y: Chay '.\setup-cloudflare.cmd -TunnelName jalongfood-laptop' de tao credential rieng cho may nay!" -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# Buoc 4: Tro ban ghi DNS CNAME tren Cloudflare
# ------------------------------------------------------------------------------
Write-Step "4/6" "Cau hinh ban ghi CNAME DNS tren Cloudflare..."

$Hostnames = @(
    $Domain,
    "db.$Domain",
    "study.$Domain",
    "game.$Domain",
    "gamemeomeo.$Domain",
    "gamenongtrai.$Domain",
    "tudien.$Domain",
    "www.$Domain",
    "food.$Domain",
    "inspector.$Domain"
)

foreach ($HostItem in $Hostnames) {
    Write-Host "  -> Routing DNS: $HostItem => $TunnelName" -ForegroundColor Gray
    $ErrorActionPreference = "Continue"
    & cloudflared tunnel route dns --overwrite-dns $TunnelName $HostItem
    $DnsCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"

    if ($DnsCode -eq 0) {
        Write-Success "Da tro CNAME: https://$HostItem"
    } else {
        Write-Warn "Khong the cap nhat tu dong CNAME cho '$HostItem' (co the can kiem tra tren Cloudflare DNS Dashboard)."
    }
}

# ------------------------------------------------------------------------------
# Buoc 5: Sinh file cau hinh deploy/cloudflare/config.yml toi uu SSE & WebSocket
# ------------------------------------------------------------------------------
Write-Step "5/6" "Tao file cau hinh Tunnel toi uu cho Real-time SSE & WebSocket..."

$ConfigDir = Join-Path $PSScriptRoot "cloudflare"
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}
$ConfigPath = Join-Path $ConfigDir "config.yml"

if (Test-Path $CredentialsFile) {
    $EscapedCreds = $CredentialsFile.Replace("'", "''")
    $ConfigContent = @"
# Auto-generated by setup-cloudflare-tunnel.ps1
tunnel: $TunnelId
credentials-file: '$EscapedCreds'

originRequest:
  connectTimeout: 30s
  tcpKeepAlive: 30s
  keepAliveConnections: 1024
  keepAliveTimeout: 3600s
  disableChunkedEncoding: false
  noTLSVerify: false

ingress:
  # --- NHOM 1: DU AN DATABASE & HOC TAP (Port 3000) ---
  - hostname: $Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: $Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: db.$Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: db.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: study.$Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: study.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: www.$Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: www.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: food.$Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: food.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: inspector.$Domain
    service: $LocalUrl
    originRequest:
      httpHostHeader: inspector.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  # --- NHOM 2: DU AN GAME H5 (Port 81) ---
  - hostname: game.$Domain
    service: http://localhost:81
    originRequest:
      httpHostHeader: game.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - hostname: gamemeomeo.$Domain
    service: http://localhost:81
    originRequest:
      httpHostHeader: gamemeomeo.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  # --- NHOM 3: WEB GAME NONG TRAI VUI VE (Port 5000) ---
  - hostname: gamenongtrai.$Domain
    service: http://127.0.0.1:5000
    originRequest:
      httpHostHeader: gamenongtrai.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  # --- NHOM 4: DO AN DSA - TU DIEN ANH VIET CAY AVL (Port 5055) ---
  - hostname: tudien.$Domain
    service: http://127.0.0.1:5055
    originRequest:
      httpHostHeader: tudien.$Domain
      disableChunkedEncoding: false
      keepAliveTimeout: 3600s

  - service: http_status:404
"@
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $ConfigContent, $Utf8NoBom)
    Write-Success "Da luu cau hinh tai: $ConfigPath"

    $ErrorActionPreference = "Continue"
    & cloudflared tunnel --config $ConfigPath ingress validate
    $ErrorActionPreference = "Stop"
}

if ($SetupOnly) {
    Write-Host "`nHoan tat thiet lap (-SetupOnly). De chay Tunnel thu cong:" -ForegroundColor Green
    Write-Host "  cloudflared tunnel --config `"$ConfigPath`" run $TunnelName" -ForegroundColor Yellow
    exit 0
}

# ------------------------------------------------------------------------------
# Buoc 6: Khoi chay Cloudflare Tunnel truc tiep ve http://localhost:3000
# ------------------------------------------------------------------------------
Write-Step "6/6" "Dang mo ket noi Cloudflare Tunnel LIVE (Nhan Ctrl+C de dung)..."
Write-Host ""
Write-Host "  +------------------------------------------------------------------+" -ForegroundColor Green
Write-Host "  |  PUBLIC LIVE DEMO URLS (HTTPS + SSE + WebSocket Ready)           |" -ForegroundColor Green
Write-Host "  +------------------------------------------------------------------+" -ForegroundColor Green
Write-Host "  |  Split Demo (Giang vien): https://$Domain/split" -ForegroundColor White
Write-Host "  |  Storefront (Dat mon)   : https://$Domain" -ForegroundColor White
Write-Host "  |  WWW Mirror             : https://www.$Domain" -ForegroundColor White
Write-Host "  |  Admin & Chaos Testing  : https://$Domain/admin" -ForegroundColor White
Write-Host "  |  DB Live Inspector 3NF  : https://inspector.$Domain" -ForegroundColor White
Write-Host "  +------------------------------------------------------------------+" -ForegroundColor Green
Write-Host ""

$ErrorActionPreference = "Continue"
if (Test-Path $CredentialsFile) {
    & cloudflared tunnel --no-autoupdate --config $ConfigPath run $TunnelName
} else {
    & cloudflared tunnel --no-autoupdate --url $LocalUrl run $TunnelName
}
exit $LASTEXITCODE
