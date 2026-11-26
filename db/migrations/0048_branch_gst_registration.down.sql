DROP TRIGGER IF EXISTS order_line_tax_matches_registration ON app.order_line;
DROP FUNCTION IF EXISTS app.order_line_tax_matches_registration();

DROP TABLE IF EXISTS app.branch_gst_registration_change;

ALTER TABLE app.bill
  DROP CONSTRAINT IF EXISTS bill_unregistered_carries_no_tax,
  DROP CONSTRAINT IF EXISTS bill_registered_iff_supplier_gstin,
  DROP CONSTRAINT IF EXISTS bill_supplier_gst_registration_known,
  DROP COLUMN IF EXISTS supplier_gst_registration;

ALTER TABLE app.branch
  DROP CONSTRAINT IF EXISTS branch_registered_iff_gstin,
  DROP CONSTRAINT IF EXISTS branch_gst_registration_known,
  DROP COLUMN IF EXISTS gst_registration;
