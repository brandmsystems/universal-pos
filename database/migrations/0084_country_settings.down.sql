-- The guard as 0082 left it, then the column it no longer names.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.tax_jurisdiction, NEW.premises_class,
      NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code,
      NEW.rounding_rule, NEW.round_off_minor)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.premises_class,
      OLD.supplier_state_code, OLD.supplier_gstin,
      OLD.supplier_gst_registration, OLD.place_of_supply_state_code,
      OLD.recipient_gstin, OLD.recipient_legal_name, OLD.recipient_state_code,
      OLD.rounding_rule, OLD.round_off_minor) THEN
    RAISE EXCEPTION
      'bill % has been tendered against: its figures and its tax identity are immutable',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;

-- The bill's currency is dropped, not lost: until this migration it always
-- equalled the restaurant's, which is where 0083's printed bill reads it.
ALTER TABLE app.bill DROP COLUMN currency;

DELETE FROM platform.platform_setting
 WHERE key IN ('country.default', 'country.offered', 'country.sales_may_change');
