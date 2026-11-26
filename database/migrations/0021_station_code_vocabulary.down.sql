ALTER TABLE app.kitchen_station DROP CONSTRAINT IF EXISTS kitchen_station_code_fk;

DROP POLICY IF EXISTS tenant_isolation ON app.station_code;
DROP TRIGGER IF EXISTS station_code_set_updated_at ON app.station_code;
DROP TABLE IF EXISTS app.station_code;
