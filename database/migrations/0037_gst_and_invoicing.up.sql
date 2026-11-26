-- Invoicing, GST place of supply, and subscription segments.
--
-- Control plane only. Nothing here reads schema `app`.
--
-- ###########################################################################
-- WHY PLACE OF SUPPLY IS STRUCTURAL AND NOT A COMPUTED CONVENIENCE
--
-- Charging CGST+SGST where IGST was due does not misstate a total -- 18% is 18%
-- either way. It breaks the RECIPIENT'S INPUT TAX CREDIT: credit claimed under
-- the wrong head is disallowed, and their only remedy is for us to credit-note
-- and reissue every invoice we ever sent them. The amount is right and the
-- document is worthless.
--
-- So the treatment is snapshotted, and a deferred trigger makes an invoice whose
-- component set contradicts its own declared treatment UNISSUABLE.
-- ###########################################################################

CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions;

-- OUR registration. Data, not a constant: hardcoding one state is what breaks
-- the day a second registration exists, and there will be one.
CREATE TABLE platform.supplier_gst_registration (
  id          uuid        PRIMARY KEY,
  state_code  text        NOT NULL
              CONSTRAINT supplier_state_code_format CHECK (state_code ~ '^[0-9]{2}$'),
  gstin       text        NOT NULL
              CONSTRAINT supplier_gstin_format
              CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  legal_name  text        NOT NULL,
  address     text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT 'active'
              CONSTRAINT supplier_registration_status_known CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- The GSTIN carries its own state in characters 1-2. If the two disagree one of
  -- them is wrong and we cannot know which, so it is refused rather than
  -- reconciled.
  CONSTRAINT supplier_gstin_matches_state CHECK (substring(gstin, 1, 2) = state_code)
);

CREATE UNIQUE INDEX supplier_gst_registration_one_default
  ON platform.supplier_gst_registration ((true)) WHERE is_default AND status = 'active';
CREATE UNIQUE INDEX supplier_gst_registration_active_gstin
  ON platform.supplier_gst_registration (gstin) WHERE status = 'active';


-- The tenant's tax identity. Separate from `tenant` because it is an optional
-- concern with its own validation and its own write authority.
CREATE TABLE platform.tenant_tax_profile (
  tenant_id      uuid        PRIMARY KEY REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  legal_name     text        NOT NULL,

  -- Nullable: an unregistered restaurant is B2C, which is a legitimate state and
  -- not a missing field.
  gstin          text
                 CONSTRAINT tenant_gstin_format
                 CHECK (gstin IS NULL
                     OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code     text        NOT NULL
                 CONSTRAINT tenant_state_code_format CHECK (state_code ~ '^[0-9]{2}$'),
  country_code   text        NOT NULL DEFAULT 'IN'
                 CONSTRAINT tenant_country_code_format CHECK (country_code ~ '^[A-Z]{2}$'),
  billing_address text       NOT NULL,

  is_sez         boolean     NOT NULL DEFAULT false,
  sez_loa_number text,
  lut_number     text,

  -- Configurable per tenant. Not everyone is on an April basis, and hardcoding
  -- April is the kind of assumption that is invisible until it is wrong.
  financial_year_starts_month smallint NOT NULL DEFAULT 4
                 CONSTRAINT tenant_fy_start_month_range
                 CHECK (financial_year_starts_month BETWEEN 1 AND 12),

  -- ########################################################################
  -- ZERO-RATING IS NOT SELF-SERVICE.
  --
  -- is_sez and a non-IN country_code both mean "charge no tax", and if the claim
  -- is wrong WE carry the liability. A tenant ticking a box must not be able to
  -- exempt itself, so both require a platform user to have seen the evidence --
  -- the same class of control as a feature flag override.
  --
  -- The mechanism is that the grant NAMES a platform user. The tenant plane holds
  -- no platform user id and cannot forge one past the FK, so the write is
  -- structurally unavailable to it rather than merely forbidden by convention.
  -- ########################################################################
  exemption_granted_by_platform_user_id uuid
                 REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  exemption_granted_at timestamptz,
  exemption_evidence   text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- The GSTIN is the authority; the free-text address never overrides it.
  CONSTRAINT tenant_gstin_matches_state
  CHECK (gstin IS NULL OR substring(gstin, 1, 2) = state_code),

  CONSTRAINT tenant_exemption_attributed
  CHECK (
    (is_sez = false AND country_code = 'IN')
    OR (exemption_granted_by_platform_user_id IS NOT NULL
        AND exemption_granted_at IS NOT NULL
        AND exemption_evidence IS NOT NULL
        AND lut_number IS NOT NULL
        AND (is_sez = false OR sez_loa_number IS NOT NULL))
  ),

  -- LUT ONLY, DELIBERATELY. Zero-rated supply has two lawful forms: under Letter
  -- of Undertaking (no tax charged) or with IGST paid and refunded later. The
  -- second means funding the tax and chasing a refund, which is a treasury
  -- decision rather than a feature. Its absence is an exclusion, not an oversight;
  -- adding it later means a second treatment and a second component set.
  CONSTRAINT tenant_zero_rated_requires_lut
  CHECK ((is_sez = false AND country_code = 'IN') OR lut_number IS NOT NULL)
);

CREATE TRIGGER tenant_tax_profile_set_updated_at
  BEFORE UPDATE ON platform.tenant_tax_profile
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Belt to the CHECK's braces: changing either exemption field must RE-STATE the
-- granting platform user in the same statement. A stale grant from six months ago
-- cannot carry a new claim.
CREATE FUNCTION platform.guard_tax_exemption() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.is_sez IS DISTINCT FROM OLD.is_sez
      OR NEW.country_code IS DISTINCT FROM OLD.country_code)
     AND NEW.exemption_granted_at IS NOT DISTINCT FROM OLD.exemption_granted_at THEN
    RAISE EXCEPTION
      'is_sez and country_code are zero-rating claims: changing one requires a platform user to re-grant it against evidence'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER tenant_tax_profile_exemption_guard
  BEFORE UPDATE ON platform.tenant_tax_profile
  FOR EACH ROW EXECUTE FUNCTION platform.guard_tax_exemption();


