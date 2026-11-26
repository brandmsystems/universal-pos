-- A fourth GST position: the composition dealer.
--
-- ###########################################################################
-- WHY THREE POSITIONS WERE NOT ENOUGH, AND WHY THIS IS A DEFECT AND NOT A
-- MISSING FEATURE.
--
-- A restaurant under the GST composition scheme -- under Rs 1.5 crore turnover,
-- Rs 1 crore in special-category states -- pays 5% of its turnover to the
-- government out of its own pocket and IS FORBIDDEN TO COLLECT ANY TAX FROM
-- THE CUSTOMER. It holds a GSTIN. It issues a BILL OF SUPPLY rather than a tax
-- invoice, and the paper must carry the words "composition taxable person, not
-- eligible to collect tax on supplies".
--
-- Migration 0048's three values cannot express that, and the failure is not a
-- gap -- it is FORCED WRONG BEHAVIOUR:
--
--   branch_registered_iff_gstin CHECK ((gst_registration = 'registered')
--                                       = (gstin IS NOT NULL))
--
-- A composition dealer holds a GSTIN, so the biconditional forces the position
-- to `registered`. `resolveOrderableItem` then resolves the menu item's tax
-- class rate onto every line, and the shop collects 5% GST FROM DINERS THAT IT
-- IS NOT ENTITLED TO COLLECT -- money it must either remit twice or refund,
-- discovered by an assessment. And the document calls itself a tax invoice
-- when it may not be one.
--
-- The alternative -- telling such a shop to answer `unregistered` -- produces
-- the right BILL and a branch whose stated position denies a registration it
-- holds, which is the exact ambiguity 0048 was written to remove.
--
-- So: a fourth value, and every rule that said "unregistered" now asks the
-- real question, WHICH IS WHETHER THE POSITION MAY COLLECT TAX AT ALL.
-- ###########################################################################

ALTER TABLE app.branch
  DROP CONSTRAINT branch_gst_registration_known,
  ADD CONSTRAINT branch_gst_registration_known
  CHECK (gst_registration IN ('registered', 'composition', 'unregistered', 'unstated')),

  -- ###########################################################################
  -- THE BICONDITIONAL, ASKING THE RIGHT QUESTION.
  --
  -- It was "registered iff a GSTIN is held". The fact it was standing in for is
  -- "this position involves a registration", and composition does. A branch
  -- claiming composition without a number cannot raise a compliant bill of
  -- supply, and a branch claiming to be unregistered while holding a number is
  -- still the lie 0048 named.
  -- ###########################################################################
  DROP CONSTRAINT branch_registered_iff_gstin,
  ADD CONSTRAINT branch_gstin_iff_position_holds_one
  CHECK ((gst_registration IN ('registered', 'composition')) = (gstin IS NOT NULL));

COMMENT ON COLUMN app.branch.gst_registration IS
  'Stated GST position. registered: tax classes apply, tax invoice. composition: '
  'holds a GSTIN, pays turnover tax itself, MAY NOT collect tax from a diner -- '
  'lines resolve at 0 bps and the document is a bill of supply. unregistered: no '
  'GSTIN, lines at 0 bps, plain bill. unstated: legacy rows only, behaves as '
  'registered did before 0048, and the admin surface prompts for an answer.';


ALTER TABLE app.bill
  DROP CONSTRAINT bill_supplier_gst_registration_known,
  ADD CONSTRAINT bill_supplier_gst_registration_known
  CHECK (supplier_gst_registration IS NULL
      OR supplier_gst_registration IN
         ('registered', 'composition', 'unregistered', 'unstated')),

  DROP CONSTRAINT bill_registered_iff_supplier_gstin,
  ADD CONSTRAINT bill_supplier_gstin_iff_position_holds_one
  CHECK (supplier_gst_registration IS NULL
      OR (supplier_gst_registration IN ('registered', 'composition'))
         = (supplier_gstin IS NOT NULL)),

  -- ###########################################################################
  -- RENAMED, NOT WIDENED IN PLACE.
  --
  -- `bill_unregistered_carries_no_tax` now governs two positions, and a
  -- constraint whose name says one thing while it enforces another is the drift
  -- this repo keeps finding. The name is referenced in `ERROR_CONTRACT`'s
  -- `CONSTRAINT_DETAIL` and asserted by name in tests/ops/service.test.ts; both
  -- move with it, which is three edits and worth it.
  --
  -- This is the constraint that makes the suppression STRUCTURAL rather than a
  -- property of three query sites. A composition dealer's bill carrying tax is
  -- refused by the database even if a future write path forgets.
  -- ###########################################################################
  DROP CONSTRAINT bill_unregistered_carries_no_tax,
  ADD CONSTRAINT bill_non_collecting_position_carries_no_tax
  CHECK (supplier_gst_registration IS NULL
      OR supplier_gst_registration NOT IN ('unregistered', 'composition')
      OR tax_minor = 0);


ALTER TABLE app.branch_gst_registration_change
  DROP CONSTRAINT branch_gst_change_from_known,
  ADD CONSTRAINT branch_gst_change_from_known
  CHECK (from_registration IN ('registered', 'composition', 'unregistered', 'unstated')),

  DROP CONSTRAINT branch_gst_change_to_known,
  ADD CONSTRAINT branch_gst_change_to_known
  CHECK (to_registration IN ('registered', 'composition', 'unregistered', 'unstated')),

  DROP CONSTRAINT branch_gst_change_to_registered_has_gstin,
  ADD CONSTRAINT branch_gst_change_to_position_has_gstin
  CHECK ((to_registration IN ('registered', 'composition')) = (to_gstin IS NOT NULL));


-- ###########################################################################
-- THE BACKSTOP, ASKING THE SAME RIGHT QUESTION.
--
-- 0048's trigger refused a non-zero rate at an `unregistered` branch and stated
-- why: three query sites is three places to forget, and a write path added next
-- year -- a delivery importer, an offline replay, a bulk insert -- would
-- otherwise collect tax under no entitlement while every existing test passed.
--
-- Composition is the same hazard with a worse smell, because the branch DOES
-- hold a GSTIN: a reviewer scanning for "has a registration" would wave it
-- through. So the trigger names the position in the refusal, rather than saying
-- "is not GST-registered" about a branch that plainly is registered.
-- ###########################################################################
CREATE OR REPLACE FUNCTION app.order_line_tax_matches_registration() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  position text;
BEGIN
  IF NEW.tax_rate_bps IS NULL OR NEW.tax_rate_bps = 0 THEN
    RETURN NEW;
  END IF;

  SELECT b.gst_registration INTO position
    FROM app.branch b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.branch_id;

  IF position IN ('unregistered', 'composition') THEN
    RAISE EXCEPTION
      'order_line_tax_requires_registration: branch % is % and may not collect tax, so it cannot carry a %bps rate',
      NEW.branch_id,
      CASE position
        WHEN 'composition' THEN 'a composition taxable person'
        ELSE 'not GST-registered'
      END,
      NEW.tax_rate_bps
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_line_tax_requires_registration';
  END IF;

  RETURN NEW;
END
$fn$;
