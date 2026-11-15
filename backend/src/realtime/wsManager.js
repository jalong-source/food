'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { eventBus, getRecentEvents } = require('./eventBus');

const PING_INTERVAL_MS = 20000; // 20s keep-alive ping/pong (Cloudflare Tunnel safe)

let wss = null;
let attachedPath = '/ws';
let pingTimer = null;
let busListener = null;
let nextWsSeq = 0;
let totalConnections = 0;
let totalMessagesSent = 0;
const wsClientMeta = new Map();

function resolveClientIp(req) {
  if (!req || !req.headers) return 'unknown';
  if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
  if (req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeSendJson(ws, serializedPayload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    ws.send(serializedPayload);
    const meta = wsClientMeta.get(ws);
    if (meta) {
      meta.messagesSent += 1;
      meta.lastSentAt = new Date().toISOString();
    }
    totalMessagesSent += 1;
    return true;
  } catch (_err) {
    return false;
  }
}

function stopPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function cleanupExistingServer() {
  stopPingTimer();
  if (busListener) {
    eventBus.off('event', busListener);
    busListener = null;
  }
  if (wss) {
    try {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (_err) {
          // Ignore individual socket termination errors
        }
      }
      wss.close();
    } catch (_err) {
      // Ignore close errors
    }
    wss = null;
  }
  wsClientMeta.clear();
}

/**
 * Attach a WebSocketServer at `/ws` onto an existing Node HTTP server,
 * broadcasting all `eventBus` events as JSON and maintaining 20s ping/pong keep-alives.
 *
 * @param {import('http').Server} httpServer
 * @param {object} [options={}]
 * @param {string} [options.path='/ws']
 * @returns {WebSocketServer}
 */
function attachWebSocketServer(httpServer, options = {}) {
  if (!httpServer) {
    throw new Error('attachWebSocketServer requires a valid Node http.Server instance');
  }

  cleanupExistingServer();

  attachedPath = options.path || '/ws';
  wss = new WebSocketServer({
    server: httpServer,
    path: attachedPath,
  });

  wss.on('error', (err) => {
    console.error('[wsManager] WebSocketServer error:', err.message);
  });

  wss.on('connection', (ws, req) => {
    const clientId = `ws-${++nextWsSeq}`;
    const connectedAt = new Date().toISOString();
    totalConnections += 1;

    ws.isAlive = true;

    const meta = {
      id: clientId,
      ip: resolveClientIp(req),
      userAgent: (req && req.headers && req.headers['user-agent']) || 'unknown',
      connectedAt,
      messagesSent: 0,
      replayedCount: 0,
      lastSentAt: connectedAt,
      lastPongAt: connectedAt,
    };
    wsClientMeta.set(ws, meta);

    ws.on('pong', () => {
      ws.isAlive = true;
      meta.lastPongAt = new Date().toISOString();
    });

    ws.on('message', (rawData) => {
      ws.isAlive = true;
      meta.lastPongAt = new Date().toISOString();

      try {
        const parsed = JSON.parse(String(rawData));
        if (!parsed || typeof parsed !== 'object') return;

        if (parsed.type === 'ping') {
          safeSendJson(
            ws,
            JSON.stringify({
              id: `pong-${Date.now()}`,
              type: 'pong',
              data: { clientTimestamp: parsed.timestamp || null },
              meta: { origin: 'ws_server' },
              timestamp: new Date().toISOString(),
            })
          );
        } else if (parsed.type === 'replay' && parsed.lastEventId) {
          const missed = getRecentEvents({ lastEventId: String(parsed.lastEventId) });
          for (const evt of missed) {
            if (safeSendJson(ws, JSON.stringify(evt))) {
              meta.replayedCount += 1;
            }
          }
        }
      } catch (_err) {
        // Ignore malformed non-JSON client frames safely
      }
    });

    ws.on('error', () => {
      wsClientMeta.delete(ws);
    });

    ws.on('close', () => {
      wsClientMeta.delete(ws);
    });

    // Check optional ?lastEventId=... query parameter for seamless SSE <-> WS handoff/reconnect
    let lastEventId = null;
    try {
      const parsedUrl = new URL((req && req.url) || attachedPath, 'http://localhost');
      const rawLastId = parsedUrl.searchParams.get('lastEventId');
      if (rawLastId && rawLastId.trim() !== '') {
        lastEventId = rawLastId.trim();
      }
    } catch (_err) {
      // Ignore malformed request URL
    }

    const missedEvents = lastEventId ? getRecentEvents({ lastEventId }) : [];

    // Send initial `connected` envelope matching SSE event structure
    const connectedPayload = {
      id: `conn-${clientId}`,
      type: 'connected',
      data: {
        clientId,
        transport: 'ws',
        connectedAt,
        pingIntervalMs: PING_INTERVAL_MS,
        replayedEvents: missedEvents.length,
      },
      meta: {
        origin: 'ws_server',
      },
      timestamp: connectedAt,
    };
    safeSendJson(ws, JSON.stringify(connectedPayload));

    // Replay missed events if requested
    for (const evt of missedEvents) {
      if (safeSendJson(ws, JSON.stringify(evt))) {
        meta.replayedCount += 1;
      }
    }
  });

  // Subscribe to eventBus and broadcast all published events to open WebSocket clients
  busListener = (evt) => {
    if (!wss || wss.clients.size === 0) return;

    const payload = JSON.stringify(evt);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        safeSendJson(client, payload);
      }
    }
  };
  eventBus.on('event', busListener);

  // Protocol-level Ping/Pong keep-alive every 20s
  pingTimer = setInterval(() => {
    if (!wss) {
      stopPingTimer();
      return;
    }

    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        wsClientMeta.delete(ws);
        try {
          ws.terminate();
        } catch (_err) {
          // Ignore terminate error
        }
        continue;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_err) {
        wsClientMeta.delete(ws);
        try {
          ws.terminate();
        } catch (_innerErr) {
          // Ignore terminate error
        }
      }
    }
  }, PING_INTERVAL_MS);

  if (typeof pingTimer.unref === 'function') {
    pingTimer.unref();
  }

  wss.on('close', () => {
    stopPingTimer();
    if (busListener) {
      eventBus.off('event', busListener);
      busListener = null;
    }
    wsClientMeta.clear();
  });

  return wss;
}

/**
 * Return WebSocket server operational statistics.
 */
function getWsStats() {
  const count = wss ? wss.clients.size : 0;
  return {
    attached: Boolean(wss),
    path: attachedPath,
    activeClients: count,
    connectedClients: count,
    clients: count,
    totalConnections,
    totalMessagesSent,
    pingIntervalMs: PING_INTERVAL_MS,
    clientList: Array.from(wsClientMeta.values()).map((meta) => ({ ...meta })),
  };
}

module.exports = {
  attachWebSocketServer,
  getWsStats,
};
