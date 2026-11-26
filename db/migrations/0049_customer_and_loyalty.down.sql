DROP TRIGGER IF EXISTS bill_earns_loyalty ON app.bill;
DROP FUNCTION IF EXISTS app.earn_loyalty_on_settlement();

ALTER TABLE app.pii_access_log
  DROP CONSTRAINT IF EXISTS pii_access_shape_exact,
  DROP CONSTRAINT IF EXISTS pii_access_permission_known;
ALTER TABLE app.pii_access_log
  ADD CONSTRAINT pii_access_permission_known
  CHECK (permission_key IN ('customer.pii.view', 'customer.pii.export')),
  ADD CONSTRAINT pii_access_shape_exact
  CHECK (
    CASE permission_key
      WHEN 'customer.pii.view' THEN customer_id IS NOT NULL AND query_descriptor IS NULL
      WHEN 'customer.pii.export' THEN customer_id IS NULL AND query_descriptor IS NOT NULL
                                      AND result_count IS NOT NULL AND reason IS NOT NULL
      ELSE false
    END
  );

-- ###########################################################################
-- THE TENDER METHOD CANNOT ALWAYS BE UN-PERMITTED, AND THAT IS NOT A BUG.
--
-- Narrowing the CHECK fails if any tender was ever taken as 'loyalty':
-- "check constraint tender_method_known is violated by some row". Three ways
-- out, and two of them are unacceptable:
--
--   DELETE the loyalty tenders -- destroys money records to make a rollback
--   tidy. A settled bill would stop reconciling.
--   UPDATE them to 'other' -- rewrites what actually happened at a till, in an
--   append-only-by-intent table, so a payment mix reported months ago would
--   stop matching its own bills.
--
-- So: if such rows exist, the value STAYS permitted and the operator is told
-- why. A rollback can undo a schema change; it cannot undo the fact that
-- customers spent points. The residue is a permitted enum value with no code
-- writing it, which is inert -- and the up migration restores the wide list
-- unconditionally, so re-applying lands on exactly the same schema either way.
-- ###########################################################################
DO $$
DECLARE
  taken bigint;
BEGIN
  SELECT count(*) INTO taken FROM app.tender WHERE method = 'loyalty';

  ALTER TABLE app.tender DROP CONSTRAINT IF EXISTS tender_method_known;

  IF taken > 0 THEN
    RAISE NOTICE
      '0049 down: % loyalty tender(s) exist, so ''loyalty'' stays a permitted method. Rolling back the schema cannot roll back money that was taken.',
      taken;
    ALTER TABLE app.tender ADD CONSTRAINT tender_method_known
      CHECK (method IN ('cash', 'card', 'upi', 'wallet', 'voucher', 'loyalty', 'other'));
  ELSE
    ALTER TABLE app.tender ADD CONSTRAINT tender_method_known
      CHECK (method IN ('cash', 'card', 'upi', 'wallet', 'voucher', 'other'));
  END IF;
END $$;

DROP INDEX IF EXISTS app.bill_by_customer_idx;
ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_customer_fk,
  DROP COLUMN IF EXISTS customer_id;

DROP TABLE IF EXISTS app.loyalty_ledger;
DROP FUNCTION IF EXISTS app.assert_loyalty_balance();
DROP TABLE IF EXISTS app.loyalty_program;
DROP TABLE IF EXISTS app.customer_consent;
DROP TABLE IF EXISTS app.customer;
