-- ============================================================================
-- HỆ THỐNG ĐẶT ĐỒ ĂN TRỰC TUYẾN (ONLINE FOOD ORDERING SYSTEM)
-- File: database/06_flash_sale_schema.sql
-- Sự kiện đặc biệt: FLASH SALE 1K GIỜ VÀNG (1:00, 2:00, 3:00...)
-- Chuẩn thiết kế: Chuẩn 3NF nghiêm ngặt (Strict Third Normal Form)
-- ============================================================================

SET client_encoding = 'UTF8';

-- 1. BẢNG `flash_sale_slots`: Quản lý các khung giờ mở bán Flash Sale
-- Phụ thuộc hàm: id -> {title, slot_hour, start_time, end_time, status, created_at, updated_at}
-- Đạt chuẩn 3NF: Mỗi thuộc tính chỉ phụ thuộc vào khóa chính id.
CREATE TABLE IF NOT EXISTS flash_sale_slots (
    id          SERIAL          PRIMARY KEY,
    title       VARCHAR(150)    NOT NULL DEFAULT 'Flash Sale Chớp Nhoáng 1K Giờ Vàng',
    slot_hour   INT             NOT NULL, -- Giờ trong ngày (0 - 23, ví dụ: 1 = 1:00, 2 = 2:00, 3 = 3:00)
    start_time  TIMESTAMPTZ     NOT NULL,
    end_time    TIMESTAMPTZ     NOT NULL,
    status      VARCHAR(20)     NOT NULL DEFAULT 'upcoming',
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_flash_sale_slots_status 
        CHECK (status IN ('upcoming', 'active', 'ended')),
    CONSTRAINT chk_flash_sale_slots_time 
        CHECK (end_time > start_time),
    CONSTRAINT chk_flash_sale_slots_hour
        CHECK (slot_hour >= 0 AND slot_hour <= 23)
);

COMMENT ON TABLE flash_sale_slots IS 'Khung giờ diễn ra sự kiện Flash Sale (1:00, 2:00, 3:00... chuẩn 3NF).';

