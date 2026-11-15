/**
 * JalongFood • jalong.io.vn — Lecturer "DB Live Inspector" & Chaos Engineering Lab
 * Classic Vintage / Parisian Bistro Admin (Bảng Quản Trị & Sổ Cái CSDL Cổ Điển)
 * Covers:
 *   - Panel 1: Dynamic PostgreSQL Pool Hot-Swap, Telemetry & Chaos Simulation (Outage, Latency, SSE<->WS)
 *   - Panel 2: Visual `foods` CRUD + 3NF Foreign Key `ON DELETE RESTRICT` (`SQLSTATE 23503`) Proof
 *   - Panel 3: Order FSM Dispatch (`sp_update_order_status`), `trg_order_status_audit` & `ON DELETE CASCADE`
 *   - Panel 4: Live 6-Table 3NF + View Explorer & Real-time SQL / `pg_notify` Trigger Console
 */

import {
  getCategories,
  getUsers,
  getFoods,
  createFood,
  updateFood,
  deleteFood,
  getOrders,
  updateOrderStatus,
  deleteOrder,
  getDbStatus,
  updateDbConfig,
  simulateDb,
  getTableData,
  getFoodRevenueReport,
  calculateOrderTotal,
  getCustomerTier,
  formatVND,
  formatDateTime,
  formatTimeShort,
  escapeHtml,
} from './api.js';
import { createRealtimeClient } from './realtime-client.js';

/* ==========================================================================
   CONSTANTS & 3NF SCHEMA METADATA
   ========================================================================== */

const EXPLORER_RELATIONS = [
  {
    name: 'users',
    label: '1. users',
    schemaNote: 'PK: id • UK: email, phone • CHECK: role IN (customer, admin, shipper, lecturer) — Chuẩn 3NF',
  },
  {
    name: 'categories',
    label: '2. categories',
    schemaNote: 'PK: id • UK: name, slug — Tách bảng độc lập triệt tiêu phụ thuộc bắc cầu từ foods',
  },
  {
    name: 'foods',
    label: '3. foods',
    schemaNote: 'PK: id • FK: category_id -> categories(id) ON DELETE RESTRICT • Kiểm soát stock_quantity >= 0',
  },
  {
    name: 'orders',
    label: '4. orders',
    schemaNote: 'PK: id • FK: user_id -> users(id) RESTRICT • Chuẩn 3NF nghiêm ngặt: KHÔNG lưu cột dư thừa total_amount',
  },
  {
    name: 'order_items',
    label: '5. order_items',
    schemaNote: 'PK: id • UK: (order_id, food_id) • FK: order_id CASCADE, food_id RESTRICT (SQLSTATE 23503) • Lưu snapshot unit_price',
  },
  {
    name: 'order_status_history',
    label: '6. order_status_history',
    schemaNote: 'PK: id • FK: order_id CASCADE, changed_by -> users(id) SET NULL • Ghi tự động bởi Trigger trg_order_status_audit',
  },
  {
    name: 'flash_sale_slots',
    label: '7. flash_sale_slots',
    schemaNote: 'PK: id • Quản lý các khung giờ mở bán Flash Sale 1K (1:00, 2:00, 3:00...) đạt chuẩn 3NF',
  },
  {
    name: 'flash_sale_items',
    label: '8. flash_sale_items',
    schemaNote: 'PK: id • UK: (slot_id, food_id) • 10 món trợ giá 1.000₫/phiên, mỗi món đúng 1 suất (stock_quantity = 1)',
  },
  {
    name: 'vw_flash_sale_active',
    label: 'VIEW: vw_flash_sale_active',
    schemaNote: 'VIEW Tổng hợp: Danh sách 10 món Flash Sale 1K đang mở bán kèm tồn kho thời gian thực',
  },
  {
    name: 'vw_orders_summary',
    label: 'VIEW: vw_orders_summary',
    schemaNote: 'VIEW Tổng hợp 3NF: Tính động total_amount = SUM(quantity * unit_price) & item_count = SUM(quantity)',
  },
];

const SAMPLE_FOOD_IMAGES = [
  'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=640&q=80',
  'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=640&q=80',
  'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=640&q=80',
  'https://images.unsplash.com/photo-1555126634-323283e090fa?auto=format&fit=crop&w=640&q=80',
  'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=640&q=80',
];

const ORDER_STATUS_STYLES = {
  Pending: 'badge-vintage-mustard',
  Preparing: 'badge-vintage-mustard',
  Delivering: 'bg-[#FAF3E0] text-[#8C6200] border border-[#DFC27D] font-bold px-2 py-0.5 rounded-full',
  Completed: 'badge-vintage-moss',
  Cancelled: 'badge-vintage-brick',
};

const NEXT_VALID_STATUS = {
  Pending: { status: 'Preparing', label: 'Duyệt & Nấu (Preparing)', cls: 'bg-[#B8860B] hover:bg-[#A07409] text-white shadow-sm' },
  Preparing: { status: 'Delivering', label: 'Giao Tài xế (Delivering)', cls: 'bg-[#8C6D46] hover:bg-[#785C3A] text-white shadow-sm' },
  Delivering: { status: 'Completed', label: 'Hoàn tất (Completed)', cls: 'bg-[#3B5249] hover:bg-[#2D4A3E] text-white shadow-sm' },
};

// Intentionally invalid transition per status so Lecturer can 1-click test Stored Procedure FSM Guard!
const INVALID_TEST_STATUS = {
  Pending: 'Completed',     // Skips Preparing & Delivering -> blocked by FSM
  Preparing: 'Pending',     // Backward transition -> blocked by FSM
  Delivering: 'Pending',    // Backward transition -> blocked by FSM
  Completed: 'Preparing',   // Re-opening finalized order -> blocked by FSM
  Cancelled: 'Delivering',  // Re-opening cancelled order -> blocked by FSM
};

const FALLBACK_THUMB =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><rect width='120' height='120' rx='12' fill='%23231a14'/><text x='60' y='68' font-size='38' text-anchor='middle'>🍲</text><rect x='1' y='1' width='118' height='118' rx='11' fill='none' stroke='%23c5a059' stroke-width='1.5' stroke-opacity='0.6'/></svg>";

/* ==========================================================================
   STATE
   ========================================================================== */

const state = {
  dbStatus: null,
  simulatedOffline: false,
  artificialDelayMs: 0,
  transport: 'sse',

  categories: [],
  users: [],
  foods: [],
  foodSearch: '',
  foodCategoryFilter: '',

  orders: [],
  orderStatusFilter: '',
  auditHistoryRows: [],
  selectedAuditOrderId: null,

  activeExplorerTable: 'orders',
  explorerLimit: 50,
  tableCounts: {},

  consoleLogs: [], // Array<{ uid, category: 'sql'|'trigger'|'error'|'system', html, timestamp }>
  seenQueryIds: new Set(),
  consoleFilter: 'all',
  consolePaused: false,

  pendingFkFood: null, // Food object currently shown in FK 23503 modal
  sampleImgIdx: 0,
};

let realtimeClient = null;

/* ==========================================================================
   DOM ELEMENTS
   ========================================================================== */

