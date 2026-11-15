-- ============================================================================
-- MIGRATION: SEED EXTRA FOODS, EXTRA CUSTOMERS & RETURNING CUSTOMER 10% DISCOUNT
-- ============================================================================

-- 1. UPDATE PROCEDURE sp_create_order TO APPLY 10% DISCOUNT FOR RETURNING CUSTOMERS
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
    -- NẾU LÀ KHÁCH HÀNG CŨ QUAY LẠI: GIẢM GIÁ 10% ĐƠN GIÁ TỪNG MÓN!
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
            -- Giảm 10% làm tròn về hàng đơn vị VNĐ
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

-- 2. SEED 30 CUSTOMERS
INSERT INTO users (full_name, email, phone, role, default_address)
VALUES
    ('Nguyễn Hoàng Nam', 'nam.nguyen@gmail.com', '0912345601', 'customer', '15 Tràng Tiền, Hoàn Kiếm, Hà Nội'),
    ('Lê Thị Mai Anh', 'maianh.le@gmail.com', '0983456702', 'customer', '45 Lê Lợi, Quận 1, TP.HCM'),
    ('Trần Quốc Bảo', 'quocbao.tran@gmail.com', '0974567803', 'customer', '78 Nguyễn Huệ, Quận 1, TP.HCM'),
    ('Đỗ Minh Đức', 'minhduc.do@gmail.com', '0905678904', 'customer', '102 Cầu Giấy, Cầu Giấy, Hà Nội'),
    ('Vũ Thu Thảo', 'thuthao.vu@gmail.com', '0916789005', 'customer', '22 Bạch Đằng, Hải Châu, Đà Nẵng'),
    ('Phan Hải Đăng', 'haidang.phan@gmail.com', '0987890106', 'customer', '64 Phan Xích Long, Phú Nhuận, TP.HCM'),
    ('Bùi Phương Linh', 'phuonglinh.bui@gmail.com', '0978901207', 'customer', '89 Nguyễn Tri Phương, Quận 5, TP.HCM'),
    ('Hoàng Trọng Khang', 'trongkhang.hoang@gmail.com', '0909012308', 'customer', '31 Võ Văn Ngân, TP. Thủ Đức, TP.HCM'),
    ('Ngô Bích Ngọc', 'bichngoc.ngo@gmail.com', '0910123409', 'customer', '12 Hoàng Hoa Thám, Ba Đình, Hà Nội'),
    ('Đặng Quang Huy', 'quanghuy.dang@gmail.com', '0981234510', 'customer', '55 Trần Hưng Đạo, Quận 5, TP.HCM'),
    ('Trương Mỹ Duyên', 'myduyen.truong@gmail.com', '0972345611', 'customer', '14 Nguyễn Văn Cừ, Quận 5, TP.HCM'),
    ('Đinh Thế Vinh', 'thevinh.dinh@gmail.com', '0903456712', 'customer', '80 Xuân Thủy, Cầu Giấy, Hà Nội'),
    ('Dương Gia Hân', 'giahan.duong@gmail.com', '0914567813', 'customer', '200 Điện Biên Phủ, Bình Thạnh, TP.HCM'),
    ('Lâm Kiến Quốc', 'kienquoc.lam@gmail.com', '0985678914', 'customer', '33 Pasteur, Bến Nghé, Quận 1, TP.HCM'),
    ('Tạ Khánh Huyền', 'khanhhuyen.ta@gmail.com', '0976789015', 'customer', '99 Kim Mã, Ba Đình, Hà Nội'),
    ('Đoàn Thanh Tùng', 'thanhtung.doan@gmail.com', '0907890116', 'customer', '180 Hai Bà Trưng, Quận 3, TP.HCM'),
    ('Huỳnh Diệu Linh', 'dieulinh.huynh@gmail.com', '0918901217', 'customer', '42 Hùng Vương, Hải Châu, Đà Nẵng'),
    ('Lương Anh Tuấn', 'anhtuan.luong@gmail.com', '0989012318', 'customer', '110 Tôn Đức Thắng, Đống Đa, Hà Nội'),
    ('Mai Phương Thúy', 'phuongthuy.mai@gmail.com', '0970123419', 'customer', '15 Nguyễn Thị Minh Khai, Quận 1, TP.HCM'),
    ('Trịnh Công Minh', 'congminh.trinh@gmail.com', '0901234520', 'customer', '250 Cách Mạng Tháng 8, Quận 3, TP.HCM'),
    ('Chu Thị Ánh Tuyết', 'anhtuyet.chu@gmail.com', '0912345621', 'customer', '68 Lý Tự Trọng, Quận 1, TP.HCM'),
    ('Nghiêm Bá Đạt', 'badat.nghiem@gmail.com', '0983456722', 'customer', '36 Láng Hạ, Đống Đa, Hà Nội'),
    ('Hồ Bảo Trâm', 'baotram.ho@gmail.com', '0974567823', 'customer', '50 Phạm Ngọc Thạch, Quận 3, TP.HCM'),
    ('Quách Gia Huy', 'giahuy.quach@gmail.com', '0905678924', 'customer', '12 Đinh Tiên Hoàng, Quận 1, TP.HCM'),
    ('Tiêu Hồng Phúc', 'hongphuc.tieu@gmail.com', '0916789025', 'customer', '75 Nguyễn Đình Chiểu, Quận 3, TP.HCM'),
    ('Khổng Minh Trí', 'minhtri.khong@gmail.com', '0987890126', 'customer', '88 Giải Phóng, Hai Bà Trưng, Hà Nội'),
    ('Đào Thu Trang', 'thutrang.dao@gmail.com', '0978901227', 'customer', '92 Trần Phú, Hải Châu, Đà Nẵng'),
    ('Cao Tiến Đạt', 'tiendat.cao@gmail.com', '0909012328', 'customer', '105 Bà Huyện Thanh Quan, Quận 3, TP.HCM'),
    ('Thân Hồng Nhung', 'hongnhung.than@gmail.com', '0910123429', 'customer', '14 Phố Huế, Hoàn Kiếm, Hà Nội'),
    ('Lục Văn Sáng', 'vansang.luc@gmail.com', '0981234530', 'customer', '210 Võ Thị Sáu, Quận 3, TP.HCM')
