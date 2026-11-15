const express = require('express');
const crypto = require('crypto');
const { query } = require('../db/poolManager');

const router = express.Router();

const SALT = 'jalong_vintage_salt_2026';

function hashPassword(pwd) {
  return crypto.scryptSync(pwd, SALT, 32).toString('hex');
}

function verifyPassword(pwd, hash) {
  if (!hash) return false;
  if (hash === pwd) return true; // Cho phép fallback plain text nếu có dữ liệu cũ
  try {
    const computed = crypto.scryptSync(pwd, SALT, 32).toString('hex');
    return computed === hash;
  } catch {
    return false;
  }
}

// Cơ chế tự động migration nhẹ khi khởi động: Thêm cột password_hash nếu chưa có
let migrationDone = false;
async function ensureMigration() {
  if (migrationDone) return;
  try {
    await query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);',
      [],
      { source: 'auth.migration', silent: true }
    );
    // Cập nhật mật khẩu mặc định (123456) cho các tài khoản demo đã seed từ trước mà chưa có mật khẩu
    const defaultHash = hashPassword('123456');
    await query(
      'UPDATE users SET password_hash = $1 WHERE password_hash IS NULL;',
      [defaultHash],
      { source: 'auth.migration', silent: true }
    );
    migrationDone = true;
  } catch (err) {
    console.warn('[auth] Migration check warning:', err.message);
  }
}

// Kích hoạt migration tự động khi load module
ensureMigration();

// Lấy phân hạng khách hàng thân thiết từ hàm CSDL fn_get_customer_tier
async function getCustomerTier(userId) {
  try {
    const tierRes = await query(
      'SELECT fn_get_customer_tier($1::int) AS tier;',
      [userId],
      { source: 'auth.customer_tier', silent: true }
    );
    return tierRes.rows[0]?.tier || 'Khách Mới (0% ưu đãi)';
  } catch (err) {
    return 'Khách Mới (0% ưu đãi)';
  }
}


/**
 * POST /api/auth/register
 * Nhận: { full_name, phone, password, default_address, email }
 */
router.post('/register', async (req, res, next) => {
  try {
    await ensureMigration();

    const body = req.body || {};
    const fullName = String(body.full_name ?? body.fullName ?? body.name ?? '').trim();
    const phone = String(body.phone ?? body.customer_phone ?? '').trim();
    const password = String(body.password ?? '').trim();
    const defaultAddress =
      body.default_address !== undefined || body.defaultAddress !== undefined || body.address !== undefined
        ? String(body.default_address ?? body.defaultAddress ?? body.address ?? '').trim()
        : null;

    let email = String(body.email ?? body.customer_email ?? '').trim();

    // Kiểm tra dữ liệu: full_name, phone, password không được để trống
    if (!fullName || !phone || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: null,
          message: 'Vui lòng điền đầy đủ họ và tên, số điện thoại và mật khẩu.',
          detail: null,
        },
      });
    }

    // Nếu email không truyền hoặc rỗng: sinh tự động ${phone}@customer.jalong.io.vn
    if (!email) {
      email = `${phone}@customer.jalong.io.vn`;
    }

    // Băm mật khẩu bằng hashPassword
    const passwordHash = hashPassword(password);

    try {
      const insertRes = await query(
        `
        INSERT INTO users (full_name, phone, email, password_hash, default_address, role)
        VALUES ($1, $2, $3, $4, $5, 'customer')
        RETURNING id, full_name, phone, email, default_address, role, created_at
        `,
        [fullName, phone, email, passwordHash, defaultAddress || null],
        { source: 'auth.register' }
      );

      const newUser = insertRes.rows[0];
      const tier = await getCustomerTier(newUser.id);

      return res.status(201).json({
        success: true,
        message: 'Đăng ký tài khoản thành công',
        user: {
          id: newUser.id,
          full_name: newUser.full_name,
          phone: newUser.phone,
          email: newUser.email,
          default_address: newUser.default_address,
          role: newUser.role,
          created_at: newUser.created_at,
          is_loyal: false,
          completed_orders: 0,
          tier,
        },
      });
    } catch (dbErr) {
      // Bắt lỗi trùng SĐT hoặc email (SQLSTATE 23505)
      if (dbErr && (dbErr.code === '23505' || dbErr.sqlState === '23505')) {
        const constraint = String(dbErr.constraint || '');
        const detail = String(dbErr.detail || '');

        // Nếu người dùng chủ động truyền email riêng và trùng email
        if (body.email && (constraint.includes('email') || detail.includes('email'))) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'EMAIL_EXISTS',
              sqlState: '23505',
              message: 'Địa chỉ email này đã được sử dụng. Vui lòng sử dụng email khác.',
              detail: dbErr.detail || null,
            },
          });
        }

        // Mặc định lỗi trùng SĐT (hoặc email tự sinh từ SĐT trùng lặp)
        return res.status(409).json({
          success: false,
          error: {
            code: 'PHONE_EXISTS',
            sqlState: '23505',
            message: 'Số điện thoại này đã được đăng ký tài khoản. Vui lòng đăng nhập hoặc dùng số khác.',
            detail: dbErr.detail || null,
          },
        });
      }
      throw dbErr;
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/login
 * Nhận: { phone, password }
 */
