const express = require('express');
const {
  query,
  getDbStatus,
  setConnectionConfig,
  setSimulation,
} = require('../db/poolManager');

const router = express.Router();

const RELATION_ORDER_BY = Object.freeze({
  users: 'ORDER BY id ASC',
  categories: 'ORDER BY display_order ASC, id ASC',
  foods: 'ORDER BY id ASC',
  orders: 'ORDER BY id DESC',
  order_items: 'ORDER BY id DESC',
  order_status_history: 'ORDER BY changed_at DESC, id DESC',
  flash_sale_slots: 'ORDER BY id DESC',
  flash_sale_items: 'ORDER BY id ASC',
  vw_orders_summary: 'ORDER BY id DESC',
  vw_flash_sale_active: 'ORDER BY flash_sale_item_id ASC',
});

const ALLOWED_RELATIONS = new Set(Object.keys(RELATION_ORDER_BY));

/**
 * GET /api/db/status
 * Live ping, PostgreSQL server metadata, pg.Pool metrics, 6 table row counts,
 * realtime SSE/WS/LISTEN stats, and last 40 SQL telemetry logs.
 * Always responds HTTP 200 (with connected: true/false) so healthchecks and
 * offline Inspector dashboards can inspect outage details without failing.
 */
router.get('/status', async (_req, res, next) => {
  try {
    const status = await getDbStatus();
    res.json({
      success: true,
      data: status,
      ...status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/db/config (and PUT /api/db/config)
 * Dynamically swap PostgreSQL connectionString at runtime or reset to .env default.
 * Body: { connectionString?: string, resetDefault?: boolean }
 */
async function handleUpdateConfig(req, res, next) {
  try {
    const body = req.body || {};
    const resetDefault = Boolean(body.resetDefault || body.reset);
    const { connectionString } = body;

    const status = await setConnectionConfig({
      connectionString,
      resetDefault,
    });

    let message;
    if (resetDefault) {
      message = status.connected
        ? 'Đã khôi phục cấu hình kết nối PostgreSQL mặc định thành công.'
        : 'Đã đặt lại chuỗi kết nối mặc định nhưng hiện chưa kết nối được tới PostgreSQL.';
    } else {
      message = status.connected
        ? 'Đã đổi chuỗi kết nối động và kết nối thành công tới PostgreSQL.'
        : `Đã áp dụng chuỗi kết nối mới nhưng kết nối thất bại: ${status.lastError || 'Không phản hồi'}`;
    }

    res.json({
      success: true,
      message,
      data: status,
      ...status,
    });
  } catch (err) {
    next(err);
  }
}

router.post('/config', handleUpdateConfig);
router.put('/config', handleUpdateConfig);

/**
 * POST /api/db/simulate
 * Chaos testing: toggle simulated DB offline mode or artificial query delay (ms).
 * Body: { offline?: boolean, artificialDelayMs?: number }
 */
router.post('/simulate', async (req, res, next) => {
  try {
    const body = req.body || {};
    const offline =
      typeof body.offline === 'boolean'
        ? body.offline
        : typeof body.simulatedOffline === 'boolean'
          ? body.simulatedOffline
          : typeof body.disconnect === 'boolean'
            ? body.disconnect
            : undefined;

    const artificialDelayMs =
      body.artificialDelayMs !== undefined
        ? body.artificialDelayMs
        : body.delayMs !== undefined
          ? body.delayMs
          : body.latencyMs;

    const status = await setSimulation({ offline, artificialDelayMs });

    const message = status.simulatedOffline
      ? 'Đã BẬT chế độ giả lập mất kết nối CSDL (SIMULATED_DB_OFFLINE).'
      : `Chế độ kết nối hoạt động bình thường (độ trễ giả lập: ${status.artificialDelayMs}ms).`;

    res.json({
      success: true,
      message,
      data: status,
      ...status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/db/tables/:tableName
 * Live data browser for the 6 normalized 3NF tables + vw_orders_summary view.
 */
router.get('/tables/:tableName', async (req, res, next) => {
  try {
    const tableName = String(req.params.tableName || '').trim().toLowerCase();

    if (!ALLOWED_RELATIONS.has(tableName)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TABLE_NAME',
          sqlState: null,
          message: `Bảng hoặc View "${tableName}" không nằm trong danh sách cho phép truy xuất.`,
          detail: `Chỉ cho phép: ${Array.from(ALLOWED_RELATIONS).join(', ')}`,
        },
      });
    }

    const rawLimit = parseInt(req.query.limit || '100', 10);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;
    const orderByClause = RELATION_ORDER_BY[tableName] || '';

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM ${tableName}`,
      [],
      { source: `db.inspect.${tableName}.count`, silent: true }
    );
    const totalRowCount = countResult.rows[0]?.total ?? 0;

    const dataResult = await query(
      `SELECT * FROM ${tableName} ${orderByClause} LIMIT $1`,
      [limit],
      { source: `db.inspect.${tableName}` }
    );

    const columns = Array.isArray(dataResult.fields)
      ? dataResult.fields.map((field) => field.name)
      : dataResult.rows[0]
        ? Object.keys(dataResult.rows[0])
        : [];

    const payload = {
      tableName,
      rowCount: totalRowCount,
      totalCount: totalRowCount,
      returnedCount: dataResult.rows.length,
      columns,
      rows: dataResult.rows,
    };

    return res.json({
      success: true,
      data: payload,
      ...payload,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
