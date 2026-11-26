-- Discount authority is a limit, not a key. Granting order.discount with no
-- ceiling grants unlimited comp, so the permission alone is not the control.
--
-- The two columns are deliberately asymmetric:
--
--   discount_percent_cap  NOT NULL DEFAULT 0  -- the authority. 0 = none.
--   discount_amount_cap   NULL                -- an ADDITIONAL ceiling, not the
--                                             -- authority. NULL is not
--                                             -- unlimited: the percentage
--                                             -- still binds.
--
-- Making both NOT NULL DEFAULT 0 would be simpler and wrong -- it cannot express
-- owner, who needs full percentage authority with no absolute ceiling, without
-- seeding an arbitrary large number that then reads as deliberate policy.
--
-- Per-membership overrides are deliberately absent: an override able to raise
-- authority above the role's cap is itself an escalation path, and enforcing
-- "may only lower" declaratively would mean denormalising both caps onto
-- membership behind a widened composite FK that cascades on every cap change.
ALTER TABLE app.role
  ADD COLUMN discount_percent_cap smallint NOT NULL DEFAULT 0
    CONSTRAINT role_discount_percent_cap_range CHECK (discount_percent_cap BETWEEN 0 AND 100),
  ADD COLUMN discount_amount_cap bigint
    CONSTRAINT role_discount_amount_cap_positive CHECK (discount_amount_cap IS NULL OR discount_amount_cap > 0);

COMMENT ON COLUMN app.role.discount_amount_cap IS
  'Additional absolute ceiling in minor units of tenant.default_currency. NULL means the percentage cap is the only ceiling, not that discounting is unlimited.';
