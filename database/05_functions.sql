-- ============================================================================
-- HỆ THỐNG ĐẶT ĐỒ ĂN TRỰC TUYẾN (ONLINE FOOD ORDERING SYSTEM - JaLongFood)
-- File: database/05_functions.sql
-- Hệ quản trị CSDL: PostgreSQL 16
-- Mục tiêu: Hiện thực các User-Defined Functions (UDFs) và cập nhật View tổng hợp
-- ============================================================================
-- Nội dung bao gồm:
--   1. Hàm vô hướng (Scalar Function): fn_calculate_order_total(p_order_id INT)
--      -> Tính tổng tiền đơn hàng động, tự động áp dụng chiết khấu 10% cho khách hàng thân thiết.
--   2. Hàm vô hướng (Scalar Function): fn_get_customer_tier(p_user_id INT)
--      -> Phân hạng mức độ thân thiết của khách hàng (Mới, Khách Quen VIP, Kim Cương).
--   3. Hàm bảng (Table-Valued Function): fn_get_food_revenue_report()
--      -> Thống kê chi tiết doanh số bán lẻ và doanh thu lũy kế từng món ăn.
--   4. Cập nhật View tổng hợp vw_orders_summary tích hợp fn_calculate_order_total(o.id).
-- ============================================================================

SET client_encoding = 'UTF8';

-- ============================================================================
-- 1. HÀM VÔ HƯỚNG: fn_calculate_order_total(p_order_id INT)
-- Phân loại: Scalar Function
-- Ý nghĩa nghiệp vụ:
--   - Tính tổng thành tiền thô từ chi tiết order_items: SUM(quantity * unit_price).
--   - Kiểm tra xem đơn hàng có thuộc khách hàng thân thiết (đã có ít nhất 1 đơn
--     Completed khác trong lịch sử, hoặc đơn hàng ghi nhận chiết khấu/tri ân).
--   - Nếu thỏa điều kiện khách quen, áp dụng chiết khấu 10% (ROUND(v_raw_total * 0.90, 2)).
--   - Nếu đơn hàng không có món ăn hoặc không tồn tại, trả về 0.00 an toàn.
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_calculate_order_total(p_order_id INT)
RETURNS NUMERIC(12,2)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_user_id               INT;
    v_raw_total             NUMERIC(12,2);
    v_is_discounted         BOOLEAN := FALSE;
    v_completed_other_count INT := 0;
    v_final_total           NUMERIC(12,2);
BEGIN
    -- 1. Xác định user_id sở hữu đơn hàng
    SELECT user_id INTO v_user_id
    FROM orders
    WHERE id = p_order_id;

    -- Đơn hàng không tồn tại trong hệ thống
    IF NOT FOUND THEN
        RETURN 0.00;
    END IF;

    -- 2. Tính tổng tiền thô từ bảng order_items
    SELECT COALESCE(SUM(quantity * unit_price), 0.00)::NUMERIC(12,2)
    INTO v_raw_total
    FROM order_items
    WHERE order_id = p_order_id;

    -- Đơn hàng không có món ăn nào
    IF v_raw_total IS NULL OR v_raw_total = 0.00 THEN
        RETURN 0.00;
    END IF;

    -- 3. Kiểm tra xem khách hàng có đơn hàng Completed khác hay không (Khách quen)
    SELECT COUNT(*)
    INTO v_completed_other_count
    FROM orders
    WHERE user_id = v_user_id
      AND status = 'Completed'
      AND id <> p_order_id;

    IF v_completed_other_count > 0 THEN
        v_is_discounted := TRUE;
    ELSE
        -- Kiểm tra nếu đơn hàng hiện tại có ghi chú áp dụng chiết khấu / tri ân khách hàng
        SELECT EXISTS (
            SELECT 1
            FROM orders
            WHERE id = p_order_id
              AND (
                  customer_note ILIKE '%giảm%'
                  OR customer_note ILIKE '%discount%'
                  OR customer_note ILIKE '%tri ân%'
                  OR customer_note ILIKE '%khách hàng thân thiết%'
                  OR customer_note ILIKE '%khách quen%'
                  OR customer_note ILIKE '%khách cũ%'
              )
            UNION ALL
            SELECT 1
            FROM order_items
            WHERE order_id = p_order_id
              AND (
                  (item_note ILIKE '%giảm%' AND item_note NOT ILIKE '%đường%' AND item_note NOT ILIKE '%đá%')
                  OR item_note ILIKE '%discount%'
                  OR item_note ILIKE '%khách cũ%'
                  OR item_note ILIKE '%chiết khấu%'
              )
        ) INTO v_is_discounted;
    END IF;

    -- 4. Áp dụng mức giảm 10% nếu là khách quen / có giảm giá
    IF v_is_discounted THEN
        v_final_total := ROUND(v_raw_total * 0.90, 2);
    ELSE
        v_final_total := ROUND(v_raw_total, 2);
    END IF;

    RETURN v_final_total;
END;
$$;