-- '2026-27' for 2026-06-01 on an April basis; '2025-26' for 2026-03-01.
CREATE FUNCTION platform.financial_year_label(d date, start_month smallint)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN extract(month FROM d) >= start_month
             THEN to_char(d, 'YYYY') || '-' || to_char((date_trunc('year', d) + interval '1 year')::date, 'YY')
           ELSE to_char((date_trunc('year', d) - interval '1 year')::date, 'YYYY') || '-' || to_char(d, 'YY')
         END
$fn$;


-- ###########################################################################
-- GAPLESS NUMBERING, PER TENANT PER SERIES PER FINANCIAL YEAR.
--
-- Statutory in India, not a nicety. A SEQUENCE is disqualified for exactly the
-- reason it was disqualified for KOT tickets: sequences deliberately do not roll
-- back, so every aborted invoice run burns a number -- and here a burned number is
-- a gap a tax officer will ask about. An ordinary counter row is gapless BECAUSE
-- the increment participates in the transaction.
--
-- A credit note carries its OWN series. Interleaving them would make neither
-- series contiguous.
-- ###########################################################################
CREATE TABLE platform.document_sequence (
  tenant_id      uuid   NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  series         text   NOT NULL
                 CONSTRAINT document_series_known CHECK (series IN ('invoice', 'credit_note')),
  financial_year text   NOT NULL
                 CONSTRAINT document_fy_format CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  next_no        bigint NOT NULL DEFAULT 0 CHECK (next_no >= 0),

  PRIMARY KEY (tenant_id, series, financial_year)
);

CREATE FUNCTION platform.next_document_no(
  target_tenant uuid, target_series text, target_fy text
) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE
  allocated bigint;
BEGIN
  INSERT INTO platform.document_sequence (tenant_id, series, financial_year, next_no)
  VALUES (target_tenant, target_series, target_fy, 0)
  ON CONFLICT DO NOTHING;

  UPDATE platform.document_sequence
     SET next_no = next_no + 1
   WHERE tenant_id = target_tenant AND series = target_series AND financial_year = target_fy
  RETURNING next_no INTO allocated;

  RETURN allocated;
END
$fn$;


