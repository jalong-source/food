const express = require('express');
const { query } = require('../db/poolManager');
const { publishEvent } = require('../realtime/eventBus');

const router = express.Router();

function normalizeOrderSummary(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_email: row.customer_email,
    delivery_address: row.delivery_address,
    customer_note: row.customer_note,
    status: row.status,
    total_amount: row.total_amount !== null && row.total_amount !== undefined ? Number(row.total_amount) : 0,
    item_count: Number(row.item_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: [],
    history: [],
  };
}

function normalizeOrderItem(row) {
  const unitPrice = Number(row.unit_price ?? 0);
  const quantity = Number(row.quantity ?? 0);
  const subtotal = row.subtotal !== undefined ? Number(row.subtotal) : Number((unitPrice * quantity).toFixed(2));
  return {
    id: row.id,
    order_id: row.order_id,
    food_id: row.food_id,
    food_name: row.food_name,
    name: row.food_name,
    food_image_url: row.food_image_url,
    image_url: row.food_image_url,
    quantity,
    unit_price: unitPrice,
    subtotal,
    current_catalog_price:
      row.current_catalog_price !== null && row.current_catalog_price !== undefined
        ? Number(row.current_catalog_price)
        : unitPrice,
    item_note: row.item_note,
  };
}

function normalizeHistoryEntry(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    old_status: row.old_status,
    new_status: row.new_status,
    changed_by: row.changed_by,
    changed_by_name: row.changed_by_name || null,
    changed_by_role: row.changed_by_role || null,
    note: row.note,
    changed_at: row.changed_at,
  };
}

/**
 * Batch load `order_items` and `order_status_history` for an array of summary rows.
 */
