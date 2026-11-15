-- ============================================================================
-- HỆ THỐNG ĐẶT ĐỒ ĂN TRỰC TUYẾN (ONLINE FOOD ORDERING SYSTEM)
-- File: database/02_triggers_and_procs.sql
-- Hệ quản trị CSDL: PostgreSQL 16 (PL/pgSQL)
-- Nội dung:
--   1. Trigger tự động cập nhật dấu thời gian `updated_at` (`users`, `foods`, `orders`)
--   2. Trigger kiểm toán & phát sự kiện thời gian thực `trg_order_status_audit`
--   3. Trigger đồng bộ thực đơn/tồn kho thời gian thực `trg_foods_realtime_notify`
--   4. Stored Procedure đặt đơn an toàn giao dịch `sp_create_order` (FOR UPDATE)
--   5. Stored Procedure chuyển trạng thái hữu hạn `sp_update_order_status` (FSM)
--   6. Stored Procedure thêm mới / cập nhật món ăn `sp_upsert_food`
-- ============================================================================

SET client_encoding = 'UTF8';

-- ============================================================================
-- PHẦN 1: TRIGGER TỰ ĐỘNG CẬP NHẬT `updated_at`
-- Đảm bảo tính nhất quán dữ liệu ở tầng CSDL dù cập nhật qua API hay SQL trực tiếp.
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_foods_set_updated_at ON foods;
CREATE TRIGGER trg_foods_set_updated_at
BEFORE UPDATE ON foods
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_set_updated_at ON orders;
CREATE TRIGGER trg_orders_set_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================================
-- PHẦN 2: TRIGGER KIỂM TOÁN TRẠNG THÁI ĐƠN HÀNG & BẮN SỰ KIỆN REAL-TIME
-- Tên Trigger: `trg_order_status_audit`
-- Cơ chế hoạt động:
--   - Kích hoạt `AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW`.
--   - Đọc ngữ cảnh phiên làm việc cục bộ (`app.changed_by`, `app.status_note`)
--     được truyền từ Stored Procedure qua `set_config(..., true)`.
--   - Ghi nhận tự động vào bảng `order_status_history` khi tạo mới (`NULL -> Pending`)
--     hoặc khi trạng thái thực sự thay đổi (`OLD.status IS DISTINCT FROM NEW.status`).
--   - Phát thông điệp JSON qua kênh `pg_notify('db_realtime_events', ...)`.
--     Lưu ý kiến trúc PostgreSQL: `pg_notify` mang tính giao dịch (Transactional) —
--     thông điệp chỉ thực sự phát tới Backend khi Transaction COMMIT thành công!
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_order_status_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_changed_by   INT;
    v_note         TEXT;
    v_old_status   VARCHAR(20) := NULL;
    v_should_audit BOOLEAN     := FALSE;