-- ###########################################################################
-- SEGMENTS, NOT PRORATION.
--
-- A segment is a contiguous span during which the plan and quantity were
-- constant. An invoice bills a set of segments, so a mid-period change does not
-- create an "adjustment" -- it creates a second segment.
--
-- This is why there is no credit-and-rebill path. A credit note under Section 34
-- records a REDUCTION IN THE TAXABLE VALUE OF A SUPPLY ALREADY MADE. Routine
-- proration is not that: the earlier invoice was correct for the facts at the
-- time. Credit-and-rebill asserts an error that did not occur, and it burns a
-- number in a statutory series to do it.
-- ###########################################################################
CREATE TABLE platform.subscription_segment (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  subscription_id uuid        NOT NULL REFERENCES platform.subscription (id) ON DELETE RESTRICT,

  plan_id         uuid        NOT NULL,
  plan_version_id uuid        NOT NULL,
  -- Seats. Quantity changes and plan changes are the SAME event to this table,
  -- which is what makes them the same mechanism.
  quantity        integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),

  starts_at       timestamptz NOT NULL,
  -- NULL means open: the segment currently in force.
  ends_at         timestamptz,

  -- Set when the segment is billed. This is what makes generation idempotent per
  -- period: an already-invoiced segment cannot be billed twice, and the gapless
  -- series makes that failure permanent if it happened.
  invoiced_on_invoice_id uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscription_segment_ordered CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT subscription_segment_version_belongs_to_plan
  FOREIGN KEY (plan_id, plan_version_id)
    REFERENCES platform.plan_version (plan_id, id) ON DELETE RESTRICT,

  -- Two segments of one subscription cannot overlap: at any instant exactly one
  -- plan and quantity were in force, and billing two of them would double-charge.
  CONSTRAINT subscription_segment_no_overlap
  EXCLUDE USING gist (
    subscription_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);

CREATE INDEX subscription_segment_uninvoiced_idx
  ON platform.subscription_segment (tenant_id, subscription_id, starts_at)
  WHERE invoiced_on_invoice_id IS NULL;


