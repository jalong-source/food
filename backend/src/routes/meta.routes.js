const express = require('express');
const { query } = require('../db/poolManager');

const router = express.Router();

/**
 * GET /api/categories
 * List all food categories ordered by display_order with total & available food_count.
 */
router.get('/categories', async (_req, res, next) => {
  try {
    const result = await query(
      `
      SELECT
        c.id,
        c.name,
        c.slug,
        c.description,
        c.display_order,
        COUNT(f.id)::int AS food_count,
        COUNT(f.id) FILTER (WHERE f.is_available = TRUE)::int AS available_food_count,
        c.created_at
      FROM categories c
      LEFT JOIN foods f ON f.category_id = c.id
      GROUP BY c.id, c.name, c.slug, c.description, c.display_order, c.created_at
      ORDER BY c.display_order ASC, c.id ASC
      `,
      [],
      { source: 'meta.categories' }
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
      categories: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users
 * List users (optionally filtered by ?role=customer|admin|shipper|lecturer).
 */
router.get('/users', async (req, res, next) => {
  try {
    const params = [];
    let whereSql = '';

    if (req.query.role && String(req.query.role).trim() !== '') {
      params.push(String(req.query.role).trim().toLowerCase());
      whereSql = 'WHERE LOWER(u.role) = $1';
    }

    const result = await query(
      `
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.phone,
        u.role,
        u.default_address,
        (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = u.id) AS order_count,
        u.created_at,
        u.updated_at
      FROM users u
      ${whereSql}
      ORDER BY u.id ASC
      `,
      params,
      { source: 'meta.users' }
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
      users: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
