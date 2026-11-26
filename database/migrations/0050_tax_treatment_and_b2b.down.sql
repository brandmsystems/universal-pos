-- Reverses the schema. It cannot reverse two things, and says which.

-- Narrowed back. A refund written while 0050 was in force that states heads and
-- no single rate would violate this, so it is dropped first and re-added only
-- when nothing offends it -- the same honest-non-reversal shape as 0049's
-- tender method: a rollback can undo a schema change, not the fact that a
-- mixed-rate bill was refunded in full.
DO $$
DECLARE
  offending bigint;
BEGIN
  ALTER TABLE app.refund DROP CONSTRAINT IF EXISTS refund_tax_snapshot_complete;

  SELECT count(*) INTO offending FROM app.refund
   WHERE taxable_minor IS NOT NULL AND tax_rate_bps IS NULL;

  IF offending > 0 THEN
    RAISE NOTICE
      'refund_tax_snapshot_complete stays widened: % refund(s) state their heads '
      'and no single rate, which is the only lawful shape for a full refund of a '
      'mixed-rate bill.', offending;
    ALTER TABLE app.refund ADD CONSTRAINT refund_tax_snapshot_complete
    CHECK (
      (taxable_minor IS NULL AND tax_minor IS NULL AND tax_rate_bps IS NULL)
      OR (taxable_minor IS NOT NULL AND tax_minor IS NOT NULL
          AND taxable_minor + tax_minor = amount_minor
          AND (tax_rate_bps IS NOT NULL OR jsonb_typeof(tax_components) = 'array'))
    );
  ELSE
    ALTER TABLE app.refund ADD CONSTRAINT refund_tax_snapshot_complete
    CHECK (
      (taxable_minor IS NULL AND tax_minor IS NULL AND tax_rate_bps IS NULL)
      OR (taxable_minor IS NOT NULL AND tax_minor IS NOT NULL AND tax_rate_bps IS NOT NULL
          AND taxable_minor + tax_minor = amount_minor)
    );
  END IF;
END
$$;

ALTER TABLE app.tax_class DROP CONSTRAINT IF EXISTS tax_class_rate_halves;

DROP TABLE IF EXISTS app.tenant_tax_setting;

DROP TRIGGER IF EXISTS bill_line_heads_match_treatment ON app.bill_line;
DROP FUNCTION IF EXISTS app.assert_bill_line_heads_match_treatment();

-- Restored BEFORE the columns go: plpgsql resolves field access at runtime, so a
-- function naming a dropped column raises on the next tendered-bill update
-- rather than at rollback time, which is the worst moment to find out.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no) THEN
    RAISE EXCEPTION 'bill % has been tendered against: its figures are immutable', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_recipient_state_matches_gstin,
  DROP CONSTRAINT IF EXISTS bill_tax_treatment_consistent,
  DROP CONSTRAINT IF EXISTS bill_tax_treatment_known,
  DROP COLUMN IF EXISTS tax_treatment,
  DROP COLUMN IF EXISTS recipient_state_code,
  DROP COLUMN IF EXISTS supplier_state_code;


-- ###########################################################################
-- THE TWO THINGS THIS DOWN CANNOT UNDO.
--
-- 1. `app.tax_component` is recreated with its original definition and NO ROWS.
--    The rows were per-tenant configuration that nothing in the product ever
--    read -- the outward-supply return matched their free-text `name` and the
--    amount it looked for was never stored -- so what is lost is a table of
--    values that had no effect. Restoring the DEFINITION is what reversibility
--    is about here; restoring values that were never load-bearing would require
--    keeping a copy of them, which would be keeping the defect.
--
-- 2. `app.order_line.tax_components` comes back nullable and empty. It was
--    written and never read except to be copied verbatim onto a bill line, and
--    the copy is what the return misread. Nothing downstream of a rollback can
--    want the old values, because nothing upstream ever consumed them.
--
-- The `place_of_supply_state_code` values the up migration filled in for
-- pre-0039 bills are NOT unwound either, and that is deliberate: the state a
-- restaurant served a meal in is a fact, not a derivation, and blanking it
-- would destroy information rather than restore a prior state.
-- ###########################################################################
CREATE TABLE app.tax_component (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  tax_class_id  uuid        NOT NULL,
  name          text        NOT NULL,
  rate_bps      integer     NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  display_order integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_component_class_fk
  FOREIGN KEY (tenant_id, tax_class_id) REFERENCES app.tax_class (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_component_name_unique UNIQUE (tenant_id, tax_class_id, name)
);

CREATE INDEX tax_component_by_class_idx ON app.tax_component (tenant_id, tax_class_id);

ALTER TABLE app.tax_component ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_component
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

DO $$
BEGIN
  RAISE NOTICE
    'app.tax_component is recreated EMPTY: its rows were configuration nothing read. '
    'app.order_line.tax_components is recreated EMPTY for the same reason.';
END
$$;

ALTER TABLE app.order_line ADD COLUMN tax_components jsonb;