-- A downgrade or seat decrease, scheduled to the period boundary. Upgrades take
-- effect immediately and never appear here: the direction that expands what the
-- customer has is immediate, the direction that contracts it waits for a boundary.
CREATE TABLE platform.scheduled_subscription_change (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  subscription_id  uuid        NOT NULL REFERENCES platform.subscription (id) ON DELETE RESTRICT,

  kind             text        NOT NULL
                   CONSTRAINT scheduled_change_kind_known
                   CHECK (kind IN ('downgrade', 'seat_decrease')),
  target_plan_id         uuid,
  target_plan_version_id uuid,
  target_quantity        integer CHECK (target_quantity IS NULL OR target_quantity > 0),

  effective_at     timestamptz NOT NULL,

  status           text        NOT NULL DEFAULT 'pending'
                   CONSTRAINT scheduled_change_status_known
                   CHECK (status IN ('pending', 'applied', 'revoked', 'failed')),

  -- The over-quota ruling: a downgrade that would leave the tenant above the
  -- target plan's limits FAILS TO APPLY and the subscription stays put. A billing
  -- job must never take a restaurant offline, and entitlements failing closed
  -- means over-quota already prevents ADDING -- if enforcement reached existing
  -- branches it would silently disable locations that are open and trading.
  failure_reason   text,

  requested_by_user_id uuid,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  applied_at       timestamptz,

  CONSTRAINT scheduled_change_target_shape
  CHECK (
    CASE kind
      WHEN 'downgrade'     THEN target_plan_version_id IS NOT NULL AND target_plan_id IS NOT NULL
      WHEN 'seat_decrease' THEN target_quantity IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT scheduled_change_version_belongs_to_plan
  FOREIGN KEY (target_plan_id, target_plan_version_id)
    REFERENCES platform.plan_version (plan_id, id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_change_resolution_consistent
  CHECK (
    CASE status
      WHEN 'pending' THEN revoked_at IS NULL AND applied_at IS NULL AND failure_reason IS NULL
      WHEN 'revoked' THEN revoked_at IS NOT NULL
      WHEN 'applied' THEN applied_at IS NOT NULL
      WHEN 'failed'  THEN failure_reason IS NOT NULL
      ELSE false
    END
  )
);

-- One pending change per subscription: a queue of contradictory scheduled
-- downgrades has no defensible resolution order. Partial per rule 11.
CREATE UNIQUE INDEX scheduled_change_one_pending
  ON platform.scheduled_subscription_change (subscription_id) WHERE status = 'pending';


CREATE TABLE platform.invoice (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  subscription_id uuid        NOT NULL REFERENCES platform.subscription (id) ON DELETE RESTRICT,

  financial_year  text        NOT NULL,
  sequence_no     bigint      NOT NULL CHECK (sequence_no > 0),
  -- The human-facing number. Derived at issue and stored, because a format change
  -- must never alter a document already sent.
  --
  -- It CARRIES THE SERIES CODE, and that is not cosmetic. Rule 46 wants the
  -- supplier's numbering unique for the financial year; a per-tenant counter is a
  -- set of parallel series, which only satisfies that if each series is
  -- identifiable in the number itself. Without the code, two tenants both produce
  -- INV/2026-27/000001 and our own books have duplicate invoice numbers.
  number          text        NOT NULL,

  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  issue_date      date        NOT NULL,
  due_date        date        NOT NULL,

  -- ##################### PARTY SNAPSHOT, BOTH SIDES ######################
  -- A tenant relocating from Karnataka to Maharashtra must not retroactively
  -- convert two years of invoices from CGST+SGST to IGST. Priced-document rule,
  -- applied to tax identity rather than to price.
  supplier_gstin       text   NOT NULL,
  supplier_state_code  text   NOT NULL,
  supplier_legal_name  text   NOT NULL,
  recipient_gstin      text,
  recipient_state_code text   NOT NULL,
  recipient_legal_name text   NOT NULL,
  recipient_address    text   NOT NULL,

  place_of_supply_state_code text NOT NULL,
  tax_treatment   text        NOT NULL
                  CONSTRAINT invoice_tax_treatment_known
                  CHECK (tax_treatment IN ('intra_state', 'inter_state', 'export', 'sez')),
  lut_number      text,

  currency        text        NOT NULL
                  CONSTRAINT invoice_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor  bigint      NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor       bigint      NOT NULL CHECK (tax_minor >= 0),
  -- The Round Off line every Indian invoice carries. Where the remainder
  -- genuinely arises: the grand total is presented in whole rupees.
  round_off_minor bigint      NOT NULL DEFAULT 0,
  total_minor     bigint      NOT NULL CHECK (total_minor >= 0),

  status          text        NOT NULL DEFAULT 'issued'
                  CONSTRAINT invoice_status_known
                  CHECK (status IN ('issued', 'paid', 'void')),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  void_credit_note_id uuid,

  CONSTRAINT invoice_number_unique UNIQUE (tenant_id, financial_year, sequence_no),
  CONSTRAINT invoice_number_text_unique UNIQUE (number),
  CONSTRAINT invoice_period_ordered CHECK (period_end > period_start),
  CONSTRAINT invoice_total_balances
  CHECK (total_minor = subtotal_minor + tax_minor + round_off_minor),
  -- The round off is what makes this true, and asserting it is what makes the
  -- round off real rather than decorative.
  CONSTRAINT invoice_total_is_whole_currency_unit CHECK (total_minor % 100 = 0),
  CONSTRAINT invoice_round_off_bounded CHECK (round_off_minor BETWEEN -50 AND 50),
  CONSTRAINT invoice_zero_rated_has_lut
  CHECK (tax_treatment IN ('intra_state', 'inter_state') OR lut_number IS NOT NULL),
  CONSTRAINT invoice_place_of_supply_consistent
  CHECK (
    CASE tax_treatment
      WHEN 'intra_state' THEN place_of_supply_state_code = supplier_state_code
      WHEN 'inter_state' THEN place_of_supply_state_code <> supplier_state_code
      ELSE true
    END
  ),
  CONSTRAINT invoice_paid_consistent CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

CREATE INDEX invoice_by_tenant_idx ON platform.invoice (tenant_id, issue_date DESC);
CREATE INDEX invoice_unpaid_idx ON platform.invoice (due_date) WHERE status = 'issued';

ALTER TABLE platform.subscription_segment
  ADD CONSTRAINT subscription_segment_invoice_fk
  FOREIGN KEY (invoiced_on_invoice_id) REFERENCES platform.invoice (id) ON DELETE RESTRICT;


CREATE TABLE platform.invoice_line (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  invoice_id     uuid        NOT NULL REFERENCES platform.invoice (id) ON DELETE RESTRICT,

  kind           text        NOT NULL
                 CONSTRAINT invoice_line_kind_known CHECK (kind IN ('segment', 'round_off')),
  line_no        integer     NOT NULL CHECK (line_no > 0),

  segment_id     uuid REFERENCES platform.subscription_segment (id) ON DELETE RESTRICT,
  description    text        NOT NULL,
  -- Services Accounting Code. Snapshotted: a reclassification must not alter a
  -- document already filed.
  sac_code       text,
  period_from    timestamptz,
  period_to      timestamptz,
  quantity       integer,
  unit_price_minor bigint,
  amount_minor   bigint      NOT NULL,

  CONSTRAINT invoice_line_no_unique UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_line_shape_exact
  CHECK (
    CASE kind
      WHEN 'segment' THEN segment_id IS NOT NULL AND sac_code IS NOT NULL
                          AND period_from IS NOT NULL AND period_to IS NOT NULL
                          AND quantity IS NOT NULL AND unit_price_minor IS NOT NULL
      -- The round off carries an amount and nothing else, and is never taxed.
      WHEN 'round_off' THEN segment_id IS NULL AND quantity IS NULL
                          AND unit_price_minor IS NULL
      ELSE false
    END
  )
);

CREATE INDEX invoice_line_by_invoice_idx ON platform.invoice_line (invoice_id);


-- Components as a child table, exactly as app.tax_component is: the split varies
-- by jurisdiction and does not belong as columns.
CREATE TABLE platform.invoice_tax_component (
  id              uuid   PRIMARY KEY,
  tenant_id       uuid   NOT NULL,
  invoice_id      uuid   NOT NULL REFERENCES platform.invoice (id) ON DELETE RESTRICT,
  invoice_line_id uuid   NOT NULL REFERENCES platform.invoice_line (id) ON DELETE RESTRICT,

  name            text   NOT NULL
                  CONSTRAINT invoice_tax_component_name_known
                  CHECK (name IN ('CGST', 'SGST', 'IGST')),
  rate_bps        integer NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  amount_minor    bigint  NOT NULL CHECK (amount_minor >= 0),

  CONSTRAINT invoice_tax_component_unique UNIQUE (invoice_line_id, name)
);

CREATE INDEX invoice_tax_component_by_invoice_idx
  ON platform.invoice_tax_component (invoice_id);


-- Deferred, firing at COMMIT: the rows are written in one transaction, and by the
-- time any nightly check ran the invoice would already be with the customer and
-- in a return. Same family as combo allocation and tender balance.
CREATE FUNCTION platform.assert_invoice_consistent() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  inv           platform.invoice;
  seg_total     bigint;
  round_total   bigint;
  comp_total    bigint;
  bad_line      uuid;
  headline      integer;
BEGIN
  SELECT * INTO inv FROM platform.invoice
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF inv.id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount_minor) FILTER (WHERE kind = 'segment'), 0),
         COALESCE(sum(amount_minor) FILTER (WHERE kind = 'round_off'), 0)
    INTO seg_total, round_total
    FROM platform.invoice_line WHERE invoice_id = inv.id;

  SELECT COALESCE(sum(amount_minor), 0) INTO comp_total
    FROM platform.invoice_tax_component WHERE invoice_id = inv.id;

  IF seg_total <> inv.subtotal_minor THEN
    RAISE EXCEPTION 'invoice % segment lines sum to % but the invoice says %',
      inv.number, seg_total, inv.subtotal_minor;
  END IF;
  IF round_total <> inv.round_off_minor THEN
    RAISE EXCEPTION 'invoice % round-off line is % but the invoice says %',
      inv.number, round_total, inv.round_off_minor;
  END IF;
  IF comp_total <> inv.tax_minor THEN
    RAISE EXCEPTION 'invoice % tax components sum to % but the invoice says %',
      inv.number, comp_total, inv.tax_minor;
  END IF;

  -- THE GUARD THAT MAKES A DEFECTIVE INVOICE UNISSUABLE: the component set must
  -- match the declared treatment, per taxable line.
  IF inv.tax_treatment = 'intra_state' THEN
    SELECT l.id INTO bad_line
      FROM platform.invoice_line l
      LEFT JOIN platform.invoice_tax_component c ON c.invoice_line_id = l.id
     WHERE l.invoice_id = inv.id AND l.kind = 'segment'
     GROUP BY l.id
    HAVING array_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL)
             IS DISTINCT FROM ARRAY['CGST', 'SGST']
        OR count(DISTINCT c.rate_bps) <> 1;
    IF bad_line IS NOT NULL THEN
      RAISE EXCEPTION
        'invoice % is intra-state: every line needs CGST and SGST at equal rates (line %)',
        inv.number, bad_line;
    END IF;

  ELSIF inv.tax_treatment = 'inter_state' THEN
    SELECT l.id INTO bad_line
      FROM platform.invoice_line l
      LEFT JOIN platform.invoice_tax_component c ON c.invoice_line_id = l.id
     WHERE l.invoice_id = inv.id AND l.kind = 'segment'
     GROUP BY l.id
    HAVING array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) IS DISTINCT FROM ARRAY['IGST'];
    IF bad_line IS NOT NULL THEN
      RAISE EXCEPTION 'invoice % is inter-state: every line needs exactly IGST (line %)',
        inv.number, bad_line;
    END IF;

  ELSE
    -- export and sez are zero-rated under LUT: no components at all.
    IF comp_total <> 0 OR EXISTS (
         SELECT 1 FROM platform.invoice_tax_component WHERE invoice_id = inv.id) THEN
      RAISE EXCEPTION 'invoice % is % and zero-rated under LUT: it may carry no tax component',
        inv.number, inv.tax_treatment;
    END IF;
  END IF;

  -- A round-off that is not doing its job is a round-off nobody can explain.
  IF (inv.subtotal_minor + inv.tax_minor + inv.round_off_minor) % 100 <> 0 THEN
    RAISE EXCEPTION 'invoice % does not round to a whole currency unit', inv.number;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER invoice_line_consistent
  AFTER INSERT OR UPDATE OR DELETE ON platform.invoice_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_invoice_consistent();