const dom = {
  inspOfflineBanner: document.getElementById('inspOfflineBanner'),
  inspOfflineReason: document.getElementById('inspOfflineReason'),
  btnBannerRestore: document.getElementById('btnBannerRestore'),

  serverMetaText: document.getElementById('serverMetaText'),
  btnRefreshAll: document.getElementById('btnRefreshAll'),
  lastCheckedTimestamp: document.getElementById('lastCheckedTimestamp'),

  // Panel 1
  metricDbDot: document.getElementById('metricDbDot'),
  metricDbState: document.getElementById('metricDbState'),
  metricDbSubtext: document.getElementById('metricDbSubtext'),
  metricLatencyValue: document.getElementById('metricLatencyValue'),
  metricArtificialDelayBadge: document.getElementById('metricArtificialDelayBadge'),
  metricPoolRatio: document.getElementById('metricPoolRatio'),
  poolTotalVal: document.getElementById('poolTotalVal'),
  poolIdleVal: document.getElementById('poolIdleVal'),
  poolWaitingVal: document.getElementById('poolWaitingVal'),
  poolMaxVal: document.getElementById('poolMaxVal'),
  metricActiveClientTransport: document.getElementById('metricActiveClientTransport'),
  rtSseCount: document.getElementById('rtSseCount'),
  rtWsCount: document.getElementById('rtWsCount'),
  rtPgListenState: document.getElementById('rtPgListenState'),

  connSourceBadge: document.getElementById('connSourceBadge'),
  btnFillInvalidConn: document.getElementById('btnFillInvalidConn'),
  activeMaskedConnStr: document.getElementById('activeMaskedConnStr'),
  connStringInput: document.getElementById('connStringInput'),
  btnApplyConnString: document.getElementById('btnApplyConnString'),
  btnResetConnString: document.getElementById('btnResetConnString'),

  btnToggleTransport: document.getElementById('btnToggleTransport'),
  btnToggleTransportLabel: document.getElementById('btnToggleTransportLabel'),
  btnToggleDbOutage: document.getElementById('btnToggleDbOutage'),
  btnToggleDbOutageLabel: document.getElementById('btnToggleDbOutageLabel'),
  simDelayLabel: document.getElementById('simDelayLabel'),
  delayPresetBtns: document.querySelectorAll('.delay-preset-btn'),

  // Panel 2
  inspFoodSearch: document.getElementById('inspFoodSearch'),
  inspFoodCategoryFilter: document.getElementById('inspFoodCategoryFilter'),
  btnOpenAddFood: document.getElementById('btnOpenAddFood'),
  inspFoodsTableBody: document.getElementById('inspFoodsTableBody'),

  // Panel 3
  dispatchActorSelect: document.getElementById('dispatchActorSelect'),
  dispatchNoteInput: document.getElementById('dispatchNoteInput'),
  inspOrderStatusFilter: document.getElementById('inspOrderStatusFilter'),
  inspOrdersCountBadge: document.getElementById('inspOrdersCountBadge'),
  inspOrdersList: document.getElementById('inspOrdersList'),
  auditFilterLabel: document.getElementById('auditFilterLabel'),
  btnShowAllAudit: document.getElementById('btnShowAllAudit'),
  inspAuditHistoryBody: document.getElementById('inspAuditHistoryBody'),

  // Panel 4A
  explorerRowLimit: document.getElementById('explorerRowLimit'),
  btnRefreshExplorer: document.getElementById('btnRefreshExplorer'),
  tableTabsContainer: document.getElementById('tableTabsContainer'),
  tableSchemaNote: document.getElementById('tableSchemaNote'),
  tableSchemaDesc: document.getElementById('tableSchemaDesc'),
  tableRowSummary: document.getElementById('tableRowSummary'),
  explorerTableHead: document.getElementById('explorerTableHead'),
  explorerTableBody: document.getElementById('explorerTableBody'),

  // Panel 4B
  consoleFilterSelect: document.getElementById('consoleFilterSelect'),
  btnPauseConsole: document.getElementById('btnPauseConsole'),
  btnClearConsole: document.getElementById('btnClearConsole'),
  consoleCounterBadge: document.getElementById('consoleCounterBadge'),
  sqlConsoleOutput: document.getElementById('sqlConsoleOutput'),

  // Modals
  foodModalBackdrop: document.getElementById('foodModalBackdrop'),
  foodModalTitle: document.getElementById('foodModalTitle'),
  btnCloseFoodModal: document.getElementById('btnCloseFoodModal'),
  btnCancelFoodModal: document.getElementById('btnCancelFoodModal'),
  foodCrudForm: document.getElementById('foodCrudForm'),
  foodFormId: document.getElementById('foodFormId'),
  foodFormName: document.getElementById('foodFormName'),
  foodFormCategory: document.getElementById('foodFormCategory'),
  foodFormPrice: document.getElementById('foodFormPrice'),
  foodFormStock: document.getElementById('foodFormStock'),
  foodFormAvailable: document.getElementById('foodFormAvailable'),
  foodFormImage: document.getElementById('foodFormImage'),
  foodFormDesc: document.getElementById('foodFormDesc'),
  btnSampleFoodImg: document.getElementById('btnSampleFoodImg'),

  fkErrorModalBackdrop: document.getElementById('fkErrorModalBackdrop'),
  btnCloseFkModal: document.getElementById('btnCloseFkModal'),
  btnFkCloseOnly: document.getElementById('btnFkCloseOnly'),
  btnFkConvertSoftDelete: document.getElementById('btnFkConvertSoftDelete'),
  fkModalFoodName: document.getElementById('fkModalFoodName'),
  fkModalRawError: document.getElementById('fkModalRawError'),
  fkModalDetail: document.getElementById('fkModalDetail'),

  toastContainer: document.getElementById('toastContainer'),

  // Panel 5: User-Defined Functions Lab
  udfOrderIdInput: document.getElementById('udfOrderIdInput'),
  btnRunOrderTotal: document.getElementById('btnRunOrderTotal'),
  udfOrderTotalValue: document.getElementById('udfOrderTotalValue'),
  udfOrderDiscountNote: document.getElementById('udfOrderDiscountNote'),
  udfOrderTotalBadge: document.getElementById('udfOrderTotalBadge'),

  udfUserIdInput: document.getElementById('udfUserIdInput'),
  btnRunCustomerTier: document.getElementById('btnRunCustomerTier'),
  udfCustomerTierBadge: document.getElementById('udfCustomerTierBadge'),
  udfCustomerTierSub: document.getElementById('udfCustomerTierSub'),
  udfCustomerTierStatusBadge: document.getElementById('udfCustomerTierStatusBadge'),

  udfTotalRevenueSum: document.getElementById('udfTotalRevenueSum'),
  btnLoadRevenueReport: document.getElementById('btnLoadRevenueReport'),
  udfRevenueTableBody: document.getElementById('udfRevenueTableBody'),
};

/* ==========================================================================
   HELPERS: ICONS, TOASTS & SQL SYNTAX HIGHLIGHTING (VINTAGE THEME)
   ========================================================================== */

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function showToast(title, message = '', variant = 'info') {
  if (!dom.toastContainer) return;
  const styles = {
    success: { border: 'border-[#4A7C59]', icon: 'check-circle-2', color: 'text-[#8FD5A6]' },
    warning: { border: 'border-[#C5A059]', icon: 'shield-alert', color: 'text-[#F3D282]' },
    error: { border: 'border-[#A63A2B]', icon: 'octagon-alert', color: 'text-[#E6A196]' },
    info: { border: 'border-[#D4A373]', icon: 'terminal', color: 'text-[#D4A373]' },
  };
  const st = styles[variant] || styles.info;

  const el = document.createElement('div');
  el.className = `pointer-events-auto toast-enter vintage-toast bg-[#2C1E16] text-[#F6F1E7] border-2 ${st.border} rounded-xl p-3.5 shadow-2xl flex items-start gap-3`;
  el.innerHTML = `
    <i data-lucide="${st.icon}" class="w-5 h-5 ${st.color} shrink-0 mt-0.5"></i>
    <div class="min-w-0 flex-1">
      <div class="text-xs font-bold font-serif text-[#F6F1E7] leading-snug">${escapeHtml(title)}</div>
      ${message ? `<div class="text-[11px] text-[#D8CBB8] mt-1 leading-relaxed font-sans">${escapeHtml(message)}</div>` : ''}
    </div>
  `;
  dom.toastContainer.appendChild(el);
  refreshIcons();

  setTimeout(() => {
    el.classList.remove('toast-enter');
    el.classList.add('toast-exit');
    setTimeout(() => el.remove(), 240);
  }, 4600);
}

function highlightSql(rawSql) {
  const safe = escapeHtml(rawSql || '');
  return safe
    .replace(
      /\b(SELECT|FROM|WHERE|INNER|LEFT|JOIN|ON|GROUP BY|ORDER BY|LIMIT|INSERT INTO|VALUES|UPDATE|SET|DELETE FROM|RETURNING|CALL|AS|AND|OR|IN|COALESCE|COUNT|SUM|FILTER|TRUE|FALSE|NULL)\b/gi,
      '<span class="sql-kw">$1</span>'
    )
    .replace(
      /\b(sp_create_order|sp_update_order_status|sp_upsert_food|trg_order_status_audit|trg_foods_realtime_notify|vw_orders_summary|vw_flash_sale_active)\b/g,
      '<span class="sql-fn">$1</span>'
    )
    .replace(/(\$\d+|\b\d+\b)/g, '<span class="sql-num">$1</span>');
}

/* ==========================================================================
   PANEL 4B: LIVE SQL & TRIGGER STREAM CONSOLE (VINTAGE LEDGER STREAM)
   ========================================================================== */

let logUidCounter = 0;

function pushConsoleLog({ category = 'sql', badgeText, badgeClass, bodyHtml, timestamp }) {
  const entry = {
    uid: ++logUidCounter,
    category,
    badgeText,
    badgeClass,
    bodyHtml,
    timestamp: timestamp || new Date().toISOString(),
  };

  state.consoleLogs.unshift(entry);
  if (state.consoleLogs.length > 120) {
    state.consoleLogs.length = 120;
  }

  dom.consoleCounterBadge.textContent = `${state.consoleLogs.length} logs`;
  if (!state.consolePaused) {
    renderConsoleLogs();
  }
}

function recordQueryEntryToConsole(q) {
  if (!q || (q.id && state.seenQueryIds.has(q.id))) return;
  if (q.id) state.seenQueryIds.add(q.id);

  const isErr = q.status === 'error' || q.success === false || Boolean(q.error);
  const category = isErr ? 'error' : 'sql';
  const badgeText = isErr
    ? `SQL ERROR ${q.error?.code ? `[${q.error.code}]` : ''}`
    : `${q.operation || 'SQL'} • ${q.durationMs ?? 0}ms`;
  const badgeClass = isErr
    ? 'badge-vintage-brick'
    : 'bg-[#C5A059]/20 text-[#E0C788] border border-[#C5A059]/40 font-mono-code font-bold text-[10px] px-1.5 py-0.5 rounded';

  const paramsHtml =
    Array.isArray(q.params) && q.params.length > 0
      ? `<div class="text-[11px] text-[#D8CBB8]/80 mt-1">params: <span class="text-[#E5A93C] font-mono-code">${escapeHtml(JSON.stringify(q.params))}</span></div>`
      : '';

  const errHtml = isErr
    ? `<div class="text-[11px] text-[#E07A5F] font-semibold mt-1">↳ ${escapeHtml(q.error?.message || 'Query execution error')}${q.error?.detail ? ` (${escapeHtml(q.error.detail)})` : ''}</div>`
    : `<div class="text-[10px] text-[#8C6D46] mt-0.5">source: ${escapeHtml(q.source || 'api')} • rows: ${q.rowCount ?? 0}</div>`;

  pushConsoleLog({
    category,
    badgeText,
    badgeClass,
    bodyHtml: `
      <div class="text-[#F6F1E7] break-words font-mono-code leading-relaxed">${highlightSql(q.sql)}</div>
      ${paramsHtml}
      ${errHtml}
    `,
    timestamp: q.timestamp,
  });
}

function recordTriggerToConsole(payload, timestamp) {
  const tbl = payload?.table || 'unknown';
  const act = payload?.action || payload?.operation || 'TRIGGER';
  const evt = payload?.event || 'pg_notify';
  const jsonCompact = JSON.stringify(payload?.data || payload);

  pushConsoleLog({
    category: 'trigger',
    badgeText: `PG_NOTIFY • ${tbl}.${act}`,
    badgeClass: 'badge-vintage-moss',
    bodyHtml: `
      <div class="text-[#E0C788] font-semibold">⚡ Trigger bắn kênh <span class="sql-str">'db_realtime_events'</span> → event: <span class="sql-fn">${escapeHtml(evt)}</span></div>
      <div class="text-[11px] text-[#D8CBB8] mt-1 break-all font-mono-code">${escapeHtml(jsonCompact)}</div>
    `,
    timestamp,
  });
}

function recordSystemToConsole(title, detail, isError = false) {
  pushConsoleLog({
    category: isError ? 'error' : 'system',
    badgeText: isError ? 'ALERT / CONSTRAINT' : 'REALTIME / POOL',
    badgeClass: isError
      ? 'badge-vintage-brick'
      : 'badge-vintage-moss',
    bodyHtml: `
      <div class="${isError ? 'text-[#E07A5F] font-bold' : 'text-[#6BBF8C] font-semibold'}">${escapeHtml(title)}</div>
      ${detail ? `<div class="text-[11px] text-[#D8CBB8]/80 mt-0.5 break-words font-mono-code">${escapeHtml(detail)}</div>` : ''}
    `,
  });
}

