const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { sseHandler } = require('./realtime/sseManager');
const { getRecentEvents, getEventStats } = require('./realtime/eventBus');
const foodsRoutes = require('./routes/foods.routes');
const ordersRoutes = require('./routes/orders.routes');
const dbRoutes = require('./routes/db.routes');
const metaRoutes = require('./routes/meta.routes');
const flashSaleRoutes = require('./routes/flashSale.routes');
const authRoutes = require('./routes/auth.routes');
const inspectorRoutes = require('./routes/inspector.routes');

const app = express();

// Trust reverse proxies (Cloudflare Tunnel / Nginx)
app.set('trust proxy', true);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Lightweight process health endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Real-time Server-Sent Events (SSE) stream & event history buffer
app.get('/api/events/stream', sseHandler);
app.get('/api/events/recent', (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  res.json({
    success: true,
    stats: getEventStats(),
    data: getRecentEvents(limit),
  });
});

// REST API Routes
app.use('/api/auth', authRoutes);
app.use('/api/foods', foodsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/db', dbRoutes);
app.use('/api/flash-sale', flashSaleRoutes);
app.use('/api/inspector', inspectorRoutes);
app.use('/api', metaRoutes);

// Catch-all JSON 404 for unknown /api/* endpoints
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'ENDPOINT_NOT_FOUND',
      sqlState: null,
      message: `Không tìm thấy API endpoint: ${req.method} ${req.originalUrl}`,
      detail: null,
    },
  });
});

// Static Frontend Serving & Subdomain Dispatcher
const frontendDir = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.resolve(__dirname, '../../frontend');

const portfolioDir = process.env.PORTFOLIO_DIR
  ? path.resolve(process.env.PORTFOLIO_DIR)
  : (fs.existsSync(path.resolve(__dirname, '../../../Portfolio'))
    ? path.resolve(__dirname, '../../../Portfolio')
    : (fs.existsSync(path.resolve(__dirname, '../../../../Portfolio'))
      ? path.resolve(__dirname, '../../../../Portfolio')
      : (fs.existsSync(path.resolve(__dirname, '../../../../Pro5 chinh'))
        ? path.resolve(__dirname, '../../../../Pro5 chinh')
        : null)));

const portfolioIndexFile = portfolioDir ? path.join(portfolioDir, 'index.html') : null;
const landingPageFile = path.join(frontendDir, 'landing.html');
const indexPageFile = path.join(frontendDir, 'index.html');
const inspectorPageFile = path.join(frontendDir, 'inspector.html');
const splitDemoPageFile = path.join(frontendDir, 'demo-split.html');

function getEffectiveHostname(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) {
    return forwardedHost.split(',')[0].trim().toLowerCase();
  }
  const hostHeader = req.headers['host'];
  if (hostHeader) {
    return hostHeader.split(':')[0].trim().toLowerCase();
  }
  return (req.hostname || '').toLowerCase();
}

/**
 * Dispatch presentation views based on incoming hostname / subdomain:
 * - inspector.* / db.*             -> inspector.html (DB Live Inspector)
 * - study.* / food.*               -> index.html (CyberFood Customer App & Course Project)
 * - jalong.io.vn / www.* / default -> landing.html or portfolio index (Project Portfolio Landing Page)
 */
function sendRootByHostname(req, res) {
  const host = getEffectiveHostname(req);

  // Subdomain: DB Live Inspector
  if (host.startsWith('inspector.') || host.startsWith('db.')) {
    return res.sendFile(inspectorPageFile);
  }

  // Subdomain: Customer Food Delivery & Course Demo (project.* / study.* / food.*)
  if (host.startsWith('project.') || host.startsWith('study.') || host.startsWith('food.')) {
    return res.sendFile(indexPageFile);
  }

  // Apex domain (jalong.io.vn / www.jalong.io.vn) or default: Portfolio Landing Page
  if (portfolioIndexFile && fs.existsSync(portfolioIndexFile)) {
    return res.sendFile(portfolioIndexFile);
  }
  if (fs.existsSync(landingPageFile)) {
    return res.sendFile(landingPageFile);
  }
  return res.sendFile(indexPageFile);
}

// Subdomain-aware presentation endpoints for root / home
app.get(['/', '/home'], (req, res) => {
  return sendRootByHostname(req, res);
});

// Explicit landing / portfolio overview route
app.get(['/landing', '/portfolio', '/intro'], (_req, res) => {
  if (portfolioIndexFile && fs.existsSync(portfolioIndexFile)) {
    return res.sendFile(portfolioIndexFile);
  }
  if (fs.existsSync(landingPageFile)) {
    return res.sendFile(landingPageFile);
  }
  return res.sendFile(indexPageFile);
});

// Explicit direct presentation routes
app.get(['/inspector', '/admin'], (_req, res) => {
  res.sendFile(inspectorPageFile);
});

app.get('/split', (_req, res) => {
  res.sendFile(splitDemoPageFile);
});

app.get(['/study', '/food', '/project'], (_req, res) => {
  res.sendFile(indexPageFile);
});

if (portfolioDir && fs.existsSync(portfolioDir)) {
  app.use(
    express.static(portfolioDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      },
    })
  );
}

app.use(
  express.static(frontendDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

// Fallback to hostname-appropriate HTML for extensionless browser navigation routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws') || path.extname(req.path)) {
    return next();
  }
  return sendRootByHostname(req, res);
});

