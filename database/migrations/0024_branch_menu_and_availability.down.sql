DROP FUNCTION IF EXISTS app.business_date(text, time, timestamptz);
ALTER TABLE app.branch DROP COLUMN business_day_starts_at;

DROP TABLE IF EXISTS app.branch_item_routing;
DROP TABLE IF EXISTS app.branch_item_availability;
DROP TABLE IF EXISTS app.menu_item_service_period;
DROP TRIGGER IF EXISTS service_period_set_updated_at ON app.service_period;
DROP TABLE IF EXISTS app.service_period;
DROP TRIGGER IF EXISTS branch_menu_price_set_updated_at ON app.branch_menu_price;
DROP TABLE IF EXISTS app.branch_menu_price;
DROP TRIGGER IF EXISTS branch_menu_listing_set_updated_at ON app.branch_menu_listing;
DROP TABLE IF EXISTS app.branch_menu_listing;
