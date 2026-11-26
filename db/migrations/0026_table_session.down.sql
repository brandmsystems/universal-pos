DROP POLICY IF EXISTS tenant_isolation ON app.table_session_table;
DROP INDEX IF EXISTS app.table_session_table_by_session_idx;
DROP INDEX IF EXISTS app.table_session_one_live_attachment_per_table;
DROP TABLE IF EXISTS app.table_session_table;

DROP POLICY IF EXISTS tenant_isolation ON app.table_session;
DROP INDEX IF EXISTS app.table_session_open_idx;
DROP TABLE IF EXISTS app.table_session;
