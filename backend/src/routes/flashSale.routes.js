const express = require('express');
const { query } = require('../db/poolManager');
const { publishEvent } = require('../realtime/eventBus');

const router = express.Router();

/**
 * GET /api/flash-sale/current
 * Lấy phiên Flash Sale 1K đang hoạt động (active), kèm 10 món trợ giá 1.000đ
 * Nếu chưa có phiên nào active, tự động gọi SP để khởi tạo phiên cho giờ hiện tại.
 */
router.get('/current', async (_req, res, next) => {
  try {
    let slotRes = await query(
      `SELECT * FROM flash_sale_slots 
       WHERE status = 'active' AND end_time > NOW() 
       ORDER BY id DESC LIMIT 1`,
      [],
      { source: 'flashSale.getActiveSlot' }
    );

    if (slotRes.rows.length === 0) {
      // Tự động kích hoạt phiên cho giờ hiện tại
      await query(
        `CALL sp_activate_flash_sale_slot(NULL, NULL)`,
        [],
        { source: 'flashSale.autoActivate' }
      );

      slotRes = await query(
        `SELECT * FROM flash_sale_slots 
         WHERE status = 'active' AND end_time > NOW() 
         ORDER BY id DESC LIMIT 1`,
        [],
        { source: 'flashSale.getNewSlot' }
      );
    }

    const currentSlot = slotRes.rows[0] || null;

    let items = [];
    if (currentSlot) {
      const itemsRes = await query(
        `SELECT * FROM vw_flash_sale_active 
         WHERE slot_id = $1 
         ORDER BY is_claimable DESC, flash_sale_item_id ASC`,
        [currentSlot.id],
        { source: 'flashSale.getItems' }
      );
      items = itemsRes.rows;
    }

    // Tính thời gian đếm ngược còn lại
    const now = Date.now();
    const endTime = currentSlot ? new Date(currentSlot.end_time).getTime() : now;
    const remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));

    res.json({
      success: true,
      data: {
        slot: currentSlot,
        remainingSeconds,
        items,
        totalItems: items.length,
        availableItemsCount: items.filter((i) => i.is_claimable).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/flash-sale/trigger
 * Kích hoạt phiên Flash Sale mới ngay lập tức (cho giảng viên & người dùng test)
 */
router.post('/trigger', async (req, res, next) => {
  try {
    const slotHour = req.body?.hour !== undefined ? parseInt(req.body.hour, 10) : null;
    const result = await query(
      `CALL sp_activate_flash_sale_slot($1, NULL)`,
      [slotHour],
      { source: 'flashSale.trigger' }
    );

    const newSlotId = result.rows[0]?.p_slot_id;

    const slotData = await query(
      `SELECT * FROM flash_sale_slots WHERE id = $1`,
      [newSlotId],
      { source: 'flashSale.fetchSlot' }
    );

    const itemsRes = await query(
      `SELECT * FROM vw_flash_sale_active WHERE slot_id = $1`,
      [newSlotId],
      { source: 'flashSale.fetchItems' }
    );

    publishEvent('flash_sale:started', {
      slot: slotData.rows[0],
      items: itemsRes.rows,
    }, { origin: 'rest_api' });

    res.json({
      success: true,
      message: `Đã kích hoạt phiên Flash Sale 1K thành công (Slot #${newSlotId})!`,
      data: {
        slot: slotData.rows[0],
        items: itemsRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/flash-sale/slots
 * Danh sách toàn bộ các phiên Flash Sale (phục vụ DB Live Inspector)
 */
router.get('/slots', async (_req, res, next) => {
  try {
    const slotsRes = await query(
      `SELECT fss.*, 
              COUNT(fsi.id)::int AS items_count,
              COUNT(fsi.id) FILTER (WHERE fsi.stock_quantity > 0)::int AS remaining_count,
              COUNT(fsi.id) FILTER (WHERE fsi.sold_quantity > 0)::int AS sold_count
       FROM flash_sale_slots fss
       LEFT JOIN flash_sale_items fsi ON fsi.slot_id = fss.id
       GROUP BY fss.id
       ORDER BY fss.id DESC
       LIMIT 20`,
      [],
      { source: 'flashSale.listSlots' }
    );

    res.json({
      success: true,
      data: slotsRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

