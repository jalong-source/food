/**
 * JalongFood • jalong.io.vn — Unified Frontend API Client (ES Module)
 * Connects Customer Ordering App & Lecturer DB Live Inspector to Express + PostgreSQL Backend.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [meta={}]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = meta.status ?? 500;
    this.code = meta.code ?? null; // PostgreSQL SQLSTATE (e.g. '23503', 'P0001') or 'SIMULATED_DB_OFFLINE'
    this.detail = meta.detail ?? null;
    this.constraint = meta.constraint ?? null;
    this.hint = meta.hint ?? null;
    this.raw = meta.raw ?? null;
  }
}

const API_BASE = '';

/**
 * Build query string from plain object, omitting undefined/null/empty strings.
 * @param {Record<string, any>} params
 * @returns {string}
 */
function toQueryString(params = {}) {
  const sp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      sp.append(key, String(val));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Core HTTP fetch wrapper with rich PostgreSQL / Express error extraction.
 * @param {string} path
 * @param {RequestInit & { bodyObj?: any }} [options={}]
 */
export async function apiRequest(path, options = {}) {
  const { bodyObj, headers = {}, ...rest } = options;
  const fetchHeaders = {
    Accept: 'application/json',
    ...headers,
  };

  let body = rest.body;
  if (bodyObj !== undefined) {
    fetchHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(bodyObj);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: fetchHeaders,
      body,
    });
  } catch (networkErr) {
    throw new ApiError(
      'Không thể kết nối tới máy chủ Backend API. Vui lòng kiểm tra kết nối mạng hoặc tiến trình Server.',
      {
        status: 0,
        code: 'NETWORK_ERROR',
        detail: networkErr?.message || null,
      }
    );
  }

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch (_e) {
      payload = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_e) {
        payload = { message: text };
      }
    }
  }

  if (!response.ok || (payload && payload.success === false)) {
    const errObj =
      payload?.error && typeof payload.error === 'object' ? payload.error : null;

    const message =
      errObj?.message ||
      (typeof payload?.error === 'string' ? payload.error : null) ||
      payload?.message ||
      `Yêu cầu thất bại (HTTP ${response.status})`;

    const code =
      errObj?.code ||
      errObj?.sqlState ||
      payload?.code ||
      payload?.sqlState ||
      (response.status === 503 ? 'DB_UNAVAILABLE' : null);

    const detail = errObj?.detail || payload?.detail || null;
    const constraint = errObj?.constraint || payload?.constraint || null;
    const hint = errObj?.hint || payload?.hint || null;

    throw new ApiError(message, {
      status: response.status,
      code,
      detail,
      constraint,
      hint,
      raw: payload,
    });
  }

  return payload;
}

/**
 * Normalize array responses regardless of envelope shape ({ data: [] }, { rows: [] }, etc.).
 */
function unwrapArray(payload, candidateKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['data', ...candidateKeys, 'rows', 'items', 'results']) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
    if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data[key])) {
      return payload.data[key];
    }
  }
  return [];
}

/**
 * Normalize single-object responses ({ success: true, data: {...} } -> {...}).
 */
function unwrapObject(payload, candidateKeys = []) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    for (const key of candidateKeys) {
      if (payload.data[key] && typeof payload.data[key] === 'object') {
        return payload.data[key];
      }
    }
    return payload.data;
  }
  for (const key of candidateKeys) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return payload;
}

/* ==========================================================================
   1. CATEGORIES & USERS
   ========================================================================== */

export async function getCategories() {
  const res = await apiRequest('/api/categories');
  return unwrapArray(res, ['categories']);
}

export async function getUsers(params = {}) {
  const res = await apiRequest(`/api/users${toQueryString(params)}`);
  return unwrapArray(res, ['users']);
}

/* ==========================================================================
   2.1. FLASH SALE 1K GIỜ VÀNG (1:00, 2:00, 3:00...)
   ========================================================================== */

export async function getFlashSaleCurrent() {
  const res = await apiRequest('/api/flash-sale/current');
  return res?.data || res;
}

