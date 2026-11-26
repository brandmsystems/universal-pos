-- Reverses 0053. The premises classification and the rate it imposes go; the
-- bill loses the column that recorded which regime it was issued under.

DROP TRIGGER IF EXISTS order_line_premises_rate ON app.order_line;
DROP FUNCTION IF EXISTS app.assert_order_line_premises_rate();

-- The frozen tuple goes back to 0052's membership. Restored in full rather than
-- patched, because a tuple assembled by two migrations is a tuple neither one
-- can be read to understand.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.tax_jurisdiction, NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.supplier_state_code, OLD.supplier_gstin,
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

-- Same DISABLE/ENABLE as the up, and for the same reason: dropping a column
-- from a table with pending deferred trigger events is refused.
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;
ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_premises_class_known,
  DROP COLUMN IF EXISTS premises_class;
ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;

DROP TABLE IF EXISTS app.branch_premises_class;
DROP FUNCTION IF EXISTS platform.fy_start_year(date, smallint);
DROP TABLE IF EXISTS platform.tax_rate_override;