function renderConsoleLogs() {
  const filtered = state.consoleLogs.filter((item) => {
    if (state.consoleFilter === 'all') return true;
    if (state.consoleFilter === 'sql') return item.category === 'sql';
    if (state.consoleFilter === 'trigger') return item.category === 'trigger';
    if (state.consoleFilter === 'error') return item.category === 'error';
    return true;
  });

  if (!filtered.length) {
    dom.sqlConsoleOutput.innerHTML = `
      <div class="py-12 text-center text-[#8C6D46] italic text-xs">
        Đang lắng nghe câu lệnh SQL trực tiếp & tín hiệu Trigger PostgreSQL (LISTEN db_realtime_events)...
      </div>
    `;
    return;
  }

  dom.sqlConsoleOutput.innerHTML = filtered
    .map((item) => {
      const borderCls =
        item.category === 'trigger'
          ? 'vintage-sql-entry-trigger'
          : item.category === 'error'
            ? 'vintage-sql-entry-error'
            : item.category === 'system'
              ? 'vintage-sql-entry-system'
              : 'vintage-sql-entry-query';

      return `
        <div class="vintage-sql-entry ${borderCls}">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="${item.badgeClass}">
              ${escapeHtml(item.badgeText)}
            </span>
            <span class="text-[10px] text-[#8C6D46] font-mono-code">${escapeHtml(formatTimeShort(item.timestamp))}</span>
          </div>
          ${item.bodyHtml}
        </div>
      `;
    })
    .join('');
}

/* ==========================================================================
   PANEL 1: DB STATUS, CONNECTION POOL & CHAOS CONTROLS (VINTAGE BRASS & DIALS)
   ========================================================================== */

function renderDbStatusPanel(status) {
  if (!status) return;
  state.dbStatus = status;
  state.simulatedOffline = Boolean(status.simulatedOffline);
  state.artificialDelayMs = Number(status.artificialDelayMs || 0);

  const isOnline = Boolean(status.connected) && !state.simulatedOffline;
  dom.lastCheckedTimestamp.textContent = `Cập nhật: ${formatTimeShort(status.checkedAt || new Date().toISOString())}`;

  // Emergency Top Banner
  if (!isOnline) {
    dom.inspOfflineBanner.classList.remove('hidden');
    dom.inspOfflineReason.textContent =
      status.lastError ||
      'POSTGRESQL ĐANG OFFLINE — Mọi kết nối đã chuyển sang trạng thái cảnh báo sự cố!';
  } else {
    dom.inspOfflineBanner.classList.add('hidden');
  }

  // Card 1: PostgreSQL State
  if (isOnline) {
    dom.metricDbDot.className = 'w-3.5 h-3.5 rounded-full bg-[#3B5249] pulse-online border border-[#6BBF8C]';
    dom.metricDbState.className = 'text-xl font-extrabold font-playfair text-[#6BBF8C] tracking-wide';
    dom.metricDbState.textContent = 'ONLINE';
    const srv = status.server || {};
    const dbText = srv.databaseName || 'jalong_food_db';
    const sizeText = srv.databaseSize ? ` • ${srv.databaseSize}` : '';
    dom.metricDbSubtext.textContent = `${dbText}${sizeText}`;
    dom.serverMetaText.textContent = `${srv.version || 'PostgreSQL'} • ${dbText}${sizeText}`;
  } else {
    dom.metricDbDot.className = 'w-3.5 h-3.5 rounded-full bg-[#A63A2B] pulse-offline border border-[#E07A5F]';
    dom.metricDbState.className = 'text-xl font-extrabold font-playfair text-[#E07A5F] tracking-wide';
    dom.metricDbState.textContent = 'OFFLINE';
    dom.metricDbSubtext.textContent = status.simulatedOffline
      ? 'Đang bật chế độ Mô phỏng Ngắt DB'
      : status.lastError || 'Không thể kết nối PostgreSQL';
  }

  // Card 2: Latency
  dom.metricLatencyValue.textContent =
    status.latencyMs !== null && status.latencyMs !== undefined
      ? `${Number(status.latencyMs).toFixed(1)} ms`
      : '-- ms';
  dom.metricLatencyValue.className =
    state.artificialDelayMs >= 500
      ? 'text-2xl font-extrabold font-mono-code text-[#E5A93C]'
      : 'text-2xl font-extrabold font-mono-code text-[#E0C788]';

  dom.metricArtificialDelayBadge.textContent = `+${state.artificialDelayMs}ms giả lập`;
  dom.metricArtificialDelayBadge.className =
    state.artificialDelayMs > 0
      ? 'text-[11px] font-mono-code px-1.5 py-0.5 rounded bg-[#FAF3E0] text-[#8C6200] border border-[#DFC27D]'
      : 'text-[11px] font-mono-code px-1.5 py-0.5 rounded bg-[#35251C] text-[#D8CBB8] border border-[#5C4332]';

  // Card 3: Pool Metrics (Brass Pressure Gauge)
  const pool = status.pool || {};
  const total = pool.totalCount ?? 0;
  const idle = pool.idleCount ?? 0;
  const waiting = pool.waitingCount ?? 0;
  const max = pool.maxConnections ?? 10;

  dom.poolTotalVal.textContent = String(total);
  dom.poolIdleVal.textContent = String(idle);
  dom.poolWaitingVal.textContent = String(waiting);
  dom.poolMaxVal.textContent = String(max);
  dom.metricPoolRatio.textContent = `${total} / ${max} conns`;

  // Card 4: Realtime Stats
  const rt = status.realtime || {};
  const sseClients = rt.sse?.clients ?? rt.sse?.activeConnections ?? 0;
  const wsClients = rt.ws?.clients ?? rt.ws?.activeConnections ?? 0;
  const pgListening = Boolean(rt.pgListen?.connected);

  dom.rtSseCount.textContent = String(sseClients);
  dom.rtWsCount.textContent = String(wsClients);
  dom.rtPgListenState.textContent = pgListening ? 'ON' : 'OFF';
  dom.rtPgListenState.className = pgListening
    ? 'text-xs font-extrabold font-mono-code text-[#6BBF8C] leading-5'
    : 'text-xs font-extrabold font-mono-code text-[#E07A5F] leading-5';

  // Connection String Status
  if (status.maskedConnectionString) {
    dom.activeMaskedConnStr.textContent = status.maskedConnectionString;
  }
  if (status.isDefaultConnection) {
    dom.connSourceBadge.textContent = 'Mặc định (.env)';
    dom.connSourceBadge.className =
      'text-[10px] font-mono-code px-2 py-0.5 rounded bg-[#3B5249]/30 text-[#6BBF8C] border border-[#52886B]/60';
  } else {
    dom.connSourceBadge.textContent = 'Đang dùng Chuỗi Động (Custom)';
    dom.connSourceBadge.className =
      'text-[10px] font-mono-code px-2 py-0.5 rounded bg-[#FAF3E0] text-[#8C6200] border border-[#DFC27D]';
  }

  // Outage Toggle Button Appearance (Vintage Seal Switch)
  if (state.simulatedOffline) {
    dom.btnToggleDbOutage.className =
      'w-full py-2.5 px-3 rounded-xl vintage-seal-restore-btn text-xs font-bold flex items-center justify-center gap-2';
    dom.btnToggleDbOutageLabel.textContent = 'Đang Ngắt DB — Bấm để Kết nối Lại!';
  } else {
    dom.btnToggleDbOutage.className =
      'w-full py-2.5 px-3 rounded-xl vintage-seal-btn text-xs font-bold flex items-center justify-center gap-2';
    dom.btnToggleDbOutageLabel.textContent = 'Ngắt kết nối DB (Mô phỏng sự cố)';
  }

  // Latency Preset Buttons Appearance
  dom.simDelayLabel.textContent = `${state.artificialDelayMs}ms`;
  dom.delayPresetBtns.forEach((btn) => {
    const val = Number(btn.dataset.delay);
    btn.className =
      val === state.artificialDelayMs
        ? 'delay-preset-btn py-1 rounded-lg text-[11px] font-mono-code font-bold bg-[#A63A2B] text-[#FFFDF9] border border-[#C25443] transition'
        : 'delay-preset-btn py-1 rounded-lg text-[11px] font-mono-code font-semibold bg-[#2A1E17] text-[#FFFDF9] hover:bg-[#3B2C24] border border-[#6B584C] transition';
  });

  // Table Row Counts for Panel 4A Tabs
  if (status.tableCounts && typeof status.tableCounts === 'object') {
    state.tableCounts = { ...state.tableCounts, ...status.tableCounts };
    renderExplorerTabs();
  }

  // Seed recent SQL queries (oldest -> newest so newest ends up on top)
  if (Array.isArray(status.recentQueries) && state.seenQueryIds.size === 0) {
    const chronological = [...status.recentQueries].reverse();
    chronological.forEach((q) => recordQueryEntryToConsole(q));
  }
}

async function refreshDbStatus() {
  try {
    const status = await getDbStatus();
    renderDbStatusPanel(status);
    return status;
  } catch (err) {
    showToast('Không đọc được trạng thái DB', err?.message, 'error');
    return null;
  }
}

async function handleApplyCustomConnString() {
  const connStr = dom.connStringInput.value.trim();
  if (!connStr) {
    showToast(
      'Chưa nhập Connection String',
      'Hãy nhập chuỗi dạng postgresql://user:pass@host:5432/db hoặc bấm "Điền mẫu chuỗi kết nối sai để Test".',
      'warning'
    );
    dom.connStringInput.focus();
    return;
  }

  dom.btnApplyConnString.disabled = true;
  try {
    const status = await updateDbConfig({ connectionString: connStr, resetDefault: false });
    renderDbStatusPanel(status);

    if (status.connected) {
      showToast(
        'Đổi Connection String thành công!',
        `Pool mới đã kết nối tới: ${status.maskedConnectionString}`,
        'success'
      );
      await loadAllBusinessPanels();
    } else {
      showToast(
        'Pool mới không thể kết nối PostgreSQL!',
        status.lastError || 'Chuỗi kết nối không hợp lệ hoặc sai thông tin xác thực. Trang Khách hàng đã nhận cảnh báo Đỏ!',
        'error'
      );
    }
  } catch (err) {
    showToast('Lỗi cấu hình Connection String', err?.message, 'error');
  } finally {
    dom.btnApplyConnString.disabled = false;
  }
}