router.post('/login', async (req, res, next) => {
  try {
    await ensureMigration();

    const body = req.body || {};
    const phone = String(body.phone ?? body.customer_phone ?? '').trim();
    const password = String(body.password ?? '').trim();

    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          sqlState: null,
          message: 'Vui lòng nhập số điện thoại và mật khẩu.',
          detail: null,
        },
      });
    }

    const userRes = await query(
      `
      SELECT id, full_name, phone, email, password_hash, default_address, role, created_at
      FROM users
      WHERE phone = $1
      `,
      [phone],
      { source: 'auth.login' }
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          sqlState: null,
          message: 'Số điện thoại hoặc mật khẩu không chính xác.',
          detail: null,
        },
      });
    }

    const user = userRes.rows[0];

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          sqlState: null,
          message: 'Số điện thoại hoặc mật khẩu không chính xác.',
          detail: null,
        },
      });
    }

    // Kiểm tra ưu đãi khách quen: Đếm số đơn hàng đã hoàn tất (Completed)
    const loyaltyRes = await query(
      `
      SELECT COUNT(*)::int AS completed_orders
      FROM orders
      WHERE user_id = $1 AND status = 'Completed'
      `,
      [user.id],
      { source: 'auth.checkLoyalty', silent: true }
    );

    const completed_orders = Number(loyaltyRes.rows[0]?.completed_orders || 0);
    const is_loyal = completed_orders > 0;
    const tier = await getCustomerTier(user.id);

    return res.json({
      success: true,
      message: 'Đăng nhập thành công',
      user: {
        id: user.id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        default_address: user.default_address,
        role: user.role,
        is_loyal,
        completed_orders,
        tier,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/auth/me
 * Nhận query ?user_id=... hoặc ?userId=...
 */
router.get('/me', async (req, res, next) => {
  try {
    await ensureMigration();

    const rawId = req.query.user_id ?? req.query.userId ?? req.query.id;
    const userId = parseInt(rawId, 10);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_USER_ID',
          sqlState: null,
          message: 'Thiếu thông tin user_id hoặc ID không hợp lệ.',
          detail: null,
        },
      });
    }

    const userRes = await query(
      `
      SELECT id, full_name, phone, email, default_address, role, created_at
      FROM users
      WHERE id = $1
      `,
      [userId],
      { source: 'auth.me' }
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          sqlState: 'P0002',
          message: 'Không tìm thấy người dùng.',
          detail: null,
        },
      });
    }

    const user = userRes.rows[0];

    const loyaltyRes = await query(
      `
      SELECT COUNT(*)::int AS completed_orders
      FROM orders
      WHERE user_id = $1 AND status = 'Completed'
      `,
      [user.id],
      { source: 'auth.checkLoyalty', silent: true }
    );

    const completed_orders = Number(loyaltyRes.rows[0]?.completed_orders || 0);
    const is_loyal = completed_orders > 0;
    const tier = await getCustomerTier(user.id);

    return res.json({
      success: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        default_address: user.default_address,
        role: user.role,
        is_loyal,
        completed_orders,
        tier,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
