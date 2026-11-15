const express = require('express');
const { query } = require('../db/poolManager');
const { publishEvent } = require('../realtime/eventBus');

const router = express.Router();

function normalizeFoodRow(row) {
  if (!row) return null;
  const orderItemCount = Number(row.order_item_count || 0);
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: row.category_name,
    category_slug: row.category_slug,
    name: row.name,
    description: row.description,
    price: row.price !== null && row.price !== undefined ? Number(row.price) : 0,
    image_url: row.image_url,
    is_available: Boolean(row.is_available),
    stock_quantity: Number(row.stock_quantity ?? 0),
    order_item_count: orderItemCount,
    has_orders: orderItemCount > 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchFoodById(foodId, meta = { source: 'foods.getById' }) {
  const res = await query(
    `
    SELECT
      f.id,
      f.category_id,
      c.name AS category_name,
      c.slug AS category_slug,
      f.name,
      f.description,
      f.price,
      f.image_url,
      f.is_available,
      f.stock_quantity,
      (SELECT COUNT(*)::int FROM order_items oi WHERE oi.food_id = f.id) AS order_item_count,
      f.created_at,
      f.updated_at
    FROM foods f
    INNER JOIN categories c ON c.id = f.category_id
    WHERE f.id = $1
    `,
    [foodId],
    meta
  );
  return normalizeFoodRow(res.rows[0] || null);
}

/**
 * GET /api/foods
 * Query params:
 *   - category_id (or categoryId): filter by category ID
 *   - search (or q): case-insensitive search on food name, description, or category name
 *   - include_unavailable (or includeUnavailable): 'true' | '1' to include unavailable foods
 */
router.get('/', async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    const rawIncludeUnavailable =
      req.query.include_unavailable ?? req.query.includeUnavailable ?? 'false';
    const includeUnavailable =
      String(rawIncludeUnavailable).toLowerCase() === 'true' ||
      String(rawIncludeUnavailable) === '1';

    if (!includeUnavailable) {
      conditions.push('f.is_available = TRUE');
    }

    const rawCategoryId = req.query.category_id ?? req.query.categoryId;
    if (
      rawCategoryId !== undefined &&
      rawCategoryId !== null &&
      String(rawCategoryId).trim() !== '' &&
      String(rawCategoryId).toLowerCase() !== 'all'
    ) {
      const catId = parseInt(rawCategoryId, 10);
      if (!Number.isInteger(catId) || catId <= 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CATEGORY_ID',
            sqlState: null,
            message: 'Tham số category_id phải là số nguyên dương.',
            detail: null,
          },
        });
      }
      params.push(catId);
      conditions.push(`f.category_id = $${params.length}`);
    }

    const rawSearch = req.query.search ?? req.query.q;
    if (rawSearch !== undefined && rawSearch !== null && String(rawSearch).trim() !== '') {
      params.push(`%${String(rawSearch).trim()}%`);
      const idx = params.length;
      conditions.push(
        `(f.name ILIKE $${idx} OR COALESCE(f.description, '') ILIKE $${idx} OR c.name ILIKE $${idx})`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `
      SELECT
        f.id,
        f.category_id,
        c.name AS category_name,
        c.slug AS category_slug,
        f.name,
        f.description,
        f.price,
        f.image_url,
        f.is_available,
        f.stock_quantity,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.food_id = f.id) AS order_item_count,
        f.created_at,
        f.updated_at
      FROM foods f
      INNER JOIN categories c ON c.id = f.category_id
      ${whereClause}
      ORDER BY c.display_order ASC, f.id ASC
      `,
      params,
      { source: 'foods.list' }
    );

    const foods = result.rows.map(normalizeFoodRow);

    return res.json({
      success: true,
      count: foods.length,
      data: foods,
      foods,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/foods/roulette
 * Lấy danh sách món ăn phục vụ vòng quay CS:GO "Hôm nay ăn gì?" theo mốc tài chính
 */
router.get('/roulette', async (req, res, next) => {
  try {
    const budget = req.query.budget || 'all';
    let priceClause = '';

    if (budget === 'under40k') {
      priceClause = 'AND f.price < 40000';
    } else if (budget === '40k-65k') {
      priceClause = 'AND f.price >= 40000 AND f.price <= 65000';
    } else if (budget === 'over65k') {
      priceClause = 'AND f.price > 65000';
    }

    const sql = `
      SELECT
        f.id,
        f.category_id,
        c.name AS category_name,
        c.slug AS category_slug,
        f.name,
        f.description,
        f.price,
        f.image_url,
        f.is_available,
        f.stock_quantity,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.food_id = f.id) AS order_item_count,
        f.created_at,
        f.updated_at,
        CASE
          WHEN f.price < 40000 THEN 'milspec'
          WHEN f.price < 55000 THEN 'restricted'
          WHEN f.price < 65000 THEN 'classified'
          WHEN f.price <= 68000 THEN 'covert'
          ELSE 'special_rare'
        END AS rarity
      FROM foods f
      INNER JOIN categories c ON c.id = f.category_id
      WHERE f.is_available = TRUE AND f.stock_quantity > 0
      ${priceClause}
      ORDER BY RANDOM()
    `;

    const result = await query(sql, [], { source: 'foods.roulette' });
    const items = result.rows.map((row) => ({
      ...normalizeFoodRow(row),
      rarity: row.rarity || 'milspec',
    }));

    return res.json({
      success: true,
      data: {
        budget,
        count: items.length,
        items,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/foods/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const foodId = parseInt(req.params.id, 10);
    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FOOD_ID',
          sqlState: null,
          message: 'ID món ăn không hợp lệ.',
          detail: null,
        },
      });
    }

    const food = await fetchFoodById(foodId, { source: 'foods.detail' });
    if (!food) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'FOOD_NOT_FOUND',
          sqlState: 'P0002',
          message: `Không tìm thấy món ăn có ID=${foodId}.`,
          detail: null,
        },
      });
    }

    return res.json({
      success: true,
      data: food,
      food,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/foods
 * Create a new food item via Stored Procedure CALL sp_upsert_food(NULL, ...).
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const categoryId = parseInt(body.category_id ?? body.categoryId, 10);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description =
      body.description !== undefined && body.description !== null
        ? String(body.description).trim()
        : null;
    const price = Number(body.price);
    const imageUrl =
      body.image_url !== undefined || body.imageUrl !== undefined
        ? String(body.image_url ?? body.imageUrl ?? '').trim() || null
        : null;
    const isAvailable =
      body.is_available !== undefined
        ? Boolean(body.is_available)
        : body.isAvailable !== undefined
          ? Boolean(body.isAvailable)
          : true;
    const rawStock = body.stock_quantity ?? body.stockQuantity;
    const stockQuantity =
      rawStock !== undefined && rawStock !== null && rawStock !== '' ? parseInt(rawStock, 10) : 50;

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Vui lòng chọn danh mục món ăn hợp lệ (category_id).',
          detail: null,
        },
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Tên món ăn không được để trống.',
          detail: null,
        },
      });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Giá món ăn phải là số lớn hơn hoặc bằng 0.',
          detail: null,
        },
      });
    }

    const callResult = await query(
      'CALL sp_upsert_food(NULL::int, $1::int, $2::varchar, $3::text, $4::numeric, $5::text, $6::boolean, $7::int)',
      [categoryId, name, description, price, imageUrl, isAvailable, stockQuantity],
      { source: 'foods.create' }
    );

    const newFoodId = callResult.rows[0]?.p_food_id;
    const food = await fetchFoodById(newFoodId, { source: 'foods.create.fetch', silent: true });

    publishEvent('food:created', food, { origin: 'rest_api' });

    return res.status(201).json({
      success: true,
      message: `Đã thêm món "${food?.name || name}" thành công.`,
      data: food,
      food,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/foods/:id
 * Update (or upsert) food item via Stored Procedure CALL sp_upsert_food($1, ...).
 * Supports both full replacement payloads and partial field updates.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const foodId = parseInt(req.params.id, 10);
    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FOOD_ID',
          sqlState: null,
          message: 'ID món ăn không hợp lệ.',
          detail: null,
        },
      });
    }

    const existing = await fetchFoodById(foodId, { source: 'foods.update.lookup', silent: true });
    const body = req.body || {};

    const rawCategoryId = body.category_id ?? body.categoryId ?? existing?.category_id;
    const categoryId = parseInt(rawCategoryId, 10);

    const name =
      body.name !== undefined ? String(body.name).trim() : String(existing?.name || '').trim();

    const description =
      body.description !== undefined
        ? body.description !== null
          ? String(body.description).trim()
          : null
        : existing?.description ?? null;

    const rawPrice = body.price !== undefined ? body.price : existing?.price;
    const price = Number(rawPrice);

    const hasImageField = body.image_url !== undefined || body.imageUrl !== undefined;
    const imageUrl = hasImageField
      ? String(body.image_url ?? body.imageUrl ?? '').trim() || null
      : existing?.image_url ?? null;

    const isAvailable =
      body.is_available !== undefined
        ? Boolean(body.is_available)
        : body.isAvailable !== undefined
          ? Boolean(body.isAvailable)
          : existing
            ? existing.is_available
            : true;

    const rawStock =
      body.stock_quantity ?? body.stockQuantity ?? (existing ? existing.stock_quantity : 50);
    const stockQuantity = parseInt(rawStock, 10);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Danh mục món ăn (category_id) không hợp lệ.',
          detail: null,
        },
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Tên món ăn không được để trống.',
          detail: null,
        },
      });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: '22023',
          message: 'Giá món ăn phải lớn hơn hoặc bằng 0.',
          detail: null,
        },
      });
    }

    const callResult = await query(
      'CALL sp_upsert_food($1::int, $2::int, $3::varchar, $4::text, $5::numeric, $6::text, $7::boolean, $8::int)',
      [foodId, categoryId, name, description, price, imageUrl, isAvailable, stockQuantity],
      { source: 'foods.update' }
    );

    const updatedId = callResult.rows[0]?.p_food_id || foodId;
    const food = await fetchFoodById(updatedId, { source: 'foods.update.fetch', silent: true });

    publishEvent('food:updated', food, { origin: 'rest_api' });

    return res.json({
      success: true,
      message: `Đã cập nhật món "${food?.name || name}" thành công.`,
      data: food,
      food,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/foods/:id
 * - ?mode=soft : Soft delete (is_available = FALSE) preserving 3NF historical order_items.
 * - default    : Hard delete (DELETE FROM foods WHERE id = $1). If referenced by order_items.food_id
 *                (ON DELETE RESTRICT), PostgreSQL throws SQLSTATE 23503 -> surfaced as HTTP 409
 *                with an educational 3NF referential integrity explanation.
 */
router.delete('/:id', async (req, res, next) => {
  const foodId = parseInt(req.params.id, 10);
  if (!Number.isInteger(foodId) || foodId <= 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_FOOD_ID',
        sqlState: null,
        message: 'ID món ăn không hợp lệ.',
        detail: null,
      },
    });
  }

  const mode = String(req.query.mode || 'hard').toLowerCase();

  try {
    if (mode === 'soft') {
      const updateRes = await query(
        'UPDATE foods SET is_available = FALSE WHERE id = $1 RETURNING id',
        [foodId],
        { source: 'foods.softDelete' }
      );

      if (updateRes.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'FOOD_NOT_FOUND',
            sqlState: 'P0002',
            message: `Không tìm thấy món ăn có ID=${foodId}.`,
            detail: null,
          },
        });
      }

      const food = await fetchFoodById(foodId, { source: 'foods.softDelete.fetch', silent: true });
      publishEvent('food:updated', food, { origin: 'rest_api', action: 'soft_delete' });

      return res.json({
        success: true,
        mode: 'soft',
        message: `Đã tạm ngưng phục vụ món "${food.name}" (Soft Delete: is_available = false). Dữ liệu lịch sử trong bảng order_items vẫn được bảo toàn nguyên vẹn theo chuẩn 3NF.`,
        data: food,
        food,
      });
    }

    // Default: Hard delete -> intentionally exercises PostgreSQL FK ON DELETE RESTRICT (23503)
    const deleteRes = await query(
      'DELETE FROM foods WHERE id = $1 RETURNING *',
      [foodId],
      { source: 'foods.hardDelete' }
    );

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'FOOD_NOT_FOUND',
          sqlState: 'P0002',
          message: `Không tìm thấy món ăn có ID=${foodId}.`,
          detail: null,
        },
      });
    }

    const deletedFood = deleteRes.rows[0];
    publishEvent(
      'food:deleted',
      { id: foodId, name: deletedFood.name, food: deletedFood },
      { origin: 'rest_api', action: 'hard_delete' }
    );

    return res.json({
      success: true,
      mode: 'hard',
      message: `Đã xóa vĩnh viễn món "${deletedFood.name}" (ID=${foodId}) khỏi bảng foods (món chưa phát sinh chi tiết đơn hàng nào).`,
      data: { id: foodId, food: deletedFood },
      food: deletedFood,
    });
  } catch (err) {
    if (err && err.code === '23503') {
      let refCount = null;
      let foodName = `ID=${foodId}`;
      try {
        const refInfo = await query(
          `
          SELECT
            f.name,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.food_id = f.id) AS ref_count
          FROM foods f
          WHERE f.id = $1
          `,
          [foodId],
          { silent: true, skipLog: true }
        );
        if (refInfo.rows[0]) {
          foodName = `"${refInfo.rows[0].name}" (ID=${foodId})`;
          refCount = refInfo.rows[0].ref_count;
        }
      } catch (_lookupErr) {
        // Ignore lookup error and still return 409 explanation
      }

      const refCountText =
        typeof refCount === 'number' && refCount > 0 ? ` (${refCount} dòng chi tiết đơn hàng)` : '';

      const explanationMessage =
        `Không thể xóa cứng món ${foodName} do vi phạm ràng buộc Khóa ngoại 3NF (SQLSTATE 23503 - ON DELETE RESTRICT): ` +
        `cột order_items.food_id đang tham chiếu tới món ăn này${refCountText} nhằm bảo vệ lịch sử hóa đơn giao dịch.`;

      const detailText =
        `${err.detail || 'Key is still referenced from table "order_items".'} | ` +
        `Giải pháp chuẩn thiết kế CSDL: Sử dụng Xóa mềm (?mode=soft -> is_available = false) để ngừng bán mà không làm mất lịch sử đơn hàng.`;

      publishEvent(
        'db:constraint_violated',
        {
          sqlState: '23503',
          constraint: err.constraint || 'fk_order_items_food',
          table: err.table || 'order_items',
          foodId,
          refCount,
          message: explanationMessage,
        },
        { origin: 'rest_api' }
      );

      return res.status(409).json({
        success: false,
        error: {
          code: '23503',
          sqlState: '23503',
          constraint: err.constraint || 'fk_order_items_food',
          message: explanationMessage,
          detail: detailText,
          hint: 'Hãy chọn chế độ "Ngừng bán (Soft Delete)" (?mode=soft) để đặt is_available = false.',
        },
      });
    }

    return next(err);
  }
});

module.exports = router;