async function handleRestoreDefaultConnection() {
  try {
    // Restore both Simulation Offline flag (if active) and Default Connection String
    if (state.simulatedOffline || state.artificialDelayMs > 0) {
      await simulateDb({ offline: false, artificialDelayMs: 0 });
    }
    const status = await updateDbConfig({ resetDefault: true });
    dom.connStringInput.value = '';
    renderDbStatusPanel(status);

    showToast(
      'Đã khôi phục Kết nối Mặc định!',
      'Connection Pool & PG LISTEN đã hoạt động ổn định trở lại.',
      'success'
    );
    await loadAllBusinessPanels();
  } catch (err) {
    showToast('Lỗi khi khôi phục kết nối', err?.message, 'error');
  }
}

async function handleToggleDbOutage() {
  const nextOffline = !state.simulatedOffline;
  try {
    const status = await simulateDb({ offline: nextOffline });
    renderDbStatusPanel(status);

    if (nextOffline) {
      showToast(
        'Đã BẬT mô phỏng mất kết nối DB!',
        'Hãy quan sát Trang Khách hàng chuyển sang Banner Cảnh báo Đỏ ngay lập tức.',
        'warning'
      );
    } else {
      showToast(
        'Đã TẮT mô phỏng sự cố — DB Online!',
        'Toàn bộ phiên Khách hàng đã tự động khôi phục trạng thái Xanh.',
        'success'
      );
      await loadAllBusinessPanels();
    }
  } catch (err) {
    showToast('Không thể đổi chế độ mô phỏng', err?.message, 'error');
  }
}

async function handleSetDelayMs(delayMs) {
  try {
    const status = await simulateDb({ artificialDelayMs: Number(delayMs) });
    renderDbStatusPanel(status);
    showToast(
      `Độ trễ mạng giả lập: ${delayMs}ms`,
      delayMs > 0
        ? `Mỗi câu lệnh SQL qua Pool sẽ bị trễ thêm ${delayMs}ms.`
        : 'Đã tắt độ trễ mạng giả lập (tốc độ thực tế).',
      'info'
    );
  } catch (err) {
    showToast('Lỗi chỉnh độ trễ', err?.message, 'error');
  }
}

/* ==========================================================================
   PANEL 2: VISUAL MENU CRUD (`foods`) & 3NF FK `23503` (VINTAGE LEDGER TABLE)
   ========================================================================== */

function populateFoodCategorySelectors() {
  const filterOptions = [
    `<option value="">Tất cả danh mục (${state.categories.length})</option>`,
    ...state.categories.map(
      (c) => `<option value="${c.id}">${escapeHtml(c.name)} (#${c.id})</option>`
    ),
  ];
  dom.inspFoodCategoryFilter.innerHTML = filterOptions.join('');
  dom.inspFoodCategoryFilter.value = state.foodCategoryFilter;

  dom.foodFormCategory.innerHTML = state.categories
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('');
}

