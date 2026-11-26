-- One boolean was carrying three meanings with three different audiences and
-- three different controls:
--
--   financial   reason code mandatory, surfaces in report.exception.view,
--               read by the owner and loss prevention
--   escalation  the subset-grant rule applies, approval path, read by security
--   privacy     logged per record viewed, read by the DPO, and never joined
--               into the loss-prevention report
--
-- One exception report mixing till fraud and PII access serves neither reader.
--
-- Safe as a drop-and-add because the catalogue has not been seeded yet.
ALTER TABLE platform.permission DROP COLUMN is_dangerous;

ALTER TABLE platform.permission
  ADD COLUMN risk_class text NOT NULL DEFAULT 'none'
    CONSTRAINT permission_risk_class_known
    CHECK (risk_class IN ('none', 'financial', 'escalation', 'privacy'));

-- Generated, so it can never disagree with risk_class. Callers that only need
-- "is this risky" keep working; seeds and reports read risk_class.
ALTER TABLE platform.permission
  ADD COLUMN is_dangerous boolean
  GENERATED ALWAYS AS (risk_class <> 'none') STORED;

CREATE INDEX permission_risk_class_idx ON platform.permission (risk_class)
  WHERE risk_class <> 'none';

COMMENT ON COLUMN platform.permission.risk_class IS
  'Selects which control applies to the key. Not itself an access control.';
