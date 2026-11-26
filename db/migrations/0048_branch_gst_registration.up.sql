-- Whether a branch is GST-registered becomes a STATED position, not an
-- inference from a null GSTIN.
--
-- ###########################################################################
-- WHY THE NULL GSTIN COULD NOT BE THE ANSWER.
--
-- Until now `app.branch.gstin` was nullable and nothing read it to decide
-- whether tax applied. Tax came from the menu item's `tax_class`, snapshotted
-- onto the order line at add time, and `generateBill` summed those snapshots.
-- So a restaurant below the registration threshold -- no GSTIN, not entitled to
-- collect a paisa of GST -- still charged its diners 5% and the money went
-- nowhere lawful.
--
-- The obvious fix, suppressing tax when `gstin IS NULL`, is wrong twice.
--
-- First, absence is not a discriminator. A null GSTIN means "unregistered" and
-- also "registered, number applied for, not yet arrived" and also "the owner
-- has not filled this field in yet" -- three positions with two different
-- lawful tax behaviours. 0039's own comment says a GSTIN "arrives from the tax
-- department after the branch exists", so the field is deliberately null during
-- ordinary onboarding.
--
-- Second, it would change money silently. Every branch in every existing
-- deployment has a null GSTIN, because until 0039 there was no column and until
-- the previous phase there was no write path. Making null mean zero-rated would
-- have taken the tax off every live bill on the day this migration ran.
--
-- Hence three values and a legacy one. `unstated` is what every existing row
-- becomes: it behaves EXACTLY as today (the tax class applies), so this
-- migration moves no money, and the admin surface nags until it is answered. A
-- branch created after this migration can never be `unstated` -- the create
-- path demands an answer -- so the value drains and does not accumulate.
-- ###########################################################################
ALTER TABLE app.branch
  ADD COLUMN gst_registration text;

-- A branch that already carries a GSTIN has answered the question by carrying
-- it. Everything else is unanswered, which is not the same as unregistered.
UPDATE app.branch
   SET gst_registration = CASE WHEN gstin IS NOT NULL THEN 'registered' ELSE 'unstated' END;

ALTER TABLE app.branch
  ALTER COLUMN gst_registration SET NOT NULL,

  ADD CONSTRAINT branch_gst_registration_known
  CHECK (gst_registration IN ('registered', 'unregistered', 'unstated')),

  -- The biconditional that makes a lying branch unrepresentable. A registered
  -- branch without a number cannot raise a compliant bill, and a branch holding
  -- a number cannot claim to be unregistered -- it would be collecting tax under
  -- a registration it denies having.
  ADD CONSTRAINT branch_registered_iff_gstin
  CHECK ((gst_registration = 'registered') = (gstin IS NOT NULL));

COMMENT ON COLUMN app.branch.gst_registration IS
  'Stated GST position. registered: tax classes apply. unregistered: order lines '
  'resolve at an explicit 0 bps. unstated: legacy rows only, behaves as '
  'registered did before 0048, and the admin surface prompts for an answer.';


-- ###########################################################################
-- THE POSITION TRAVELS ON THE DOCUMENT.
--
-- A bill showing no tax is either lawful or a misconfiguration, and the paper
-- cannot tell you which. `supplier_gstin` being null does not distinguish them
-- either -- an `unstated` branch has no GSTIN and DOES charge tax.
--
-- Snapshotted, not joined, for the reason every other column here is: a branch
-- that registers in October must not retitle September's bills as tax invoices.
-- ###########################################################################
ALTER TABLE app.bill
  ADD COLUMN supplier_gst_registration text,

  ADD CONSTRAINT bill_supplier_gst_registration_known
  CHECK (supplier_gst_registration IS NULL
      OR supplier_gst_registration IN ('registered', 'unregistered', 'unstated')),

  -- The same biconditional as the branch, on the snapshot. Null on both sides is
  -- permitted only for bills raised before this migration existed.
  ADD CONSTRAINT bill_registered_iff_supplier_gstin
  CHECK (supplier_gst_registration IS NULL
      OR (supplier_gst_registration = 'registered') = (supplier_gstin IS NOT NULL)),

  -- An unregistered supply carries no tax. This is the constraint that makes the
  -- suppression structural rather than a property of one code path: if a future
  -- change forgets to zero the line rates, the bill is refused rather than
  -- printed.
  ADD CONSTRAINT bill_unregistered_carries_no_tax
  CHECK (supplier_gst_registration IS DISTINCT FROM 'unregistered' OR tax_minor = 0);


