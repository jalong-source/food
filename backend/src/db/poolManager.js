require('dotenv').config();
const { Pool } = require('pg');
const { publishEvent } = require('../realtime/eventBus');
const { pgNotifyListener } = require('../realtime/pgNotifyListener');
const { getSseStats } = require('../realtime/sseManager');
const { getWsStats } = require('../realtime/wsManager');

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://jalong_admin:jalong_secret_2026@localhost:5432/jalong_food_db';

const MAX_POOL_SIZE = Math.max(1, parseInt(process.env.DB_POOL_MAX || '10', 10) || 10);
const MAX_RECENT_QUERIES = 40;

const TRACKED_TABLES = [
  'users',
  'categories',
  'foods',
  'orders',
  'order_items',
  'order_status_history',
  'flash_sale_slots',
  'flash_sale_items',
];

let currentConnectionString = DEFAULT_DATABASE_URL;
let isCustomConnection = false;
let simulatedOffline = false;
let artificialDelayMs = 0;
let lastError = null;
let querySeq = 0;
const recentQueries = [];

/**
 * Mask password inside a PostgreSQL URI or key=value connection string.
 * @param {string} connStr
 * @returns {string}
 */
function maskConnectionString(connStr) {
  if (!connStr || typeof connStr !== 'string') return '';
  return connStr
    .replace(/(:\/\/[^:/?#\s]+:)([^@\s]+)(@)/, '$1******$3')
    .replace(/(password\s*=\s*)([^\s&;]+)/gi, '$1******');
}

/**
 * Create a new pg.Pool instance with safe error listeners attached.
 * @param {string} connectionString
 * @returns {Pool}
 */
function createPool(connectionString) {
  const nextPool = new Pool({
    connectionString,
    max: MAX_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  nextPool.on('error', (err) => {
    lastError = err ? err.message : 'Idle PostgreSQL client error';
    console.error('[poolManager] Unexpected error on idle PostgreSQL client:', err.message);
  });

  return nextPool;
}

let pool = createPool(currentConnectionString);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSqlOperation(sql) {
  const match = compactSql(sql).match(/^([a-zA-Z]+)/);
  return match ? match[1].toUpperCase() : 'SQL';
}

function sanitizeParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map((item) => {
    if (typeof item === 'string' && item.length > 300) {
      return `${item.slice(0, 297)}...`;
    }
    return item;
  });
}

function recordQueryEntry(entry, silent = false) {
  recentQueries.unshift(entry);
  if (recentQueries.length > MAX_RECENT_QUERIES) {
    recentQueries.length = MAX_RECENT_QUERIES;
  }
  if (!silent && typeof publishEvent === 'function') {
    try {
      publishEvent('db:query_logged', entry);
    } catch (err) {
      console.error('[poolManager] Failed to publish db:query_logged:', err.message);
    }
  }
}

function createSimulatedOfflineError() {
  const err = new Error(
    'Kết nối PostgreSQL đang ở chế độ giả lập mất kết nối (Simulated DB Offline).'
  );
  err.code = 'SIMULATED_DB_OFFLINE';
  err.status = 503;
  return err;
}

/**
 * Coordinate pgNotifyListener state when DB connection config or simulation mode changes.
 */
async function syncPgNotifyListener() {
  if (!pgNotifyListener) return;

  try {
    if (simulatedOffline) {
      if (typeof pgNotifyListener.disconnect === 'function') {
        await pgNotifyListener.disconnect();
      } else if (typeof pgNotifyListener.stop === 'function') {
        await pgNotifyListener.stop();
      }
      return;
    }

    if (typeof pgNotifyListener.connect === 'function') {
      await pgNotifyListener.connect(currentConnectionString);
    } else if (typeof pgNotifyListener.reconnect === 'function') {
      await pgNotifyListener.reconnect(currentConnectionString);
    } else if (typeof pgNotifyListener.start === 'function') {
      await pgNotifyListener.start(currentConnectionString);
    }
  } catch (err) {
    lastError = err.message;
    console.warn('[poolManager] pgNotifyListener sync warning:', err.message);
  }
}

function readPgListenStats() {
  if (!pgNotifyListener) {
    return { connected: false, channels: [] };
  }
  if (typeof pgNotifyListener.getStatus === 'function') {
    return pgNotifyListener.getStatus();
  }
  if (typeof pgNotifyListener.getStats === 'function') {
    return pgNotifyListener.getStats();
  }
  return {
    connected: Boolean(pgNotifyListener.connected || pgNotifyListener.isConnected),
    channels: pgNotifyListener.channels || [],
  };
}

function normalizeChannelStats(raw) {
  if (!raw || typeof raw !== 'object') {
    return { clients: 0, activeClients: 0, activeConnections: 0, clientList: [] };
  }
  const clientList = Array.isArray(raw.clients) ? raw.clients : [];
  const count =
    typeof raw.activeClients === 'number'
      ? raw.activeClients
      : typeof raw.activeConnections === 'number'
        ? raw.activeConnections
        : typeof raw.clients === 'number'
          ? raw.clients
          : clientList.length;
  return {
    ...raw,
    clients: count,
    activeClients: count,
    activeConnections: count,
    clientList,
  };
}

/**
 * Execute a parameterized SQL query against the active dynamic pool with hrtime telemetry.
 * @param {string} sql
 * @param {Array<any>} [params=[]]
 * @param {{ silent?: boolean, skipLog?: boolean, skipDelay?: boolean, source?: string, tag?: string }} [meta={}]
 */
async function query(sql, params = [], meta = {}) {
  const startNs = process.hrtime.bigint();
  const silent = Boolean(meta.silent);
  const skipLog = Boolean(meta.skipLog);

  try {
    if (artificialDelayMs > 0 && !meta.skipDelay) {
      await sleep(artificialDelayMs);
    }

    if (simulatedOffline) {
      throw createSimulatedOfflineError();
    }

    const result = await pool.query(sql, params);
    const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
    lastError = null;

    if (!skipLog) {
      const entry = {
        id: ++querySeq,
        sql: compactSql(sql),
        params: sanitizeParams(params),
        operation: detectSqlOperation(sql),
        source: meta.source || meta.tag || 'api',
        durationMs,
        rowCount:
          typeof result.rowCount === 'number'
            ? result.rowCount
            : Array.isArray(result.rows)
              ? result.rows.length
              : 0,
        status: 'ok',
        success: true,
        error: null,
        timestamp: new Date().toISOString(),
      };
      recordQueryEntry(entry, silent);
    }

    return result;
  } catch (err) {
    const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
    lastError = `${err.code ? `[${err.code}] ` : ''}${err.message}`;

    if (!skipLog) {
      const entry = {
        id: ++querySeq,
        sql: compactSql(sql),
        params: sanitizeParams(params),
        operation: detectSqlOperation(sql),
        source: meta.source || meta.tag || 'api',
        durationMs,
        rowCount: 0,
        status: 'error',
        success: false,
        error: {
          code: err.code || 'DB_ERROR',
          message: err.message,
          detail: err.detail || null,
        },
        timestamp: new Date().toISOString(),
      };
      recordQueryEntry(entry, silent);
    }

    throw err;
  }
}

/**
 * Swap PostgreSQL connection string at runtime or restore default .env DATABASE_URL.
 * @param {{ connectionString?: string, resetDefault?: boolean }} options
 */
async function setConnectionConfig({ connectionString, resetDefault } = {}) {
  let nextConnStr;

  if (resetDefault) {
    nextConnStr = DEFAULT_DATABASE_URL;
    isCustomConnection = false;
  } else {
    if (!connectionString || typeof connectionString !== 'string' || !connectionString.trim()) {
      const err = new Error('Vui lòng cung cấp connectionString hợp lệ hoặc chọn resetDefault.');
      err.code = 'INVALID_CONNECTION_CONFIG';
      err.status = 400;
      throw err;
    }
    const trimmed = connectionString.trim();
    const isUri = /^postgres(ql)?:\/\//i.test(trimmed);
    const isKeyValue = /\b(host|dbname|user)=/i.test(trimmed);
    if (!isUri && !isKeyValue) {
      const err = new Error(
        'Định dạng connectionString không hợp lệ (cần bắt đầu bằng postgresql:// hoặc postgres://).'
      );
      err.code = 'INVALID_CONNECTION_CONFIG';
      err.status = 400;
      throw err;
    }
    nextConnStr = trimmed;
    isCustomConnection = nextConnStr !== DEFAULT_DATABASE_URL;
  }

  const previousPool = pool;
  currentConnectionString = nextConnStr;
  lastError = null;
  pool = createPool(currentConnectionString);

  if (previousPool && previousPool !== pool) {
    previousPool.end().catch((err) => {
      console.warn('[poolManager] Error closing previous pool:', err.message);
    });
  }

  await syncPgNotifyListener();
  const status = await getDbStatus();

  if (typeof publishEvent === 'function') {
    const nowIso = new Date().toISOString();
    publishEvent('db:config_changed', {
      maskedConnectionString: maskConnectionString(currentConnectionString),
      isDefault: !isCustomConnection,
      connected: status.connected,
      online: status.connected,
      latencyMs: status.latencyMs,
      lastError: status.lastError,
      timestamp: nowIso,
    });
    publishEvent('db:status_changed', {
      connected: status.connected,
      online: status.connected,
      latencyMs: status.latencyMs,
      simulatedOffline,
      artificialDelayMs,
      maskedConnectionString: maskConnectionString(currentConnectionString),
      lastError: status.lastError,
      timestamp: nowIso,
    });
  }

  return status;
}

/**
 * Toggle simulated DB outage and/or artificial query latency (chaos testing).
 * @param {{ offline?: boolean, artificialDelayMs?: number }} options
 */
async function setSimulation({ offline, artificialDelayMs: nextDelayMs } = {}) {
  const prevOffline = simulatedOffline;

  if (typeof offline === 'boolean') {
    simulatedOffline = offline;
    if (simulatedOffline) {
      lastError =
        '[SIMULATED_DB_OFFLINE] Kết nối PostgreSQL đang ở chế độ giả lập mất kết nối.';
    } else {
      lastError = null;
    }
  }

  if (nextDelayMs !== undefined && nextDelayMs !== null) {
    const parsed = Number(nextDelayMs);
    if (!Number.isFinite(parsed) || parsed < 0) {
      const err = new Error('artificialDelayMs phải là số không âm (ms).');
      err.code = 'INVALID_SIMULATION_CONFIG';
      err.status = 400;
      throw err;
    }
    artificialDelayMs = Math.min(30000, Math.round(parsed));
  }

  if (prevOffline !== simulatedOffline) {
    await syncPgNotifyListener();
  }

  const status = await getDbStatus();

  if (typeof publishEvent === 'function') {
    const nowIso = new Date().toISOString();
    publishEvent('db:simulation_changed', {
      offline: simulatedOffline,
      simulatedOffline,
      artificialDelayMs,
      connected: status.connected,
      online: status.connected,
      latencyMs: status.latencyMs,
      timestamp: nowIso,
    });
    publishEvent('db:status_changed', {
      connected: status.connected,
      online: status.connected,
      latencyMs: status.latencyMs,
      simulatedOffline,
      artificialDelayMs,
      maskedConnectionString: maskConnectionString(currentConnectionString),
      lastError: status.lastError,
      timestamp: nowIso,
    });
  }

  return status;
}

/**
 * Inspect live DB connectivity, latency, PG server info, pool metrics, 6 table row counts,
 * realtime channel stats, and recent SQL telemetry. Never throws when DB is offline.
 */
async function getDbStatus() {
  const basePoolStats = {
    totalCount: pool ? pool.totalCount : 0,
    idleCount: pool ? pool.idleCount : 0,
    waitingCount: pool ? pool.waitingCount : 0,
    maxConnections: MAX_POOL_SIZE,
  };

  const realtimeStats = {
    pgListen: readPgListenStats(),
    sse: normalizeChannelStats(typeof getSseStats === 'function' ? getSseStats() : null),
    ws: normalizeChannelStats(typeof getWsStats === 'function' ? getWsStats() : null),
  };

  const emptyCounts = TRACKED_TABLES.reduce((acc, tbl) => {
    acc[tbl] = null;
    return acc;
  }, {});

  if (simulatedOffline) {
    const offlineMsg =
      lastError || '[SIMULATED_DB_OFFLINE] Kết nối PostgreSQL đang ở chế độ giả lập mất kết nối.';
    const maskedConn = maskConnectionString(currentConnectionString);
    return {
      connected: false,
      online: false,
      latencyMs: null,
      lastError: offlineMsg,
      maskedConnectionString: maskedConn,
      connectionString: maskedConn,
      isDefaultConnection: !isCustomConnection,
      isCustomConnection,
      simulatedOffline,
      artificialDelayMs,
      simulation: {
        offline: simulatedOffline,
        artificialDelayMs,
      },
      server: null,
      pool: basePoolStats,
      tableCounts: emptyCounts,
      realtime: realtimeStats,
      recentQueries: [...recentQueries],
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const pingStart = process.hrtime.bigint();
    if (artificialDelayMs > 0) {
      await sleep(artificialDelayMs);
    }
    await pool.query('SELECT 1 AS ok');
    const latencyMs = Number((Number(process.hrtime.bigint() - pingStart) / 1e6).toFixed(2));

    const serverRes = await pool.query(`
      SELECT
        current_database() AS database_name,
        current_user AS current_user,
        COALESCE(inet_server_addr()::text, 'localhost') AS server_addr,
        inet_server_port() AS server_port,
        version() AS full_version,
        current_setting('server_version') AS server_version,
        pg_size_pretty(pg_database_size(current_database())) AS database_size,
        NOW() AS server_time
    `);

    const srv = serverRes.rows[0] || {};
    const serverInfo = {
      database: srv.database_name || null,
      databaseName: srv.database_name || null,
      user: srv.current_user || null,
      currentUser: srv.current_user || null,
      host: srv.server_addr || 'localhost',
      port: srv.server_port || 5432,
      version: srv.server_version ? `PostgreSQL ${srv.server_version}` : srv.full_version || null,
      fullVersion: srv.full_version || null,
      databaseSize: srv.database_size || null,
      serverTime: srv.server_time || null,
    };

    const tableCounts = { ...emptyCounts };
    try {
      const countsRes = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM categories) AS categories,
          (SELECT COUNT(*)::int FROM foods) AS foods,
          (SELECT COUNT(*)::int FROM orders) AS orders,
          (SELECT COUNT(*)::int FROM order_items) AS order_items,
          (SELECT COUNT(*)::int FROM order_status_history) AS order_status_history,
          (SELECT COUNT(*)::int FROM flash_sale_slots) AS flash_sale_slots,
          (SELECT COUNT(*)::int FROM flash_sale_items) AS flash_sale_items
      `);
      if (countsRes.rows[0]) {
        for (const tbl of TRACKED_TABLES) {
          tableCounts[tbl] = countsRes.rows[0][tbl] ?? 0;
        }
      }
    } catch (countErr) {
      // Fallback per-table in case connected to a partial/custom database
      for (const tbl of TRACKED_TABLES) {
        try {
          const singleRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
          tableCounts[tbl] = singleRes.rows[0]?.cnt ?? 0;
        } catch (_) {
          tableCounts[tbl] = null;
        }
      }
    }

    lastError = null;
    const maskedConn = maskConnectionString(currentConnectionString);

    return {
      connected: true,
      online: true,
      latencyMs,
      lastError: null,
      maskedConnectionString: maskedConn,
      connectionString: maskedConn,
      isDefaultConnection: !isCustomConnection,
      isCustomConnection,
      simulatedOffline,
      artificialDelayMs,
      simulation: {
        offline: simulatedOffline,
        artificialDelayMs,
      },
      server: serverInfo,
      pool: {
        totalCount: pool ? pool.totalCount : 0,
        idleCount: pool ? pool.idleCount : 0,
        waitingCount: pool ? pool.waitingCount : 0,
        maxConnections: MAX_POOL_SIZE,
      },
      tableCounts,
      realtime: {
        pgListen: readPgListenStats(),
        sse: normalizeChannelStats(typeof getSseStats === 'function' ? getSseStats() : null),
        ws: normalizeChannelStats(typeof getWsStats === 'function' ? getWsStats() : null),
      },
      recentQueries: [...recentQueries],
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    lastError = `${err.code ? `[${err.code}] ` : ''}${err.message}`;
    const maskedConn = maskConnectionString(currentConnectionString);

    return {
      connected: false,
      online: false,
      latencyMs: null,
      lastError,
      maskedConnectionString: maskedConn,
      connectionString: maskedConn,
      isDefaultConnection: !isCustomConnection,
      isCustomConnection,
      simulatedOffline,
      artificialDelayMs,
      simulation: {
        offline: simulatedOffline,
        artificialDelayMs,
      },
      server: null,
      pool: basePoolStats,
      tableCounts: emptyCounts,
      realtime: realtimeStats,
      recentQueries: [...recentQueries],
      checkedAt: new Date().toISOString(),
    };
  }
}

function getPool() {
  return pool;
}

function getConnectionString() {
  return currentConnectionString;
}

function getSimulationState() {
  return {
    offline: simulatedOffline,
    simulatedOffline,
    artificialDelayMs,
  };
}

function getRecentQueries() {
  return [...recentQueries];
}

module.exports = {
  query,
  getPool,
  getConnectionString,
  maskConnectionString,
  setConnectionConfig,
  setSimulation,
  getSimulationState,
  getDbStatus,
  getRecentQueries,
  TRACKED_TABLES,
  DEFAULT_DATABASE_URL,
};
