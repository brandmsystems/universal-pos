-- ###########################################################################
-- 0083: HOW A BRANCH CHARGES TAX, AND WHO IT SAYS IT IS ON THE BILL.
--
-- Three settings per branch, beside the GST position they generalise:
--
--   tax_enabled           off charges no tax at all, whatever the dish says.
--   tax_account_type      none | gst | vat | others -- which tax the branch
--                         charges, and so which heads its bills carry: CGST and
--                         SGST (or IGST) under GST, one VAT head under VAT, one
--                         Tax head under OTHERS. The RATE is still the dish's
--                         tax class; nothing here holds a rate.
--   tax_calculation_mode  forward adds tax to the price (100 + 5% = 105);
--                         reverse finds the tax already inside it (100 holds
--                         4.76 at 5%).
--
-- Written only by POST /admin/branches/:id/tax (`tax.setting.edit`), refused
-- while the branch has an open order, for the reason the GST position is: the
-- setting decides what a diner is charged.
--
-- THE ORDER SNAPSHOTS THE MODE, THE BILL SNAPSHOTS ALL OF IT.
--
-- `sales_order.prices_include_tax` is fixed when the order is opened, so every
-- line of one order is priced one way and a report reading the order lines
-- later knows which way, whatever the branch says by then. The bill stamps the
-- account it was raised under, the mode, and the registration number it
-- printed -- a reprint after the branch changes says what was true then.
--
-- A UAE jurisdiction is added, implemented: VAT, OTHERS or none, never GST.
-- India gains VAT and OTHERS as single-head treatments. Both are kept OUT of
-- the GST return, which reads only bills raised under the GST account.
-- ###########################################################################

ALTER TABLE app.branch
  ADD COLUMN tax_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN tax_account_type text NOT NULL DEFAULT 'gst',
  ADD COLUMN tax_calculation_mode text NOT NULL DEFAULT 'forward',
  ADD COLUMN tax_registration_no text,
  ADD COLUMN email text,
  ADD COLUMN bill_name text,
  ADD CONSTRAINT branch_tax_account_type_known
    CHECK (tax_account_type IN ('none', 'gst', 'vat', 'others')),
  ADD CONSTRAINT branch_tax_calculation_mode_known
    CHECK (tax_calculation_mode IN ('forward', 'reverse')),
  -- A VAT number (a UAE TRN is 15 digits) or another regime's: letters, digits,
  -- spaces, slashes and hyphens. A GSTIN keeps its own column and format.
  ADD CONSTRAINT branch_tax_registration_no_format
    CHECK (tax_registration_no IS NULL OR tax_registration_no ~ '^[A-Z0-9][A-Z0-9 /-]{2,28}[A-Z0-9]$'),
  ADD CONSTRAINT branch_email_format
    CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD CONSTRAINT branch_bill_name_length
    CHECK (bill_name IS NULL OR length(bill_name) BETWEEN 1 AND 120);

ALTER TABLE app.sales_order
  ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false;

-- Every bill so far was raised under GST, forward. The defaults backfill that,
-- and are then dropped: a writer states the account and the mode, never inherits them.
ALTER TABLE app.bill
  ADD COLUMN tax_account_type text NOT NULL DEFAULT 'gst',
  ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false,
  ADD COLUMN supplier_tax_registration_no text;
ALTER TABLE app.bill
  ALTER COLUMN tax_account_type DROP DEFAULT,
  ALTER COLUMN prices_include_tax DROP DEFAULT;

ALTER TABLE app.bill DROP CONSTRAINT bill_tax_treatment_known;
ALTER TABLE app.bill
  ADD CONSTRAINT bill_tax_treatment_known
  CHECK (tax_treatment IN ('intra_state', 'inter_state', 'none', 'unstated', 'vat', 'other'));

ALTER TABLE app.bill DROP CONSTRAINT bill_tax_treatment_consistent;
ALTER TABLE app.bill
  ADD CONSTRAINT bill_tax_treatment_consistent
  CHECK (
    CASE tax_treatment
      WHEN 'intra_state' THEN supplier_state_code IS NOT NULL AND place_of_supply_state_code IS NOT NULL
                              AND place_of_supply_state_code = supplier_state_code
      WHEN 'inter_state' THEN supplier_state_code IS NOT NULL AND place_of_supply_state_code IS NOT NULL
                              AND place_of_supply_state_code <> supplier_state_code
      WHEN 'none' THEN tax_minor = 0
      WHEN 'unstated' THEN supplier_state_code IS NULL AND tax_minor > 0
      -- One head, no state: a VAT or other-tax bill names no GST place of supply.
      WHEN 'vat' THEN tax_minor > 0 AND supplier_state_code IS NULL AND place_of_supply_state_code IS NULL
      WHEN 'other' THEN tax_minor > 0 AND supplier_state_code IS NULL AND place_of_supply_state_code IS NULL
      ELSE false
    END
  );

ALTER TABLE app.bill
  ADD CONSTRAINT bill_tax_account_type_known
    CHECK (tax_account_type IN ('none', 'gst', 'vat', 'others')),
  -- The account decides which treatments a bill may carry, and a bill outside
  -- GST carries no GST identity at all: no position, no GSTIN.
  ADD CONSTRAINT bill_treatment_fits_tax_account
    CHECK (
      CASE tax_account_type
        WHEN 'gst' THEN tax_treatment IN ('intra_state', 'inter_state', 'none', 'unstated')
        WHEN 'vat' THEN tax_treatment IN ('vat', 'none')
                        AND supplier_gst_registration IS NULL AND supplier_gstin IS NULL
        WHEN 'others' THEN tax_treatment IN ('other', 'none')
                           AND supplier_gst_registration IS NULL AND supplier_gstin IS NULL
        WHEN 'none' THEN tax_treatment = 'none'
                         AND supplier_gst_registration IS NULL AND supplier_gstin IS NULL
        ELSE false
      END
    ),
  -- The registration number printed on a VAT or other-tax bill; a GST bill keeps
  -- its GSTIN in supplier_gstin.
  ADD CONSTRAINT bill_supplier_tax_registration_no_outside_gst
    CHECK (supplier_tax_registration_no IS NULL OR tax_account_type IN ('vat', 'others'));

-- The catalogue: the code (src/modules/tax/jurisdictions.ts) authors it, and
-- tests/tax/jurisdiction.test.ts asserts the two agree in both directions.
INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule) VALUES
  ('IN', 'vat',   'VAT',       'required'),
  ('IN', 'other', 'Other tax', 'required');
INSERT INTO platform.tax_head (jurisdiction_code, treatment_key, name, share_bps, ordinal) VALUES
  ('IN', 'vat',   'VAT', 10000, 1),
  ('IN', 'other', 'TAX', 10000, 1);

-- ON CONFLICT: the down keeps the UAE while a restaurant trades in it, so an
-- up after such a down finds the rows already there.
INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
VALUES ('AE', 'United Arab Emirates', 'implemented', '971')
ON CONFLICT DO NOTHING;
INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule) VALUES
  ('AE', 'vat',   'VAT',              'required'),
  ('AE', 'other', 'Other tax',        'required'),
  ('AE', 'none',  'No tax collected', 'none')
ON CONFLICT DO NOTHING;
INSERT INTO platform.tax_head (jurisdiction_code, treatment_key, name, share_bps, ordinal) VALUES
  ('AE', 'vat',   'VAT', 10000, 1),
  ('AE', 'other', 'TAX', 10000, 1)
ON CONFLICT DO NOTHING;