ON CONFLICT (email) DO NOTHING;

-- 3. SEED 24 MORE DISHES (FOODS)
INSERT INTO foods (category_id, name, description, price, image_url, is_available, stock_quantity)
VALUES
    -- Phở & Bún (category_id = 1)
    (1, 'Phở Gà Ta Đồi Trứng Non', 'Thịt gà ta thả đồi da vàng giòn sần sật, nước dùng gà thanh ngọt kèm chùm trứng non béo bùi.', 60000, 'https://images.unsplash.com/photo-1594998893017-36147cbcae05?auto=format&fit=crop&w=800&q=80', true, 50),
    (1, 'Phở Bò Sốt Vang Bánh Mì', 'Nạm gầu bò hầm mềm quyện sốt vang rượu đỏ đậm đà, thơm nồng quế hồi hoa hồi Hà Nội.', 68000, 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=800&q=80', true, 45),
    (1, 'Bún Riêu Cua Đồng Bắp Bò', 'Cua đồng giã tay đóng tảng chắc thịt, cà chua chín mọng, bắp bò hoa chần tái và đậu mơ chiên giòn.', 58000, 'https://images.unsplash.com/photo-1617093727343-374698b1b08d?auto=format&fit=crop&w=800&q=80', true, 40),
    (1, 'Bún Đậu Mắm Tôm Thập Cẩm', 'Mẹt bún lá ăn kèm chả cốm làng Vòng chiên giòn, thịt chân giò luộc, dồi sụn và mắm tôm Thanh Hóa pha chanh sủi bọt.', 65000, 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=800&q=80', true, 60),
    (1, 'Hủ Tiếu Nam Vang Sườn Tôm', 'Sợi hủ tiếu dai tơi, nước dùng ninh mực nướng ngọt thanh cùng tôm sú tươi, sườn non và trứng cút lòng đào.', 62000, 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=800&q=80', true, 55),
    (1, 'Bún Chả Que Tre Hà Nội', 'Thịt ba chỉ và chả viên kẹp que tre nướng than hoa thơm lừng chấm nước mắm giấm tỏi ớt đu đủ giòn.', 60000, 'https://images.unsplash.com/photo-1559314809-0d155014e29e?auto=format&fit=crop&w=800&q=80', true, 50),

    -- Cơm Việt (category_id = 2)
    (2, 'Cơm Niêu Cá Bống Kho Tộ Miền Tây', 'Cơm cháy đáy nồi gang giòn rụm, cá bống kho tiêu ớt keo lại cay mặn chuẩn gu sông nước Nam Bộ.', 68000, 'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=800&q=80', true, 45),
    (2, 'Cơm Tấm Sườn Cây Khổng Lồ', 'Miếng sườn cây ướp mật ong rừng nướng xém cạnh mọng nước, dùng kèm trứng ốp la lòng đào và mỡ hành giòn.', 75000, 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=800&q=80', true, 60),
    (2, 'Cơm Rang Dưa Bò Hà Thành', 'Hạt cơm vàng săn tơi giòn tan đảo cùng thăn bò mềm ngọt và dưa cải muối chua xào tỏi hoa tiêu.', 55000, 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=800&q=80', true, 70),
    (2, 'Cơm Chiên Dương Châu Hải Sản', 'Cơm chiên hạt ngọc hòa quyện tôm nõn, mực tươi, lạp xưởng Mai Quế Lộ, cà rốt và đậu Hà Lan ngọt bùi.', 52000, 'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=800&q=80', true, 55),
    (2, 'Cơm Thố Bò Xào Nấm Kim Châm', 'Thịt bò phi lê xào lửa lớn với nấm kim châm, hành tây và nước xốt dầu hào thơm lừng trong thố đá nóng giữ nhiệt.', 65000, 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80', true, 50),
    (2, 'Cơm Cháy Kho Quẹt Tôm Tóp Mỡ', 'Đĩa cơm cháy giòn rụm chấm nước mắm kho quẹt sền sệt đậm đà cùng tôm khô Cà Mau và tóp mỡ béo giòn.', 48000, 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80', true, 65),

    -- Bánh Mì & Cuốn (category_id = 3)
    (3, 'Bánh Mì Chảo Bò Né Trứng Xíu Mại', 'Chảo gang nóng sôi xèo xèo gồm thăn bò mềm, trứng ốp la, pate gan béo ngậy, phô mai và viên xíu mại sốt cà chua.', 55000, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=800&q=80', true, 50),
    (3, 'Bánh Mì Heo Quay Giòn Bì', 'Thịt ba chỉ heo quay nổ bì giòn tan kết hợp nước xốt ngũ vị đậm đà, dưa leo giòn mát và ớt hiểm cay nồng.', 38000, 'https://images.unsplash.com/photo-1600454309261-3dc9b7597637?auto=format&fit=crop&w=800&q=80', true, 60),
    (3, 'Nem Nướng Nha Trang Cuốn Bánh Tráng', 'Phần mẹt gồm nem nướng than hồng, bánh tráng chiên giòn, xoài non, chuối chát và nước chấm tương nếp thịt băm bí truyền.', 65000, 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?auto=format&fit=crop&w=800&q=80', true, 45),
    (3, 'Bánh Xèo Miền Tây Tôm Thịt Giá Đỗ', 'Vỏ bánh mỏng vàng giòn rụm thơm nước cốt dừa bọc nhân tôm sú, thịt ba chỉ, ăn kèm rau rừng Tây Ninh tươi mát.', 50000, 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?auto=format&fit=crop&w=800&q=80', true, 40),
    (3, 'Phở Cuốn Bò Rau Mùi Tây Hồ', 'Bánh phở tươi mềm mịn cuộn bắp bò xào lăn chín tới, rau mùi thơm mát chấm nước mắm chua ngọt chuẩn vị Trúc Bạch.', 48000, 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=800&q=80', true, 55),
    (3, 'Bánh Cuốn Nóng Chả Mực Hạ Long', 'Bánh tráng mỏng mềm mướt rắc hành phi thơm nức mũi ăn kèm chả mực giã tay giòn sần sật và nước mắm ớt thơm.', 45000, 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?auto=format&fit=crop&w=800&q=80', true, 50),

    -- Trà & Cà Phê (category_id = 4)
    (4, 'Cà Phê Muối Xứ Huế Kem Béo', 'Cà phê phin đậm đà nguyên bản hòa cùng lớp kem sữa mặn béo ngậy ngọt dịu gây nghiện chuẩn phong vị cố đô.', 35000, 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=80', true, 80),
    (4, 'Trà Mãng Cầu Đắk Lắk Tươi', 'Thịt mãng cầu xiêm chua ngọt thanh khiết dầm cùng cốt trà lài ủ lạnh sảng khoái mát lạnh ngày hè.', 38000, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=800&q=80', true, 75),
    (4, 'Trà Sen Vàng Củ Năng Kem Cheese', 'Trà ô long thanh dịu kết hợp hạt sen Huế bùi bùi, củ năng giòn tan và lớp kem phô mai béo ngậy mằn mặn.', 45000, 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=800&q=80', true, 70),
    (4, 'Sinh Tố Bơ Sáp Dừa Non Bến Tre', 'Bơ sáp 034 Đắk Lắk dẻo quánh xay cùng cơm dừa non béo thơm và sữa tươi thanh trùng nguyên kem.', 42000, 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80', true, 60),
    (4, 'Nước Ép Dưa Hấu Bạc Hà', '100% dưa hấu tươi nguyên chất ép lạnh cùng lá bạc hà the mát thanh lọc giải nhiệt cơ thể tức thì.', 32000, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=800&q=80', true, 85),
    (4, 'Trà Sữa Ô Long Nướng Trân Châu', 'Lá trà ô long rang nướng thơm khói hòa quyện sữa béo ngậy và trân châu hoàng kim nấu đường nâu dẻo dai.', 40000, 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=800&q=80', true, 90)
ON CONFLICT DO NOTHING;