BEGIN
    -- Đọc thông tin người thao tác và ghi chú từ biến cấu hình phiên cục bộ (nếu có)
    v_changed_by := NULLIF(current_setting('app.changed_by', true), '')::INT;
    v_note       := NULLIF(current_setting('app.status_note', true), '');

    -- Phân nhánh theo TG_OP bằng PL/pgSQL thuần để không truy xuất bản ghi `OLD` khi INSERT
    IF TG_OP = 'INSERT' THEN
        v_old_status   := NULL;
        v_should_audit := TRUE;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old_status := OLD.status;
        IF OLD.status IS DISTINCT FROM NEW.status THEN
            v_should_audit := TRUE;
        END IF;
    END IF;

    -- Ghi lịch sử kiểm toán và bắn sự kiện Real-time khi tạo đơn hoặc đổi trạng thái
    IF v_should_audit THEN
        INSERT INTO order_status_history (
            order_id,
            old_status,
            new_status,
            changed_by,
            note,
            changed_at
        ) VALUES (
            NEW.id,
            v_old_status,
            NEW.status,
            v_changed_by,
            v_note,
            NOW()
        );

        PERFORM pg_notify(
            'db_realtime_events',
            json_build_object(
                'source',    'pg_trigger',
                'event',     'order_status_changed',
                'table',     'orders',
                'action',    TG_OP,
                'record_id', NEW.id,
                'data',      json_build_object(
                    'order_id',   NEW.id,
                    'old_status', v_old_status,
                    'new_status', NEW.status,
                    'changed_by', v_changed_by,
                    'note',       v_note
                ),
                'timestamp', NOW()
            )::TEXT
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_status_audit ON orders;
CREATE TRIGGER trg_order_status_audit
AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION fn_order_status_audit();

-- ============================================================================
-- PHẦN 3: TRIGGER ĐỒNG BỘ THỰC ĐƠN & TỒN KHO THỜI GIAN THỰC (`foods`)
-- Tên Trigger: `trg_foods_realtime_notify`
-- Cơ chế hoạt động:
--   - Kích hoạt `AFTER INSERT OR UPDATE OR DELETE ON foods FOR EACH ROW`.
--   - Bắn thông điệp JSON qua kênh `db_realtime_events` mỗi khi thêm món mới,
--     cập nhật giá/tồn kho (kể cả khi trừ kho lúc đặt đơn hoặc hoàn kho lúc hủy đơn),
--     hoặc xóa cứng món ăn chưa có lịch sử giao dịch.
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_foods_realtime_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_record foods%ROWTYPE;
    v_event  TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_record := OLD;
        v_event  := 'food_deleted';
    ELSIF TG_OP = 'INSERT' THEN
        v_record := NEW;
        v_event  := 'food_created';
    ELSE
        v_record := NEW;
        v_event  := 'food_updated';
    END IF;

    PERFORM pg_notify(
        'db_realtime_events',
        json_build_object(
            'source',    'pg_trigger',
            'event',     v_event,
            'table',     'foods',
            'action',    TG_OP,
            'record_id', v_record.id,
            'data',      json_build_object(
                'id',             v_record.id,
                'category_id',    v_record.category_id,
                'name',           v_record.name,
                'price',          v_record.price,
                'image_url',      v_record.image_url,
                'is_available',   v_record.is_available,
                'stock_quantity', v_record.stock_quantity
            ),
            'timestamp', NOW()
        )::TEXT
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_foods_realtime_notify ON foods;
CREATE TRIGGER trg_foods_realtime_notify
AFTER INSERT OR UPDATE OR DELETE ON foods
FOR EACH ROW
EXECUTE FUNCTION fn_foods_realtime_notify();

-- ============================================================================
-- PHẦN 4: STORED PROCEDURE ĐẶT ĐƠN HÀNG AN TOÀN ĐỒNG THỜI (`sp_create_order`)
-- Tham số:
--   - p_user_id          : ID người đặt hàng
--   - p_delivery_address : Địa chỉ nhận hàng của đơn (rỗng sẽ lấy default_address)
--   - p_customer_note    : Ghi chú chung của đơn hàng
--   - p_items            : Mảng JSONB [{"food_id": 1, "quantity": 2, "item_note": "..."}]
--   - p_order_id (INOUT) : Trả về ID đơn hàng vừa khởi tạo
-- Điểm nhấn kỹ thuật (Concurrency & ACID):
--   1. Gộp các mục trùng `food_id` trong JSON đầu vào và sắp xếp `ORDER BY food_id ASC`
--      trước khi khóa dòng `SELECT ... FOR UPDATE` nhằm TRIỆT TIÊU DEADLOCK khi nhiều
--      khách hàng đặt trùng tập món ăn ở cùng một thời điểm!
--   2. Kiểm tra nghiêm ngặt trạng thái mở bán (`is_available`) và tồn kho (`stock_quantity`).
--   3. Chốt đơn giá giao dịch lịch sử `order_items.unit_price := foods.price` đúng chuẩn 3NF.
-- ============================================================================
CREATE OR REPLACE PROCEDURE sp_create_order(
    p_user_id          INT,
    p_delivery_address TEXT,
    p_customer_note    TEXT,
    p_items            JSONB,
    INOUT p_order_id   INT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_default_address       TEXT;
    v_final_address         TEXT;
    v_item                  RECORD;
    v_food_id               INT;
    v_food_name             VARCHAR(150);
    v_unit_price            NUMERIC(12, 2);
    v_is_available          BOOLEAN;
    v_stock_quantity        INT;
    v_prior_orders_count    INT;
    v_is_returning_customer BOOLEAN;
    v_item_final_note       VARCHAR(255);
    v_audit_note            TEXT;
BEGIN
    -- 1. Kiểm tra người dùng tồn tại và xác định địa chỉ giao hàng
    SELECT default_address
    INTO v_default_address
    FROM users
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Người dùng ID=% không tồn tại trong hệ thống.', p_user_id
            USING ERRCODE = 'P0002';
    END IF;

    v_final_address := COALESCE(NULLIF(BTRIM(p_delivery_address), ''), NULLIF(BTRIM(v_default_address), ''));
    IF v_final_address IS NULL THEN
        RAISE EXCEPTION 'Địa chỉ giao hàng không được để trống.'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Kiểm tra cấu trúc mảng JSONB `p_items`
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Danh sách món đặt hàng (p_items) phải là mảng JSON không rỗng.'
            USING ERRCODE = '22023';
    END IF;

    -- Kiểm tra định dạng nguyên dương cho `food_id` và `quantity` trên từng phần tử JSON
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS elem
        WHERE CASE
            WHEN jsonb_typeof(elem) <> 'object' THEN TRUE
            WHEN COALESCE(elem->>'food_id', elem->>'foodId', '') !~ '^[1-9][0-9]*$' THEN TRUE
            WHEN COALESCE(elem->>'quantity', '') !~ '^[1-9][0-9]*$' THEN TRUE
            ELSE FALSE
        END
    ) THEN
        RAISE EXCEPTION 'Mỗi phần tử trong p_items phải có food_id nguyên dương và quantity nguyên dương (> 0).'
            USING ERRCODE = '22023';
    END IF;

    -- 3. Khóa dòng Pessimistic Locking (`FOR UPDATE`) theo thứ tự tăng dần `food_id`
    --    để chống Race Condition (bán âm kho) và chống Deadlock giữa các giao dịch đồng thời.
    FOR v_item IN
        SELECT
            COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT) AS food_id,
            SUM((elem->>'quantity')::INT)::INT                        AS total_qty
        FROM jsonb_array_elements(p_items) AS elem
        GROUP BY COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT)
        ORDER BY food_id ASC
    LOOP
        SELECT id, name, price, is_available, stock_quantity
        INTO v_food_id, v_food_name, v_unit_price, v_is_available, v_stock_quantity
        FROM foods
        WHERE id = v_item.food_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Món ăn có ID=% không tồn tại.', v_item.food_id
                USING ERRCODE = 'P0002';
        END IF;

        IF NOT v_is_available THEN
            RAISE EXCEPTION 'Món "%" (ID=%) hiện đang tạm ngưng phục vụ.', v_food_name, v_food_id
                USING ERRCODE = 'P0001';
        END IF;

        IF v_stock_quantity < v_item.total_qty THEN
            RAISE EXCEPTION 'Món "%" (ID=%) không đủ số lượng tồn kho (yêu cầu: %, còn lại: %).',
                v_food_name, v_food_id, v_item.total_qty, v_stock_quantity
                USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    -- Kiểm tra xem khách hàng này đã từng có đơn hàng trước đây hay chưa (chính sách tri ân giảm 10% khách quen)
    SELECT COUNT(*)
    INTO v_prior_orders_count
    FROM orders
    WHERE user_id = p_user_id;

    v_is_returning_customer := (v_prior_orders_count > 0);

    -- 4. Thiết lập ngữ cảnh kiểm toán cục bộ cho Trigger `trg_order_status_audit` và tạo đơn hàng
    IF v_is_returning_customer THEN
        v_audit_note := COALESCE(NULLIF(BTRIM(p_customer_note), ''), 'Khách hàng thân thiết quay lại (Áp dụng giảm 10% tri ân chuẩn 3NF)');
    ELSE
        v_audit_note := COALESCE(NULLIF(BTRIM(p_customer_note), ''), 'Khách hàng khởi tạo đơn hàng mới');
    END IF;

    PERFORM set_config('app.changed_by', p_user_id::TEXT, true);
    PERFORM set_config('app.status_note', v_audit_note, true);

    INSERT INTO orders (
        user_id,
        delivery_address,
        customer_note,
        status
    ) VALUES (
        p_user_id,
        v_final_address,
        NULLIF(BTRIM(p_customer_note), ''),
        'Pending'
    )
    RETURNING id INTO p_order_id;

    -- Xóa biến cấu hình tạm ngay sau khi Trigger đã đọc để tránh rò rỉ trong cùng Transaction
    PERFORM set_config('app.changed_by', '', true);
    PERFORM set_config('app.status_note', '', true);

    -- 5. Trừ tồn kho và thêm các dòng chi tiết `order_items` với đơn giá lịch sử snapshot (chuẩn 3NF)
    --    Nếu là khách quen: Giảm 10% đơn giá giao dịch lịch sử unit_price làm tròn về VNĐ
    FOR v_item IN
        SELECT
            COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT)                        AS food_id,
            SUM((elem->>'quantity')::INT)::INT                                               AS total_qty,
            STRING_AGG(NULLIF(BTRIM(COALESCE(elem->>'item_note', elem->>'note')), ''), '; ') AS merged_note
        FROM jsonb_array_elements(p_items) AS elem
        GROUP BY COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT)
        ORDER BY food_id ASC
    LOOP
        UPDATE foods
        SET stock_quantity = stock_quantity - v_item.total_qty
        WHERE id = v_item.food_id
        RETURNING price INTO v_unit_price;

        IF v_is_returning_customer THEN
            -- Giảm 10% đơn giá giao dịch lịch sử theo chuẩn 3NF: (order_id, food_id) -> unit_price
            v_unit_price := ROUND(v_unit_price * 0.90, 0);
            v_item_final_note := LEFT(
                CASE
                    WHEN v_item.merged_note IS NOT NULL AND v_item.merged_note <> ''
                    THEN '[Giảm 10% khách quen] ' || v_item.merged_note
                    ELSE '[Giảm 10% khách quen]'
                END, 255);
        ELSE
            v_item_final_note := LEFT(v_item.merged_note, 255);
        END IF;

        INSERT INTO order_items (
            order_id,
            food_id,
            quantity,
            unit_price,
            item_note
        ) VALUES (
            p_order_id,
            v_item.food_id,
            v_item.total_qty,
            v_unit_price,
            v_item_final_note
        );
    END LOOP;
