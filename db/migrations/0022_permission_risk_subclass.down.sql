DROP INDEX IF EXISTS platform.permission_risk_subclass_idx;
ALTER TABLE platform.permission DROP CONSTRAINT IF EXISTS permission_financial_has_subclass;
ALTER TABLE platform.permission DROP COLUMN risk_subclass;
