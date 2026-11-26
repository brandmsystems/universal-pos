ALTER TABLE app.branch
  DROP CONSTRAINT branch_parcel_charge_tax_class_fk,
  DROP CONSTRAINT branch_parcel_charge_taxed,
  DROP CONSTRAINT branch_parcel_charge_default_within_max,
  DROP COLUMN parcel_charge_tax_class_id,
  DROP COLUMN parcel_charge_max_minor,
  DROP COLUMN parcel_charge_default_minor;

DROP INDEX app.order_line_one_charge_per_order;

-- A charge line already billed is a record of money taken, and bill_line pins
-- it (ON DELETE RESTRICT). A rollback must not destroy one, so the old CHECKs
-- come back NOT VALID: no new charge can be written, and the rows that exist stay.
ALTER TABLE app.order_line DROP CONSTRAINT order_line_shape_exact;
ALTER TABLE app.order_line
  ADD CONSTRAINT order_line_shape_exact
  CHECK (
    CASE kind
      WHEN 'item' THEN
        quantity > 0 AND unit_price_minor IS NOT NULL AND line_total_minor > 0
        AND display_total_minor IS NULL AND parent_line_id IS NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      WHEN 'combo_parent' THEN
        quantity > 0 AND unit_price_minor IS NULL AND line_total_minor IS NULL
        AND display_total_minor IS NOT NULL AND parent_line_id IS NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      WHEN 'combo_component' THEN
        quantity > 0 AND unit_price_minor IS NOT NULL AND line_total_minor > 0
        AND display_total_minor IS NULL AND parent_line_id IS NOT NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      WHEN 'void' THEN
        quantity < 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      WHEN 'comp' THEN
        quantity = 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      WHEN 'discount' THEN
        quantity = 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      ELSE false
    END
  ) NOT VALID;

ALTER TABLE app.order_line DROP CONSTRAINT order_line_kind_known;
ALTER TABLE app.order_line
  ADD CONSTRAINT order_line_kind_known
  CHECK (kind IN ('item', 'combo_parent', 'combo_component',
                  'void', 'comp', 'discount')) NOT VALID;
