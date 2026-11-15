'use strict';

const { eventBus, getRecentEvents } = require('./eventBus');

const RETRY_INTERVAL_MS = 2500;
const HEARTBEAT_INTERVAL_MS = 15000; // 15s (< Cloudflare 100s proxy idle timeout)

const sseClients = new Map();
let nextClientSeq = 0;
let totalConnections = 0;
let totalEventsSent = 0;
let totalHeartbeatsSent = 0;
let heartbeatTimer = null;

/**
 * Safely write raw text to an SSE HTTP response stream.
 * Automatically flushes if compression middleware attached res.flush().
 *
 * @param {object} client - Client record from sseClients
 * @param {string} chunk - Raw SSE frame
 * @returns {boolean} true if write succeeded
 */
function safeWriteClient(client, chunk) {
  const { res } = client;
  if (!res || res.writableEnded || res.destroyed) {
    removeClient(client.id);
    return false;
  }

  try {
    res.write(chunk);
    if (typeof res.flush === 'function') {
      res.flush();
    }
    return true;
  } catch (_err) {
    removeClient(client.id);
    return false;
  }
}

/**
 * Format an eventBus event as a named SSE frame.
 */
function formatSseEventFrame(evt) {
  const safeId = String(evt.id).replace(/[\r\n]+/g, '');
  const safeType = String(evt.type).replace(/[\r\n]+/g, '');
  return `id: ${safeId}\nevent: ${safeType}\ndata: ${JSON.stringify(evt)}\n\n`;
}

/**
 * Start the 15s keep-alive comment heartbeat when at least one SSE client is connected.
 */
function ensureHeartbeatTimer() {
  if (heartbeatTimer || sseClients.size === 0) return;

  heartbeatTimer = setInterval(() => {
    if (sseClients.size === 0) {
      stopHeartbeatTimer();
      return;
    }

    const nowIso = new Date().toISOString();
    for (const client of sseClients.values()) {
      if (safeWriteClient(client, ': ping\n\n')) {
        client.lastHeartbeatAt = nowIso;
        totalHeartbeatsSent += 1;
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

function stopHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function removeClient(clientId) {
  const existed = sseClients.delete(clientId);
  if (existed && sseClients.size === 0) {
    stopHeartbeatTimer();
  }
}

/**
 * Broadcast every published eventBus event to all connected SSE streams.
 */
eventBus.on('event', (evt) => {
  if (sseClients.size === 0) return;

  const frame = formatSseEventFrame(evt);
  const nowIso = new Date().toISOString();

  for (const client of sseClients.values()) {
    if (safeWriteClient(client, frame)) {
      client.eventsSent += 1;
      client.lastSentAt = nowIso;
      totalEventsSent += 1;
    }
  }
});

/**
 * Resolve client IP behind Cloudflare Tunnel / reverse proxies.
 */
function resolveClientIp(req) {
  const cfIp = req.headers && req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp);

  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();

  return (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

/**
 * Express route handler for GET /api/events/stream
 */
function sseHandler(req, res) {
  // Optimize underlying TCP socket for low-latency streaming behind Cloudflare Tunnel
  if (req.socket) {
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);
  }

  if (typeof res.status === 'function') {
    res.status(200);
  } else {
    res.statusCode = 200;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const clientId = `sse-${++nextClientSeq}`;
  const connectedAt = new Date().toISOString();
  totalConnections += 1;

  const client = {
    id: clientId,
    res,
    ip: resolveClientIp(req),
    userAgent: (req.headers && req.headers['user-agent']) || 'unknown',
    connectedAt,
    eventsSent: 0,
    replayedCount: 0,
    lastSentAt: connectedAt,
    lastHeartbeatAt: null,
  };

  sseClients.set(clientId, client);
  ensureHeartbeatTimer();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removeClient(clientId);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // 1. Configure client reconnect backoff
  safeWriteClient(client, `retry: ${RETRY_INTERVAL_MS}\n\n`);

  // 2. Determine Last-Event-ID from header or query string for lossless replay
  const rawHeaderLastId = req.headers && req.headers['last-event-id'];
  const rawQueryLastId = req.query && req.query.lastEventId;
  const lastEventId =
    rawHeaderLastId !== undefined && String(rawHeaderLastId).trim() !== ''
      ? String(rawHeaderLastId).trim()
      : rawQueryLastId !== undefined && String(rawQueryLastId).trim() !== ''
        ? String(rawQueryLastId).trim()
        : null;

  const missedEvents = lastEventId ? getRecentEvents({ lastEventId }) : [];

  // 3. Emit initial `connected` handshake event (without `id:` so browser Last-Event-ID stays intact)
  const connectedPayload = {
    id: `conn-${clientId}`,
    type: 'connected',
    data: {
      clientId,
      transport: 'sse',
      connectedAt,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      retryMs: RETRY_INTERVAL_MS,
      replayedEvents: missedEvents.length,
    },
    meta: {
      origin: 'sse_server',
    },
    timestamp: connectedAt,
  };
  safeWriteClient(client, `event: connected\ndata: ${JSON.stringify(connectedPayload)}\n\n`);

  // 4. Replay any missed ring-buffer events after Last-Event-ID
  for (const evt of missedEvents) {
    if (safeWriteClient(client, formatSseEventFrame(evt))) {
      client.eventsSent += 1;
      client.replayedCount += 1;
      totalEventsSent += 1;
    }
  }
}

/**
 * Return SSE connection metrics for health/monitoring endpoints.
 */
function getSseStats() {
  const count = sseClients.size;
  return {
    activeClients: count,
    connectedClients: count,
    clients: count,
    totalConnections,
    totalEventsSent,
    totalHeartbeatsSent,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    retryIntervalMs: RETRY_INTERVAL_MS,
    clientList: Array.from(sseClients.values()).map((c) => ({
      id: c.id,
      ip: c.ip,
      connectedAt: c.connectedAt,
      eventsSent: c.eventsSent,
      replayedCount: c.replayedCount,
      lastSentAt: c.lastSentAt,
      lastHeartbeatAt: c.lastHeartbeatAt,
    })),
  };
}

/**
 * Gracefully close all active SSE streams (e.g., on server shutdown or transport reset).
 *
 * @returns {number} Number of disconnected clients
 */
function disconnectAllSseClients() {
  const count = sseClients.size;
  for (const client of sseClients.values()) {
    try {
      if (client.res && !client.res.writableEnded && !client.res.destroyed) {
        client.res.end();
      }
    } catch (_err) {
      // Ignore socket close errors
    }
  }
  sseClients.clear();
  stopHeartbeatTimer();
  return count;
}

module.exports = {
  sseHandler,
  getSseStats,
  disconnectAllSseClients,
};