async function hydrateOrderRows(summaryRows, { silent = false, sourcePrefix = 'orders' } = {}) {
  if (!Array.isArray(summaryRows) || summaryRows.length === 0) {
    return [];
  }

  const ordersMap = new Map();
  const orderIds = [];

  for (const row of summaryRows) {
    const normalized = normalizeOrderSummary(row);
    ordersMap.set(normalized.id, normalized);
    orderIds.push(normalized.id);
  }

  const [itemsRes, historyRes] = await Promise.all([
    query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.food_id,
        f.name AS food_name,
        f.image_url AS food_image_url,
        f.price AS current_catalog_price,
        oi.quantity,
        oi.unit_price,
        (oi.quantity * oi.unit_price)::NUMERIC(12, 2) AS subtotal,
        oi.item_note
      FROM order_items oi
      INNER JOIN foods f ON f.id = oi.food_id
      WHERE oi.order_id = ANY($1::int[])
      ORDER BY oi.id ASC
      `,
      [orderIds],
      { source: `${sourcePrefix}.items`, silent }
    ),
    query(
      `
      SELECT
        osh.id,
        osh.order_id,
        osh.old_status,
        osh.new_status,
        osh.changed_by,
        u.full_name AS changed_by_name,
        u.role AS changed_by_role,
        osh.note,
        osh.changed_at
      FROM order_status_history osh
      LEFT JOIN users u ON u.id = osh.changed_by
      WHERE osh.order_id = ANY($1::int[])
      ORDER BY osh.changed_at ASC, osh.id ASC
      `,
      [orderIds],
      { source: `${sourcePrefix}.history`, silent }
    ),
  ]);

  for (const itemRow of itemsRes.rows) {
    const target = ordersMap.get(itemRow.order_id);
    if (target) {
      target.items.push(normalizeOrderItem(itemRow));
    }
  }

  for (const histRow of historyRes.rows) {
    const target = ordersMap.get(histRow.order_id);
    if (target) {
      target.history.push(normalizeHistoryEntry(histRow));
    }
  }

  return orderIds.map((id) => ordersMap.get(id));
}

async function getHydratedOrderById(orderId, { silent = false, source = 'orders.detail' } = {}) {
  const summaryRes = await query(
    'SELECT * FROM vw_orders_summary WHERE id = $1',
    [orderId],
    { source, silent }
  );

  if (summaryRes.rows.length === 0) {
    return null;
  }

  const [order] = await hydrateOrderRows(summaryRes.rows, {
    silent,
    sourcePrefix: source,
  });
  return order || null;
}

/**
 * GET /api/orders
 * Query orders from 3NF view `vw_orders_summary` and batch-load `items` + `history`.
 * Optional query filters: ?user_id=..., ?status=..., ?limit=...
 */
router.get('/', async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    const rawUserId = req.query.user_id ?? req.query.userId;
    if (rawUserId !== undefined && rawUserId !== null && String(rawUserId).trim() !== '') {
      const userId = parseInt(rawUserId, 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_USER_ID',
            sqlState: null,
            message: 'Tham sá»‘ user_id pháº£i lÃ  sá»‘ nguyÃªn dÆ°Æ¡ng.',
            detail: null,
          },
        });
      }
      params.push(userId);
      conditions.push(`user_id = $${params.length}`);
    }

    const rawStatus = req.query.status;
    if (
      rawStatus !== undefined &&
      rawStatus !== null &&
      String(rawStatus).trim() !== '' &&
      String(rawStatus).toLowerCase() !== 'all'
    ) {
      params.push(String(rawStatus).trim());
      conditions.push(`status = $${params.length}`);
    }

    const rawLimit = parseInt(req.query.limit || '100', 10);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 100;
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const summaryRes = await query(
      `
      SELECT *
      FROM vw_orders_summary
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
      `,
      params,
      { source: 'orders.list' }
    );

    const orders = await hydrateOrderRows(summaryRes.rows, {
      silent: true,
      sourcePrefix: 'orders.list',
    });

    return res.json({
      success: true,
      count: orders.length,
      data: orders,
      orders,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/orders/check-customer
 * Check if the customer (by phone, email, or name) is a returning customer with prior orders,
 * qualifying for a 10% returning customer discount!
 */
router.get('/check-customer', async (req, res, next) => {
  try {
    const phone = String(req.query.phone || '').trim();
    const email = String(req.query.email || '').trim();
    const name = String(req.query.name || '').trim();

    if (!phone && !email && !name) {
      return res.json({
        success: true,
        isReturning: false,
        orderCount: 0,
        discountPercent: 0,
        message: 'Chưa có thông tin tra cứu',
      });
    }

    let matched = null;
    if (phone) {
      const r = await query(
        'SELECT id, full_name, email, phone, default_address FROM users WHERE phone = $1 LIMIT 1',
        [phone],
        { source: 'orders.checkCustomer.byPhone' }
      );
      if (r.rows.length > 0) matched = r.rows[0];
    }
    if (!matched && email) {
      const r = await query(
        'SELECT id, full_name, email, phone, default_address FROM users WHERE email ILIKE $1 LIMIT 1',
        [email],
        { source: 'orders.checkCustomer.byEmail' }
      );
      if (r.rows.length > 0) matched = r.rows[0];
    }
    if (!matched && name) {
      const r = await query(
        'SELECT id, full_name, email, phone, default_address FROM users WHERE full_name ILIKE $1 LIMIT 1',
        [name],
        { source: 'orders.checkCustomer.byName' }
      );
      if (r.rows.length > 0) matched = r.rows[0];
    }

    if (!matched) {
      return res.json({
        success: true,
        isReturning: false,
        orderCount: 0,
        discountPercent: 0,
        message: 'Khách hàng mới (chưa có tài khoản)',
      });
    }

    const orderCheck = await query(
      'SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1',
      [matched.id],
      { source: 'orders.checkCustomer.ordersCount' }
    );
    const orderCount = orderCheck.rows[0]?.count || 0;
    const isReturning = orderCount > 0;

    return res.json({
      success: true,
      isReturning,
      orderCount,
      discountPercent: isReturning ? 10 : 0,
      user: {
        id: matched.id,
        full_name: matched.full_name,
        phone: matched.phone,
        email: matched.email,
        default_address: matched.default_address,
      },
      message: isReturning
        ? `Chào mừng ${matched.full_name} quay trở lại! Bạn được giảm 10% tri ân khách hàng thân thiết.`
        : 'Khách hàng mới',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/orders/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ORDER_ID',
          sqlState: null,
          message: 'ID Ä‘Æ¡n hÃ ng khÃ´ng há»£p lá»‡.',
          detail: null,
        },
      });
    }

    const order = await getHydratedOrderById(orderId, { source: 'orders.detail' });
    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ORDER_NOT_FOUND',
          sqlState: 'P0002',
          message: `KhÃ´ng tÃ¬m tháº¥y Ä‘Æ¡n hÃ ng #${orderId}.`,
          detail: null,
        },
      });
    }

    return res.json({
      success: true,
      data: order,
      order,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/orders
 * Create order transactionally via CALL sp_create_order($1, $2, $3, $4::jsonb, NULL).
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    let userId = parseInt(body.user_id ?? body.userId, 10);
    const customerName = String(body.customer_name ?? body.name ?? body.full_name ?? '').trim();
    const customerPhone = String(body.customer_phone ?? body.phone ?? '').trim();
    const customerEmail = String(body.customer_email ?? body.email ?? '').trim();
    const deliveryAddress =
      body.delivery_address !== undefined || body.deliveryAddress !== undefined
        ? String(body.delivery_address ?? body.deliveryAddress ?? '').trim()
        : '';
    const customerNote =
      body.customer_note !== undefined || body.customerNote !== undefined || body.note !== undefined
        ? String(body.customer_note ?? body.customerNote ?? body.note ?? '').trim() || null
        : null;
    const rawItems = body.items;

    // Tự động phân giải hoặc tạo/cập nhật tài khoản khách hàng để đồng bộ trực tiếp vào bảng users
    if (customerName) {
      const cleanSlug = customerName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]/g, '') || 'khach';
      const timestamp = Date.now();
      const fallbackEmail = `${cleanSlug}${timestamp % 10000}@gmail.com`;
      const fallbackPhone = `09${Math.floor(10000000 + Math.random() * 90000000)}`;

      const finalEmail = customerEmail || fallbackEmail;
      const finalPhone = customerPhone || fallbackPhone;

      let matched = null;
      if (customerPhone) {
        const byPhone = await query(
          'SELECT id, full_name, email, phone FROM users WHERE phone = $1 LIMIT 1',
          [customerPhone],
          { source: 'orders.resolveUserByPhone' }
        );
        if (byPhone.rows.length > 0) matched = byPhone.rows[0];
      }
      if (!matched && customerEmail) {
        const byEmail = await query(
          'SELECT id, full_name, email, phone FROM users WHERE email ILIKE $1 LIMIT 1',
          [customerEmail],
          { source: 'orders.resolveUserByEmail' }
        );
        if (byEmail.rows.length > 0) matched = byEmail.rows[0];
      }
      if (!matched && customerName) {
        const byName = await query(
          'SELECT id, full_name, email, phone FROM users WHERE full_name ILIKE $1 LIMIT 1',
          [customerName],
          { source: 'orders.resolveUserByName' }
        );
        if (byName.rows.length > 0) matched = byName.rows[0];
      }

      if (matched) {
        userId = matched.id;
        await query(
          `UPDATE users
           SET full_name = $1,
               phone = COALESCE(NULLIF($2, ''), phone),
               email = COALESCE(NULLIF($3, ''), email),
               default_address = COALESCE(NULLIF($4, ''), default_address),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
          [customerName, customerPhone || matched.phone, customerEmail || matched.email, deliveryAddress || null, userId],
          { source: 'orders.updateCustomerUser' }
        );
      } else {
        const newUser = await query(
          `INSERT INTO users (full_name, email, phone, role, default_address)
           VALUES ($1, $2, $3, 'customer', $4)
           ON CONFLICT (email) DO UPDATE
             SET full_name = EXCLUDED.full_name,
                 phone = EXCLUDED.phone,
                 default_address = COALESCE(EXCLUDED.default_address, users.default_address),
                 updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [customerName, finalEmail, finalPhone, deliveryAddress || null],
          { source: 'orders.createCustomerUser' }
        );
        userId = newUser.rows[0].id;
      }
    } else if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Vui lòng chọn khách hàng đặt món hợp lệ (user_id).',
          detail: null,
        },
      });
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Giỏ hàng trống. Vui lòng chọn ít nhất 1 món ăn.',
          detail: null,
        },
      });
    }

    const normalizedItems = rawItems.map((item) => ({
      food_id: parseInt(item.food_id ?? item.foodId ?? item.id, 10),
      quantity: parseInt(item.quantity ?? item.qty ?? 1, 10),
      item_note:
        item.item_note !== undefined || item.itemNote !== undefined || item.note !== undefined
          ? String(item.item_note ?? item.itemNote ?? item.note ?? '').trim() || null
          : null,
      is_flash_sale: Boolean(item.is_flash_sale ?? item.isFlashSale ?? false),
    }));

    const callRes = await query(
      'CALL sp_create_order($1, $2, $3, $4::jsonb, NULL)',
      [userId, deliveryAddress, customerNote, JSON.stringify(normalizedItems)],
      { source: 'orders.create' }
    );

    const newOrderId = callRes.rows[0]?.p_order_id;
    const order = await getHydratedOrderById(newOrderId, {
      silent: true,
      source: 'orders.create.fetch',
    });

    publishEvent('order:created', order, { origin: 'rest_api' });

    return res.status(201).json({
      success: true,
      message: `Đặt đơn hàng #${newOrderId} thành công!`,
      data: order,
      order,
    });
  } catch (err) {
    return next(err);
  }
});