function renderFoodsCrudTable(highlightId = null) {
  const q = state.foodSearch.trim().toLowerCase();
  const filtered = state.foods.filter((f) => {
    if (state.foodCategoryFilter && Number(f.category_id) !== Number(state.foodCategoryFilter)) {
      return false;
    }
    if (q) {
      const hay = `${f.name || ''} ${f.category_name || ''} #${f.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    dom.inspFoodsTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center text-[#8C6D46] italic">Không có món ăn nào khớp bộ lọc.</td>
      </tr>
    `;
    return;
  }

  dom.inspFoodsTableBody.innerHTML = filtered
    .map((food) => {
      const refCount = Number(food.order_item_count || 0);
      const isAvail = Boolean(food.is_available);
      const stock = Number(food.stock_quantity ?? 0);
      const thumb = escapeHtml(food.image_url || FALLBACK_THUMB);

      const refBadge =
        refCount > 0
          ? `<span class="badge-vintage-mustard" title="Món này đang được tham chiếu bởi ${refCount} dòng trong bảng order_items">🔗 ${refCount} đơn (FK)</span>`
          : `<span class="badge-vintage-parchment" title="Món chưa có đơn hàng, có thể xóa cứng">0 đơn</span>`;

      return `
        <tr id="insp-food-row-${food.id}">
          <td class="py-2.5 px-3 font-mono-code font-bold text-[#8C6D46]">#${food.id}</td>
          <td class="py-2.5 px-3">
            <div class="flex items-center gap-2.5">
              <img src="${thumb}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_THUMB}';" class="w-9 h-9 rounded-lg object-cover border border-[#D8CBB8] shrink-0 shadow-sm" />
              <div class="min-w-0">
                <div class="font-bold text-[#2C1E16] truncate max-w-[210px]">${escapeHtml(food.name)}</div>
                <div class="mt-0.5">${refBadge}</div>
              </div>
            </div>
          </td>
          <td class="py-2.5 px-3">
            <span class="badge-vintage-parchment">
              ${escapeHtml(food.category_name || `Cat #${food.category_id}`)}
            </span>
          </td>
          <td class="py-2.5 px-3 text-right font-mono-code font-bold text-[#8B2500] whitespace-nowrap">
            ${formatVND(food.price)}
          </td>
          <td class="py-2.5 px-3 text-center">
            <div class="inline-flex items-center gap-1.5 bg-[#FAF6F0] border border-[#D8CBB8] rounded-lg px-2 py-0.5 shadow-inner">
              <span class="font-mono-code font-bold ${stock <= 5 ? 'text-[#8C6200]' : 'text-[#2D4A3E]'}">${stock}</span>
              <button type="button" data-quick-stock="${food.id}" class="text-[10px] px-1.5 py-0.5 rounded bg-[#EFE8DA] hover:bg-[#C5A059] text-[#2C1E16] hover:text-[#1F150F] font-bold transition" title="Cộng thêm +10 tồn kho nhanh">+10</button>
            </div>
          </td>
          <td class="py-2.5 px-3 text-center">
            ${
              isAvail
                ? `<span class="badge-vintage-moss">Đang bán</span>`
                : `<span class="badge-vintage-brick">Ngừng bán</span>`
            }
          </td>
          <td class="py-2 px-2.5 text-right whitespace-nowrap">
            <div class="inline-flex items-center justify-end gap-1">
              <button
                type="button"
                data-edit-food="${food.id}"
                class="px-2 py-1 rounded bg-[#3A2A1E] hover:bg-[#4A3528] border border-[#5C4332] text-[#E0C788] hover:text-[#FFFDF9] text-[11px] font-semibold transition"
                title="Sửa thông tin món ăn"
              >
                Sửa
              </button>
              ${
                isAvail
                  ? `
                    <button
                      type="button"
                      data-soft-del-food="${food.id}"
                      class="px-2 py-1 rounded badge-vintage-mustard text-[11px] font-semibold hover:brightness-95 transition"
                      title="Soft Delete (?mode=soft): Đặt is_available = false an toàn chuẩn 3NF"
                    >
                      Ngừng bán
                    </button>
                  `
                  : `
                    <button
                      type="button"
                      data-reopen-food="${food.id}"
                      class="px-2 py-1 rounded badge-vintage-moss text-[11px] font-semibold hover:brightness-95 transition"
                      title="Mở bán lại món ăn"
                    >
                      Mở bán
                    </button>
                  `
              }
              <button
                type="button"
                data-hard-del-food="${food.id}"
                class="px-2 py-1 rounded badge-vintage-brick text-[11px] font-bold hover:brightness-95 transition"
                title="DELETE /api/foods/:id: Kiểm chứng Khóa ngoại ON DELETE RESTRICT (SQLSTATE 23503)"
              >
                Xóa cứng
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  // Bind Row Actions
  dom.inspFoodsTableBody.querySelectorAll('[data-edit-food]').forEach((btn) => {
    btn.addEventListener('click', () => openFoodModal(Number(btn.dataset.editFood)));
  });

  dom.inspFoodsTableBody.querySelectorAll('[data-quick-stock]').forEach((btn) => {
    btn.addEventListener('click', () => handleQuickAddStock(Number(btn.dataset.quickStock), 10));
  });

  dom.inspFoodsTableBody.querySelectorAll('[data-soft-del-food]').forEach((btn) => {
    btn.addEventListener('click', () => handleSoftDeleteFood(Number(btn.dataset.softDelFood)));
  });

  dom.inspFoodsTableBody.querySelectorAll('[data-reopen-food]').forEach((btn) => {
    btn.addEventListener('click', () => handleReopenFood(Number(btn.dataset.reopenFood)));
  });

  dom.inspFoodsTableBody.querySelectorAll('[data-hard-del-food]').forEach((btn) => {
    btn.addEventListener('click', () => handleHardDeleteFoodTestFk(Number(btn.dataset.hardDelFood)));
  });

  if (highlightId) {
    const row = document.getElementById(`insp-food-row-${highlightId}`);
    if (row) {
      row.classList.remove('live-flash-row');
      void row.offsetWidth;
      row.classList.add('live-flash-row');
    }
  }
}

function openFoodModal(foodId = null) {
  const existing = foodId ? state.foods.find((f) => Number(f.id) === Number(foodId)) : null;

  if (existing) {
    dom.foodModalTitle.innerHTML = `<i data-lucide="pencil" class="w-4 h-4 text-[#C5A059]"></i><span>Cập nhật Món #${existing.id}: ${escapeHtml(existing.name)}</span>`;
    dom.foodFormId.value = String(existing.id);
    dom.foodFormName.value = existing.name || '';
    dom.foodFormCategory.value = String(existing.category_id);
    dom.foodFormPrice.value = String(Math.round(Number(existing.price || 0)));
    dom.foodFormStock.value = String(existing.stock_quantity ?? 0);
    dom.foodFormAvailable.value = existing.is_available ? 'true' : 'false';
    dom.foodFormImage.value = existing.image_url || '';
    dom.foodFormDesc.value = existing.description || '';
  } else {
    dom.foodModalTitle.innerHTML = `<i data-lucide="plus-circle" class="w-4 h-4 text-[#C5A059]"></i><span>Thêm Món Ăn Mới (CALL sp_upsert_food)</span>`;
    dom.foodFormId.value = '';
    dom.foodFormName.value = '';
    if (state.categories[0]) {
      dom.foodFormCategory.value = String(state.categories[0].id);
    }
    dom.foodFormPrice.value = '45000';
    dom.foodFormStock.value = '30';
    dom.foodFormAvailable.value = 'true';
    dom.foodFormImage.value = SAMPLE_FOOD_IMAGES[state.sampleImgIdx % SAMPLE_FOOD_IMAGES.length];
    dom.foodFormDesc.value = 'Món mới thêm trực tiếp từ DB Live Inspector để kiểm chứng đồng bộ Real-time.';
  }

  dom.foodModalBackdrop.classList.remove('hidden');
  refreshIcons();
  dom.foodFormName.focus();
}

function closeFoodModal() {
  dom.foodModalBackdrop.classList.add('hidden');
}

async function handleFoodFormSubmit(evt) {
  evt.preventDefault();
  const idVal = dom.foodFormId.value.trim();
  const payload = {
    category_id: Number(dom.foodFormCategory.value),
    name: dom.foodFormName.value.trim(),
    price: Number(dom.foodFormPrice.value),
    stock_quantity: Number(dom.foodFormStock.value),
    is_available: dom.foodFormAvailable.value === 'true',
    image_url: dom.foodFormImage.value.trim(),
    description: dom.foodFormDesc.value.trim(),
  };

  try {
    let saved;
    if (idVal) {
      saved = await updateFood(Number(idVal), payload);
      showToast(
        `Đã cập nhật món "${saved?.name || payload.name}"!`,
        'Trang Khách hàng đã tự động nhận giá/tồn kho mới qua SSE/WS.',
        'success'
      );
    } else {
      saved = await createFood(payload);
      showToast(
        `Đã thêm món mới "${saved?.name || payload.name}" (#${saved?.id})!`,
        'Món ăn vừa xuất hiện ngay trên Thực đơn Khách hàng không cần F5.',
        'success'
      );
    }
    closeFoodModal();
    await loadFoodsData(saved?.id);
    await refreshDbStatus();
  } catch (err) {
    showToast(`Lỗi lưu món ăn${err?.code ? ` [${err.code}]` : ''}`, err?.message, 'error');
  }
}

async function handleQuickAddStock(foodId, delta) {
  const food = state.foods.find((f) => Number(f.id) === Number(foodId));
  if (!food) return;
  try {
    const nextStock = Math.max(0, Number(food.stock_quantity || 0) + delta);
    await updateFood(foodId, {
      ...food,
      stock_quantity: nextStock,
    });
    showToast(`Đã cộng tồn kho "${food.name}" → ${nextStock} phần`, 'Thực đơn Khách hàng đã cập nhật tức thì.', 'success');
    await loadFoodsData(foodId);
  } catch (err) {
    showToast('Không thể cập nhật tồn kho', err?.message, 'error');
  }
}

async function handleSoftDeleteFood(foodId) {
  const food = state.foods.find((f) => Number(f.id) === Number(foodId));
  try {
    await deleteFood(foodId, 'soft');
    showToast(
      `Đã ngừng bán "${food?.name || `#${foodId}`}" (Soft Delete)`,
      'is_available = FALSE • Bảo toàn 100% lịch sử hóa đơn trong bảng order_items.',
      'warning'
    );
    await loadFoodsData(foodId);
  } catch (err) {
    showToast('Lỗi ngừng bán món ăn', err?.message, 'error');
  }
}

async function handleReopenFood(foodId) {
  const food = state.foods.find((f) => Number(f.id) === Number(foodId));
  if (!food) return;
  try {
    await updateFood(foodId, {
      ...food,
      is_available: true,
      stock_quantity: Math.max(10, Number(food.stock_quantity || 0)),
    });
    showToast(`Đã mở bán lại "${food.name}"!`, 'Khách hàng đã có thể đặt lại món này ngay.', 'success');
    await loadFoodsData(foodId);
  } catch (err) {
    showToast('Lỗi mở bán lại', err?.message, 'error');
  }
}

async function handleHardDeleteFoodTestFk(foodId) {
  const food = state.foods.find((f) => Number(f.id) === Number(foodId));
  try {
    await deleteFood(foodId, 'hard');
    showToast(
      `Đã xóa cứng vĩnh viễn món "${food?.name || `#${foodId}`}"!`,
      'Món này chưa có dòng tham chiếu nào trong order_items nên PostgreSQL cho phép DELETE.',
      'success'
    );
    await loadFoodsData();
    await refreshDbStatus();
  } catch (err) {
    if (String(err?.code) === '23503' || err?.status === 409) {
      // Open Educational 3NF Foreign Key Violation Dialog!
      state.pendingFkFood = food || { id: foodId, name: `Món #${foodId}` };
      dom.fkModalFoodName.textContent = `${state.pendingFkFood.name} (ID=${foodId})`;
      dom.fkModalRawError.textContent = `ERROR [SQLSTATE ${err.code || '23503'}]: ${err.message}`;
      dom.fkModalDetail.textContent =
        err.detail ||
        `Key (id)=(${foodId}) is still referenced from table "order_items" (constraint: ${err.constraint || 'fk_order_items_food'}).`;
      dom.fkErrorModalBackdrop.classList.remove('hidden');
      refreshIcons();

      recordSystemToConsole(
        `[SQLSTATE 23503] Chặn xóa cứng món "${state.pendingFkFood.name}" (ON DELETE RESTRICT)`,
        err.message,
        true
      );
    } else {
      showToast(`Lỗi xóa món ăn${err?.code ? ` [${err.code}]` : ''}`, err?.message, 'error');
    }
  }
}

function closeFkModal() {
  dom.fkErrorModalBackdrop.classList.add('hidden');
  state.pendingFkFood = null;
}

/* ==========================================================================
   PANEL 3: ORDER DISPATCH, FSM GUARD & `trg_order_status_audit` VERIFICATION
   ========================================================================== */

function populateDispatchActors() {
  if (dom.dispatchActorSelect) {
    if (dom.dispatchActorSelect.tagName === 'SELECT') {
      dom.dispatchActorSelect.innerHTML = `<option value="2" selected>👑 Người duyệt: Trần Quản Trị (Admin)</option>`;
    } else {
      dom.dispatchActorSelect.value = '2';
    }
  }
}

function renderOrdersDispatchList(highlightOrderId = null) {
  const filtered = state.orders.filter((o) => {
    if (state.orderStatusFilter && o.status !== state.orderStatusFilter) return false;
    return true;
  });

  dom.inspOrdersCountBadge.textContent = `${filtered.length} / ${state.orders.length} đơn`;

  if (!filtered.length) {
    dom.inspOrdersList.innerHTML = `
      <div class="vintage-order-dossier p-8 text-center text-xs text-[#8C6D46] italic">
        Không có đơn hàng nào khớp trạng thái đang chọn.
      </div>
    `;
    return;
  }

  dom.inspOrdersList.innerHTML = filtered
    .map((order) => {
      const badgeCls = ORDER_STATUS_STYLES[order.status] || ORDER_STATUS_STYLES.Pending;
      const nextStep = NEXT_VALID_STATUS[order.status];
      const invalidTarget = INVALID_TEST_STATUS[order.status] || 'Pending';
      const canCancel = order.status !== 'Completed' && order.status !== 'Cancelled';
      const isSelectedAudit = Number(state.selectedAuditOrderId) === Number(order.id);

      const itemsSummary = Array.isArray(order.items) && order.items.length
        ? order.items.map((it) => `${it.quantity}x ${it.food_name || it.name}`).join(', ')
        : `${order.item_count || 0} phần ăn`;

      return `
        <article
          id="insp-order-card-${order.id}"
          class="vintage-order-dossier ${isSelectedAudit ? 'audit-selected' : ''} space-y-3"
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono-code font-extrabold text-sm text-[#2C1E16]">#ORD-${order.id}</span>
                <span class="text-[11px] ${badgeCls}">
                  ${escapeHtml(order.status)}
                </span>
                <span class="text-xs font-bold text-[#4A3528]">
                  👤 ${escapeHtml(order.customer_name || `User #${order.user_id}`)}
                </span>
              </div>
              <p class="text-[11px] text-[#6E533F] mt-1">
                📍 ${escapeHtml(order.delivery_address || '---')} • 🕒 ${escapeHtml(formatDateTime(order.created_at))}
              </p>
              <p class="text-[11px] text-[#8B2500] font-medium mt-0.5 line-clamp-1">
                🍜 ${escapeHtml(itemsSummary)}
              </p>
            </div>

            <div class="text-right">
              <div class="text-base font-extrabold font-mono-code text-[#8B2500]">${formatVND(order.total_amount)}</div>
              <button
                type="button"
                data-filter-audit="${order.id}"
                class="mt-1 text-[11px] text-[#8C6D46] hover:text-[#5C4332] underline font-semibold"
              >
                Soi lịch sử Trigger (${Array.isArray(order.history) ? order.history.length : '?'})
              </button>
            </div>
          </div>

          <!-- 1-Touch FSM Transition & Proof Controls -->
          <div class="pt-2.5 border-t border-[#D8CBB8] flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              ${
                nextStep
                  ? `
                    <button
                      type="button"
                      data-order-next="${order.id}"
                      data-target-status="${nextStep.status}"
                      class="px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm transition ${nextStep.cls}"
                    >
                      ⚡ ${escapeHtml(nextStep.label)}
                    </button>
                  `
                  : `<span class="text-[11px] text-[#8C6D46] italic">Đơn đã hoàn tất vòng đời FSM</span>`
              }

              ${
                canCancel
                  ? `
                    <button
                      type="button"
                      data-order-cancel="${order.id}"
                      class="px-2.5 py-1.5 rounded-lg badge-vintage-brick text-xs font-semibold hover:brightness-95 transition"
                      title="Hủy đơn hàng (tự động hoàn lại tồn kho nếu đang ở Pending hoặc Preparing)"
                    >
                      Hủy đơn
                    </button>
                  `
                  : ''
              }
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-order-invalid-fsm="${order.id}"
                data-invalid-target="${invalidTarget}"
                class="px-2.5 py-1 rounded-lg border border-[#DFC27D] bg-[#FAF3E0] text-[#8C6200] text-[11px] font-semibold hover:bg-[#F2E6C4] transition"
                title="Cố tình chuyển sai quy trình (${order.status} -> ${invalidTarget}) để kiểm chứng Stored Procedure sp_update_order_status chặn lỗi P0001!"
              >
                Test Sai Quy trình (${order.status}→${invalidTarget})
              </button>

              <button
                type="button"
                data-order-cascade-del="${order.id}"
                class="px-2.5 py-1 rounded-lg border border-[#DB988F] bg-[#FBECEB] text-[#8B2500] hover:bg-[#A63A2B] hover:text-[#FFFDF9] text-[11px] font-semibold transition"
                title="Xóa đơn hàng để chứng minh ON DELETE CASCADE tự xóa sạch order_items & order_status_history"
              >
                Xóa (CASCADE)
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  // Bind Order Actions
  dom.inspOrdersList.querySelectorAll('[data-order-next]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleTransitionOrder(Number(btn.dataset.orderNext), btn.dataset.targetStatus, false)
    );
  });

  dom.inspOrdersList.querySelectorAll('[data-order-cancel]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleTransitionOrder(
        Number(btn.dataset.orderCancel),
        'Cancelled',
        false,
        'Giảng viên hủy đơn kiểm thử (hoàn tồn kho tự động)'
      )
    );
  });

  dom.inspOrdersList.querySelectorAll('[data-order-invalid-fsm]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleTransitionOrder(
        Number(btn.dataset.orderInvalidFsm),
        btn.dataset.invalidTarget,
        true
      )
    );
  });

  dom.inspOrdersList.querySelectorAll('[data-order-cascade-del]').forEach((btn) => {
    btn.addEventListener('click', () => handleCascadeDeleteOrder(Number(btn.dataset.orderCascadeDel)));
  });

  dom.inspOrdersList.querySelectorAll('[data-filter-audit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedAuditOrderId = Number(btn.dataset.filterAudit);
      renderOrdersDispatchList();
      renderAuditHistoryTable(true);
    });
  });

  if (highlightOrderId) {
    const card = document.getElementById(`insp-order-card-${highlightOrderId}`);
    if (card) {
      card.classList.remove('live-flash-row');
      void card.offsetWidth;
      card.classList.add('live-flash-row');
    }
  }
}