export async function triggerFlashSaleSlot(hour = null) {
  const res = await apiRequest('/api/flash-sale/trigger', {
    method: 'POST',
    bodyObj: { hour },
  });
  return res?.data || res;
}

export async function getFlashSaleSlots() {
  const res = await apiRequest('/api/flash-sale/slots');
  return unwrapArray(res, ['slots']);
}

/* ==========================================================================
   2. FOODS (MENU & INVENTORY CRUD + 3NF FK RESTRICT TEST)
   ========================================================================== */

export async function getRouletteFoods(budget = 'all') {
  const res = await apiRequest(`/api/foods/roulette${toQueryString({ budget })}`);
  return res?.data?.items || unwrapArray(res, ['items']);
}

export async function getFoods(params = {}) {
  const res = await apiRequest(`/api/foods${toQueryString(params)}`);
  return unwrapArray(res, ['foods']);
}

export async function getFoodById(id) {
  const res = await apiRequest(`/api/foods/${encodeURIComponent(id)}`);
  return unwrapObject(res, ['food']);
}

export async function createFood(foodData) {
  const categoryId = Number(foodData.category_id ?? foodData.categoryId);
  const price = Number(foodData.price);
  const stockQuantity = Number(foodData.stock_quantity ?? foodData.stockQuantity ?? 50);
  const isAvailable =
    foodData.is_available !== undefined
      ? Boolean(foodData.is_available)
      : foodData.isAvailable !== undefined
        ? Boolean(foodData.isAvailable)
        : true;
  const imageUrl = (foodData.image_url ?? foodData.imageUrl ?? '').trim() || null;
  const description = (foodData.description ?? '').trim() || null;

  const bodyObj = {
    category_id: categoryId,
    categoryId,
    name: String(foodData.name || '').trim(),
    description,
    price,
    image_url: imageUrl,
    imageUrl,
    is_available: isAvailable,
    isAvailable,
    stock_quantity: stockQuantity,
    stockQuantity,
  };

  const res = await apiRequest('/api/foods', {
    method: 'POST',
    bodyObj,
  });
  return unwrapObject(res, ['food']);
}

export async function updateFood(id, foodData) {
  const categoryId = Number(foodData.category_id ?? foodData.categoryId);
  const price = Number(foodData.price);
  const stockQuantity = Number(foodData.stock_quantity ?? foodData.stockQuantity ?? 0);
  const isAvailable =
    foodData.is_available !== undefined
      ? Boolean(foodData.is_available)
      : foodData.isAvailable !== undefined
        ? Boolean(foodData.isAvailable)
        : true;
  const imageUrl = (foodData.image_url ?? foodData.imageUrl ?? '').trim() || null;
  const description = (foodData.description ?? '').trim() || null;

  const bodyObj = {
    category_id: categoryId,
    categoryId,
    name: String(foodData.name || '').trim(),
    description,
    price,
    image_url: imageUrl,
    imageUrl,
    is_available: isAvailable,
    isAvailable,
    stock_quantity: stockQuantity,
    stockQuantity,
  };

  const res = await apiRequest(`/api/foods/${encodeURIComponent(id)}`, {
    method: 'PUT',
    bodyObj,
  });
  return unwrapObject(res, ['food']);
}

/**
 * Delete food item:
 *  - mode = 'hard' (default): executes SQL `DELETE FROM foods WHERE id = $1` -> tests FK `23503` ON DELETE RESTRICT!
 *  - mode = 'soft': sets `is_available = false` safely preserving historical `order_items`.
 * @param {number|string} id
 * @param {'hard'|'soft'} [mode='hard']
 */
export async function deleteFood(id, mode = 'hard') {
  const query = mode === 'soft' ? '?mode=soft' : '';
  const res = await apiRequest(`/api/foods/${encodeURIComponent(id)}${query}`, {
    method: 'DELETE',
  });
  return unwrapObject(res, ['food']);
}

