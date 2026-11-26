DROP POLICY IF EXISTS tenant_isolation ON app.station_printer;
DROP INDEX IF EXISTS app.station_printer_by_printer_idx;
DROP INDEX IF EXISTS app.station_printer_one_primary_per_station;
DROP TABLE IF EXISTS app.station_printer;

DROP POLICY IF EXISTS tenant_isolation ON app.printer;
DROP TRIGGER IF EXISTS printer_set_updated_at ON app.printer;
DROP INDEX IF EXISTS app.printer_by_branch_idx;
DROP TABLE IF EXISTS app.printer;

DROP POLICY IF EXISTS tenant_isolation ON app.kitchen_station;
DROP TRIGGER IF EXISTS kitchen_station_set_updated_at ON app.kitchen_station;
DROP TABLE IF EXISTS app.kitchen_station;