async function handleTransitionOrder(orderId, targetStatus, isInvalidTest = false, defaultNote = '') {
  const actorId = 2; // Cố định duy nhất 1 Admin (Trần Quản Trị ID=2) duyệt đơn
  const customNote = dom.dispatchNoteInput.value.trim() || defaultNote || `Admin duyệt chuyển sang ${targetStatus}`;

  try {
    await updateOrderStatus(orderId, {
      status: targetStatus,
      changed_by: actorId,
      note: customNote,
      force: false,
    });

    dom.dispatchNoteInput.value = '';
    showToast(
      `Đơn #${orderId} → ${targetStatus} thành công!`,
      'Trigger trg_order_status_audit đã tự động sinh dòng mới trong order_status_history & đẩy về màn hình Khách.',
      'success'
    );

    await Promise.all([
      loadOrdersAndAuditData(orderId),
      targetStatus === 'Cancelled' ? loadFoodsData() : Promise.resolve(),
      refreshDbStatus(),
    ]);
  } catch (err) {
    if (isInvalidTest) {
      showToast(
        `Stored Procedure Đã Chặn Đúng Quy Tắc! [${err?.code || 'P0001'}]`,
        err?.message || 'Chuyển trạng thái sai quy trình FSM đã bị chặn ngay ở tầng PostgreSQL.',
        'warning'
      );
      recordSystemToConsole(
        `[FSM GUARD - SQLSTATE ${err?.code || 'P0001'}] sp_update_order_status chặn chuyển sai quy trình`,
        err?.message,
        true
      );
    } else {
      showToast(`Không thể đổi trạng thái [${err?.code || 'ERR'}]`, err?.message, 'error');
    }
  }
}

async function handleCascadeDeleteOrder(orderId) {
  try {
    const res = await deleteOrder(orderId);
    const itemsCnt = res?.cascadedOrderItems ?? '?';
    const histCnt = res?.cascadedStatusHistory ?? '?';

    if (Number(state.selectedAuditOrderId) === Number(orderId)) {
      state.selectedAuditOrderId = null;
    }

    showToast(
      `Đã xóa Đơn #${orderId} (ON DELETE CASCADE)!`,
      `PostgreSQL tự động xóa dây chuyền ${itemsCnt} dòng order_items & ${histCnt} dòng order_status_history.`,
      'success'
    );
    recordSystemToConsole(
      `[ON DELETE CASCADE] DELETE FROM orders WHERE id = ${orderId}`,
      `Tự động dọn sạch ${itemsCnt} bản ghi con trong order_items và ${histCnt} bản ghi con trong order_status_history.`
    );

    await Promise.all([loadOrdersAndAuditData(), loadExplorerTable(), refreshDbStatus()]);
  } catch (err) {
    showToast('Lỗi xóa đơn hàng', err?.message, 'error');
  }
}

function renderAuditHistoryTable(flashTopRow = false) {
  let rows = [...state.auditHistoryRows];
  if (state.selectedAuditOrderId) {
    rows = rows.filter((r) => Number(r.order_id) === Number(state.selectedAuditOrderId));
    dom.auditFilterLabel.textContent = `Đang lọc riêng lịch sử Trigger của Đơn #ORD-${state.selectedAuditOrderId}`;
    dom.btnShowAllAudit.classList.remove('hidden');
  } else {
    dom.auditFilterLabel.textContent = 'Đang hiển thị lịch sử kiểm toán mới nhất toàn hệ thống';
    dom.btnShowAllAudit.classList.add('hidden');
  }

  if (!rows.length) {
    dom.inspAuditHistoryBody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-[#8C6D46] italic">Chưa có dòng kiểm toán trạng thái nào.</td>
      </tr>
    `;
    return;
  }

  dom.inspAuditHistoryBody.innerHTML = rows
    .slice(0, 40)
    .map((h, idx) => {
      const userObj = h.changed_by
        ? state.users.find((u) => Number(u.id) === Number(h.changed_by))
        : null;
      const actor = h.changed_by_name || userObj?.full_name || (h.changed_by ? `User #${h.changed_by}` : 'System');
      const flashCls = flashTopRow && idx === 0 ? 'live-flash-row' : '';

      return `
        <tr class="${flashCls}">
          <td class="py-2 px-2 font-mono-code text-[#8C6D46]">#${h.id}</td>
          <td class="py-2 px-2 font-mono-code font-bold text-[#2C1E16]">#${h.order_id}</td>
          <td class="py-2 px-2 whitespace-nowrap">
            <span class="badge-vintage-parchment font-mono-code">${escapeHtml(h.old_status || 'NULL')}</span>
            <span class="text-[#8C6D46] mx-0.5 font-bold">→</span>
            <span class="badge-vintage-moss font-mono-code font-bold">${escapeHtml(h.new_status)}</span>
          </td>
          <td class="py-2 px-2">
            <div class="text-[11px] font-bold text-[#2C1E16]">${escapeHtml(actor)}</div>
            ${h.note ? `<div class="text-[10px] text-[#6E533F] truncate max-w-[180px]" title="${escapeHtml(h.note)}">"${escapeHtml(h.note)}"</div>` : ''}
          </td>
          <td class="py-2 px-2 text-right font-mono-code text-[10px] text-[#8C6D46] whitespace-nowrap">
            ${escapeHtml(formatTimeShort(h.changed_at))}
          </td>
        </tr>
      `;
    })
    .join('');
}

/* ==========================================================================
   PANEL 4A: LIVE 6-TABLE 3NF + VIEW EXPLORER (VINTAGE LEDGER TABLES)
   ========================================================================== */

function renderExplorerTabs() {
  dom.tableTabsContainer.innerHTML = EXPLORER_RELATIONS.map((rel) => {
    const isActive = state.activeExplorerTable === rel.name;
    const countVal =
      rel.name === 'vw_orders_summary'
        ? state.tableCounts.orders
        : state.tableCounts[rel.name];
    const countBadge =
      countVal !== undefined && countVal !== null ? `${countVal}` : '•';

    const cls = isActive
      ? 'bg-[#A63A2B] text-[#FFFDF9] border border-[#8C2E21] shadow-sm font-bold'
      : 'bg-[#EFE8DA] hover:bg-[#E5DCCB] text-[#2C1E16] border border-[#D8CBB8] font-semibold';

    return `
      <button
        type="button"
        data-explorer-tab="${rel.name}"
        class="px-3 py-1.5 rounded-xl border text-xs font-mono-code flex items-center gap-1.5 transition ${cls}"
      >
        <span>${escapeHtml(rel.label)}</span>
        <span class="px-1.5 py-0.2 rounded-full text-[10px] ${isActive ? 'bg-[#1F150F]/20 text-[#1F150F]' : 'bg-[#17100B] text-[#C5A059]'}">${countBadge}</span>
      </button>
    `;
  }).join('');

  dom.tableTabsContainer.querySelectorAll('[data-explorer-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeExplorerTable = btn.dataset.explorerTab;
      renderExplorerTabs();
      loadExplorerTable();
    });
  });
}

function formatCellValue(colName, val) {
  if (val === null || val === undefined) {
    return `<span class="text-[#8C6D46] italic">NULL</span>`;
  }
  if (typeof val === 'boolean') {
    return val
      ? `<span class="text-[#2D4A3E] font-bold">TRUE</span>`
      : `<span class="text-[#8B2500] font-bold">FALSE</span>`;
  }
  if (colName.endsWith('_at') || colName === 'server_time') {
    return `<span class="text-[#5C4332] whitespace-nowrap">${escapeHtml(formatDateTime(val))}</span>`;
  }
  if (colName === 'price' || colName === 'unit_price' || colName === 'total_amount') {
    return `<span class="text-[#8B2500] font-bold whitespace-nowrap">${formatVND(val)}</span>`;
  }
  if (typeof val === 'object') {
    return `<span class="text-[#8C6200] font-mono-code">${escapeHtml(JSON.stringify(val))}</span>`;
  }
  const str = String(val);
  if (str.length > 58) {
    return `<span title="${escapeHtml(str)}">${escapeHtml(str.slice(0, 55))}…</span>`;
  }
  return escapeHtml(str);
}