/* ==========================================================================
   3. ORDERS (STORED PROCEDURES `sp_create_order`, `sp_update_order_status` & CASCADE)
   ========================================================================== */

export async function checkCustomer(params = {}) {
  const res = await apiRequest(`/api/orders/check-customer${toQueryString(params)}`);
  return res;
}

export async function getOrders(params = {}) {
  const res = await apiRequest(`/api/orders${toQueryString(params)}`);
  return unwrapArray(res, ['orders']);
}

export async function getOrderById(id) {
  const res = await apiRequest(`/api/orders/${encodeURIComponent(id)}`);
  // Preserve items & history if attached at top-level or inside res.data
  if (res && typeof res === 'object') {
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
      if (res.data.order && typeof res.data.order === 'object') {
        return {
          ...res.data.order,
          items: res.data.items || res.data.order.items || [],
          history:
            res.data.history ||
            res.data.status_history ||
            res.data.statusHistory ||
            res.data.order.history ||
            res.data.order.status_history ||
            [],
        };
      }
      return res.data;
    }
    if (res.order && typeof res.order === 'object') {
      return {
        ...res.order,
        items: res.items || res.order.items || [],
        history: res.history || res.status_history || res.order.history || [],
      };
    }
  }
  return res;
}

export async function createOrder(payload = {}) {
  const {
    userId,
    user_id,
    customerName,
    customer_name,
    customerPhone,
    customer_phone,
    customerEmail,
    customer_email,
    deliveryAddress,
    delivery_address,
    customerNote,
    customer_note,
    items,
  } = payload;

  const finalUserId = Number.isFinite(Number(user_id ?? userId)) && Number(user_id ?? userId) > 0 ? Number(user_id ?? userId) : undefined;
  const finalName = String(customer_name ?? customerName ?? '').trim();
  const finalPhone = String(customer_phone ?? customerPhone ?? '').trim();
  const finalEmail = String(customer_email ?? customerEmail ?? '').trim();
  const finalAddress = String(delivery_address ?? deliveryAddress ?? '').trim();
  const finalNote = String(customer_note ?? customerNote ?? '').trim();

  const normalizedItems = (items || []).map((item) => {
    const foodId = Number(item.food_id ?? item.foodId);
    const quantity = Number(item.quantity);
    const itemNote = String(item.item_note ?? item.itemNote ?? item.note ?? '').trim();
    return {
      food_id: foodId,
      foodId,
      quantity,
      item_note: itemNote || null,
      note: itemNote || null,
    };
  });

  const bodyObj = {
    user_id: finalUserId,
    userId: finalUserId,
    customer_name: finalName || undefined,
    customer_phone: finalPhone || undefined,
    customer_email: finalEmail || undefined,
    delivery_address: finalAddress,
    deliveryAddress: finalAddress,
    customer_note: finalNote || null,
    customerNote: finalNote || null,
    note: finalNote || null,
    items: normalizedItems,
  };

  const res = await apiRequest('/api/orders', {
    method: 'POST',
    bodyObj,
  });
  return unwrapObject(res, ['order']);
}

