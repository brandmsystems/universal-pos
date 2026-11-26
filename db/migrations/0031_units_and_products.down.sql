DROP FUNCTION IF EXISTS app.from_base(uuid, uuid, text, bigint);
DROP FUNCTION IF EXISTS app.to_base(uuid, uuid, text, numeric);
ALTER TABLE app.product
  DROP CONSTRAINT IF EXISTS product_recipe_unit_fk,
  DROP CONSTRAINT IF EXISTS product_stock_unit_fk,
  DROP CONSTRAINT IF EXISTS product_purchase_unit_fk;
DROP TABLE IF EXISTS app.product_unit;
DROP TRIGGER IF EXISTS product_set_updated_at ON app.product;
DROP TABLE IF EXISTS app.product;
DROP TABLE IF EXISTS app.unit;