async function handleUpdateOrderStatus(req, res, next) {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ORDER_ID',
          sqlState: null,
          message: 'ID đơn hàng không hợp lệ.',
          detail: null,
        },
      });
    }

    const body = req.body || {};
    const newStatus = body.status ?? body.new_status ?? body.newStatus;
    if (!newStatus || String(newStatus).trim() === '') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Vui lòng cung cấp trạng thái mới (status).',
          detail: null,
        },
      });
    }

    const rawActor = body.changed_by ?? body.changedBy ?? body.actor_id ?? null;
    const parsedActor =
      rawActor !== null && rawActor !== undefined && String(rawActor).trim() !== ''
        ? parseInt(rawActor, 10)
        : null;
    const changedBy = Number.isInteger(parsedActor) && parsedActor > 0 ? parsedActor : null;

    if (changedBy) {
      const actorCheck = await query(
        'SELECT id, role, full_name FROM users WHERE id = $1',
        [changedBy],
        { source: 'orders.checkAdminRole' }
      );
      if (actorCheck.rows.length === 0 || actorCheck.rows[0].role !== 'admin') {
        const actorName = actorCheck.rows[0]?.full_name || `ID=${changedBy}`;
        const actorRole = actorCheck.rows[0]?.role || 'không xác định';
        return res.status(403).json({
          success: false,
          error: {
            code: 'PERMISSION_DENIED',
            sqlState: '42501',
            message: 'Quyền bị từ chối: Chỉ tài khoản Quản trị viên (Admin) mới có quyền duyệt đơn hàng.',
            detail: `Người dùng "${actorName}" mang vai trò "${actorRole}". Hệ thống chỉ cho phép tài khoản Admin thực hiện duyệt chuyển trạng thái.`,
          },
        });
      }
    }

    const note =
      body.note !== undefined || body.status_note !== undefined
        ? String(body.note ?? body.status_note ?? '').trim() || null
        : null;

    const force = Boolean(body.force ?? body.p_force ?? false);

    await query(
      'CALL sp_update_order_status($1, $2, $3, $4, $5)',
      [orderId, String(newStatus).trim(), changedBy, note, force],
      { source: 'orders.updateStatus' }
    );

    const order = await getHydratedOrderById(orderId, {
      silent: true,
      source: 'orders.updateStatus.fetch',
    });

    publishEvent('order:status_updated', order, { origin: 'rest_api' });

    return res.json({
      success: true,
      message: `Đã cập nhật trạng thái đơn hàng #${orderId} sang "${order?.status || newStatus}".`,
      data: order,
      order,
    });
  } catch (err) {
    return next(err);
  }
}