CREATE CONSTRAINT TRIGGER invoice_tax_component_consistent
  AFTER INSERT OR UPDATE OR DELETE ON platform.invoice_tax_component
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_invoice_consistent();


-- Immutable once issued. A reissued PDF six months later must match the original
-- byte for byte in every figure; the only permitted transition is the payment
-- stamp and the void pointer.
CREATE FUNCTION platform.deny_issued_invoice_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.number, NEW.sequence_no, NEW.financial_year, NEW.subtotal_minor, NEW.tax_minor,
      NEW.round_off_minor, NEW.total_minor, NEW.tax_treatment, NEW.supplier_gstin,
      NEW.recipient_gstin, NEW.place_of_supply_state_code, NEW.period_start, NEW.period_end,
      NEW.issue_date)
     IS DISTINCT FROM
     (OLD.number, OLD.sequence_no, OLD.financial_year, OLD.subtotal_minor, OLD.tax_minor,
      OLD.round_off_minor, OLD.total_minor, OLD.tax_treatment, OLD.supplier_gstin,
      OLD.recipient_gstin, OLD.place_of_supply_state_code, OLD.period_start, OLD.period_end,
      OLD.issue_date) THEN
    RAISE EXCEPTION
      'invoice % is issued and immutable; correct it with a credit note, not an UPDATE',
      OLD.number USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_is_immutable
  BEFORE UPDATE ON platform.invoice
  FOR EACH ROW EXECUTE FUNCTION platform.deny_issued_invoice_rewrite();

