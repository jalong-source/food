-- ============================================================================
-- HỆ THỐNG ĐẶT ĐỒ ĂN TRỰC TUYẾN (ONLINE FOOD ORDERING SYSTEM)
-- File: database/03_seed_data.sql
-- Hệ quản trị CSDL: PostgreSQL 16
-- Nội dung dữ liệu mẫu phục vụ thuyết trình & kiểm thử thực nghiệm:
--   1. 05 Người dùng đủ 4 vai trò (`lecturer`, `admin`, `shipper`, `customer`)
--   2. 04 Danh mục ẩm thực Việt Nam đặc trưng
--   3. 10 Món ăn Việt Nam kèm ảnh Unsplash chất lượng cao:
--      - Món ID 1..8 : Đã phát sinh trong `order_items` -> Test XÓA CỨNG sẽ bị
--                      PostgreSQL chặn bởi khóa ngoại `ON DELETE RESTRICT` (mã lỗi `23503`).
--      - Món ID 9, 10: CHƯA phát sinh đơn hàng nào -> Test XÓA CỨNG thành công
--                      và kích hoạt `trg_foods_realtime_notify` (`DELETE`).
--   4. 03 Đơn hàng mẫu khởi tạo hoàn toàn qua `CALL sp_create_order` và chuyển
--      trạng thái qua `CALL sp_update_order_status` để sinh tự động lịch sử
--      kiểm toán `order_status_history` và trừ tồn kho chính xác.
-- ============================================================================

SET client_encoding = 'UTF8';

-- Làm sạch dữ liệu và đặt lại toàn bộ bộ đếm SERIAL về 1 (Idempotent Seed)
TRUNCATE TABLE
    order_status_history,
    order_items,
    orders,
    foods,
    categories,
    users
RESTART IDENTITY CASCADE;

-- ============================================================================
-- 1. KHỞI TẠO 5 NGƯỜI DÙNG (`users` -> ID: 1..5)
-- ============================================================================
INSERT INTO users (full_name, email, phone, password_hash, role, default_address)
VALUES
    -- ID = 1: Giảng viên chấm thi
    (
        'Giảng Viên Test',
        'lecturer.test@fit.edu.vn',
        '0909999999',
        '665fbcfe5ffdfc0984a281040d2d4763d5351ecb448179838013cce639b8226a',
        'lecturer',
        'Phòng Hội đồng A201, Khoa CNTT, ĐH Bách Khoa, Quận 10, TP.HCM'
    ),
    -- ID = 2: Quản trị viên cửa hàng / Bếp trưởng
    (
        'Trần Quản Trị',
        'admin@jalong.io.vn',
        '0901000002',
        '665fbcfe5ffdfc0984a281040d2d4763d5351ecb448179838013cce639b8226a',
        'admin',
        'Tầng 5, Tòa nhà JaLongFood, 65 Lê Lợi, Quận 1, TP.HCM'
    ),
    -- ID = 3: Nhân viên giao hàng (Shipper)
    (
        'Lê Hoàng Giao Nhanh',
        'shipper@jalong.io.vn',
        '0901000003',
        '665fbcfe5ffdfc0984a281040d2d4763d5351ecb448179838013cce639b8226a',
        'shipper',
        'Trạm điều phối Quận 3, 120 Võ Văn Tần, TP.HCM'
    ),
    -- ID = 4: Khách hàng chính
    (
        'Gia Long',
        'gialong@jalong.io.vn',
        '0901234567',
        '665fbcfe5ffdfc0984a281040d2d4763d5351ecb448179838013cce639b8226a',
        'customer',
        'Số 88 Đồng Khởi, Phường Bến Nghé, Quận 1, TP.HCM'
    ),
    -- ID = 5: Khách hàng 2
    (
        'Võ Thị Thanh Hà',
        'thanhha@gmail.com',
        '0901000005',
        '665fbcfe5ffdfc0984a281040d2d4763d5351ecb448179838013cce639b8226a',
        'customer',
        '268 Lý Thường Kiệt, Phường 14, Quận 10, TP.HCM'
    );

