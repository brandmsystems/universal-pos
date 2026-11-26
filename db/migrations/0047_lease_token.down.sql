DROP INDEX IF EXISTS app.table_session_lease_token_uk;
ALTER TABLE app.table_session_lease DROP COLUMN IF EXISTS token;
