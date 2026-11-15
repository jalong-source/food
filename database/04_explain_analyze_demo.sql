-- ============================================================================
-- ĐỒ ÁN MÔN THIẾT KẾ CƠ SỞ DỮ LIỆU - JALONG CYBERFOOD
-- File: database/04_explain_analyze_demo.sql
-- Mục đích: Kịch bản kiểm thử hiệu năng và chứng minh hoạt động của B-Tree Index
-- Hệ quản trị CSDL: PostgreSQL 16
-- 
-- HƯỚNG DẪN DÀNH CHO BẢO VỆ ĐỒ ÁN TRƯỚC GIẢNG VIÊN:
-- 1. Mở công cụ quản trị (pgAdmin 4 / DBeaver / VS Code Database Client / psql CLI).
-- 2. Kết nối vào CSDL: `jalong_db` (hoặc `cyberfood_db`).
-- 3. Lưu ý về Cost Model của PostgreSQL:
--    Trên các bảng dữ liệu mẫu có số lượng dòng nhỏ (< vài chục dòng), bộ tối ưu hóa
--    PostgreSQL Query Planner thường chủ động chọn "Seq Scan" (Quét tuần tự) vì chi phí
--    đọc toàn bộ bảng chỉ tốn 1 block I/O, nhanh hơn việc đọc 1 block trang chỉ mục +
--    1 block trang dữ liệu (Heap Fetch).
--    Để ép Query Planner minh họa cơ chế hoạt động của B-Tree Index trong môi trường Demo,
--    chúng ta sử dụng câu lệnh: `SET enable_seqscan = OFF;`
--    Sau đó chạy lại câu lệnh để chụp màn hình "Index Scan" / "Bitmap Index Scan"
--    nộp vào phụ lục báo cáo đồ án.
-- ============================================================================

SET client_encoding = 'UTF8';

-- Bật định dạng hiển thị chi tiết tài nguyên bộ nhớ đệm (Buffers) và thời gian thực thi (Timing)
\timing on

-- ============================================================================
-- DEMO 1: TỐI ƯU TRUY VẤN LỌC MÓN ĂN THEO DANH MỤC & TRẠNG THÁI MỞ BÁN
-- Chỉ mục kiểm thử: `idx_foods_available_category` (foods: is_available, category_id)
-- Nghiệp vụ: Khi khách hàng mở trang chủ hoặc chọn tab danh mục (ví dụ category_id = 2)
-- ============================================================================
-- Bước 1.1: Chạy truy vấn với cấu hình mặc định
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT id, name, price, stock_quantity
FROM foods
WHERE is_available = TRUE AND category_id = 2
ORDER BY price ASC;

-- Bước 1.2: Ép Planner dùng B-Tree Index để đối soát chi phí (Cost Comparison)
SET enable_seqscan = OFF;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT id, name, price, stock_quantity
FROM foods
WHERE is_available = TRUE AND category_id = 2
ORDER BY price ASC;

-- Khôi phục lại trạng thái mặc định
SET enable_seqscan = ON;


-- ============================================================================
-- DEMO 2: TỐI ƯU TRUY VẤN CHI TIẾT ĐƠN HÀNG (JOIN ORDER_ITEMS & FOODS)
-- Chỉ mục kiểm thử: `idx_order_items_order_id` (order_items: order_id)
-- Nghiệp vụ: Tải danh sách các món ăn trong đơn hàng #1 để hiển thị hóa đơn và tính tiền
-- ============================================================================
-- Bước 2.1: Truy vấn chi tiết đơn hàng
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT 
    oi.id,
    oi.order_id,
    f.name AS food_name,
    oi.quantity,
    oi.unit_price,
    (oi.quantity * oi.unit_price)::NUMERIC(12,2) AS subtotal
FROM order_items oi
INNER JOIN foods f ON f.id = oi.food_id
WHERE oi.order_id = 1;

-- Bước 2.2: Ép sử dụng Index Scan trên khóa ngoại `order_items.order_id`
SET enable_seqscan = OFF;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT 
    oi.id,
    oi.order_id,
    f.name AS food_name,
    oi.quantity,
    oi.unit_price,
    (oi.quantity * oi.unit_price)::NUMERIC(12,2) AS subtotal
FROM order_items oi
INNER JOIN foods f ON f.id = oi.food_id
WHERE oi.order_id = 1;

SET enable_seqscan = ON;


-- ============================================================================
-- DEMO 3: TỐI ƯU TRUY VẤN LỊCH SỬ ĐƠN HÀNG CỦA KHÁCH HÀNG (SẮP XẾP MỚI NHẤT)
-- Chỉ mục kiểm thử: `idx_orders_user_id` (orders: user_id) kết hợp `idx_orders_created_at`
-- Nghiệp vụ: Khách hàng mở trang Order Tracker để xem các đơn hàng của mình
-- ============================================================================
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT id, user_id, status, created_at, delivery_address
FROM orders
WHERE user_id = 1
ORDER BY created_at DESC;

-- Minh chứng Index Scan:
SET enable_seqscan = OFF;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT id, user_id, status, created_at, delivery_address
FROM orders
WHERE user_id = 1
ORDER BY created_at DESC;

SET enable_seqscan = ON;


-- ============================================================================
-- DEMO 4: TỐI ƯU DÒNG THỜI GIAN KIỂM TOÁN TRẠNG THÁI (AUDIT TRAIL TIMELINE)
-- Chỉ mục kiểm thử: `idx_order_status_history_order_timeline`
--                   (order_status_history: order_id, changed_at ASC, id ASC)
-- Nghiệp vụ: Vẽ thanh tiến trình giao hàng Real-time từ Pending -> Preparing -> Delivering -> Completed
-- ============================================================================
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT 
    osh.id,
    osh.order_id,
    osh.old_status,
    osh.new_status,
    osh.changed_at,
    osh.note,
    u.full_name AS changed_by_name
FROM order_status_history osh
LEFT JOIN users u ON u.id = osh.changed_by
WHERE osh.order_id = 1
ORDER BY osh.changed_at ASC, osh.id ASC;

-- Minh chứng Index Scan tổng hợp đa cột (Composite B-Tree Index):
SET enable_seqscan = OFF;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS)
SELECT 
    osh.id,
    osh.order_id,
    osh.old_status,
    osh.new_status,
    osh.changed_at,
    osh.note,
    u.full_name AS changed_by_name
FROM order_status_history osh
LEFT JOIN users u ON u.id = osh.changed_by
WHERE osh.order_id = 1
ORDER BY osh.changed_at ASC, osh.id ASC;

SET enable_seqscan = ON;

-- ============================================================================
-- HẾT KỊCH BẢN DEMO EXPLAIN ANALYZE
-- ============================================================================