-- ============================================================================
-- 2. KHỞI TẠO 4 DANH MỤC ẨM THỰC VIỆT (`categories` -> ID: 1..4)
-- ============================================================================
INSERT INTO categories (name, slug, description, display_order)
VALUES
    -- ID = 1
    (
        'Phở & Bún Truyền Thống',
        'pho-bun-truyen-thong',
        'Tinh hoa nước dùng hầm xương bò và thảo mộc 12 giờ cùng sợi phở, bún tươi truyền thống Việt Nam.',
        1
    ),
    -- ID = 2
    (
        'Cơm Việt Đậm Đà',
        'com-viet-dam-da',
        'Cơm tấm sườn nướng than hoa thơm lừng, cơm gà xối mỡ giòn da chuẩn vị Sài Gòn.',
        2
    ),
    -- ID = 3
    (
        'Bánh Mì & Món Cuốn',
        'banh-mi-mon-cuon',
        'Bánh mì vỏ giòn nhân thịt nướng đầy đặn và gỏi cuốn tôm thịt tươi mát chấm tương đậu phộng.',
        3
    ),
    -- ID = 4
    (
        'Trà Trái Cây & Cà Phê',
        'tra-trai-cay-ca-phe',
        'Cà phê phin rang mộc truyền thống và các dòng trà trái cây nhiệt đới thanh mát giải nhiệt.',
        4
    );