router.patch('/:id/status', handleUpdateOrderStatus);
router.put('/:id/status', handleUpdateOrderStatus);
router.put('/:id', handleUpdateOrderStatus);

/**
 * DELETE /api/orders/:id
 * Demonstrates ON DELETE CASCADE referential action: deleting parent `orders` row
 * automatically cleans up child `order_items` and `order_status_history` rows.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ORDER_ID',
          sqlState: null,
          message: 'ID Ä‘Æ¡n hÃ ng khÃ´ng há»£p lá»‡.',
          detail: null,
        },
      });
    }

    // Measure dependent child rows prior to CASCADE deletion for educational reporting
    const preCountRes = await query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM order_items WHERE order_id = $1) AS items_count,
        (SELECT COUNT(*)::int FROM order_status_history WHERE order_id = $1) AS history_count
      `,
      [orderId],
      { source: 'orders.delete.preCascadeCount', silent: true }
    );

    const cascadedItems = preCountRes.rows[0]?.items_count ?? 0;
    const cascadedHistory = preCountRes.rows[0]?.history_count ?? 0;

    const deleteRes = await query(
      'DELETE FROM orders WHERE id = $1 RETURNING *',
      [orderId],
      { source: 'orders.deleteCascade' }
    );

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ORDER_NOT_FOUND',
          sqlState: 'P0002',
          message: `KhÃ´ng tÃ¬m tháº¥y Ä‘Æ¡n hÃ ng #${orderId} Ä‘á»ƒ xÃ³a.`,
          detail: null,
        },
      });
    }

    const deletedOrder = deleteRes.rows[0];
    const cascadePayload = {
      id: orderId,
      deletedOrder,
      cascadedOrderItems: cascadedItems,
      cascadedStatusHistory: cascadedHistory,
    };

    publishEvent('order:deleted', cascadePayload, { origin: 'rest_api' });

    return res.json({
      success: true,
      message:
        `ÄÃ£ xÃ³a Ä‘Æ¡n hÃ ng #${orderId}. Nhá» rÃ ng buá»™c khÃ³a ngoáº¡i ON DELETE CASCADE, PostgreSQL Ä‘Ã£ tá»± Ä‘á»™ng ` +
        `xÃ³a dÃ¢y chuyá»n ${cascadedItems} dÃ²ng trong order_items vÃ  ${cascadedHistory} dÃ²ng trong order_status_history.`,
      data: cascadePayload,
      ...cascadePayload,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
