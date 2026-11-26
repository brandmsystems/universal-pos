ALTER TABLE app.branch DROP COLUMN IF EXISTS over_receipt_tolerance_bps;
DROP TABLE IF EXISTS app.goods_receipt_line;
DROP TABLE IF EXISTS app.goods_receipt;
DROP TABLE IF EXISTS app.purchase_order_line;
DROP TABLE IF EXISTS app.purchase_order;
DROP TABLE IF EXISTS app.supplier_product;
DROP TABLE IF EXISTS app.supplier;