-- ###########################################################################
-- WHY THE CHANGE IS RECORDED AND NOT MERELY PERFORMED.
--
-- A GST return covers a period. If a branch crosses the threshold on the 12th,
-- the return for that month has zero-rated supplies up to the 11th and taxable
-- supplies from the 12th, and the filer has to be able to say why. The bill
-- snapshot proves what each document did; this table proves WHEN the position
-- moved and who moved it, which is the question an assessing officer asks.
--
-- The business date, not the calendar date: the position moves at a boundary the
-- restaurant recognises, and a change made at 1am belongs to the trading day
-- that has not yet ended.
--
-- Append-only. UPDATE and DELETE are revoked from katkitchen_app below, for the
-- same reason stock_movement is: a record whose purpose is to be believed later
-- must not be editable by the plane that produced it.
-- ###########################################################################
CREATE TABLE app.branch_gst_registration_change (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id          uuid        NOT NULL,

  from_registration  text        NOT NULL,
  to_registration    text        NOT NULL,
  from_gstin         text,
  to_gstin           text,

  business_date      date        NOT NULL,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id uuid        NOT NULL,

  CONSTRAINT branch_gst_change_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT branch_gst_change_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_gst_change_actor_fk
  FOREIGN KEY (tenant_id, changed_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT branch_gst_change_from_known
  CHECK (from_registration IN ('registered', 'unregistered', 'unstated')),
  CONSTRAINT branch_gst_change_to_known
  CHECK (to_registration IN ('registered', 'unregistered', 'unstated')),

  -- A row that records no movement is noise in the one place that must not have
  -- any. And nothing may move TO `unstated`: it is a migration artifact, not a
  -- position an owner can choose.
  CONSTRAINT branch_gst_change_moves
  CHECK (from_registration <> to_registration OR from_gstin IS DISTINCT FROM to_gstin),
  CONSTRAINT branch_gst_change_to_not_unstated
  CHECK (to_registration <> 'unstated'),

  CONSTRAINT branch_gst_change_to_registered_has_gstin
  CHECK ((to_registration = 'registered') = (to_gstin IS NOT NULL))
);

CREATE INDEX branch_gst_change_by_branch_idx
  ON app.branch_gst_registration_change (tenant_id, branch_id, business_date DESC);

ALTER TABLE app.branch_gst_registration_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_gst_registration_change
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON app.branch_gst_registration_change FROM katkitchen_app;


-- ###########################################################################
-- THE SUPPRESSION MADE STRUCTURAL.
--
-- `resolveOrderableItem` and the two combo paths now zero the rate for an
-- unregistered branch, and that is the code that gives a good answer: the
-- waiter sees the right price and nothing is refused in front of a customer.
--
-- But three query sites is three places to forget, and this repo's recurring
-- defect is precisely code that is correct and joined to the running system by
-- nothing. A fourth write path added next year -- a delivery-channel importer,
-- an offline replay, a bulk line insert -- would collect tax at a branch with
-- no registration to remit it under, and every existing test would pass.
--
-- So the database refuses it. One indexed lookup per inserted line, against a
-- table already in cache, and it makes the unlawful row unrepresentable rather
-- than merely unlikely.
--
-- It fires on INSERT and on UPDATE OF tax_rate_bps: a line's rate is a snapshot
-- and is not supposed to move at all, but if something does move it, it must
-- not be able to move it upward past this.
-- ###########################################################################
CREATE FUNCTION app.order_line_tax_matches_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  position text;
BEGIN
  IF NEW.tax_rate_bps IS NULL OR NEW.tax_rate_bps = 0 THEN
    RETURN NEW;
  END IF;

  SELECT b.gst_registration INTO position
    FROM app.branch b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.branch_id;

  IF position = 'unregistered' THEN
    RAISE EXCEPTION
      'order_line_tax_requires_registration: branch % is not GST-registered and cannot carry a %bps rate',
      NEW.branch_id, NEW.tax_rate_bps
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_line_tax_requires_registration';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER order_line_tax_matches_registration
  BEFORE INSERT OR UPDATE OF tax_rate_bps ON app.order_line
  FOR EACH ROW EXECUTE FUNCTION app.order_line_tax_matches_registration();
