DROP TRIGGER IF EXISTS refund_invariants ON app.refund;
DROP TRIGGER IF EXISTS tender_invariants ON app.tender;
DROP TRIGGER IF EXISTS bill_line_invariants ON app.bill_line;
DROP TRIGGER IF EXISTS bill_invariants ON app.bill;
DROP FUNCTION IF EXISTS app.assert_billing_invariants();
DROP TRIGGER IF EXISTS bill_tendered_is_immutable ON app.bill;
DROP FUNCTION IF EXISTS app.deny_tendered_bill_mutation();

DROP INDEX IF EXISTS app.refund_by_bill_idx;
DROP TABLE IF EXISTS app.refund;
DROP INDEX IF EXISTS app.tender_by_bill_idx;
DROP TABLE IF EXISTS app.tender;
DROP INDEX IF EXISTS app.bill_line_by_order_line_idx;
DROP TABLE IF EXISTS app.bill_line;
DROP INDEX IF EXISTS app.bill_by_session_idx;
DROP TABLE IF EXISTS app.bill;
DROP TABLE IF EXISTS app.bill_sequence;

-- ###########################################################################
-- NARROWING A CHECK MEANS REMOVING THE ROWS THE WIDER ONE ADMITTED. FIRST.
--
-- 0030's up widened this CHECK to allow kind = 'refund'. Narrowing it back is
-- refused by Postgres the moment any tenant has mapped a reason to that kind --
-- which is every deployment that seeded reason kinds. Rolling back 0030 was
-- impossible and nothing said so, because no down had ever been executed;
-- `tests/db/reversibility.test.ts` found it on its first run.
--
-- Deleting these rows is safe in a way that deleting metering rows was not (see
-- 0042's down): this is CONFIGURATION for a feature this migration is removing,
-- not a record of something that happened. app.refund itself is dropped a few
-- statements above, so the mappings describe nothing by the time they go.
-- ###########################################################################
DELETE FROM app.adjustment_reason_kind WHERE kind = 'refund';

ALTER TABLE app.adjustment_reason_kind DROP CONSTRAINT adjustment_reason_kind_known;
ALTER TABLE app.adjustment_reason_kind
  ADD CONSTRAINT adjustment_reason_kind_known
  CHECK (kind IN ('void', 'comp', 'discount', 'recall'));