export async function updateOrderStatus(id, { status, changedBy, changed_by, note, force = false }) {
  const parsedActor = changed_by ?? changedBy ?? null;
  const numericActor =
    parsedActor !== null && parsedActor !== '' && Number.isFinite(Number(parsedActor))
      ? Number(parsedActor)
      : null;

  const bodyObj = {
    status,
    new_status: status,
    newStatus: status,
    changed_by: numericActor,
    changedBy: numericActor,
    note: note ? String(note).trim() : null,
    force: Boolean(force),
  };

  try {
    const res = await apiRequest(`/api/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      bodyObj,
    });
    return unwrapObject(res, ['order']);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      const res = await apiRequest(`/api/orders/${encodeURIComponent(id)}/status`, {
        method: 'PUT',
        bodyObj,
      });
      return unwrapObject(res, ['order']);
    }
    throw err;
  }
}

export async function deleteOrder(id) {
  const res = await apiRequest(`/api/orders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return unwrapObject(res);
}

/* ==========================================================================
   4. DATABASE LIVE INSPECTOR, DYNAMIC POOL & CHAOS CONTROL (`/api/db/*`)
   ========================================================================== */

export async function getDbStatus() {
  const res = await apiRequest('/api/db/status');
  return unwrapObject(res);
}

export async function updateDbConfig({ connectionString, resetDefault = false }) {
  const bodyObj = resetDefault
    ? { resetDefault: true, reset: true }
    : { connectionString: String(connectionString || '').trim(), resetDefault: false };

  try {
    const res = await apiRequest('/api/db/config', {
      method: 'POST',
      bodyObj,
    });
    return unwrapObject(res);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      const res = await apiRequest('/api/db/config', {
        method: 'PUT',
        bodyObj,
      });
      return unwrapObject(res);
    }
    throw err;
  }
}

export async function simulateDb({ offline, artificialDelayMs }) {
  const bodyObj = {};
  if (typeof offline === 'boolean') {
    bodyObj.offline = offline;
    bodyObj.simulatedOffline = offline;
    bodyObj.disconnect = offline;
  }
  if (artificialDelayMs !== undefined && artificialDelayMs !== null) {
    const ms = Number(artificialDelayMs);
    bodyObj.artificialDelayMs = ms;
    bodyObj.latencyMs = ms;
    bodyObj.delayMs = ms;
  }

  const res = await apiRequest('/api/db/simulate', {
    method: 'POST',
    bodyObj,
  });
  return unwrapObject(res);
}


export async function getFoodRevenueReport() {
  const res = await apiRequest('/api/inspector/food-revenue');
  return unwrapArray(res, ['data', 'rows']);
}

export async function calculateOrderTotal(orderId) {
  const res = await apiRequest(/api/inspector/order-total/);
  return unwrapObject(res);
}

export async function getCustomerTier(userId) {
  const res = await apiRequest(/api/inspector/customer-tier/);
  return unwrapObject(res);
}

export async function getTableData(tableName, params = { limit: 50 }) {
  const res = await apiRequest(
    `/api/db/tables/${encodeURIComponent(tableName)}${toQueryString(params)}`
  );

  // Preserve metadata (columns, totalCount, rows)
  const obj = unwrapObject(res);
  if (Array.isArray(obj)) {
    return {
      tableName,
      rows: obj,
      rowCount: obj.length,
      totalCount: obj.length,
      columns: obj.length > 0 ? Object.keys(obj[0]) : [],
    };
  }

  const rows = unwrapArray(obj, ['rows', 'records', 'items']);
  const columns = Array.isArray(obj?.columns)
    ? obj.columns.map((c) => (typeof c === 'string' ? c : c.column_name || c.name))
    : rows.length > 0
      ? Object.keys(rows[0])
      : [];

  return {
    tableName: obj?.tableName || obj?.table || tableName,
    rows,
    rowCount: obj?.rowCount ?? rows.length,
    totalCount: obj?.totalCount ?? obj?.total ?? obj?.count ?? rows.length,
    columns,
  };
}

/* ==========================================================================
   5. SHARED UI FORMATTERS (VNĐ, Timestamps, Safe HTML Escaping)
   ========================================================================== */

const vndFormatter = new Intl.NumberFormat('vi-VN');

export function formatVND(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num)) return '0 ₫';
  return `${vndFormatter.format(Math.round(num))} ₫`;
}

export function formatDateTime(isoString) {
  if (!isoString) return '--:--';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return d.toLocaleString('vi-VN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatTimeShort(isoString) {
  if (!isoString) return '--:--:--';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return d.toLocaleTimeString('vi-VN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default {
  ApiError,
  apiRequest,
  getCategories,
  getUsers,
  getFoods,
  getFoodById,
  getRouletteFoods,
  createFood,
  updateFood,
  deleteFood,
  getOrders,
  getOrderById,
  createOrder,
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
};