CREATE FUNCTION platform.deny_invoice_line_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  issued boolean;
BEGIN
  SELECT true INTO issued FROM platform.invoice
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id)
     AND issued_at < now() - interval '1 second';
  IF issued THEN
    RAISE EXCEPTION 'invoice lines are immutable once the invoice is issued'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER invoice_line_is_immutable
  BEFORE UPDATE OR DELETE ON platform.invoice_line
  FOR EACH ROW EXECUTE FUNCTION platform.deny_invoice_line_rewrite();


-- Its own gapless series, deliberately separate.
CREATE TABLE platform.credit_note (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  invoice_id      uuid        NOT NULL REFERENCES platform.invoice (id) ON DELETE RESTRICT,

  financial_year  text        NOT NULL,
  sequence_no     bigint      NOT NULL CHECK (sequence_no > 0),
  number          text        NOT NULL,

  issue_date      date        NOT NULL,
  reason          text        NOT NULL,
  -- Section 34 records a reduction in the taxable value of a supply already made.
  -- If this is ever used for routine proration, the segment model has been
  -- abandoned and this comment is the thing to read first.
  subtotal_minor  bigint      NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor       bigint      NOT NULL CHECK (tax_minor >= 0),
  round_off_minor bigint      NOT NULL DEFAULT 0,
  total_minor     bigint      NOT NULL CHECK (total_minor >= 0),

  issued_at       timestamptz NOT NULL DEFAULT now(),
  issued_by_platform_user_id uuid REFERENCES platform.platform_user (id) ON DELETE RESTRICT,

  CONSTRAINT credit_note_number_unique UNIQUE (tenant_id, financial_year, sequence_no),
  CONSTRAINT credit_note_number_text_unique UNIQUE (number),
  CONSTRAINT credit_note_total_balances
  CHECK (total_minor = subtotal_minor + tax_minor + round_off_minor)
);

ALTER TABLE platform.invoice
  ADD CONSTRAINT invoice_void_credit_note_fk
  FOREIGN KEY (void_credit_note_id) REFERENCES platform.credit_note (id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_void_consistent
  CHECK ((status = 'void') = (void_credit_note_id IS NOT NULL));
