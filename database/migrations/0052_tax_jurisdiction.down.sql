-- Puts the head vocabulary back into the trigger as literals.
--
-- ###########################################################################
-- ONE THING IT CANNOT PUT BACK, AND IT CHECKS BEFORE TRYING.
--
-- `tax_class_rate_halves` required an even number of basis points, because the
-- intra-state split was `rate_bps / 2`. Once that CHECK is gone a tenant may
-- have entered an odd rate -- California's 7.25% is 725bps, which is the whole
-- reason this migration exists -- and re-adding the CHECK over such a row would
-- fail, or worse, force somebody to edit a rate a restaurant is trading on.
--
-- So it checks, re-adds the CHECK only when nothing offends it, and RAISEs a
-- notice naming the rates when something does. Same honest-non-reversal shape
-- as 0049's tender method, 0050's refund snapshot and 0051's composition
-- position: a rollback can undo a schema change, not the fact that somebody
-- configured a rate the old rule forbade.
-- ###########################################################################
DO $$
DECLARE
  odd_rates text;
BEGIN
  SELECT string_agg(DISTINCT (rate_bps / 100.0)::text || '%', ', ') INTO odd_rates
    FROM app.tax_class WHERE rate_bps % 2 <> 0;

  IF odd_rates IS NULL THEN
    ALTER TABLE app.tax_class ADD CONSTRAINT tax_class_rate_halves CHECK (rate_bps % 2 = 0);
  ELSE
    RAISE NOTICE
      'tax_class_rate_halves stays dropped: % in use cannot split into two equal '
      'halves, and the intra-state split this constraint protected is gone with it.',
      odd_rates;
  END IF;
END
$$;

-- Restored to 0051's tuple, WITHOUT tax_jurisdiction. Before the column goes:
-- plpgsql resolves field access at runtime, so a function naming a dropped
-- column raises on the next tendered-bill update rather than at rollback time,
-- which is the worst moment to find out.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.supplier_state_code, OLD.supplier_gstin,
      OLD.supplier_gst_registration, OLD.place_of_supply_state_code,
      OLD.recipient_gstin, OLD.recipient_legal_name, OLD.recipient_state_code) THEN
    RAISE EXCEPTION
      'bill % has been tendered against: its figures and its tax identity are immutable',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

-- 0051's version, naming CGST/SGST/IGST again.
CREATE OR REPLACE FUNCTION app.assert_bill_line_heads_match_treatment() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  treatment  text;
  bill_no_   integer;
  comps      jsonb;
  head_total bigint;
  names      text[];
  rates      integer[];
BEGIN
  SELECT b.tax_treatment, b.bill_no INTO treatment, bill_no_
    FROM app.bill b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.bill_id;

  IF treatment IS NULL THEN RETURN NULL; END IF;
  IF treatment = 'unstated' THEN RETURN NULL; END IF;

  comps := CASE WHEN jsonb_typeof(NEW.tax_components) = 'array'
                THEN NEW.tax_components ELSE '[]'::jsonb END;

  SELECT COALESCE(sum((c.value ->> 'amount_minor')::bigint), 0),
         array_agg(c.value ->> 'name' ORDER BY c.value ->> 'name'),
         array_agg((c.value ->> 'rate_bps')::integer ORDER BY c.value ->> 'name')
    INTO head_total, names, rates
    FROM jsonb_array_elements(comps) c;

  IF treatment = 'none' THEN
    IF NEW.tax_minor <> 0 OR jsonb_array_length(comps) <> 0 THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % carries no tax but line % has % in tax and % component(s)',
        bill_no_, NEW.id, NEW.tax_minor, jsonb_array_length(comps)
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.tax_minor = 0 AND jsonb_array_length(comps) = 0 THEN RETURN NULL; END IF;

  IF head_total <> NEW.tax_minor THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % line % says % in tax but its heads sum to %',
      bill_no_, NEW.id, NEW.tax_minor, head_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  IF treatment = 'intra_state' THEN
    IF names IS DISTINCT FROM ARRAY['CGST', 'SGST']
       OR rates[1] IS DISTINCT FROM rates[2] THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % is intra-state, so line % needs CGST and SGST at equal rates, not %',
        bill_no_, NEW.id, names
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
  ELSE
    IF names IS DISTINCT FROM ARRAY['IGST'] THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % is inter-state, so line % needs exactly IGST, not %',
        bill_no_, NEW.id, names
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
  END IF;

  RETURN NULL;
END
$fn$;

-- The bill's stamped jurisdiction goes. `bill_invariants` is disabled across
-- the DROP for the reason the up migration states.
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;
ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_tax_jurisdiction_fk,
  DROP COLUMN IF EXISTS tax_jurisdiction;
ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;

ALTER TABLE platform.tenant
  DROP CONSTRAINT IF EXISTS tenant_tax_jurisdiction_fk,
  DROP COLUMN IF EXISTS tax_jurisdiction;

DROP TRIGGER IF EXISTS tax_treatment_shares_whole ON platform.tax_treatment;
DROP TRIGGER IF EXISTS tax_head_shares_whole ON platform.tax_head;
DROP FUNCTION IF EXISTS platform.assert_tax_shares_whole();

DROP TABLE IF EXISTS platform.tax_head;
DROP TABLE IF EXISTS platform.tax_treatment;
DROP TABLE IF EXISTS platform.tax_jurisdiction;
