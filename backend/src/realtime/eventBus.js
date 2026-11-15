'use strict';

const { EventEmitter } = require('events');

const MAX_BUFFER_SIZE = 100;

const eventBus = new EventEmitter();
// Allow unlimited SSE/WS/internal subscribers without MaxListenersExceededWarning
eventBus.setMaxListeners(0);

const ringBuffer = [];
let sequence = 0;
let lastEventAt = null;
const startedAt = new Date().toISOString();
const countsByType = Object.create(null);
const countsByOrigin = Object.create(null);

/**
 * Publish a real-time domain/system event onto the in-memory event bus
 * and append it to the 100-event ring buffer for SSE/WS replay.
 *
 * @param {string} type - Event name (e.g. 'order:created', 'db:status_changed')
 * @param {*} [data=null] - Event payload
 * @param {object} [meta={}] - Additional metadata (e.g. { origin: 'postgresql_trigger' })
 * @returns {{ id: string, type: string, data: *, meta: object, timestamp: string }}
 */
function publishEvent(type, data = null, meta = {}) {
  const normalizedType = String(type || 'system:event').replace(/[\r\n]+/g, '').trim();
  const safeMeta = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
  const timestamp = new Date().toISOString();
  const id = String(++sequence);

  const evt = {
    id,
    type: normalizedType,
    data,
    meta: safeMeta,
    timestamp,
  };

  ringBuffer.push(evt);
  if (ringBuffer.length > MAX_BUFFER_SIZE) {
    ringBuffer.shift();
  }

  lastEventAt = timestamp;
  countsByType[normalizedType] = (countsByType[normalizedType] || 0) + 1;
  const originKey = String(safeMeta.origin || 'application');
  countsByOrigin[originKey] = (countsByOrigin[originKey] || 0) + 1;

  eventBus.emit('event', evt);
  return evt;
}

/**
 * Retrieve buffered events from the 100-item ring buffer.
 * Supports:
 *  - getRecentEvents() -> all buffered events (oldest -> newest)
 *  - getRecentEvents(limit) -> last `limit` events
 *  - getRecentEvents({ limit, lastEventId, sinceId, type }) -> filtered/replayed events
 *
 * @param {number|object} [options]
 * @returns {Array<{ id: string, type: string, data: *, meta: object, timestamp: string }>}
 */
function getRecentEvents(options) {
  if (typeof options === 'number') {
    if (options <= 0) return [];
    return ringBuffer.slice(-options);
  }

  if (!options || typeof options !== 'object') {
    return [...ringBuffer];
  }

  const anchorId = options.lastEventId ?? options.sinceId ?? null;
  let items;

  if (anchorId !== null && anchorId !== undefined && String(anchorId).trim() !== '') {
    const targetId = String(anchorId).trim();
    const exactIdx = ringBuffer.findIndex((evt) => evt.id === targetId);

    if (exactIdx !== -1) {
      items = ringBuffer.slice(exactIdx + 1);
    } else {
      const numericAnchor = Number(targetId);
      const oldestBufferedId = ringBuffer.length > 0 ? Number(ringBuffer[0].id) : Infinity;

      if (
        Number.isInteger(numericAnchor) &&
        numericAnchor > 0 &&
        numericAnchor < oldestBufferedId &&
        numericAnchor < sequence
      ) {
        // Requested ID rolled off the ring buffer during this process run; replay available window
        items = [...ringBuffer];
      } else {
        items = [];
      }
    }
  } else {
    items = [...ringBuffer];
  }

  if (options.type) {
    const filterType = String(options.type);
    items = items.filter((evt) => evt.type === filterType);
  }

  if (typeof options.limit === 'number' && options.limit >= 0) {
    items = options.limit === 0 ? [] : items.slice(-options.limit);
  }

  return items;
}

/**
 * Get operational statistics for the real-time event bus.
 */
function getEventStats() {
  return {
    totalPublished: sequence,
    bufferSize: ringBuffer.length,
    maxBufferSize: MAX_BUFFER_SIZE,
    countsByType: { ...countsByType },
    countsByOrigin: { ...countsByOrigin },
    lastEventAt,
    startedAt,
    listenerCount: eventBus.listenerCount('event'),
  };
}

module.exports = {
  eventBus,
  publishEvent,
  getRecentEvents,
  getEventStats,
};
