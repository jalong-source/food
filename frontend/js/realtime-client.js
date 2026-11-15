/**
 * Resilient Browser Real-Time Client (SSE + WebSocket)
 * Designed for seamless operation behind Cloudflare DNS & Cloudflare Tunnels.
 */

export const NAMED_EVENTS = Object.freeze([
  'connected',
  'order:created',
  'order:status_updated',
  'order:updated',
  'order:deleted',
  'food:created',
  'food:updated',
  'food:deleted',
  'category:created',
  'category:updated',
  'category:deleted',
  'db:status_changed',
  'db:config_changed',
  'db:simulation_changed',
  'db:constraint_violated',
  'db:query_logged',
  'db:trigger_fired',
  'db:listener_changed',
]);

const WS_CLIENT_PING_MS = 25000;
const BASE_RECONNECT_MS = 1500;
const MAX_RECONNECT_MS = 15000;

export class RealtimeClient {
  /**
   * @param {object} [options={}]
   * @param {'sse'|'ws'} [options.transport='sse'] - Initial transport protocol
   * @param {string} [options.sseUrl='/api/events/stream'] - SSE endpoint path or URL
   * @param {string} [options.wsUrl] - Explicit WS URL (defaults to ws(s)://<host>/ws)
   * @param {string} [options.baseUrl=''] - Optional API origin prefix
   * @param {boolean} [options.autoConnect=true] - Connect immediately upon creation
   * @param {boolean} [options.withCredentials=false] - EventSource credentials flag
   */
  constructor(options = {}) {
    const initialTransport = String(options.transport || 'sse').toLowerCase() === 'ws' ? 'ws' : 'sse';

    this.transport = initialTransport;
    this.baseUrl = options.baseUrl ? String(options.baseUrl).replace(/\/+$/, '') : '';
    this.ssePath = options.sseUrl || '/api/events/stream';
    this.explicitWsUrl = options.wsUrl || null;
    this.withCredentials = Boolean(options.withCredentials);

    this.state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
    this.currentUrl = '';
    this.clientId = null;
    this.lastEventId = options.lastEventId ? String(options.lastEventId) : null;
    this.lastEventAt = null;
    this.eventsReceived = 0;
    this.reconnectAttempts = 0;
    this.lastError = null;

    this._closedManually = false;
    this._source = null; // Active EventSource
    this._socket = null; // Active WebSocket
    this._reconnectTimer = null;
    this._wsPingTimer = null;

    this._listeners = new Map(); // Map<string, Set<Function>>
    this._statusListeners = new Set(); // Set<Function>
    this._sseEventTypes = new Set(NAMED_EVENTS);

    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  /**
   * Compute full SSE endpoint URL, attaching ?lastEventId=... when resuming externally.
   */
  _buildSseUrl(includeLastEventId = false) {
    const rawBase = /^https?:\/\//i.test(this.ssePath)
      ? this.ssePath
      : `${this.baseUrl}${this.ssePath}`;

    if (!includeLastEventId || !this.lastEventId) {
      return rawBase;
    }

    const separator = rawBase.includes('?') ? '&' : '?';
    return `${rawBase}${separator}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  /**
   * Compute WebSocket endpoint URL (`ws://<host>/ws` or `wss://<host>/ws`).
   */
  _buildWsUrl() {
    let baseWs;

    if (this.explicitWsUrl) {
      if (/^wss?:\/\//i.test(this.explicitWsUrl)) {
        baseWs = this.explicitWsUrl;
      } else {
        const loc = typeof window !== 'undefined' && window.location ? window.location : null;
        const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = (loc && loc.host) || 'localhost:3000';
        const path = this.explicitWsUrl.startsWith('/')
          ? this.explicitWsUrl
          : `/${this.explicitWsUrl}`;
        baseWs = `${proto}//${host}${path}`;
      }
    } else if (this.baseUrl && /^https?:\/\//i.test(this.baseUrl)) {
      const wsOrigin = this.baseUrl.replace(/^http/i, 'ws');
      baseWs = `${wsOrigin}/ws`;
    } else {
      const loc = typeof window !== 'undefined' && window.location ? window.location : null;
      const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = (loc && loc.host) || 'localhost:3000';
      baseWs = `${proto}//${host}/ws`;
    }

    if (!this.lastEventId) {
      return baseWs;
    }

    const separator = baseWs.includes('?') ? '&' : '?';
    return `${baseWs}${separator}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  _clearTimers() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._wsPingTimer) {
      clearInterval(this._wsPingTimer);
      this._wsPingTimer = null;
    }
  }

  _teardownTransport() {
    this._clearTimers();

    if (this._source) {
      const es = this._source;
      this._source = null;
      try {
        es.close();
      } catch (_err) {
        // Ignore close error
      }
    }

    if (this._socket) {
      const ws = this._socket;
      this._socket = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === 0 || ws.readyState === 1) {
          ws.close(1000, 'transport_teardown');
        }
      } catch (_err) {
        // Ignore close error
      }
    }
  }

  _setState(nextState, errorMessage = undefined) {
    const prevState = this.state;
    const prevError = this.lastError;

    this.state = nextState;
    if (errorMessage !== undefined) {
      this.lastError = errorMessage;
    }

    if (prevState !== this.state || prevError !== this.lastError) {
      this._emitStatus();
    }
  }

  _emitStatus() {
    const snapshot = this.getStatus();
    for (const cb of this._statusListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error('[RealtimeClient] Status listener error:', err);
      }
    }
  }

  _dispatchEvent(eventType, envelope) {
    const typeCallbacks = this._listeners.get(eventType);
    if (typeCallbacks) {
      for (const cb of typeCallbacks) {
        try {
          cb(envelope);
        } catch (err) {
          console.error(`[RealtimeClient] Listener error on "${eventType}":`, err);
        }
      }
    }

    // Ignore internal keep-alive `pong` on wildcard '*' stream
    if (eventType !== 'pong') {
      const wildcardCallbacks = this._listeners.get('*');
      if (wildcardCallbacks) {
        for (const cb of wildcardCallbacks) {
          try {
            cb(envelope);
          } catch (err) {
            console.error('[RealtimeClient] Wildcard listener error:', err);
          }
        }
      }
    }
  }

  _handleRawPayload(rawData, fallbackType = 'message', sseLastEventId = '') {
    let parsed;
    if (typeof rawData === 'string') {
      try {
        parsed = JSON.parse(rawData);
      } catch (_err) {
        parsed = {
          id: sseLastEventId || null,
          type: fallbackType,
          data: rawData,
          meta: {},
          timestamp: new Date().toISOString(),
        };
      }
    } else if (rawData && typeof rawData === 'object') {
      parsed = rawData;
    } else {
      return;
    }

    const eventType = String(parsed.type || fallbackType || 'message');
    const candidateId = parsed.id || sseLastEventId || null;

    if (eventType === 'connected') {
      if (parsed.data && parsed.data.clientId) {
        this.clientId = String(parsed.data.clientId);
      }
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.state = 'connected';
      this._emitStatus();
      this._dispatchEvent('connected', parsed);
      return;
    }

    if (eventType === 'pong') {
      this._dispatchEvent('pong', parsed);
      return;
    }

    if (candidateId && !String(candidateId).startsWith('conn-')) {
      this.lastEventId = String(candidateId);
    }

    this.eventsReceived += 1;
    this.lastEventAt = parsed.timestamp || new Date().toISOString();

    this._dispatchEvent(eventType, parsed);
  }

  _scheduleReconnect(reason = 'Connection interrupted') {
    if (this._closedManually || this._reconnectTimer) return;

    this.reconnectAttempts += 1;
    this._setState('reconnecting', reason);

    const expDelay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, Math.min(this.reconnectAttempts - 1, 4)),
      MAX_RECONNECT_MS
    );
    const jitter = Math.floor(Math.random() * 400);
    const waitMs = expDelay + jitter;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closedManually) return;

      if (this.transport === 'ws') {
        this._connectWs();
      } else {
        this._connectSse(true);
      }
    }, waitMs);
  }

  _bindSseEventType(es, eventType) {
    es.addEventListener(eventType, (evt) => {
      if (this._source !== es) return;
      this._handleRawPayload(evt.data, eventType, evt.lastEventId);
    });
  }

  _connectSse(useQueryReplay = false) {
    if (typeof EventSource === 'undefined') {
      this._setState('disconnected', 'EventSource API is not available in this environment');
      return;
    }

    this._teardownTransport();

    const includeLastId = Boolean(useQueryReplay && this.lastEventId);
    const url = this._buildSseUrl(includeLastId);
    this.currentUrl = url;
    this._setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let es;
    try {
      es = this.withCredentials
        ? new EventSource(url, { withCredentials: true })
        : new EventSource(url);
    } catch (err) {
      this._scheduleReconnect(err && err.message ? err.message : 'Failed to create EventSource');
      return;
    }

    this._source = es;

    es.onopen = () => {
      if (this._source !== es) return;
      this.reconnectAttempts = 0;
      this._setState('connected', null);
    };

    // Register listeners for all known named events + any custom events registered via .on()
    for (const eventType of this._sseEventTypes) {
      this._bindSseEventType(es, eventType);
    }

    // Fallback listener for unnamed SSE frames (`data: ...` with no `event:` field)
    es.onmessage = (evt) => {
      if (this._source !== es) return;
      this._handleRawPayload(evt.data, 'message', evt.lastEventId);
    };

    es.onerror = () => {
      if (this._source !== es || this._closedManually) return;

      // readyState 2 === EventSource.CLOSED (e.g. Cloudflare 502/524/530 stopped native retry)
      if (es.readyState === 2) {
        this._teardownTransport();
        this._scheduleReconnect('SSE stream closed; reconnecting with backoff');
      } else {
        this.reconnectAttempts += 1;
        this._setState('reconnecting', 'SSE connection interrupted; auto-retrying');
      }
    };
  }

  _connectWs() {
    if (typeof WebSocket === 'undefined') {
      this._setState('disconnected', 'WebSocket API is not available in this environment');
      return;
    }

    this._teardownTransport();

    const url = this._buildWsUrl();
    this.currentUrl = url;
    this._setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._scheduleReconnect(err && err.message ? err.message : 'Failed to open WebSocket');
      return;
    }

    this._socket = ws;

    ws.onopen = () => {
      if (this._socket !== ws) return;
      this.reconnectAttempts = 0;
      this._setState('connected', null);

      // Periodic client->server ping keeps Cloudflare Tunnel WebSocket idle timers active
      this._wsPingTimer = setInterval(() => {
        if (this._socket === ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
          } catch (_err) {
            // Socket close handler will manage reconnection
          }
        }
      }, WS_CLIENT_PING_MS);
    };

    ws.onmessage = (evt) => {
      if (this._socket !== ws) return;
      this._handleRawPayload(evt.data, 'message', '');
    };

    ws.onerror = () => {
      if (this._socket !== ws || this._closedManually) return;
      this.lastError = 'WebSocket transport error';
    };

    ws.onclose = () => {
      if (this._socket !== ws) return;
      this._socket = null;
      this._clearTimers();

      if (!this._closedManually && this.transport === 'ws') {
        this._scheduleReconnect('WebSocket closed; reconnecting');
      } else {
        this._setState('disconnected');
      }
    };
  }

  /**
   * Open the real-time connection if not already active/connecting.
   */
  connect() {
    this._closedManually = false;

    if (this.transport === 'sse' && this._source && this._source.readyState !== 2) {
      return this;
    }
    if (
      this.transport === 'ws' &&
      this._socket &&
      (this._socket.readyState === 0 || this._socket.readyState === 1)
    ) {
      return this;
    }

    if (this.transport === 'ws') {
      this._connectWs();
    } else {
      this._connectSse(Boolean(this.lastEventId));
    }

    return this;
  }

  /**
   * Dynamically switch active transport between `'sse'` (`EventSource`) and `'ws'` (`WebSocket`)
   * while preserving `lastEventId` for lossless event continuity.
   *
   * @param {'sse'|'ws'} nextTransport
   * @returns {object} Updated client status snapshot
   */
  switchTransport(nextTransport) {
    const normalized = String(nextTransport || '').toLowerCase().trim();
    if (normalized !== 'sse' && normalized !== 'ws') {
      throw new Error(`Unsupported transport "${nextTransport}". Expected "sse" or "ws".`);
    }

    this._closedManually = false;
    this.transport = normalized;
    this.reconnectAttempts = 0;
    this.clientId = null;

    this._teardownTransport();

    if (normalized === 'ws') {
      this._connectWs();
    } else {
      this._connectSse(Boolean(this.lastEventId));
    }

    return this.getStatus();
  }

  /**
   * Subscribe to a specific event type (e.g. `'order:created'`) or wildcard `'*'`.
   *
   * @param {string} type
   * @param {Function} cb
   * @returns {Function} Unsubscribe callback
   */
  on(type, cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('RealtimeClient.on(type, cb) requires a callback function');
    }

    const eventType = String(type || '*');
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    this._listeners.get(eventType).add(cb);

    // Dynamically register any custom named SSE event if EventSource is already open
    if (eventType !== '*' && eventType !== 'message' && !this._sseEventTypes.has(eventType)) {
      this._sseEventTypes.add(eventType);
      if (this._source) {
        this._bindSseEventType(this._source, eventType);
      }
    }

    return () => this.off(eventType, cb);
  }

  /**
   * Remove a previously registered event listener.
   */
  off(type, cb) {
    const eventType = String(type || '*');
    const set = this._listeners.get(eventType);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      this._listeners.delete(eventType);
    }
  }

  /**
   * Subscribe to connection & transport status transitions.
   * Immediately invokes `cb` with the current status snapshot.
   *
   * @param {Function} cb
   * @returns {Function} Unsubscribe callback
   */
  onStatusChange(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('RealtimeClient.onStatusChange(cb) requires a callback function');
    }

    this._statusListeners.add(cb);
    try {
      cb(this.getStatus());
    } catch (err) {
      console.error('[RealtimeClient] Initial status callback error:', err);
    }

    return () => {
      this._statusListeners.delete(cb);
    };
  }

  /**
   * Return current transport state, counters, and diagnostics.
   */
  getStatus() {
    return {
      connected: this.state === 'connected',
      state: this.state,
      transport: this.transport,
      url: this.currentUrl,
      clientId: this.clientId,
      lastEventId: this.lastEventId,
      lastEventAt: this.lastEventAt,
      eventsReceived: this.eventsReceived,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  /**
   * Permanently close the active SSE/WS transport and stop auto-reconnection.
   */
  close() {
    this._closedManually = true;
    this._teardownTransport();
    this._setState('disconnected', null);
  }
}

/**
 * Factory helper to create and start a RealtimeClient instance.
 *
 * @param {object} [options={}]
 * @returns {RealtimeClient}
 */
export function createRealtimeClient(options = {}) {
  return new RealtimeClient(options);
}

export default RealtimeClient;
