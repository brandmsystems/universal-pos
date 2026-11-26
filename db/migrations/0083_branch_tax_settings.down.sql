ALTER TABLE app.bill
  DROP CONSTRAINT bill_supplier_tax_registration_no_outside_gst,
  DROP CONSTRAINT bill_treatment_fits_tax_account,
  DROP CONSTRAINT bill_tax_account_type_known;

-- A VAT or other-tax bill already raised is a record of money taken, and its
-- lines keep their taxable value and tax. So the old CHECKs come back NOT
-- VALID: no new one can be written, and the rows that exist stay.
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
      ELSE false
    END
  ) NOT VALID;
ALTER TABLE app.bill DROP CONSTRAINT bill_tax_treatment_known;
ALTER TABLE app.bill
  ADD CONSTRAINT bill_tax_treatment_known
  CHECK (tax_treatment IN ('intra_state', 'inter_state', 'none', 'unstated')) NOT VALID;

ALTER TABLE app.bill
  DROP COLUMN supplier_tax_registration_no,
  DROP COLUMN prices_include_tax,
  DROP COLUMN tax_account_type;

ALTER TABLE app.sales_order DROP COLUMN prices_include_tax;

ALTER TABLE app.branch
  DROP CONSTRAINT branch_bill_name_length,
  DROP CONSTRAINT branch_email_format,
  DROP CONSTRAINT branch_tax_registration_no_format,
  DROP CONSTRAINT branch_tax_calculation_mode_known,
  DROP CONSTRAINT branch_tax_account_type_known,
  DROP COLUMN bill_name,
  DROP COLUMN email,
  DROP COLUMN tax_registration_no,
  DROP COLUMN tax_calculation_mode,
  DROP COLUMN tax_account_type,
  DROP COLUMN tax_enabled;

DELETE FROM platform.tax_head WHERE jurisdiction_code = 'IN' AND treatment_key IN ('vat', 'other');
DELETE FROM platform.tax_treatment WHERE jurisdiction_code = 'IN' AND key IN ('vat', 'other');

-- The UAE stays while a restaurant or a bill names it: those FKs are
-- ON DELETE RESTRICT, and a rollback must not take a jurisdiction out from
-- under a restaurant trading in it.
DELETE FROM platform.tax_head h
 WHERE h.jurisdiction_code = 'AE'
   AND NOT EXISTS (SELECT 1 FROM platform.tenant WHERE tax_jurisdiction = 'AE')
   AND NOT EXISTS (SELECT 1 FROM app.bill WHERE tax_jurisdiction = 'AE');
DELETE FROM platform.tax_treatment t
 WHERE t.jurisdiction_code = 'AE'
   AND NOT EXISTS (SELECT 1 FROM platform.tenant WHERE tax_jurisdiction = 'AE')
   AND NOT EXISTS (SELECT 1 FROM app.bill WHERE tax_jurisdiction = 'AE');
DELETE FROM platform.tax_jurisdiction j
 WHERE j.code = 'AE'
   AND NOT EXISTS (SELECT 1 FROM platform.tenant WHERE tax_jurisdiction = 'AE')
   AND NOT EXISTS (SELECT 1 FROM app.bill WHERE tax_jurisdiction = 'AE');

-- The catalogue's share checks are deferred to COMMIT. Fire them now, on the
-- rows deleted here, so a later statement in the same transaction (an earlier
-- migration's down dropping these tables) meets no pending events.
SET CONSTRAINTS platform.tax_head_shares_whole, platform.tax_treatment_shares_whole IMMEDIATE;
