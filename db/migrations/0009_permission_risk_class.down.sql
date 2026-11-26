DROP INDEX IF EXISTS platform.permission_risk_class_idx;

ALTER TABLE platform.permission DROP COLUMN is_dangerous;
ALTER TABLE platform.permission DROP COLUMN risk_class;

ALTER TABLE platform.permission
  ADD COLUMN is_dangerous boolean NOT NULL DEFAULT false;
