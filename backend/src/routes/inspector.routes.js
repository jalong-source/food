const express = require('express');
const { query } = require('../db/poolManager');

const router = express.Router();

/**
 * GET /api/inspector/food-revenue
 * Báo cáo doanh thu và số lượng bán của từng món ăn từ hàm UDF fn_get_food_revenue_report()
 */
router.get('/food-revenue', async (_req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM fn_get_food_revenue_report();',
      [],
      { source: 'inspector.food_revenue_report' }
    );
    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/inspector/order-total/:id
 * Tính tổng tiền đơn hàng chuẩn 3NF từ hàm UDF fn_calculate_order_total(order_id)
 */
router.get('/order-total/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ORDER_ID',
          message: 'Mã đơn hàng (Order ID) không hợp lệ. Phải là số nguyên dương.',
        },
      });
    }

    const result = await query(
      'SELECT fn_calculate_order_total($1::int) AS order_total;',
      [orderId],
      { source: 'inspector.calculate_order_total' }
    );

    const orderTotal = Number(result.rows[0]?.order_total || 0);

    return res.json({
      success: true,
      order_id: orderId,
      order_total: orderTotal,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/inspector/customer-tier/:userId
 * Lấy phân hạng khách hàng thân thiết từ hàm UDF fn_get_customer_tier(user_id)
 */
router.get('/customer-tier/:userId', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_USER_ID',
          message: 'Mã khách hàng (User ID) không hợp lệ. Phải là số nguyên dương.',
        },
      });
    }

    const result = await query(
      'SELECT fn_get_customer_tier($1::int) AS tier;',
      [userId],
      { source: 'inspector.customer_tier' }
    );

    return res.json({
      success: true,
      user_id: userId,
      tier: result.rows[0]?.tier ?? null,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
