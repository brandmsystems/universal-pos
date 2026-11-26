DROP TRIGGER IF EXISTS pii_access_log_append_only ON app.pii_access_log;
DROP FUNCTION IF EXISTS app.deny_pii_access_log_rewrite();
DROP TABLE IF EXISTS app.pii_access_log;

ALTER TABLE app.refund
  DROP CONSTRAINT IF EXISTS refund_tax_snapshot_complete,
  DROP COLUMN IF EXISTS tax_components,
  DROP COLUMN IF EXISTS tax_rate_bps,
  DROP COLUMN IF EXISTS tax_minor,
  DROP COLUMN IF EXISTS taxable_minor;

DROP INDEX IF EXISTS app.bill_b2b_idx;
ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_b2b_named,
  DROP COLUMN IF EXISTS supplier_gstin,
  DROP COLUMN IF EXISTS place_of_supply_state_code,
  DROP COLUMN IF EXISTS recipient_legal_name,
  DROP COLUMN IF EXISTS recipient_gstin;

ALTER TABLE app.branch
  DROP CONSTRAINT IF EXISTS branch_gstin_matches_state,
  DROP COLUMN IF EXISTS state_code,
  DROP COLUMN IF EXISTS gstin;
