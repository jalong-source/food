'use strict';

const { Client } = require('pg');
const { publishEvent } = require('./eventBus');

const DEFAULT_CHANNEL = 'db_realtime_events';
const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Dedicated PostgreSQL LISTEN/NOTIFY real-time subscriber.
 * Uses an isolated `pg.Client` (outside the query pool) to receive instant
 * row-level trigger notifications on `db_realtime_events` without polling.
 */
class PgNotifyListener {
  constructor(options = {}) {
    this.channel = options.channel || DEFAULT_CHANNEL;
    this.autoReconnect = options.autoReconnect !== false;

    this.client = null;
    this.connected = false;
    this.lastNotificationAt = null;
    this.notificationsReceived = 0;
    this.lastError = null;

    this._lastConnectionInput = null;
    this._manualDisconnect = false;
    this._generation = 0;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  /**
   * Build a safe `pg.Client` configuration from a connection string, config object, or env.
   */
  _normalizeClientConfig(connectionStringOrConfig) {
    if (typeof connectionStringOrConfig === 'string' && connectionStringOrConfig.trim() !== '') {
      return {
        connectionString: connectionStringOrConfig.trim(),
        keepAlive: true,
        connectionTimeoutMillis: 8000,
      };
    }

    if (connectionStringOrConfig && typeof connectionStringOrConfig === 'object') {
      return {
        keepAlive: true,
        connectionTimeoutMillis: 8000,
        ...connectionStringOrConfig,
      };
    }

    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
      return {
        connectionString: process.env.DATABASE_URL.trim(),
        keepAlive: true,
        connectionTimeoutMillis: 8000,
      };
    }

    return null;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Safely tear down an existing `pg.Client` instance without ever emitting uncaught socket errors.
   */
  async _safeCloseClient(clientInstance, sendUnlisten = false) {
    if (!clientInstance) return;

    clientInstance.removeAllListeners('notification');
    clientInstance.removeAllListeners('end');
    clientInstance.removeAllListeners('error');
    // Keep a no-op error handler attached so late TCP resets during .end() never crash Node
    clientInstance.on('error', () => {});

    if (sendUnlisten) {
      try {
        const safeChannel = this.channel.replace(/[^a-zA-Z0-9_]/g, '');
        if (safeChannel) {
          await clientInstance.query(`UNLISTEN ${safeChannel}`);
        }
      } catch (_err) {
        // Ignore UNLISTEN errors if socket is already broken
      }
    }

    try {
      await clientInstance.end();
    } catch (_err) {
      // Ignore close errors safely
    }
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this._manualDisconnect || !this._lastConnectionInput) {
      return;
    }
    if (this._reconnectTimer) {
      return;
    }

    const attempt = ++this._reconnectAttempts;
    const expDelay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(attempt - 1, 4)),
      MAX_RECONNECT_DELAY_MS
    );
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = expDelay + jitter;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._manualDisconnect || !this._lastConnectionInput) return;
      this.connect(this._lastConnectionInput, { _isRetry: true }).catch(() => {
        // Handled internally; never reject unhandled
      });
    }, delayMs);

    if (typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
  }

  /**
   * Handle an incoming PostgreSQL NOTIFY frame from `LISTEN db_realtime_events`.
   */
  _handleNotification(msg) {
    try {
      if (!msg) return;
      if (msg.channel && msg.channel !== this.channel) return;

      this.notificationsReceived += 1;
      this.lastNotificationAt = new Date().toISOString();

      let payload;
      if (typeof msg.payload === 'string' && msg.payload.trim() !== '') {
        try {
          payload = JSON.parse(msg.payload);
          this.lastError = null;
        } catch (parseErr) {
          this.lastError = `Invalid JSON notification payload: ${parseErr.message}`;
          payload = { raw: msg.payload };
        }
      } else if (msg.payload && typeof msg.payload === 'object') {
        payload = msg.payload;
      } else {
        payload = {};
      }

      const rawTable =
        (payload && (payload.table || payload.table_name || payload.relname)) || '';
      const table = String(rawTable).toLowerCase().replace(/^public\./, '').trim();

      const rawOperation =
        (payload &&
          (payload.operation || payload.op || payload.action || payload.tg_op || payload.event)) ||
        '';
      const operation = String(rawOperation).toUpperCase().trim();

      const triggerMeta = { origin: 'postgresql_trigger' };

      if (table === 'orders') {
        publishEvent('order:status_updated', payload, triggerMeta);
      } else if (table === 'foods') {
        if (operation === 'INSERT') {
          publishEvent('food:created', payload, triggerMeta);
        } else if (operation === 'UPDATE') {
          publishEvent('food:updated', payload, triggerMeta);
        } else if (operation === 'DELETE') {
          publishEvent('food:deleted', payload, triggerMeta);
        } else {
          publishEvent('food:updated', payload, triggerMeta);
        }
      } else if (table === 'flash_sale_items' || table === 'flash_sale_slots') {
        publishEvent('flash_sale:updated', payload, triggerMeta);
      }

      // Always emit `db:trigger_fired` for SQL & Trigger Inspector visibility
      publishEvent('db:trigger_fired', payload, triggerMeta);
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
    }
  }

  /**
   * Connect (or reconnect) to PostgreSQL and issue `LISTEN db_realtime_events`.
   * Closes any previous client safely before opening the new connection.
   * Never throws uncaught errors on DB unavailability.
   *
   * @param {string|object} [connectionString]
   * @param {object} [internalOpts]
   * @returns {Promise<{ connected: boolean, channel: string, lastNotificationAt: string|null, notificationsReceived: number, lastError: string|null }>}
   */
  async connect(connectionString, internalOpts = {}) {
    const isRetry = Boolean(internalOpts && internalOpts._isRetry);
    if (!isRetry) {
      this._manualDisconnect = false;
      this._reconnectAttempts = 0;
    }
    this._clearReconnectTimer();

    if (connectionString !== undefined) {
      this._lastConnectionInput = connectionString;
    }

    const currentGen = ++this._generation;

    // Close existing client if any before establishing new connection
    if (this.client) {
      const prevClient = this.client;
      this.client = null;
      this.connected = false;
      await this._safeCloseClient(prevClient, false);
    }

    const clientConfig = this._normalizeClientConfig(
      connectionString !== undefined ? connectionString : this._lastConnectionInput
    );

    if (!clientConfig) {
      this.connected = false;
      this.lastError = 'No PostgreSQL connection string provided';
      publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
      return this.getStatus();
    }

    const client = new Client(clientConfig);

    // Attach error handler BEFORE connect() so socket errors can never crash Node
    client.on('error', (err) => {
      if (this.client !== client) return;

      this.connected = false;
      this.lastError = err && err.message ? err.message : 'PostgreSQL connection lost';
      this.client = null;

      this._safeCloseClient(client, false).catch(() => {});
      publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
      this._scheduleReconnect();
    });

    client.on('end', () => {
      if (this.client !== client) return;

      this.connected = false;
      this.client = null;
      publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
      this._scheduleReconnect();
    });

    client.on('notification', (msg) => {
      if (this.client !== client) return;
      this._handleNotification(msg);
    });

    try {
      await client.connect();

      // If another connect() or disconnect() happened while awaiting TCP handshake, abort cleanly
      if (currentGen !== this._generation || this._manualDisconnect) {
        await this._safeCloseClient(client, false);
        return this.getStatus();
      }

      const safeChannel = this.channel.replace(/[^a-zA-Z0-9_]/g, '');
      await client.query(`LISTEN ${safeChannel}`);

      if (currentGen !== this._generation || this._manualDisconnect) {
        await this._safeCloseClient(client, true);
        return this.getStatus();
      }

      this.client = client;
      this.connected = true;
      this.lastError = null;
      this._reconnectAttempts = 0;

      publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
      return this.getStatus();
    } catch (err) {
      this.connected = false;
      this.lastError = err && err.message ? err.message : 'Failed to connect PostgreSQL listener';
      await this._safeCloseClient(client, false);

      if (currentGen === this._generation) {
        publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
        this._scheduleReconnect();
      }

      return this.getStatus();
    }
  }

  /**
   * Cleanly UNLISTEN and disconnect the PostgreSQL listener client, disabling auto-reconnect.
   *
   * @returns {Promise<{ connected: boolean, channel: string, lastNotificationAt: string|null, notificationsReceived: number, lastError: string|null }>}
   */
  async disconnect() {
    this._manualDisconnect = true;
    this._generation += 1;
    this._clearReconnectTimer();

    const activeClient = this.client;
    this.client = null;
    const wasConnected = this.connected;
    this.connected = false;

    if (activeClient) {
      await this._safeCloseClient(activeClient, wasConnected);
    }

    publishEvent('db:listener_changed', this.getStatus(), { origin: 'pg_notify_listener' });
    return this.getStatus();
  }

  /**
   * Return current listener health & metrics.
   */
  getStatus() {
    return {
      connected: this.connected,
      channel: this.channel,
      lastNotificationAt: this.lastNotificationAt,
      notificationsReceived: this.notificationsReceived,
      lastError: this.lastError,
    };
  }
}

const pgNotifyListener = new PgNotifyListener();

module.exports = {
  pgNotifyListener,
  PgNotifyListener,
};
