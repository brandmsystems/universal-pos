-- The second dimension, now due.
--
-- report.exception.view has to serve two readers who are looking for different
-- things: an owner scanning for till fraud, and someone auditing configuration
-- drift. A void and a menu price change are both financial, but paging through
-- menu edits to find a suspicious refund is how a fraud report stops being read.
--
-- Derived, not enumerated: the report's sections come from this column, so a new
-- financial key lands in the right section without anyone editing a key list.
ALTER TABLE platform.permission
  ADD COLUMN risk_subclass text
    CONSTRAINT permission_risk_subclass_known
    CHECK (risk_subclass IN ('transaction', 'configuration'));

-- Biconditional: required exactly when the key is financial, forbidden otherwise.
-- An escalation or privacy key has no transaction/configuration meaning, and
-- letting one carry a subclass would put it in a report it does not belong in.
ALTER TABLE platform.permission
  ADD CONSTRAINT permission_financial_has_subclass
  CHECK ((risk_class = 'financial') = (risk_subclass IS NOT NULL));

CREATE INDEX permission_risk_subclass_idx
  ON platform.permission (risk_class, risk_subclass)
  WHERE risk_class <> 'none';

COMMENT ON COLUMN platform.permission.risk_subclass IS
  'transaction = a per-event exception (void, refund, adjustment). configuration = a standing change (price, recipe, vendor master). Selects which section of report.exception.view the key appears in.';
