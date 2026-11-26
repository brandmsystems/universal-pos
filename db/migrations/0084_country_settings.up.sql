-- ###########################################################################
-- 0084: A RESTAURANT'S COUNTRY AND CURRENCY ARE CHOSEN, AND A BILL KEEPS ITS OWN.
--
-- The country is `platform.tenant.tax_jurisdiction` and the currency
-- `platform.tenant.default_currency`; both already existed. What this adds:
--
--   1. Platform settings the Super Admin changes: which countries are OFFERED
--      to a new restaurant, which one the create form starts on, and whether a
--      Sales person may change a restaurant's country.
--
--   2. `app.bill.currency`. The printed bill read the restaurant's CURRENT
--      currency, so a bill reprinted after a change would have said AED over
--      figures taken in rupees -- the priced-document rule, broken for the one
--      value nobody snapshotted because it never changed. A country can now
--      change only until the restaurant's first bill (modules/platform/
--      countries.ts), so today the two always agree; the stamp is what keeps a
--      document true if that rule is ever relaxed.
--
--   3. Once tendered, the currency is as fixed as the figures it labels.
-- ###########################################################################

INSERT INTO platform.platform_setting (key, value, description) VALUES
  ('country.default', '"IN"',
   'The country a new restaurant form starts on. Must be one of country.offered.'),
  ('country.offered', '["IN", "AE"]',
   'Countries a restaurant may be created in or moved to.'),
  ('country.sales_may_change', 'false',
   'Whether a Sales person may change the country and currency of a restaurant they sold, before its first bill.')
ON CONFLICT (key) DO NOTHING;

-- 0052's reason: the backfill would queue one deferred invariant check per bill,
-- and Postgres refuses the ALTER below while any is pending.
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;

ALTER TABLE app.bill ADD COLUMN currency text;

UPDATE app.bill b SET currency = t.default_currency
  FROM platform.tenant t WHERE t.id = b.tenant_id;

ALTER TABLE app.bill
  ALTER COLUMN currency SET NOT NULL,
  ADD CONSTRAINT bill_currency_format CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;

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
      NEW.rounding_rule, NEW.round_off_minor, NEW.currency)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.premises_class,
      OLD.supplier_state_code, OLD.supplier_gstin,
      OLD.supplier_gst_registration, OLD.place_of_supply_state_code,
      OLD.recipient_gstin, OLD.recipient_legal_name, OLD.recipient_state_code,
      OLD.rounding_rule, OLD.round_off_minor, OLD.currency) THEN
    RAISE EXCEPTION
      'bill % has been tendered against: its figures and its tax identity are immutable',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;