END;
$$;

-- ============================================================================
-- PHẦN 5: STORED PROCEDURE CẬP NHẬT TRẠNG THÁI ĐƠN HÀNG (`sp_update_order_status`)
-- Máy trạng thái hữu hạn (Finite State Machine - FSM):
--   - Luồng chuẩn: Pending -> Preparing -> Delivering -> Completed
--   - Nhánh hủy : Pending -> Cancelled | Preparing -> Cancelled | Delivering -> Cancelled
--   - Hoàn kho  : Tự động hoàn lại `stock_quantity` nếu hủy đơn từ `Pending` hoặc `Preparing`
--                 (khi món ăn chưa xuất khỏi bếp đi giao).
--   - Cờ `p_force = TRUE`: Cho phép Admin cưỡng chế bỏ qua kiểm tra luồng FSM khi xử lý sự cố.
-- ============================================================================
CREATE OR REPLACE PROCEDURE sp_update_order_status(
    p_order_id   INT,
    p_new_status VARCHAR,
    p_changed_by INT     DEFAULT NULL,
    p_note       TEXT    DEFAULT NULL,
    p_force      BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_old_status VARCHAR(20);
    v_is_valid   BOOLEAN := FALSE;
    v_line       RECORD;
BEGIN
    -- 1. Kiểm tra miền giá trị trạng thái đích
    IF p_new_status IS NULL OR p_new_status NOT IN ('Pending', 'Preparing', 'Delivering', 'Completed', 'Cancelled') THEN
        RAISE EXCEPTION 'Trạng thái mới "%" không hợp lệ (chỉ chấp nhận: Pending, Preparing, Delivering, Completed, Cancelled).',
            COALESCE(p_new_status, 'NULL')
            USING ERRCODE = '22023';
    END IF;

    -- 2. Kiểm tra người thực hiện thay đổi (nếu được truyền vào)
    IF p_changed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = p_changed_by) THEN
        RAISE EXCEPTION 'Người thực hiện thay đổi (ID=%) không tồn tại.', p_changed_by
            USING ERRCODE = 'P0002';
    END IF;

    -- 3. Khóa bản ghi đơn hàng cần chuyển trạng thái
    SELECT status
    INTO v_old_status
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Đơn hàng ID=% không tồn tại.', p_order_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Trạng thái không đổi
    IF v_old_status = p_new_status THEN
        IF COALESCE(p_force, FALSE) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'Đơn hàng ID=% hiện đã ở trạng thái "%".', p_order_id, p_new_status
            USING ERRCODE = 'P0001';
    END IF;

    -- 4. Kiểm tra quy tắc chuyển trạng thái FSM (trừ khi bật p_force = TRUE)
    IF NOT COALESCE(p_force, FALSE) THEN
        v_is_valid := CASE
            WHEN v_old_status = 'Pending'    AND p_new_status IN ('Preparing', 'Cancelled')  THEN TRUE
            WHEN v_old_status = 'Preparing'  AND p_new_status IN ('Delivering', 'Cancelled') THEN TRUE
            WHEN v_old_status = 'Delivering' AND p_new_status IN ('Completed', 'Cancelled')  THEN TRUE
            ELSE FALSE
        END;

        IF NOT v_is_valid THEN
            RAISE EXCEPTION 'Chuyển trạng thái không hợp lệ cho đơn hàng ID=%: "%" -> "%". Luồng hợp lệ: Pending -> Preparing -> Delivering -> Completed (hoặc -> Cancelled).',
                p_order_id, v_old_status, p_new_status
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- 5. Hoàn trả tồn kho nếu hủy đơn từ trạng thái `Pending` hoặc `Preparing`
    --    (Cập nhật `foods` theo thứ tự `food_id ASC` để đồng nhất chiến lược chống Deadlock)
    IF p_new_status = 'Cancelled' AND v_old_status IN ('Pending', 'Preparing') THEN
        FOR v_line IN
            SELECT oi.food_id, oi.quantity
            FROM order_items oi
            WHERE oi.order_id = p_order_id
            ORDER BY oi.food_id ASC
        LOOP
            UPDATE foods
            SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.food_id;
        END LOOP;
    END IF;

    -- 6. Truyền metadata vào cấu hình phiên cục bộ và cập nhật `orders`
    --    Trigger `trg_order_status_audit` sẽ tự động ghi `order_status_history` & bắn `pg_notify`
    PERFORM set_config('app.changed_by', COALESCE(p_changed_by::TEXT, ''), true);
    PERFORM set_config('app.status_note', COALESCE(NULLIF(BTRIM(p_note), ''), ''), true);

    UPDATE orders
    SET status = p_new_status
    WHERE id = p_order_id;

    PERFORM set_config('app.changed_by', '', true);
    PERFORM set_config('app.status_note', '', true);