COMMENT ON FUNCTION fn_calculate_order_total(INT) IS 'Hàm vô hướng tính tổng giá trị đơn hàng; tự động khấu trừ 10% nếu là khách quen (>= 1 đơn Completed khác) hoặc có chiết khấu.';


-- ============================================================================
-- 2. HÀM VÔ HƯỚNG: fn_get_customer_tier(p_user_id INT)
-- Phân loại: Scalar Function
-- Ý nghĩa nghiệp vụ:
--   - Đếm số lượng đơn hàng có trạng thái "Completed" của khách hàng.
--   - Phân loại cấp độ thẻ thành viên:
--       + 0 đơn: "Khách Mới (0% ưu đãi)"
--       + 1 đến 4 đơn: "Khách Quen VIP (Giảm 10%)"
--       + >= 5 đơn: "Khách Kim Cương (Giảm 10% + Ưu tiên)"
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_customer_tier(p_user_id INT)
RETURNS VARCHAR
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_completed_count INT := 0;
    v_tier            VARCHAR(100);
BEGIN
    -- 1. Đếm số đơn hàng hoàn tất (Completed) của khách hàng
    SELECT COUNT(*)
    INTO v_completed_count
    FROM orders
    WHERE user_id = p_user_id
      AND status = 'Completed';

    -- 2. Phân hạng khách hàng
    IF v_completed_count = 0 THEN
        v_tier := 'Khách Mới (0% ưu đãi)';
    ELSIF v_completed_count >= 1 AND v_completed_count <= 4 THEN
        v_tier := 'Khách Quen VIP (Giảm 10%)';
    ELSE
        v_tier := 'Khách Kim Cương (Giảm 10% + Ưu tiên)';
    END IF;

    RETURN v_tier;
END;
$$;

COMMENT ON FUNCTION fn_get_customer_tier(INT) IS 'Hàm vô hướng phân hạng cấp bậc hội viên khách hàng dựa trên lịch sử đơn hàng hoàn tất.';


-- ============================================================================
-- 3. HÀM BẢNG: fn_get_food_revenue_report()
-- Phân loại: Table-Valued Function
-- Ý nghĩa nghiệp vụ:
--   - Báo cáo tổng hợp số lượng bán và tổng doanh thu tích lũy của từng món ăn.
--   - Bỏ qua các đơn hàng có trạng thái "Cancelled".
--   - Hiển thị danh mục món ăn (nếu không có danh mục hiển thị "Chưa phân loại").
--   - Sắp xếp giảm dần theo doanh thu (total_revenue DESC) và số lượng bán (total_sold DESC).
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_food_revenue_report()
RETURNS TABLE(
    food_id       INT,
    food_name     VARCHAR,
    category_name VARCHAR,
    total_sold    BIGINT,
    total_revenue NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        f.id                                                             AS food_id,
        f.name::VARCHAR                                                  AS food_name,
        COALESCE(c.name, 'Chưa phân loại')::VARCHAR                      AS category_name,
        COALESCE(SUM(oi.quantity), 0)::BIGINT                            AS total_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0.00)::NUMERIC(12,2)   AS total_revenue
    FROM foods f
    LEFT JOIN categories c
        ON c.id = f.category_id
    LEFT JOIN order_items oi
        ON oi.food_id = f.id
    LEFT JOIN orders o
        ON o.id = oi.order_id
       AND o.status <> 'Cancelled'
    GROUP BY
        f.id,
        f.name,
        c.name
    ORDER BY
        total_revenue DESC,
        total_sold DESC,
        f.id ASC;
$$;

COMMENT ON FUNCTION fn_get_food_revenue_report() IS 'Hàm trả về bảng báo cáo doanh số và doanh thu từng món ăn từ các đơn hàng thành công.';


-- ============================================================================
-- 4. CẬP NHẬT VIEW TỔNG HỢP vw_orders_summary SỬ DỤNG fn_calculate_order_total
-- Tái cấu trúc chuẩn 3NF:
--   - Cột total_amount được tính toán trực tiếp qua hàm fn_calculate_order_total(o.id).
--   - Giữ nguyên cấu trúc các cột và kiểu dữ liệu tương thích hoàn toàn với API & Dashboard.
-- ============================================================================
DROP VIEW IF EXISTS vw_orders_summary CASCADE;
CREATE OR REPLACE VIEW vw_orders_summary AS
SELECT
    o.id,
    o.user_id,
    u.full_name                                     AS customer_name,
    u.phone                                         AS customer_phone,
    u.email                                         AS customer_email,
    o.delivery_address,
    o.customer_note,
    o.status,
    fn_calculate_order_total(o.id)::NUMERIC(12,2)   AS total_amount,
    COALESCE(SUM(oi.quantity), 0)::INT              AS item_count,
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

COMMENT ON VIEW vw_orders_summary IS 'View tổng hợp thông tin đơn hàng tích hợp tính toán tổng tiền động qua hàm fn_calculate_order_total(o.id) chuẩn 3NF.';
