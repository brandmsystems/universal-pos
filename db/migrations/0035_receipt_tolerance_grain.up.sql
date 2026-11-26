-- Over-receipt tolerance moves to the PRODUCT, with the branch as the default.
--
-- The grain was wrong. A tolerance answers "is this delivery close enough to what
-- we ordered", and closeness is a property of what is being measured, not of the
-- building it arrives at. 2% over on flour by weight is a scoop; 2% over on a
-- case of wine is not a thing that can happen.
--
-- The branch column stays as the DEFAULT rather than being dropped: a tenant
-- with 400 products cannot be made to set a tolerance on each one before they
-- can receive anything, which is the same onboarding-wall argument that made the
-- missing-recipe gate entitlement-scoped. COALESCE(product, branch).
--
-- A NOTE ON DISCRETE UNITS, so nobody "fixes" it later:
-- a percentage is a poor instrument for a count product, because the same
-- physical event -- one extra bottle -- is 8% of a case of twelve and 1% of a
-- hundred. It is tolerable here only because the percentage is the REFUSAL
-- threshold and not the control: every over-receipt within tolerance still
-- requires a reason code, and the small-order case errs toward demanding an
-- explanation, which is the safe direction. If that stops being enough the fix
-- is an absolute allowance for count-dimension products, not a wider percentage.
ALTER TABLE app.product
  ADD COLUMN over_receipt_tolerance_bps integer
  CONSTRAINT product_over_receipt_tolerance_range
  CHECK (over_receipt_tolerance_bps IS NULL
      OR over_receipt_tolerance_bps BETWEEN 0 AND 10000);

COMMENT ON COLUMN app.product.over_receipt_tolerance_bps IS
  'NULL means "the branch default binds", not "unlimited" -- same reading as a NULL discount amount cap.';