async function loadExplorerTable() {
  const relMeta =
    EXPLORER_RELATIONS.find((r) => r.name === state.activeExplorerTable) || EXPLORER_RELATIONS[0];
  dom.tableSchemaDesc.textContent = relMeta.schemaNote;

  try {
    const data = await getTableData(state.activeExplorerTable, { limit: state.explorerLimit });
    state.tableCounts[state.activeExplorerTable] = data.rowCount;
    renderExplorerTabs();

    dom.tableRowSummary.textContent = `Hiển thị ${data.rows.length} / Tổng ${data.rowCount} bản ghi`;

    const cols = data.columns.length
      ? data.columns
      : data.rows[0]
        ? Object.keys(data.rows[0])
        : [];

    dom.explorerTableHead.innerHTML = cols.length
      ? `<tr>${cols.map((c) => `<th class="py-2.5 px-3 font-bold text-[11px] whitespace-nowrap">${escapeHtml(c)}</th>`).join('')}</tr>`
      : '';

    if (!data.rows.length) {
      dom.explorerTableBody.innerHTML = `<tr><td colspan="${Math.max(1, cols.length)}" class="p-6 text-center text-[#8C6D46] italic">Bảng hiện chưa có bản ghi nào (0 rows).</td></tr>`;
      return;
    }

    dom.explorerTableBody.innerHTML = data.rows
      .map(
        (row) =>
          `<tr>${cols
            .map((col) => `<td class="py-2 px-3 align-top font-mono-code">${formatCellValue(col, row[col])}</td>`)
            .join('')}</tr>`
      )
      .join('');
  } catch (err) {
    dom.explorerTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="p-6 text-center text-[#E07A5F]">
          Không thể truy vấn bảng "${escapeHtml(state.activeExplorerTable)}": ${escapeHtml(err?.message || 'DB Offline')}
        </td>
      </tr>
    `;
  }
}

/* ==========================================================================
   DATA LOADERS & REAL-TIME EVENT WIRING
   ========================================================================== */

async function loadFoodsData(highlightId = null) {
  const foods = await getFoods({ include_unavailable: 'true' });
  state.foods = foods;
  renderFoodsCrudTable(highlightId);
}

async function loadOrdersAndAuditData(highlightOrderId = null) {
  const [orders, historyTable] = await Promise.all([
    getOrders({ limit: 80 }),
    getTableData('order_status_history', { limit: 60 }),
  ]);

  state.orders = orders;
  state.auditHistoryRows = historyTable.rows || [];

  renderOrdersDispatchList(highlightOrderId);
  renderAuditHistoryTable(Boolean(highlightOrderId));
}

async function loadAllBusinessPanels() {
  try {
    const [categories, users] = await Promise.all([getCategories(), getUsers()]);
    state.categories = categories;
    state.users = users;
    populateFoodCategorySelectors();
    populateDispatchActors();

    await Promise.all([
      loadFoodsData(),
      loadOrdersAndAuditData(),
      loadExplorerTable(),
      handleLoadRevenueReport().catch(() => {}),
      handleRunOrderTotal().catch(() => {}),
      handleRunCustomerTier().catch(() => {}),
    ]);
  } catch (_err) {
    // Individual panels handle offline states gracefully
  }
}

let syncDebounce = null;
function scheduleLivePanelRefresh({ foodId = null, orderId = null } = {}) {
  if (syncDebounce) clearTimeout(syncDebounce);
  syncDebounce = setTimeout(async () => {
    await Promise.all([
      loadFoodsData(foodId).catch(() => {}),
      loadOrdersAndAuditData(orderId).catch(() => {}),
      loadExplorerTable().catch(() => {}),
      refreshDbStatus().catch(() => {}),
    ]);
  }, 200);
}

function initRealtimeInspectorStream() {
  realtimeClient = createRealtimeClient({ transport: 'sse' });

  realtimeClient.onStatusChange((snap) => {
    state.transport = snap.transport;
    const upper = String(snap.transport || 'sse').toUpperCase();
    dom.metricActiveClientTransport.textContent = `Client: ${upper} (${snap.state})`;
    dom.btnToggleTransportLabel.textContent =
      snap.transport === 'sse' ? 'Đang dùng SSE → Chuyển WS' : 'Đang dùng WS → Chuyển SSE';
  });

  // Live SQL Stream (`db:query_logged`)
  realtimeClient.on('db:query_logged', (envelope) => {
    const q = envelope?.data || envelope;
    // Skip noisy background status count queries from flooding lecturer console if desired, or show all real queries
    if (q?.sql && q.sql === 'SELECT 1 AS ok') return;
    recordQueryEntryToConsole(q);
  });

  // Live PostgreSQL Trigger NOTIFY Stream (`db:trigger_fired`)
  realtimeClient.on('db:trigger_fired', (envelope) => {
    const payload = envelope?.data || envelope;
    recordTriggerToConsole(payload, envelope?.timestamp);
  });

  // Constraint Violation Telemetry (`23503`)
  realtimeClient.on('db:constraint_violated', (envelope) => {
    const data = envelope?.data || envelope;
    recordSystemToConsole(
      `Vi phạm Ràng buộc Khóa ngoại 3NF [SQLSTATE ${data?.sqlState || '23503'}]`,
      data?.message,
      true
    );
  });

  // Food & Order Domain Sync
  realtimeClient.on('food:created', (env) => {
    const id = env?.data?.id ?? env?.data?.record_id ?? null;
    scheduleLivePanelRefresh({ foodId: id });
  });
  realtimeClient.on('food:updated', (env) => {
    const id = env?.data?.id ?? env?.data?.record_id ?? null;
    scheduleLivePanelRefresh({ foodId: id });
  });
  realtimeClient.on('food:deleted', () => scheduleLivePanelRefresh());

  realtimeClient.on('order:created', (env) => {
    const id = env?.data?.id ?? env?.data?.record_id ?? null;
    showToast(
      `Đơn hàng mới #${id || ''} vừa được Khách đặt!`,
      'Stored Procedure sp_create_order vừa trừ kho & bắn Trigger kiểm toán.',
      'info'
    );
    scheduleLivePanelRefresh({ orderId: id });
  });
  realtimeClient.on('order:status_updated', (env) => {
    const id = env?.data?.id ?? env?.data?.record_id ?? env?.data?.data?.order_id ?? null;
    scheduleLivePanelRefresh({ orderId: id });
  });
  realtimeClient.on('order:deleted', () => scheduleLivePanelRefresh());

  // DB Config / Simulation / Listener Changes
  realtimeClient.on('db:config_changed', (env) => {
    recordSystemToConsole(
      'Thay đổi Connection String Động',
      `Pool đang trỏ tới: ${env?.data?.maskedConnectionString || '---'}`
    );
    refreshDbStatus();
  });
  realtimeClient.on('db:simulation_changed', (env) => {
    const d = env?.data || {};
    recordSystemToConsole(
      `Chaos Simulation: offline=${Boolean(d.offline)} • delay=${d.artificialDelayMs ?? 0}ms`,
      null,
      Boolean(d.offline)
    );
    refreshDbStatus();
  });
  realtimeClient.on('db:listener_changed', () => refreshDbStatus());

  // Periodic Pool & Latency Telemetry Poll
  setInterval(refreshDbStatus, 7000);
}

/* ==========================================================================
   BIND UI EVENTS & STARTUP
   ========================================================================== */


/* ==========================================================================
   PANEL 5: USER-DEFINED FUNCTIONS (`FUNCTION`) LAB HANDLERS
   ========================================================================== */

async function handleRunOrderTotal() {
  const input = dom.udfOrderIdInput;
  const rawId = input ? input.value.trim() : '1';
  const orderId = parseInt(rawId, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    showToast('Lỗi nhập liệu', 'Vui lòng nhập Mã đơn hàng hợp lệ (> 0).', 'warning');
    return;
  }

  if (dom.btnRunOrderTotal) {
    dom.btnRunOrderTotal.disabled = true;
    dom.btnRunOrderTotal.classList.add('opacity-70');
  }

  try {
    const data = await calculateOrderTotal(orderId);
    const total = Number(data.order_total || 0);

    if (dom.udfOrderTotalValue) {
      dom.udfOrderTotalValue.textContent = formatVND(total);
    }
    if (dom.udfOrderDiscountNote) {
      dom.udfOrderDiscountNote.textContent = `Đơn hàng #${orderId} • Tính từ order_items (Chuẩn 3NF)`;
    }
    if (dom.udfOrderTotalBadge) {
      dom.udfOrderTotalBadge.textContent = 'Thành công (200 OK)';
      dom.udfOrderTotalBadge.className = 'text-[10px] font-mono-code text-[#3B5249] bg-[#E8EFEA] border border-[#A2C2B2] px-2 py-0.5 rounded font-bold';
    }

    showToast('Tính tổng tiền đơn', `Đơn #${orderId}: ${formatVND(total)} (fn_calculate_order_total)`, 'success');
  } catch (err) {
    if (dom.udfOrderTotalBadge) {
      dom.udfOrderTotalBadge.textContent = 'Lỗi truy vấn';
      dom.udfOrderTotalBadge.className = 'text-[10px] font-mono-code text-[#A63A2B] bg-[#FBEBE8] border border-[#F1C2B8] px-2 py-0.5 rounded font-bold';
    }
    showToast('Lỗi tính tổng đơn', err.message, 'error');
  } finally {
    if (dom.btnRunOrderTotal) {
      dom.btnRunOrderTotal.disabled = false;
      dom.btnRunOrderTotal.classList.remove('opacity-70');
    }
  }
}

