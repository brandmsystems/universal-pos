-- Narrows the position vocabulary back to three.
--
-- ###########################################################################
-- IT CANNOT NARROW WHILE ANYTHING HOLDS THE FOURTH, AND NOT ONLY THE
-- VOCABULARY CHECK.
--
-- A composition dealer has bills stamped with the position and a change-log row
-- saying when it moved. Rewriting those to `registered` would assert the shop
-- was entitled to collect tax it never collected; rewriting them to
-- `unregistered` would deny a GSTIN it holds. Both falsify a statutory record
-- to undo a schema change.
--
-- The BICONDITIONALS are the trap here. `branch_registered_iff_gstin` in its
-- 0048 form is VIOLATED by a composition branch -- it holds a GSTIN and its
-- position is not `registered` -- and so is
-- `branch_gst_change_to_registered_has_gstin` by a row moving to composition.
-- An earlier draft of this file re-added those two unconditionally with a
-- comment claiming they were satisfied either way. They are not. Every
-- constraint that mentions a position has to move together, which is why this
-- is one branch and not four.
--
-- Same honest-non-reversal shape as 0049's tender method and 0050's refund
-- snapshot: a rollback can undo a schema change, not the fact that a restaurant
-- traded under the composition scheme.
-- ###########################################################################
DO $$
DECLARE
  held bigint;
BEGIN
  SELECT (SELECT count(*) FROM app.branch WHERE gst_registration = 'composition')
       + (SELECT count(*) FROM app.bill WHERE supplier_gst_registration = 'composition')
       + (SELECT count(*) FROM app.branch_gst_registration_change
           WHERE 'composition' IN (from_registration, to_registration))
    INTO held;

  ALTER TABLE app.branch
    DROP CONSTRAINT branch_gst_registration_known,
    DROP CONSTRAINT branch_gstin_iff_position_holds_one;
  ALTER TABLE app.bill
    DROP CONSTRAINT bill_supplier_gst_registration_known,
    DROP CONSTRAINT bill_supplier_gstin_iff_position_holds_one,
    DROP CONSTRAINT bill_non_collecting_position_carries_no_tax;
  ALTER TABLE app.branch_gst_registration_change
    DROP CONSTRAINT branch_gst_change_from_known,
    DROP CONSTRAINT branch_gst_change_to_known,
    DROP CONSTRAINT branch_gst_change_to_position_has_gstin;

  IF held > 0 THEN
    RAISE NOTICE
      '''composition'' stays a permitted position: % row(s) across branches, bills '
      'and the change log hold it. Narrowing would mean rewriting a statutory '
      'record.', held;

    ALTER TABLE app.branch
      ADD CONSTRAINT branch_gst_registration_known
      CHECK (gst_registration IN ('registered', 'composition', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_registered_iff_gstin
      CHECK ((gst_registration IN ('registered', 'composition')) = (gstin IS NOT NULL));
    ALTER TABLE app.bill
      ADD CONSTRAINT bill_supplier_gst_registration_known
      CHECK (supplier_gst_registration IS NULL
          OR supplier_gst_registration IN
             ('registered', 'composition', 'unregistered', 'unstated')),
      ADD CONSTRAINT bill_registered_iff_supplier_gstin
      CHECK (supplier_gst_registration IS NULL
          OR (supplier_gst_registration IN ('registered', 'composition'))
             = (supplier_gstin IS NOT NULL)),
      ADD CONSTRAINT bill_unregistered_carries_no_tax
      CHECK (supplier_gst_registration IS NULL
          OR supplier_gst_registration NOT IN ('unregistered', 'composition')
          OR tax_minor = 0);
    ALTER TABLE app.branch_gst_registration_change
      ADD CONSTRAINT branch_gst_change_from_known
      CHECK (from_registration IN ('registered', 'composition', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_gst_change_to_known
      CHECK (to_registration IN ('registered', 'composition', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_gst_change_to_registered_has_gstin
      CHECK ((to_registration IN ('registered', 'composition')) = (to_gstin IS NOT NULL));
  ELSE
    ALTER TABLE app.branch
      ADD CONSTRAINT branch_gst_registration_known
      CHECK (gst_registration IN ('registered', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_registered_iff_gstin
      CHECK ((gst_registration = 'registered') = (gstin IS NOT NULL));
    ALTER TABLE app.bill
      ADD CONSTRAINT bill_supplier_gst_registration_known
      CHECK (supplier_gst_registration IS NULL
          OR supplier_gst_registration IN ('registered', 'unregistered', 'unstated')),
      ADD CONSTRAINT bill_registered_iff_supplier_gstin
      CHECK (supplier_gst_registration IS NULL
          OR (supplier_gst_registration = 'registered') = (supplier_gstin IS NOT NULL)),
      ADD CONSTRAINT bill_unregistered_carries_no_tax
      CHECK (supplier_gst_registration IS DISTINCT FROM 'unregistered' OR tax_minor = 0);
    ALTER TABLE app.branch_gst_registration_change
      ADD CONSTRAINT branch_gst_change_from_known
      CHECK (from_registration IN ('registered', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_gst_change_to_known
      CHECK (to_registration IN ('registered', 'unregistered', 'unstated')),
      ADD CONSTRAINT branch_gst_change_to_registered_has_gstin
      CHECK ((to_registration = 'registered') = (to_gstin IS NOT NULL));
  END IF;
END
$$;

COMMENT ON COLUMN app.branch.gst_registration IS
  'Stated GST position. registered: tax classes apply. unregistered: order lines '
  'resolve at an explicit 0 bps. unstated: legacy rows only, behaves as '
  'registered did before 0048, and the admin surface prompts for an answer.';

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

  IF position = 'unregistered' THEN
    RAISE EXCEPTION
      'order_line_tax_requires_registration: branch % is not GST-registered and cannot carry a %bps rate',
      NEW.branch_id, NEW.tax_rate_bps
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_line_tax_requires_registration';
  END IF;

  RETURN NEW;
END
$fn$;
