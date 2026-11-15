-- ============================================================================
-- HỆ THỐNG ĐẶT ĐỒ ĂN TRỰC TUYẾN (ONLINE FOOD ORDERING SYSTEM)
-- File: database/01_schema_ddl.sql
-- Hệ quản trị CSDL: PostgreSQL 16
-- Chuẩn thiết kế: Chuẩn 3NF nghiêm ngặt (Strict Third Normal Form)
-- ============================================================================
-- Mục tiêu học thuật & kỹ thuật:
--   1. Đảm bảo toàn vẹn thực thể (Entity Integrity), toàn vẹn miền giá trị
--      (Domain Integrity - CHECK, NOT NULL, UNIQUE) và toàn vẹn tham chiếu
--      (Referential Integrity - FOREIGN KEY: RESTRICT, CASCADE, SET NULL).
--   2. Tuân thủ nghiêm ngặt chuẩn 3NF:
--      - Mọi thuộc tính đều nguyên tố (1NF).
--      - Không có phụ thuộc hàm bộ phận vào khóa dự tuyển (2NF).
--      - Không có phụ thuộc hàm bắc cầu giữa các thuộc tính không khóa (3NF),
--        và loại bỏ thuộc tính dẫn xuất dư thừa `total_amount` khỏi bảng `orders`.
--   3. Tối ưu hóa truy vấn đọc qua hệ thống B-Tree Index và View tổng hợp
--      `vw_orders_summary` phục vụ Dashboard & API.
-- ============================================================================

SET client_encoding = 'UTF8';

-- Làm sạch đối tượng cũ theo thứ tự phụ thuộc ngược để script có tính Idempotent
DROP VIEW IF EXISTS vw_orders_summary CASCADE;
DROP TABLE IF EXISTS order_status_history CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS foods CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================================
-- 1. BẢNG `users`: Quản lý tài khoản người dùng đa vai trò
-- Phụ thuộc hàm: id -> {full_name, email, phone, role, default_address, created_at, updated_at}
-- Khóa dự tuyển (Candidate Keys): {id}, {email}, {phone} -> Đạt chuẩn 3NF & BCNF.
-- ============================================================================
CREATE TABLE users (
    id              SERIAL          PRIMARY KEY,
    full_name       VARCHAR(100)    NOT NULL,
    email           VARCHAR(150)    NOT NULL,
    phone           VARCHAR(20)     NOT NULL,
    role            VARCHAR(20)     NOT NULL DEFAULT 'customer',
    default_address TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT uq_users_phone UNIQUE (phone),
    CONSTRAINT chk_users_role CHECK (role IN ('customer', 'admin', 'shipper', 'lecturer'))
);

COMMENT ON TABLE users IS 'Bảng lưu trữ thông tin người dùng hệ thống (khách hàng, quản trị viên, tài xế giao hàng, giảng viên đánh giá).';
COMMENT ON COLUMN users.default_address IS 'Địa chỉ mặc định của người dùng trong hồ sơ cá nhân; độc lập với địa chỉ giao hàng của từng đơn cụ thể.';

-- ============================================================================
-- 2. BẢNG `categories`: Danh mục phân loại ẩm thực
-- Phụ thuộc hàm: id -> {name, slug, description, display_order, created_at}
-- Khóa dự tuyển (Candidate Keys): {id}, {name}, {slug} -> Đạt chuẩn 3NF & BCNF.
-- Tách `categories` riêng khỏi `foods` giúp triệt tiêu phụ thuộc bắc cầu:
--   food_id -> category_id -> {category_name, category_slug, category_description}
-- ============================================================================
CREATE TABLE categories (
    id              SERIAL          PRIMARY KEY,
    name            VARCHAR(100)    NOT NULL,
    slug            VARCHAR(100)    NOT NULL,
    description     TEXT,
    display_order   INT             NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_categories_name UNIQUE (name),
    CONSTRAINT uq_categories_slug UNIQUE (slug)
);

COMMENT ON TABLE categories IS 'Danh mục phân loại món ăn (Phở & Bún, Cơm Việt, Bánh Mì & Món Cuốn, Đồ Uống...).';