async function handleRunCustomerTier() {
  const input = dom.udfUserIdInput;
  const rawId = input ? input.value.trim() : '4';
  const userId = parseInt(rawId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    showToast('Lỗi nhập liệu', 'Vui lòng nhập Mã khách hàng hợp lệ (> 0).', 'warning');
    return;
  }

  if (dom.btnRunCustomerTier) {
    dom.btnRunCustomerTier.disabled = true;
    dom.btnRunCustomerTier.classList.add('opacity-70');
  }

  try {
    const data = await getCustomerTier(userId);
    const tier = data.tier || 'Khách Mới (0% ưu đãi)';

    if (dom.udfCustomerTierBadge) {
      dom.udfCustomerTierBadge.textContent = tier;
    }
    if (dom.udfCustomerTierSub) {
      if (tier.includes('VIP') || tier.includes('10%')) {
        dom.udfCustomerTierSub.textContent = 'Đã có đơn hàng hoàn tất • Áp dụng chiết khấu 10% tri ân khách cũ';
        dom.udfCustomerTierBadge.className = 'text-base font-extrabold font-playfair text-[#A63A2B] tracking-wide';
      } else {
        dom.udfCustomerTierSub.textContent = 'Chưa có đơn hàng hoàn tất • Chưa áp dụng chiết khấu 10%';
        dom.udfCustomerTierBadge.className = 'text-base font-extrabold font-playfair text-[#8C6D46] tracking-wide';
      }
    }
    if (dom.udfCustomerTierStatusBadge) {
      dom.udfCustomerTierStatusBadge.textContent = 'Thành công (200 OK)';
    }

    showToast('Phân hạng khách hàng', `User #${userId}: ${tier} (fn_get_customer_tier)`, 'success');
  } catch (err) {
    if (dom.udfCustomerTierStatusBadge) {
      dom.udfCustomerTierStatusBadge.textContent = 'Lỗi truy vấn';
    }
    showToast('Lỗi lấy phân hạng', err.message, 'error');
  } finally {
    if (dom.btnRunCustomerTier) {
      dom.btnRunCustomerTier.disabled = false;
      dom.btnRunCustomerTier.classList.remove('opacity-70');
    }
  }
}

async function handleLoadRevenueReport() {
  if (dom.btnLoadRevenueReport) {
    dom.btnLoadRevenueReport.disabled = true;
    dom.btnLoadRevenueReport.classList.add('opacity-70');
  }

  if (dom.udfRevenueTableBody) {
    dom.udfRevenueTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-[#8C6D46] italic">
          Đang nạp báo cáo doanh thu từ hàm fn_get_food_revenue_report()...
        </td>
      </tr>
    `;
  }

  try {
    const rows = await getFoodRevenueReport();
    if (!rows || rows.length === 0) {
      if (dom.udfRevenueTableBody) {
        dom.udfRevenueTableBody.innerHTML = `
          <tr>
            <td colspan="5" class="py-8 text-center text-[#8C6D46] italic">
              Chưa có dữ liệu giao dịch để thống kê doanh thu món ăn.
            </td>
          </tr>
        `;
      }
      if (dom.udfTotalRevenueSum) dom.udfTotalRevenueSum.textContent = '0 ₫';
      return;
    }

    let totalSum = 0;
    const html = rows
      .map((row) => {
        const rev = Number(row.total_revenue || 0);
        totalSum += rev;
        const sold = Number(row.total_sold || 0);
        return `
          <tr class="hover:bg-[#F6F1E7]/70 transition-colors border-b border-[#EAE2D5]">
            <td class="py-2.5 px-3 font-mono-code text-xs font-bold text-[#8C6D46]">#${row.food_id}</td>
            <td class="py-2.5 px-3 font-semibold text-xs text-[#2C1E16] font-playfair">${escapeHtml(row.food_name)}</td>
            <td class="py-2.5 px-3 text-xs text-[#5C493E]">
              <span class="bg-[#F6F1E7] border border-[#D8CBB8] px-2 py-0.5 rounded text-[11px] font-medium text-[#2C1E16]">
                ${escapeHtml(row.category_name || '--')}
              </span>
            </td>
            <td class="py-2.5 px-3 text-center font-mono-code font-bold text-xs text-[#3B5249]">
              ${sold.toLocaleString('vi-VN')}
            </td>
            <td class="py-2.5 px-3 text-right font-mono-code font-bold text-xs text-[#A63A2B]">
              ${formatVND(rev)}
            </td>
          </tr>
        `;
      })
      .join('');

    if (dom.udfRevenueTableBody) {
      dom.udfRevenueTableBody.innerHTML = html;
      refreshIcons();
    }
    if (dom.udfTotalRevenueSum) {
      dom.udfTotalRevenueSum.textContent = formatVND(totalSum);
    }

    showToast('Báo cáo doanh thu', `Đã nạp ${rows.length} món ăn từ fn_get_food_revenue_report()`, 'success');
  } catch (err) {
    if (dom.udfRevenueTableBody) {
      dom.udfRevenueTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 text-center text-[#A63A2B] font-medium">
            Lỗi tải báo cáo: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
    showToast('Lỗi tải báo cáo', err.message, 'error');
  } finally {
    if (dom.btnLoadRevenueReport) {
      dom.btnLoadRevenueReport.disabled = false;
      dom.btnLoadRevenueReport.classList.remove('opacity-70');
    }
  }
}

function bindInspectorEvents() {
  dom.btnRefreshAll.addEventListener('click', async () => {
    await refreshDbStatus();
    await loadAllBusinessPanels();
    showToast('Đã đồng bộ toàn bộ Dashboard!', '', 'info');
  });

  // Panel 1 Controls
  dom.btnFillInvalidConn.addEventListener('click', () => {
    dom.connStringInput.value =
      'postgresql://wrong_lecturer_test:wrong_pass@localhost:5432/non_existent_db';
    dom.connStringInput.focus();
  });

  dom.btnApplyConnString.addEventListener('click', handleApplyCustomConnString);
  dom.btnResetConnString.addEventListener('click', handleRestoreDefaultConnection);
  dom.btnBannerRestore.addEventListener('click', handleRestoreDefaultConnection);
  dom.btnToggleDbOutage.addEventListener('click', handleToggleDbOutage);

  dom.delayPresetBtns.forEach((btn) => {
    btn.addEventListener('click', () => handleSetDelayMs(Number(btn.dataset.delay)));
  });

  dom.btnToggleTransport.addEventListener('click', () => {
    if (!realtimeClient) return;
    const next = state.transport === 'sse' ? 'ws' : 'sse';
    realtimeClient.switchTransport(next);
    recordSystemToConsole(
      `Chuyển kênh Real-time sang ${next.toUpperCase()}`,
      `Inspector đang nhận sự kiện trực tiếp qua giao thức ${next === 'ws' ? 'WebSocket (/ws)' : 'Server-Sent Events (/api/events/stream)'}.`
    );
    showToast(`Đã chuyển sang kênh ${next.toUpperCase()}!`, 'Giữ nguyên lastEventId không mất gói tin.', 'info');
    setTimeout(refreshDbStatus, 400);
  });

  // Panel 2 Controls
  dom.inspFoodSearch.addEventListener('input', () => {
    state.foodSearch = dom.inspFoodSearch.value;
    renderFoodsCrudTable();
  });
  dom.inspFoodCategoryFilter.addEventListener('change', () => {
    state.foodCategoryFilter = dom.inspFoodCategoryFilter.value;
    renderFoodsCrudTable();
  });
  dom.btnOpenAddFood.addEventListener('click', () => openFoodModal(null));
  dom.btnCloseFoodModal.addEventListener('click', closeFoodModal);
  dom.btnCancelFoodModal.addEventListener('click', closeFoodModal);
  dom.foodCrudForm.addEventListener('submit', handleFoodFormSubmit);

  dom.btnSampleFoodImg.addEventListener('click', () => {
    state.sampleImgIdx += 1;
    dom.foodFormImage.value = SAMPLE_FOOD_IMAGES[state.sampleImgIdx % SAMPLE_FOOD_IMAGES.length];
  });

  // FK 23503 Modal Controls
  dom.btnCloseFkModal.addEventListener('click', closeFkModal);
  dom.btnFkCloseOnly.addEventListener('click', closeFkModal);
  dom.btnFkConvertSoftDelete.addEventListener('click', async () => {
    const food = state.pendingFkFood;
    closeFkModal();
    if (food?.id) {
      await handleSoftDeleteFood(food.id);
    }
  });

  // Panel 3 Controls
  dom.inspOrderStatusFilter.addEventListener('change', () => {
    state.orderStatusFilter = dom.inspOrderStatusFilter.value;
    renderOrdersDispatchList();
  });
  dom.btnShowAllAudit.addEventListener('click', () => {
    state.selectedAuditOrderId = null;
    renderOrdersDispatchList();
    renderAuditHistoryTable(false);
  });

  // Panel 4A & 4B Controls
  dom.explorerRowLimit.addEventListener('change', () => {
    state.explorerLimit = Number(dom.explorerRowLimit.value) || 50;
    loadExplorerTable();
  });
  dom.btnRefreshExplorer.addEventListener('click', loadExplorerTable);

  dom.consoleFilterSelect.addEventListener('change', () => {
    state.consoleFilter = dom.consoleFilterSelect.value;
    renderConsoleLogs();
  });
  dom.btnPauseConsole.addEventListener('click', () => {
    state.consolePaused = !state.consolePaused;
    dom.btnPauseConsole.textContent = state.consolePaused ? 'Tiếp tục' : 'Tạm dừng';
    dom.btnPauseConsole.className = state.consolePaused
      ? 'px-2.5 py-1 rounded-lg bg-[#C5A059] text-[#1F150F] text-[11px] font-extrabold transition'
      : 'px-2.5 py-1 rounded-lg bg-[#35251C] hover:bg-[#4A3528] text-[11px] font-semibold text-[#E2D9CC] border border-[#5C4332] transition';
    if (!state.consolePaused) {
      renderConsoleLogs();
    }
  });
  dom.btnClearConsole.addEventListener('click', () => {
    state.consoleLogs = [];
    dom.consoleCounterBadge.textContent = '0 logs';
    renderConsoleLogs();
  });
}

async function initInspectorApp() {
  refreshIcons();
  renderExplorerTabs();
  bindInspectorEvents();

  await refreshDbStatus();
  await loadAllBusinessPanels();
  initRealtimeInspectorStream();
}

initInspectorApp();
