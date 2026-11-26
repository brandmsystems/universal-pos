DROP POLICY IF EXISTS tenant_isolation ON app.dining_table;
DROP TRIGGER IF EXISTS dining_table_set_updated_at ON app.dining_table;
DROP INDEX IF EXISTS app.dining_table_by_branch_idx;
DROP INDEX IF EXISTS app.dining_table_identifier_per_floor;
DROP TABLE IF EXISTS app.dining_table;

DROP POLICY IF EXISTS tenant_isolation ON app.table_type;
DROP TRIGGER IF EXISTS table_type_set_updated_at ON app.table_type;
DROP TABLE IF EXISTS app.table_type;

DROP POLICY IF EXISTS tenant_isolation ON app.floor;
DROP TRIGGER IF EXISTS floor_set_updated_at ON app.floor;
DROP INDEX IF EXISTS app.floor_by_branch_idx;
DROP TABLE IF EXISTS app.floor;
