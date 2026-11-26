-- A parcel charge: a line on the order, typed at the till, capped by the branch.
--
-- ###########################################################################
-- A LINE, NOT A COLUMN ON THE BILL.
--
-- Packing on a restaurant parcel is part of the one supply and is taxed with
-- it, so the charge needs a tax rate, a snapshot and a place in the GST
-- return. `bill_line` references `order_line`, and the bill, the paper and the
-- return already read every taxed figure from there. A `bill.parcel_charge`
-- column would be a figure none of them read: `bill_total_is_subtotal_plus_tax`
-- and `assert_billing_invariants` would have to learn it, and the return would
-- reconcile to the bills only by also learning it.
--
-- So `kind = 'charge'`: quantity 1, its own price, no menu item, never an
-- adjustment target (`order_line_adjusts_priced_kind` already names the two
-- kinds that may be), never sent to the kitchen (every kitchen path selects
-- `kind IN ('item', ...)`, an allowlist this kind is not on).
--
-- THE AMOUNT IS TYPED, SO THE BRANCH CAPS IT. A price from a tablet is the
-- thing the priced-document rule refuses; this one is permitted because it is
-- bounded, like a discount: `parcel_charge_max_minor` is the authority and
-- defaults to 0, so a branch charges nothing until a manager decides it does
-- -- the same direction as `discount_percent_cap`. The default is what the
-- till fills in. A cap above zero needs a tax class: an untaxed charge is the
-- silent under-collection, so the schema refuses the setting rather than the
-- bill discovering it.
-- ###########################################################################

ALTER TABLE app.order_line DROP CONSTRAINT order_line_kind_known;
ALTER TABLE app.order_line
  ADD CONSTRAINT order_line_kind_known
  CHECK (kind IN ('item', 'combo_parent', 'combo_component',
                  'void', 'comp', 'discount', 'charge'));

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
      -- Not food: no menu item, no guest, no kitchen note, nothing to adjust.
      -- 0 is the stated "no charge": a charge cleared after a bill was made
      -- cannot be deleted (the voided bill's line still references it), so it
      -- is set to 0, and a 0 line is never billed (billableLines bills > 0).
      WHEN 'charge' THEN
        quantity = 1 AND unit_price_minor >= 0 AND line_total_minor = unit_price_minor
        AND menu_item_id IS NULL AND display_total_minor IS NULL AND parent_line_id IS NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
        AND guest_no IS NULL AND note IS NULL
      ELSE false
    END
  );

-- One charge per order: changing it replaces the line, it never adds a second.
CREATE UNIQUE INDEX order_line_one_charge_per_order
  ON app.order_line (tenant_id, order_id) WHERE kind = 'charge';

ALTER TABLE app.branch
  ADD COLUMN parcel_charge_default_minor bigint NOT NULL DEFAULT 0
    CONSTRAINT branch_parcel_charge_default_non_negative CHECK (parcel_charge_default_minor >= 0),
  ADD COLUMN parcel_charge_max_minor bigint NOT NULL DEFAULT 0
    CONSTRAINT branch_parcel_charge_max_non_negative CHECK (parcel_charge_max_minor >= 0),
  ADD COLUMN parcel_charge_tax_class_id uuid,
  ADD CONSTRAINT branch_parcel_charge_default_within_max
    CHECK (parcel_charge_default_minor <= parcel_charge_max_minor),
  ADD CONSTRAINT branch_parcel_charge_taxed
    CHECK (parcel_charge_max_minor = 0 OR parcel_charge_tax_class_id IS NOT NULL),
  ADD CONSTRAINT branch_parcel_charge_tax_class_fk
    FOREIGN KEY (tenant_id, parcel_charge_tax_class_id)
    REFERENCES app.tax_class (tenant_id, id) ON DELETE RESTRICT;