-- ============================================================================
-- 3. KHỞI TẠO 10 MÓN ĂN VIỆT (`foods` -> ID: 1..10)
--    Món 1..8 sẽ có mặt trong các đơn hàng mẫu (bị khóa FK `23503` khi xóa cứng).
--    Món 9..10 được tạo qua `CALL sp_upsert_food` và ĐỂ TRỐNG ĐƠN HÀNG nhằm demo
--    xóa cứng thành công đối chiếu trực tiếp với món 1..8!
-- ============================================================================
INSERT INTO foods (category_id, name, description, price, image_url, is_available, stock_quantity)
VALUES
    -- ID = 1 (Thuộc Category 1 - Có trong Đơn #1)
    (
        1,
        'Phở Bò Tái Nạm Hà Nội',
        'Nước dùng xương ống bò trong ngọt thanh thảo quả quế hồi, thịt bò tái mềm và nạm gầu giòn thơm.',
        65000.00,
        'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=800&q=80',
        TRUE,
        60
    ),
    -- ID = 2 (Thuộc Category 1 - Có trong Đơn #2)
    (
        1,
        'Bún Bò Huế Giò Heo Đặc Biệt',
        'Chuẩn vị cố đô với mắm ruốc Huế thơm nồng, sả cây, bắp bò hoa, chả cua và khoanh giò heo hầm mềm.',
        70000.00,
        'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=800&q=80',
        TRUE,
        45
    ),
    -- ID = 3 (Thuộc Category 2 - Có trong Đơn #2)
    (
        2,
        'Cơm Tấm Sườn Bì Chả Trứng Ốp La',
        'Hạt tấm dẻo thơm ăn kèm sườn cốt lết ướp mật ong nướng than hồng, bì thính, chả hấp và mỡ hành tóp mỡ.',
        60000.00,
        'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=800&q=80',
        TRUE,
        80
    ),
    -- ID = 4 (Thuộc Category 2 - Có trong Đơn #3)
    (
        2,
        'Cơm Gà Xối Mỡ Giòn Da Mắm Tỏi',
        'Đùi gà góc tư xối mỡ vàng rụm ngoài giòn trong mọng nước, dùng kèm cơm chiên hạt điều đỏ và xốt mắm tỏi.',
        58000.00,
        'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=800&q=80',
        TRUE,
        50
    ),
    -- ID = 5 (Thuộc Category 3 - Có trong Đơn #1)
    (
        3,
        'Bánh Mì Thịt Nướng Đặc Biệt Sài Gòn',
        'Ổ bánh mì nóng giòn rụm kẹp thịt heo nướng sả vừng, pate gan nhà làm, bơ trứng gà, đồ chua và ngò rí.',
        35000.00,
        'https://images.unsplash.com/photo-1600454309261-3dc9b7597637?auto=format&fit=crop&w=800&q=80',
        TRUE,
        100
    ),
    -- ID = 6 (Thuộc Category 3 - Có trong Đơn #3)
    (
        3,
        'Gỏi Cuốn Tôm Thịt Sốt Tương Đậu Phộng',
        'Phần 3 cuốn bánh tráng dẻo cuộn tôm sú tươi, thịt ba chỉ luộc, bún tươi, rau thơm và tương đen đậu phộng rang.',
        40000.00,
        'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?auto=format&fit=crop&w=800&q=80',
        TRUE,
        60
    ),
    -- ID = 7 (Thuộc Category 4 - Có trong Đơn #1)
    (
        4,
        'Cà Phê Sữa Đá Pha Phin Truyền Thống',
        'Hạt Robusta Buôn Ma Thuột rang mộc chiết xuất phin nhôm đậm đà quyện cùng sữa đặc béo thơm chuẩn gu Sài Gòn.',
        29000.00,
        'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=80',
        TRUE,
        120
    ),
    -- ID = 8 (Thuộc Category 4 - Có trong Đơn #2)
    (
        4,
        'Trà Đào Cam Sả Thanh Mát',
        'Hồng trà ủ lạnh kết hợp đào miếng giòn ngọt, cam vàng tươi cắt lát và hương sả tự nhiên sảng khoái.',
        39000.00,
        'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=800&q=80',
        TRUE,
        90
    );

-- Món ID = 9 (CHƯA CÓ ĐƠN HÀNG - Khởi tạo qua Stored Procedure `sp_upsert_food` để sẵn sàng demo XÓA CỨNG)
CALL sp_upsert_food(
    NULL::INT,
    1,
    'Bún Thịt Nướng Chả Giò Sài Gòn',
    'Bún tươi ăn kèm thịt heo nướng xiên sả, chả giò rế chiên giòn, đậu phộng rang, mỡ hành và nước mắm chua ngọt. (Món chưa phát sinh đơn hàng - có thể xóa cứng)',
    55000.00,
    'https://images.unsplash.com/photo-1559314809-0d155014e29e?auto=format&fit=crop&w=800&q=80',
    TRUE,
    40
);

-- Món ID = 10 (CHƯA CÓ ĐƠN HÀNG - Khởi tạo qua Stored Procedure `sp_upsert_food` để sẵn sàng demo XÓA CỨNG)
CALL sp_upsert_food(
    NULL::INT,
    4,
    'Trà Nhiệt Đới Xoài Chanh Dây Hạt Đác',
    'Trà lài thanh khiết hòa quyện mứt xoài chín, cốt chanh dây tươi chua dịu và hạt đác rim giòn sần sật. (Món chưa phát sinh đơn hàng - có thể xóa cứng)',
    42000.00,
    'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=800&q=80',
    TRUE,
    50
);

-- ============================================================================
-- 4. KHỞI TẠO 3 ĐƠN HÀNG MẪU QUA STORED PROCEDURES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ĐƠN HÀNG #1: Khách hàng Gia Long (user_id = 4) -> Hoàn tất (`Completed`)
-- Gồm: 2x Phở Bò (ID=1), 1x Bánh Mì (ID=5), 2x Cà Phê Sữa Đá (ID=7)
-- Tổng tiền (3NF tính qua vw_orders_summary): 2*65000 + 1*35000 + 2*29000 = 223,000 VNĐ
-- ----------------------------------------------------------------------------
CALL sp_create_order(
    4,
    'Số 88 Đồng Khởi, Phường Bến Nghé, Quận 1, TP.HCM',
    'Giao trước 12h trưa giúp mình, gọi điện khi tới sảnh tòa nhà',
    '[
        {"food_id": 1, "quantity": 2, "item_note": "Nhiều hành lá, không giá"},
        {"food_id": 5, "quantity": 1, "item_note": "Ít ớt"},
        {"food_id": 7, "quantity": 2, "item_note": "Ít sữa, nhiều đá"}
    ]'::JSONB,
    NULL::INT
);

CALL sp_update_order_status(
    1,
    'Preparing',
    2,
    'Bếp đã xác nhận đơn hàng #1 và đang chần phở, nướng bánh mì',
    FALSE
);

CALL sp_update_order_status(
    1,
    'Delivering',
    3,
    'Shipper Lê Hoàng đã nhận món tại bếp, đang di chuyển giao hàng',
    FALSE
);

CALL sp_update_order_status(
    1,
    'Completed',
    3,
    'Khách hàng Gia Long đã nhận đủ 5 món và thanh toán hoàn tất',
    FALSE
);

-- ----------------------------------------------------------------------------
-- ĐƠN HÀNG #2: Giảng viên Giảng Viên Test (user_id = 1) -> Đang giao (`Delivering`)
-- Gồm: 1x Bún Bò Huế (ID=2), 2x Cơm Tấm (ID=3), 3x Trà Đào Cam Sả (ID=8)
-- Tổng tiền (3NF tính qua vw_orders_summary): 1*70000 + 2*60000 + 3*39000 = 307,000 VNĐ
-- ----------------------------------------------------------------------------
CALL sp_create_order(
    1,
    'Phòng Hội đồng A201, Khoa CNTT, ĐH Bách Khoa, Quận 10, TP.HCM',
    'Đặt phần ăn trưa cho hội đồng chấm đồ án Thiết kế Cơ sở dữ liệu',
    '[
        {"food_id": 2, "quantity": 1, "item_note": "Không huyết, để sa tế riêng"},
        {"food_id": 3, "quantity": 2, "item_note": "Nước mắm để riêng"},
        {"food_id": 8, "quantity": 3, "item_note": "Giảm 50% đường"}
    ]'::JSONB,
    NULL::INT
);

CALL sp_update_order_status(
    2,
    'Preparing',
    2,
    'Ưu tiên chuẩn bị phần ăn hội đồng giảng viên đóng hộp giữ nhiệt kỹ lưỡng',
    FALSE
);

CALL sp_update_order_status(
    2,
    'Delivering',
    3,
    'Shipper đang trên đường giao đến cổng Lý Thường Kiệt - ĐH Bách Khoa',
    FALSE
);

-- ----------------------------------------------------------------------------
-- ĐƠN HÀNG #3: Khách hàng Võ Thị Thanh Hà (user_id = 5) -> Chờ xác nhận (`Pending`)
-- Gồm: 1x Cơm Gà Xối Mỡ (ID=4), 2x Gỏi Cuốn Tôm Thịt (ID=6)
-- Tổng tiền (3NF tính qua vw_orders_summary): 1*58000 + 2*40000 = 138,000 VNĐ
-- Giữ ở trạng thái `Pending` để sẵn sàng demo trực tiếp luồng chuyển trạng thái
-- hoặc demo HỦY ĐƠN hoàn lại `stock_quantity` ngay trên giao diện thuyết trình!
-- ----------------------------------------------------------------------------
CALL sp_create_order(
    5,
    '268 Lý Thường Kiệt, Phường 14, Quận 10, TP.HCM',
    'Cho xin thêm 2 bịch tương đậu phộng chấm gỏi cuốn',
    '[
        {"food_id": 4, "quantity": 1, "item_note": "Da gà giòn, thêm dưa leo"},
        {"food_id": 6, "quantity": 2, "item_note": "Thêm tương đậu phộng"}
    ]'::JSONB,
    NULL::INT
);