-- 2. BẢNG `flash_sale_items`: 10 món ăn được trợ giá 1.000đ trong mỗi khung giờ
-- Mỗi món số lượng đúng 1 suất (stock_quantity = 1, sold_quantity = 0 hoặc 1).
-- Khóa dự tuyển tự nhiên: (slot_id, food_id) -> Đạt chuẩn 3NF & BCNF.
CREATE TABLE IF NOT EXISTS flash_sale_items (
    id              SERIAL          PRIMARY KEY,
    slot_id         INT             NOT NULL,
    food_id         INT             NOT NULL,
    sale_price      NUMERIC(12, 2)  NOT NULL DEFAULT 1000.00,
    original_price  NUMERIC(12, 2)  NOT NULL,
    stock_quantity  INT             NOT NULL DEFAULT 1,
    sold_quantity   INT             NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_flash_sale_items_slot_food 
        UNIQUE (slot_id, food_id),
    CONSTRAINT fk_flash_sale_items_slot 
        FOREIGN KEY (slot_id) REFERENCES flash_sale_slots(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    CONSTRAINT fk_flash_sale_items_food 
        FOREIGN KEY (food_id) REFERENCES foods(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_flash_sale_items_price 
        CHECK (sale_price >= 0),
    CONSTRAINT chk_flash_sale_items_stock 
        CHECK (stock_quantity >= 0),
    CONSTRAINT chk_flash_sale_items_sold 
        CHECK (sold_quantity >= 0),
    CONSTRAINT chk_flash_sale_items_quota 
        CHECK (stock_quantity + sold_quantity = 1) -- Đảm bảo mỗi món đúng 1 suất
);

COMMENT ON TABLE flash_sale_items IS 'Chi tiết các món trợ giá 1K trong từng phiên Flash Sale (Mỗi món số lượng 1).';

-- 3. LIÊN KẾT `order_items` VỚI `flash_sale_items`
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'order_items' AND column_name = 'flash_sale_item_id'
    ) THEN
        ALTER TABLE order_items 
        ADD COLUMN flash_sale_item_id INT REFERENCES flash_sale_items(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'order_items' AND column_name = 'is_flash_sale'
    ) THEN
        ALTER TABLE order_items 
        ADD COLUMN is_flash_sale BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- 4. VIEW TỔNG HỢP FLASH SALE ACTIVE: `vw_flash_sale_active`
CREATE OR REPLACE VIEW vw_flash_sale_active AS
SELECT 
    fsi.id AS flash_sale_item_id,
    fsi.slot_id,
    fss.title AS slot_title,
    fss.slot_hour,
    fss.start_time,
    fss.end_time,
    fss.status AS slot_status,
    EXTRACT(EPOCH FROM (fss.end_time - NOW()))::INT AS seconds_remaining,
    fsi.food_id,
    f.name AS food_name,
    f.image_url,
    f.description AS food_description,
    c.id AS category_id,
    c.name AS category_name,
    fsi.sale_price,
    fsi.original_price,
    fsi.stock_quantity,
    fsi.sold_quantity,
    (fsi.stock_quantity > 0 AND f.is_available = TRUE) AS is_claimable,
    fsi.created_at
FROM flash_sale_items fsi
INNER JOIN flash_sale_slots fss ON fss.id = fsi.slot_id
INNER JOIN foods f ON f.id = fsi.food_id
INNER JOIN categories c ON c.id = f.category_id
ORDER BY fsi.stock_quantity DESC, fsi.id ASC;

-- 5. TRIGGER BẮN SỰ KIỆN REAL-TIME KHI TỒN KHO FLASH SALE THAY ĐỔI
CREATE OR REPLACE FUNCTION fn_flash_sale_realtime_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify(
        'db_realtime_events',
        json_build_object(
            'source',    'pg_trigger',
            'event',     'flash_sale_updated',
            'table',     'flash_sale_items',
            'action',    TG_OP,
            'record_id', NEW.id,
            'data',      json_build_object(
                'flash_sale_item_id', NEW.id,
                'slot_id',            NEW.slot_id,
                'food_id',            NEW.food_id,
                'sale_price',         NEW.sale_price,
                'stock_quantity',     NEW.stock_quantity,
                'sold_quantity',      NEW.sold_quantity,
                'is_sold_out',        (NEW.stock_quantity = 0)
            ),
            'timestamp', NOW()
        )::TEXT
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flash_sale_items_notify ON flash_sale_items;
CREATE TRIGGER trg_flash_sale_items_notify
AFTER INSERT OR UPDATE ON flash_sale_items
FOR EACH ROW
EXECUTE FUNCTION fn_flash_sale_realtime_notify();

-- 6. PROCEDURE KÍCH HOẠT / KHỞI TẠO PHIÊN FLASH SALE (CÓ 10 MÓN GIÁ 1K, SỐ LƯỢNG 1)
CREATE OR REPLACE PROCEDURE sp_activate_flash_sale_slot(
    p_slot_hour     INT DEFAULT NULL,
    INOUT p_slot_id INT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_hour INT;
    v_start_time  TIMESTAMPTZ;
    v_end_time    TIMESTAMPTZ;
    v_food        RECORD;
    v_count       INT := 0;
BEGIN
    -- Mặc định lấy giờ hiện tại nếu không truyền vào
    IF p_slot_hour IS NULL THEN
        v_target_hour := EXTRACT(HOUR FROM NOW())::INT;
    ELSE
        v_target_hour := p_slot_hour % 24;
    END IF;

    -- Đặt thời gian diễn ra: Từ thời điểm hiện tại kéo dài 60 phút
    v_start_time := NOW();
    v_end_time   := NOW() + INTERVAL '60 minutes';

    -- Đóng các slot cũ đang active
    UPDATE flash_sale_slots
    SET status = 'ended', updated_at = NOW()
    WHERE status = 'active';

    -- Tạo slot mới
    INSERT INTO flash_sale_slots (
        title,
        slot_hour,
        start_time,
        end_time,
        status
    ) VALUES (
        '🔥 FLASH SALE 1K - GIỜ VÀNG ' || LPAD(v_target_hour::TEXT, 2, '0') || ':00',
        v_target_hour,
        v_start_time,
        v_end_time,
        'active'
    )
    RETURNING id INTO p_slot_id;

    -- Chọn ra đúng 10 món ngon tiêu biểu từ bảng foods để đưa vào Flash Sale giá 1k
    FOR v_food IN
        SELECT id, price
        FROM foods
        WHERE is_available = TRUE
        ORDER BY id ASC
        LIMIT 10
    LOOP
        INSERT INTO flash_sale_items (
            slot_id,
            food_id,
            sale_price,
            original_price,
            stock_quantity,
            sold_quantity
        ) VALUES (
            p_slot_id,
            v_food.id,
            1000.00,
            v_food.price,
            1, -- Mỗi món số lượng 1
            0  -- Chưa bán
        );
        v_count := v_count + 1;
    END LOOP;

    -- Bắn thông báo real-time qua SSE/WS
    PERFORM pg_notify(
        'db_realtime_events',
        json_build_object(
            'source',    'pg_trigger',
            'event',     'flash_sale_started',
            'table',     'flash_sale_slots',
            'action',    'INSERT',
            'record_id', p_slot_id,
            'data',      json_build_object(
                'slot_id',     p_slot_id,
                'slot_hour',   v_target_hour,
                'items_count', v_count,
                'start_time',  v_start_time,
                'end_time',    v_end_time
            ),
            'timestamp', NOW()
        )::TEXT
    );
END;
$$;

-- 7. CẬP NHẬT `sp_create_order` HỖ TRỢ ĐẶT MÓN FLASH SALE 1K (CHỐNG RACE CONDITION BẰNG FOR UPDATE)
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
    v_is_flash_sale         BOOLEAN;
    v_fsi_id                INT;
    v_fsi_stock             INT;
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

    -- Tự động cập nhật địa chỉ giao hàng mặc định cho khách hàng
    UPDATE users
    SET default_address = v_final_address,
        updated_at = NOW()
    WHERE id = p_user_id
      AND (default_address IS DISTINCT FROM v_final_address);

    -- 2. Kiểm tra cấu trúc mảng JSONB `p_items`
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Danh sách món đặt hàng (p_items) phải là mảng JSON không rỗng.'
            USING ERRCODE = '22023';
    END IF;

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

    -- Kiểm tra xem khách hàng này đã từng có đơn hàng nào trước đây hay chưa
    SELECT COUNT(*)
    INTO v_prior_orders_count
    FROM orders
    WHERE user_id = p_user_id;

    v_is_returning_customer := (v_prior_orders_count > 0);

    -- 3. Khóa dòng Pessimistic Locking (`FOR UPDATE`) theo thứ tự tăng dần `food_id`
    FOR v_item IN
        SELECT
            COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT) AS food_id,
            SUM((elem->>'quantity')::INT)::INT                        AS total_qty,
            BOOL_OR(COALESCE((elem->>'is_flash_sale')::BOOLEAN, (elem->>'isFlashSale')::BOOLEAN, FALSE)) AS is_flash_sale
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

        -- Nếu là món Flash Sale 1K: Khóa dòng kiểm tra tồn kho Flash Sale độc quyền
        IF v_item.is_flash_sale THEN
            SELECT fsi.id, fsi.stock_quantity
            INTO v_fsi_id, v_fsi_stock
            FROM flash_sale_items fsi
            INNER JOIN flash_sale_slots fss ON fss.id = fsi.slot_id
            WHERE fsi.food_id = v_item.food_id AND fss.status = 'active'
            FOR UPDATE;

            IF NOT FOUND OR v_fsi_stock < v_item.total_qty THEN
                RAISE EXCEPTION 'Suất Flash Sale 1K của món "%" vừa có người nhanh tay hơn chốt đơn rồi!', v_food_name
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;
    END LOOP;

    -- 4. Thiết lập ngữ cảnh kiểm toán và ghi nhận đơn hàng
    IF v_is_returning_customer THEN
        v_audit_note := COALESCE(NULLIF(BTRIM(p_customer_note), ''), 'Khách hàng thân thiết quay lại (Áp dụng giảm 10% tri ân)');
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

    PERFORM set_config('app.changed_by', '', true);
    PERFORM set_config('app.status_note', '', true);

    -- 5. Trừ tồn kho và thêm chi tiết `order_items` với đơn giá lịch sử
    FOR v_item IN
        SELECT
            COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT)                        AS food_id,
            SUM((elem->>'quantity')::INT)::INT                                               AS total_qty,
            STRING_AGG(NULLIF(BTRIM(COALESCE(elem->>'item_note', elem->>'note')), ''), '; ') AS merged_note,
            BOOL_OR(COALESCE((elem->>'is_flash_sale')::BOOLEAN, (elem->>'isFlashSale')::BOOLEAN, FALSE)) AS is_flash_sale
        FROM jsonb_array_elements(p_items) AS elem
        GROUP BY COALESCE((elem->>'food_id')::INT, (elem->>'foodId')::INT)
        ORDER BY food_id ASC
    LOOP
        -- Trừ kho chính của món
        UPDATE foods
        SET stock_quantity = stock_quantity - v_item.total_qty
        WHERE id = v_item.food_id
        RETURNING price INTO v_unit_price;

        v_fsi_id := NULL;

        -- XỬ LÝ ĐƠN GIÁ THEO ĐIỀU KIỆN
        IF v_item.is_flash_sale THEN
            -- MÓN FLASH SALE: Giá cố định đúng 1.000 VNĐ!
            SELECT fsi.id INTO v_fsi_id
            FROM flash_sale_items fsi
            INNER JOIN flash_sale_slots fss ON fss.id = fsi.slot_id
            WHERE fsi.food_id = v_item.food_id AND fss.status = 'active';

            IF v_fsi_id IS NOT NULL THEN
                UPDATE flash_sale_items
                SET stock_quantity = stock_quantity - v_item.total_qty,
                    sold_quantity  = sold_quantity + v_item.total_qty,
                    updated_at     = NOW()
                WHERE id = v_fsi_id;

                v_unit_price := 1000.00;
                v_item_final_note := LEFT(
                    CASE 
                        WHEN v_item.merged_note IS NOT NULL AND v_item.merged_note <> ''
                        THEN '[⚡ Flash Sale 1K] ' || v_item.merged_note
                        ELSE '[⚡ Flash Sale 1K]'
                    END, 255);
            END IF;
        ELSIF v_is_returning_customer THEN
            -- Khách cũ: Giảm 10%
            v_unit_price := ROUND(v_unit_price * 0.90, 0);
            v_item_final_note := LEFT(
                CASE
                    WHEN v_item.merged_note IS NOT NULL AND v_item.merged_note <> ''
                    THEN '[Giảm 10% khách cũ] ' || v_item.merged_note
                    ELSE '[Giảm 10% khách cũ]'
                END, 255);
        ELSE
            v_item_final_note := LEFT(v_item.merged_note, 255);
        END IF;

        -- Ghi chi tiết đơn hàng
        INSERT INTO order_items (
            order_id,
            food_id,
            quantity,
            unit_price,
            item_note,
            flash_sale_item_id,
            is_flash_sale
        ) VALUES (
            p_order_id,
            v_item.food_id,
            v_item.total_qty,
            v_unit_price,
            v_item_final_note,
            v_fsi_id,
            COALESCE(v_item.is_flash_sale, FALSE)
        );
    END LOOP;
END;
$$;

-- 8. THIẾT LẬP NGAY PHIÊN FLASH SALE CHO THỜI ĐIỂM HIỆN TẠI (10 MÓN GIÁ 1K)
DO $$
DECLARE
    v_new_slot_id INT;
BEGIN
    CALL sp_activate_flash_sale_slot(EXTRACT(HOUR FROM NOW())::INT, v_new_slot_id);
    RAISE NOTICE 'Đã khởi tạo thành công phiên Flash Sale 1K slot_id=%', v_new_slot_id;
END $$;
