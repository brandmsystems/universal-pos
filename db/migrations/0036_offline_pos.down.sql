DROP INDEX IF EXISTS app.tender_manual_settlement_idx;
ALTER TABLE app.tender
  DROP CONSTRAINT IF EXISTS tender_manual_settlement_complete,
  DROP CONSTRAINT IF EXISTS tender_manual_authoriser_fk,
  DROP COLUMN IF EXISTS authorised_by_user_id,
  DROP COLUMN IF EXISTS operator_reference,
  DROP COLUMN IF EXISTS settled_offline_manually;

DROP INDEX IF EXISTS app.stock_movement_synced_late_idx;
ALTER TABLE app.stock_movement DROP COLUMN IF EXISTS synced_late;

ALTER TABLE app.kot DROP CONSTRAINT IF EXISTS kot_has_a_human_reference;
ALTER TABLE app.kot DROP COLUMN IF EXISTS local_reference;

DROP TABLE IF EXISTS app.sync_quarantine;
DROP TABLE IF EXISTS app.sync_batch;

DROP TRIGGER IF EXISTS table_session_lease_is_append_only ON app.table_session_lease;
DROP FUNCTION IF EXISTS app.deny_lease_rewrite();
DROP TABLE IF EXISTS app.table_session_lease;
