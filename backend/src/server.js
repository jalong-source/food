require('dotenv').config();
const http = require('http');
const app = require('./app');
const { attachWebSocketServer } = require('./realtime/wsManager');
const { disconnectAllSseClients } = require('./realtime/sseManager');
const { pgNotifyListener } = require('./realtime/pgNotifyListener');
const {
  getPool,
  getConnectionString,
  maskConnectionString,
} = require('./db/poolManager');

const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

// Attach real-time WebSocket server (/ws) onto the shared HTTP server
attachWebSocketServer(server, { path: '/ws' });

// Start dedicated PostgreSQL LISTEN/NOTIFY client asynchronously (never blocks HTTP boot)
pgNotifyListener
  .connect(getConnectionString())
  .then((listenerState) => {
    if (listenerState.connected) {
      console.log(
        `[pgNotifyListener] Subscribed to channel "${listenerState.channel}" on ${maskConnectionString(getConnectionString())}`
      );
    } else {
      console.warn(
        `[pgNotifyListener] Initial LISTEN deferred (${listenerState.lastError || 'DB unavailable'}) — auto-reconnect active.`
      );
    }
  })
  .catch((err) => {
    console.warn('[pgNotifyListener] Startup warning:', err.message);
  });

server.listen(PORT, HOST, () => {
  console.log('==================================================================');
  console.log(` JaLong Food Backend & Realtime Server running on http://${HOST}:${PORT}`);
  console.log(` - Customer App     : http://localhost:${PORT}/`);
  console.log(` - DB Live Inspector: http://localhost:${PORT}/inspector`);
  console.log(` - Split Demo View  : http://localhost:${PORT}/split`);
  console.log(` - SSE Stream       : http://localhost:${PORT}/api/events/stream`);
  console.log(` - WebSocket        : ws://localhost:${PORT}/ws`);
  console.log(` - PostgreSQL Pool  : ${maskConnectionString(getConnectionString())}`);
  console.log('==================================================================');
});

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);

  try {
    disconnectAllSseClients();
  } catch (_err) {
    // Ignore SSE cleanup errors
  }

  try {
    await pgNotifyListener.disconnect();
  } catch (_err) {
    // Ignore PG listener disconnect errors
  }

  server.close(async () => {
    try {
      const activePool = getPool();
      if (activePool) {
        await activePool.end();
      }
    } catch (_err) {
      // Ignore pool shutdown errors
    }
    process.exit(0);
  });

  // Force exit after 5s if lingering sockets block server.close
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = server;