END;
$$;

-- ============================================================================
-- PHẦN 6: STORED PROCEDURE THÊM MỚI / CẬP NHẬT MÓN ĂN (`sp_upsert_food`)
-- Tham số:
--   - p_food_id (INOUT) : NULL (hoặc <= 0) để thêm món mới và nhận lại ID mới;
--                         truyền ID dương để cập nhật món hiện có (hoặc chèn mới nếu chưa có).
-- ============================================================================
CREATE OR REPLACE PROCEDURE sp_upsert_food(
    INOUT p_food_id    INT,
    p_category_id      INT,
    p_name             VARCHAR,
    p_description      TEXT,
    p_price            NUMERIC,
    p_image_url        TEXT,
    p_is_available     BOOLEAN DEFAULT TRUE,
    p_stock_quantity   INT     DEFAULT 50
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- 1. Kiểm tra dữ liệu đầu vào
    IF p_name IS NULL OR BTRIM(p_name) = '' THEN
        RAISE EXCEPTION 'Tên món ăn không được để trống.'
            USING ERRCODE = '22023';
    END IF;

    IF p_price IS NULL OR p_price < 0 THEN
        RAISE EXCEPTION 'Giá món ăn phải lớn hơn hoặc bằng 0.'
            USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_stock_quantity, 50) < 0 THEN
        RAISE EXCEPTION 'Số lượng tồn kho không được âm.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_category_id) THEN
        RAISE EXCEPTION 'Danh mục món ăn ID=% không tồn tại.', p_category_id
            USING ERRCODE = 'P0002';
    END IF;

    -- 2. Thực hiện INSERT mới hoặc UPDATE theo `p_food_id`
    IF p_food_id IS NULL OR p_food_id <= 0 THEN
        INSERT INTO foods (
            category_id,
            name,
            description,
            price,
            image_url,
            is_available,
            stock_quantity
        ) VALUES (
            p_category_id,
            BTRIM(p_name),
            NULLIF(BTRIM(p_description), ''),
            ROUND(p_price, 2),
            NULLIF(BTRIM(p_image_url), ''),
            COALESCE(p_is_available, TRUE),
            COALESCE(p_stock_quantity, 50)
        )
        RETURNING id INTO p_food_id;
    ELSE
        UPDATE foods
        SET category_id    = p_category_id,
            name           = BTRIM(p_name),
            description    = NULLIF(BTRIM(p_description), ''),
            price          = ROUND(p_price, 2),
            image_url      = NULLIF(BTRIM(p_image_url), ''),
            is_available   = COALESCE(p_is_available, TRUE),
            stock_quantity = COALESCE(p_stock_quantity, 50)
        WHERE id = p_food_id;

        IF NOT FOUND THEN
            INSERT INTO foods (
                id,
                category_id,
                name,
                description,
                price,
                image_url,
                is_available,
                stock_quantity
            ) VALUES (
                p_food_id,
                p_category_id,
                BTRIM(p_name),
                NULLIF(BTRIM(p_description), ''),
                ROUND(p_price, 2),
                NULLIF(BTRIM(p_image_url), ''),
                COALESCE(p_is_available, TRUE),
                COALESCE(p_stock_quantity, 50)
            )
            RETURNING id INTO p_food_id;

            PERFORM setval(
                pg_get_serial_sequence('foods', 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 1) FROM foods), 1),
                true
            );
        END IF;
    END IF;
END;
$$;