const DB_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name (database does not exist)
]);

/**
 * Centralized PostgreSQL & Express Error Normalization Middleware.
 * Translates SQLSTATE codes (23503, 23505, 23514, P0001, P0002, 22023) and
 * SIMULATED_DB_OFFLINE into clear, Vietnamese educational error responses.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  // Malformed JSON body
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON',
        sqlState: null,
        message: 'Cú pháp JSON gửi lên không hợp lệ.',
        detail: err.message,
      },
    });
  }

  const rawCode = err && err.code ? String(err.code) : '';
  const isSqlState = /^[0-9A-Z]{5}$/.test(rawCode);

  // 1. Simulated DB Offline (Chaos Lab)
  if (rawCode === 'SIMULATED_DB_OFFLINE') {
    return res.status(503).json({
      success: false,
      error: {
        code: 'SIMULATED_DB_OFFLINE',
        sqlState: null,
        message:
          'Mất kết nối PostgreSQL (Chế độ giả lập sự cố SIMULATED_DB_OFFLINE đang bật). Vui lòng khôi phục kết nối trên DB Live Inspector.',
        detail: err.message,
      },
    });
  }

  // 2. Real PostgreSQL / TCP Connection & Auth Outage
  if (DB_NETWORK_ERROR_CODES.has(rawCode)) {
    return res.status(503).json({
      success: false,
      error: {
        code: rawCode,
        sqlState: isSqlState ? rawCode : null,
        message:
          'Không thể kết nối tới máy chủ CSDL PostgreSQL. Vui lòng kiểm tra dịch vụ PostgreSQL hoặc cấu hình Connection String.',
        detail: err.message,
      },
    });
  }

  // 3. SQLSTATE 23503: Foreign Key Violation (3NF Referential Integrity)
  if (rawCode === '23503') {
    return res.status(409).json({
      success: false,
      error: {
        code: '23503',
        sqlState: '23503',
        constraint: err.constraint || null,
        message:
          'Vi phạm ràng buộc Khóa ngoại 3NF (SQLSTATE 23503 - Foreign Key Restrict): Không thể xóa hoặc tham chiếu bản ghi do ràng buộc toàn vẹn tham chiếu giữa các bảng.',
        detail: err.detail || err.message,
        hint: err.hint || 'Hãy kiểm tra các bản ghi phụ thuộc (ví dụ: order_items.food_id) hoặc dùng chế độ xóa mềm.',
      },
    });
  }

  // 4. SQLSTATE 23505: Unique Constraint Violation
  if (rawCode === '23505') {
    return res.status(409).json({
      success: false,
      error: {
        code: '23505',
        sqlState: '23505',
        constraint: err.constraint || null,
        message:
          'Vi phạm ràng buộc Duy nhất (SQLSTATE 23505 - Unique Constraint): Giá trị dữ liệu bị trùng lặp với bản ghi đã tồn tại.',
        detail: err.detail || err.message,
      },
    });
  }

  // 5. SQLSTATE 23514: Check Constraint Violation
  if (rawCode === '23514') {
    return res.status(400).json({
      success: false,
      error: {
        code: '23514',
        sqlState: '23514',
        constraint: err.constraint || null,
        message:
          'Vi phạm ràng buộc miền giá trị (SQLSTATE 23514 - Check Constraint): Dữ liệu không thỏa mãn điều kiện kiểm tra của bảng (ví dụ: giá >= 0, tồn kho >= 0, trạng thái hợp lệ).',
        detail: err.detail || err.message,
      },
    });
  }

  // 6. SQLSTATE P0001: PL/pgSQL Business Logic / FSM / Stock Exception
  if (rawCode === 'P0001') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'P0001',
        sqlState: 'P0001',
        message:
          err.message ||
          'Vi phạm quy tắc nghiệp vụ trong Stored Procedure PostgreSQL (SQLSTATE P0001).',
        detail:
          err.detail ||
          'Được kiểm tra và từ chối tự động bởi Stored Procedure trong Transaction PostgreSQL.',
      },
    });
  }

  // 7. SQLSTATE P0002: PL/pgSQL Record Not Found
  if (rawCode === 'P0002') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'P0002',
        sqlState: 'P0002',
        message: err.message || 'Không tìm thấy dữ liệu yêu cầu trong CSDL (SQLSTATE P0002).',
        detail: err.detail || null,
      },
    });
  }

  // 8. SQLSTATE 22023 / 22P02 / 23502: Parameter & Not-Null Validation Errors
  if (rawCode === '22023' || rawCode === '22P02' || rawCode === '23502') {
    return res.status(400).json({
      success: false,
      error: {
        code: rawCode,
        sqlState: rawCode,
        constraint: err.constraint || null,
        message:
          rawCode === '23502'
            ? `Thiếu trường dữ liệu bắt buộc NOT NULL: "${err.column || 'unknown'}" (SQLSTATE 23502).`
            : err.message || 'Giá trị tham số đầu vào không hợp lệ.',
        detail: err.detail || null,
      },
    });
  }

  const statusCode = Number(err.status || err.statusCode) || 500;

  if (statusCode >= 500) {
    console.error('[Express Error]', err);
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code: rawCode || 'INTERNAL_SERVER_ERROR',
      sqlState: isSqlState ? rawCode : null,
      message: err.message || 'Đã xảy ra lỗi không xác định trên máy chủ.',
      detail: err.detail || null,
    },
  });
});

module.exports = app;