-- ============================================================================
-- 3. BẢNG `foods`: Thực đơn món ăn và quản lý tồn kho
-- Phụ thuộc hàm: id -> {category_id, name, description, price, image_url,
--                       is_available, stock_quantity, created_at, updated_at}
-- Tham chiếu:
--   - `ON DELETE RESTRICT` tới `categories(id)`: Ngăn xóa danh mục đang chứa món ăn.
--   - `price` là giá niêm yết hiện hành (Current Catalog Price).
-- ============================================================================
CREATE TABLE foods (
    id              SERIAL          PRIMARY KEY,
    category_id     INT             NOT NULL,
    name            VARCHAR(150)    NOT NULL,
    description     TEXT,
    price           NUMERIC(12, 2)  NOT NULL,
    image_url       TEXT,
    is_available    BOOLEAN         NOT NULL DEFAULT TRUE,
    stock_quantity  INT             NOT NULL DEFAULT 50,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_foods_category
        FOREIGN KEY (category_id) REFERENCES categories(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_foods_price_non_negative
        CHECK (price >= 0),
    CONSTRAINT chk_foods_stock_non_negative
        CHECK (stock_quantity >= 0)
);

COMMENT ON TABLE foods IS 'Danh sách món ăn, giá niêm yết hiện hành và số lượng tồn kho phục vụ kiểm soát đồng thời (Row-Level Locking).';

-- ============================================================================
-- 4. BẢNG `orders`: Thông tin chung của đơn đặt hàng (Order Header)
-- Phụ thuộc hàm: id -> {user_id, delivery_address, customer_note, status, created_at, updated_at}
-- GIẢI TRÌNH THIẾT KẾ CHUẨN 3NF:
--   1. KHÔNG lưu cột `total_amount` trong bảng `orders`:
--      Tổng tiền là thuộc tính dẫn xuất (Derived Attribute) bằng SUM(quantity * unit_price)
--      từ bảng `order_items`. Nếu lưu cứng `total_amount` sẽ gây dị thường cập nhật
--      (Update Anomaly) khi thêm/sửa/xóa dòng chi tiết. Thay vào đó, tổng tiền được
--      tính động chính xác qua View `vw_orders_summary`.
--   2. Thuộc tính `delivery_address` KHÔNG vi phạm 3NF dù `users` có `default_address`:
--      `users.default_address` là địa chỉ hồ sơ hiện tại của khách, còn `orders.delivery_address`
--      là địa chỉ giao hàng thực tế tại thời điểm đặt đơn (khách có thể đặt giao tới văn phòng,
--      tặng bạn bè, hoặc đổi địa chỉ hồ sơ sau này mà không làm sai lệch lịch sử đơn hàng cũ).
-- ============================================================================
CREATE TABLE orders (
    id                  SERIAL          PRIMARY KEY,
    user_id             INT             NOT NULL,
    delivery_address    TEXT            NOT NULL,
    customer_note       TEXT,
    status              VARCHAR(20)     NOT NULL DEFAULT 'Pending',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_orders_status
        CHECK (status IN ('Pending', 'Preparing', 'Delivering', 'Completed', 'Cancelled'))
);

COMMENT ON TABLE orders IS 'Bảng đầu mục đơn hàng chuẩn 3NF (không lưu cột dư thừa total_amount).';

-- ============================================================================
-- 5. BẢNG `order_items`: Chi tiết từng món ăn trong đơn hàng (Order Lines)
-- Khóa chính đại diện (Surrogate PK): `id`
-- Khóa dự tuyển tự nhiên (Natural Candidate Key): `(order_id, food_id)`
-- Phụ thuộc hàm:
--   - id -> {order_id, food_id, quantity, unit_price, item_note}
--   - (order_id, food_id) -> {id, quantity, unit_price, item_note}
-- GIẢI TRÌNH THIẾT KẾ CHUẨN 3NF & TOÀN VẸN THAM CHIẾU:
--   1. `unit_price` KHÔNG phụ thuộc hàm chỉ vào `food_id` theo thời gian:
--      `foods.price` là giá thực đơn hiện tại (có thể tăng/giảm theo khuyến mãi),
--      trong khi `order_items.unit_price` là giá chốt giao dịch lịch sử tại thời điểm
--      đặt đơn: (order_id, food_id) -> unit_price. Nhờ vậy khi Admin đổi giá món ăn,
--      hóa đơn lịch sử của khách không bị biến dạng!
--   2. `ON DELETE RESTRICT` trên `food_id`:
--      Bảo vệ dữ liệu kế toán — bất kỳ món ăn nào đã phát sinh giao dịch trong
--      `order_items` sẽ bị PostgreSQL chặn xóa cứng với mã lỗi SQLSTATE `23503`.
--   3. `ON DELETE CASCADE` trên `order_id`:
--      Thực thể yếu phụ thuộc vào `orders`; xóa đơn hàng sẽ tự động dọn chi tiết đi kèm.
-- ============================================================================
CREATE TABLE order_items (
    id              SERIAL          PRIMARY KEY,
    order_id        INT             NOT NULL,
    food_id         INT             NOT NULL,
    quantity        INT             NOT NULL,
    unit_price      NUMERIC(12, 2)  NOT NULL,
    item_note       VARCHAR(255),

    CONSTRAINT uq_order_items_order_food
        UNIQUE (order_id, food_id),
    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    CONSTRAINT fk_order_items_food
        FOREIGN KEY (food_id) REFERENCES foods(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_order_items_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT chk_order_items_unit_price_non_negative
        CHECK (unit_price >= 0)
);

COMMENT ON TABLE order_items IS 'Chi tiết các món ăn thuộc đơn hàng; lưu snapshot đơn giá lịch sử unit_price tại thời điểm giao dịch.';

-- ============================================================================
-- 6. BẢNG `order_status_history`: Nhật ký kiểm toán trạng thái đơn hàng (Audit Trail)
-- Phụ thuộc hàm: id -> {order_id, old_status, new_status, changed_by, note, changed_at}
-- Vai trò:
--   - Được tự động ghi nhận bởi Trigger `trg_order_status_audit` mỗi khi đơn hàng
--     được khởi tạo (`NULL -> Pending`) hoặc chuyển đổi trạng thái.
--   - `ON DELETE SET NULL` trên `changed_by`: Giữ nguyên lịch sử kiểm toán ngay cả
--     khi tài khoản nhân viên thực hiện thao tác bị xóa khỏi hệ thống.
-- ============================================================================
CREATE TABLE order_status_history (
    id              SERIAL          PRIMARY KEY,
    order_id        INT             NOT NULL,
    old_status      VARCHAR(20),
    new_status      VARCHAR(20)     NOT NULL,
    changed_by      INT,
    note            TEXT,
    changed_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_order_status_history_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    CONSTRAINT fk_order_status_history_changed_by
        FOREIGN KEY (changed_by) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    CONSTRAINT chk_order_status_history_old_status
        CHECK (old_status IS NULL OR old_status IN ('Pending', 'Preparing', 'Delivering', 'Completed', 'Cancelled')),
    CONSTRAINT chk_order_status_history_new_status
        CHECK (new_status IN ('Pending', 'Preparing', 'Delivering', 'Completed', 'Cancelled'))
);

COMMENT ON TABLE order_status_history IS 'Bảng lưu vết lịch sử chuyển đổi trạng thái đơn hàng tự động qua Database Trigger.';

-- ============================================================================
-- HỆ THỐNG CHỈ MỤC TỐI ƯU HÓA TRUY VẤN (PERFORMANCE INDEXES)
-- ============================================================================
-- Tối ưu lọc người dùng theo vai trò
CREATE INDEX idx_users_role ON users(role);

-- Tối ưu sắp xếp danh mục hiển thị trên Menu
CREATE INDEX idx_categories_display_order ON categories(display_order ASC, id ASC);

-- Tối ưu lọc món ăn theo danh mục và trạng thái mở bán
CREATE INDEX idx_foods_category_id ON foods(category_id);
CREATE INDEX idx_foods_available_category ON foods(is_available, category_id);

-- Tối ưu truy vấn danh sách đơn hàng theo khách hàng, trạng thái và thời gian mới nhất
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- Tối ưu phép kết (JOIN) tính tổng tiền đơn hàng và kiểm tra khóa ngoại FK `23503` khi xóa món
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_food_id ON order_items(food_id);

-- Tối ưu truy xuất dòng thời gian kiểm toán (Timeline) của từng đơn hàng
CREATE INDEX idx_order_status_history_order_timeline ON order_status_history(order_id, changed_at ASC, id ASC);
CREATE INDEX idx_order_status_history_changed_by ON order_status_history(changed_by);

-- ============================================================================
-- VIEW TỔNG HỢP `vw_orders_summary`
-- Giải quyết bài toán đọc dữ liệu tổng hợp mà không phá vỡ chuẩn 3NF:
--   - Tự động tính `total_amount` = SUM(quantity * unit_price) kiểu NUMERIC(12,2)
--   - Tự động tính `item_count`   = SUM(quantity) kiểu INT (tránh BIGINT trả chuỗi trên JS)
-- ============================================================================
CREATE OR REPLACE VIEW vw_orders_summary AS
SELECT
    o.id,
    o.user_id,
    u.full_name                                                     AS customer_name,
    u.phone                                                         AS customer_phone,
    u.email                                                         AS customer_email,
    o.delivery_address,
    o.customer_note,
    o.status,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0.00)::NUMERIC(12,2) AS total_amount,
    COALESCE(SUM(oi.quantity), 0)::INT                              AS item_count,
    o.created_at,
    o.updated_at
FROM orders o
INNER JOIN users u
    ON u.id = o.user_id
LEFT JOIN order_items oi
    ON oi.order_id = o.id
GROUP BY
    o.id,
    o.user_id,
    u.full_name,
    u.phone,
    u.email,
    o.delivery_address,
    o.customer_note,
    o.status,
    o.created_at,
    o.updated_at;

COMMENT ON VIEW vw_orders_summary IS 'View tổng hợp thông tin đơn hàng kèm thông tin khách hàng, tổng số lượng món (item_count) và tổng thành tiền (total_amount) tính động theo chuẩn 3NF.';
