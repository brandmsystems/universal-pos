-- Specified premises: a per-premises, per-financial-year classification that
-- overrides the rate on every line sold there.
--
-- ###########################################################################
-- THE DEFECT THIS CLOSES, AND WHY NOTHING WENT RED.
--
-- A premises whose declared tariff exceeds Rs 7,500 per unit per day is a
-- SPECIFIED PREMISES, and every restaurant supply made there is taxed at 18%
-- WITH input credit -- not the 5% without credit that an ordinary restaurant
-- charges. It is automatic above the threshold, and may also be opted into via
-- Annexure VII in the January-March window or opted out of via Annexure IX.
--
-- This product resolves the rate PER DISH, from the tax class on the menu item.
-- Migration 0048 gave the branch one override and it only goes DOWN: an
-- unregistered or composition branch resolves every line to 0. There is no
-- upward override. So a hotel restaurant with a dish sitting on the seeded
-- `gst_5` class under-collects on every bill it ever issues, and nothing
-- notices -- the bill adds up, the heads sum, the return reconciles to the
-- bills, and the shortfall is found by an assessment.
--
-- Same family as every serious defect this project has had: the guard exists,
-- it is correct, and the case it does not cover is silent.
-- ###########################################################################


-- ###########################################################################
-- THE RATE IS A JURISDICTION FACT, AND A TENANT MAY NOT SET IT.
--
-- 18% is India's number for this position. It is not a tenant preference: a
-- tenant who could choose it could choose 5%, which is precisely the
-- under-collection this migration exists to prevent. So it goes where the head
-- catalogue went in 0052 -- control-plane reference data, read-only to the
-- application role.
--
-- NAMED GENERICALLY, and that is deliberate. `specified_premises` is one entry
-- keyed by jurisdiction; the table itself knows nothing about India, hotels or
-- tariffs. Putting `specified_premises_rate_bps` as a COLUMN on
-- `platform.tax_jurisdiction` was the alternative and was rejected: it would
-- put an India-shaped concept back into the global catalogue that 0052 had just
-- finished taking India out of.
-- ###########################################################################
CREATE TABLE platform.tax_rate_override (
  jurisdiction_code text     NOT NULL
                    REFERENCES platform.tax_jurisdiction (code) ON DELETE RESTRICT,

  -- The position that triggers the override, in the jurisdiction's own terms.
  position          text     NOT NULL
                    CONSTRAINT tax_rate_override_position_format
                    CHECK (position ~ '^[a-z][a-z0-9_]*$'),

  name              text     NOT NULL,

  -- The rate every line takes at a premises holding this position, replacing
  -- whatever the dish's own tax class says.
  rate_bps          integer  NOT NULL
                    CONSTRAINT tax_rate_override_rate_range
                    CHECK (rate_bps >= 0 AND rate_bps <= 10000),

  PRIMARY KEY (jurisdiction_code, position)
);

COMMENT ON TABLE platform.tax_rate_override IS
  'Immutable global reference data: a rate that a stated PREMISES position '
  'imposes on every line, overriding the dish tax class. Read-only to '
  'katkitchen_app -- a tenant that could write here could lower its own rate.';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON platform.tax_rate_override FROM katkitchen_app;

INSERT INTO platform.tax_rate_override (jurisdiction_code, position, name, rate_bps)
VALUES ('IN', 'specified_premises', 'Specified premises (18% with ITC)', 1800);


-- ###########################################################################
-- THE FINANCIAL YEAR AS A NUMBER, NOT A LABEL.
--
-- `platform.financial_year_label` (0037) answers '2026-27' for a document
-- series. This answers 2026 -- the START year -- because it is a KEY, and a key
-- has to be comparable and joinable rather than pretty.
--
-- Takes the start month like its sibling does, so it carries no assumption
-- about India. The CALLER supplies 4, and says why at the call site: India's
-- GST year is April-March by statute, which is not the same thing as
-- `platform.tenant_tax_profile.financial_year_starts_month` -- that column is
-- the year WE invoice the tenant on, and reusing it here would let a tenant
-- shift the boundary of a statutory classification by changing their own
-- billing preferences.
-- ###########################################################################
CREATE FUNCTION platform.fy_start_year(d date, start_month smallint)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (extract(year FROM d)
          - CASE WHEN extract(month FROM d) < start_month THEN 1 ELSE 0 END)::smallint
$fn$;


-- ###########################################################################
-- THE POSITION, DECLARED FOR A YEAR.
--
-- `app.branch.gst_registration` is the proven shape for a stated branch
-- position, and this one deliberately does NOT copy it. That column moves on a
-- BUSINESS DATE and needed `branch_gst_registration_change` beside it so the
-- outward-supply return could refuse a period that spans a move.
--
-- This classification does not work that way. It is declared FOR A FINANCIAL
-- YEAR and does not move inside one. So the year is part of the key, the table
-- IS the history, and there is no change log to keep in step -- a second table
-- recording movements between rows that are already dated would be two
-- spellings of one fact. A GST return period is a month and never spans an
-- April boundary, so the refusal 0048 needed has no counterpart here.
--
-- ABSENCE IS `unstated`, NOT `standard`. A branch with no row for a year has
-- not answered the question, which is a different thing from having answered
-- `standard` -- exactly the distinction 0048 drew for the GST position, and for
-- the same reason: the screen can count the unanswered ones and nag, and a bill
-- can record that nobody had decided.
-- ###########################################################################
CREATE TABLE app.branch_premises_class (
  tenant_id            uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id            uuid        NOT NULL,

  -- The START year of the financial year this declaration covers: 2026 means
  -- 2026-27. Derived from a business date by platform.fy_start_year(d, 4).
  fy_start_year        smallint    NOT NULL
                       CONSTRAINT branch_premises_fy_sane
                       CHECK (fy_start_year BETWEEN 2000 AND 2200),

  class                text        NOT NULL
                       CONSTRAINT branch_premises_class_known
                       CHECK (class IN ('standard', 'specified')),

  -- What the declaration rests on. Above the threshold the classification is
  -- automatic; below it, it is an Annexure VII election. Recorded because the
  -- two are audited differently and a year later nobody remembers which it was.
  declared_tariff_minor bigint
                       CONSTRAINT branch_premises_tariff_positive
                       CHECK (declared_tariff_minor IS NULL OR declared_tariff_minor > 0),

  declared_at          timestamptz NOT NULL DEFAULT now(),
  declared_by_user_id  uuid        NOT NULL,

  PRIMARY KEY (tenant_id, branch_id, fy_start_year),

  CONSTRAINT branch_premises_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_premises_actor_fk
  FOREIGN KEY (tenant_id, declared_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.branch_premises_class ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_premises_class
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

COMMENT ON TABLE app.branch_premises_class IS
  'Per-branch, per-financial-year premises classification. A specified '
  'premises taxes every line at platform.tax_rate_override, whatever the dish '
  'tax class says. No row for a year means the question is unanswered.';


-- ###########################################################################
-- AND IT TRAVELS ON THE DOCUMENT.
--
-- Stamped for the same reason `supplier_gst_registration` is: a bill reprinted
-- after the branch is reclassified must show the position it was ISSUED under,
-- and the return must bucket by the paper rather than by what the branch is
-- today.
--
-- `unstated` for the backfill, and for every bill raised at a branch that has
-- not answered. Not `standard` -- see the table comment above.
--
-- WHAT IS DELIBERATELY NOT ASSERTED: that the LINE rates agree with this stamp.
-- An order taken on 31 March and billed on 1 April crosses the year boundary
-- legitimately, and its lines were priced correctly under the OLD year's
-- classification. A trigger comparing them would refuse a lawful bill. The
-- control that prevents under-collection is at order time, where the rate is
-- resolved; this column is for the document and the return.
--
-- `bill_invariants` is disabled across the backfill for the reason 0050 and
-- 0052 both record: it is a per-row DEFERRABLE constraint trigger, so an UPDATE
-- touching every bill queues one pending event per row, and Postgres refuses
-- ALTER TABLE on a table with pending events.
-- ###########################################################################
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;

ALTER TABLE app.bill ADD COLUMN premises_class text;

UPDATE app.bill SET premises_class = 'unstated';

ALTER TABLE app.bill
  ALTER COLUMN premises_class SET NOT NULL,
  ADD CONSTRAINT bill_premises_class_known
  CHECK (premises_class IN ('standard', 'specified', 'unstated'));

ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;


-- The tax identity freezes at the first tender, and the premises class is part
-- of it -- 0052's tuple with one more member. Which rate regime a document was
-- raised under is not a thing that may change after the customer has paid.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.tax_jurisdiction, NEW.premises_class,
      NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.premises_class,
      OLD.supplier_state_code, OLD.supplier_gstin,
      OLD.supplier_gst_registration, OLD.place_of_supply_state_code,
      OLD.recipient_gstin, OLD.recipient_legal_name, OLD.recipient_state_code) THEN
    RAISE EXCEPTION
      'bill % has been tendered against: its figures and its tax identity are immutable',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;


-- ###########################################################################
-- THE ORDER-LINE GUARD, WIDENED TO REFUSE AN UNDER-CHARGE.
--
-- 0048 and 0051 added the downward half: a branch that may not collect tax
-- cannot carry a rate. This is the upward half, and it is the one the whole
-- migration is for -- a specified premises whose line carries the dish's 5%
-- instead of the position's 18%.
--
-- Written as a trigger rather than a CHECK because it has to read
-- `app.branch_premises_class` for the line's own financial year and
-- `platform.tax_rate_override` for the rate, and a CHECK sees one row.
--
-- It fires only where the premises has ANSWERED and answered `specified`. An
-- unanswered branch is left exactly as it trades today: this migration does not
-- retroactively decide a question nobody has been asked.
-- ###########################################################################
CREATE FUNCTION app.assert_order_line_premises_rate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  juris     text;
  class_    text;
  required_ integer;
  bdate     date;
  position_ text;
BEGIN
  IF NEW.tax_rate_bps IS NULL THEN RETURN NULL; END IF;

  -- A branch that collects no output tax collects none here either. The
  -- specified-premises classification raises the RATE on a branch that charges;
  -- it does not turn an unregistered or composition branch into one that
  -- charges. 0051 owns those two positions and already forces their lines to 0,
  -- so this guard has no requirement to impose and must not contradict it.
  SELECT b.gst_registration INTO position_
    FROM app.branch b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.branch_id;
  IF position_ IN ('unregistered', 'composition') THEN RETURN NULL; END IF;

  SELECT o.business_date INTO bdate
    FROM app.sales_order o
   WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
  IF bdate IS NULL THEN RETURN NULL; END IF;

  SELECT t.tax_jurisdiction INTO juris
    FROM platform.tenant t WHERE t.id = NEW.tenant_id;
  IF juris IS NULL THEN RETURN NULL; END IF;

  SELECT p.class INTO class_
    FROM app.branch_premises_class p
   WHERE p.tenant_id = NEW.tenant_id
     AND p.branch_id = NEW.branch_id
     AND p.fy_start_year = platform.fy_start_year(bdate, 4::smallint);

  -- Unanswered, or answered `standard`: the dish's own class stands.
  IF class_ IS DISTINCT FROM 'specified' THEN RETURN NULL; END IF;

  SELECT o2.rate_bps INTO required_
    FROM platform.tax_rate_override o2
   WHERE o2.jurisdiction_code = juris AND o2.position = 'specified_premises';

  -- The jurisdiction defines no override for this position, so there is nothing
  -- to impose. Refused rather than passed: a branch declared specified under
  -- rules that do not define the position is a setup somebody has to fix, and
  -- silently charging the dish rate is the under-collection this guard exists
  -- to stop.
  IF required_ IS NULL THEN
    RAISE EXCEPTION
      'order_line_premises_rate: branch % is a specified premises and % defines no specified_premises rate, so no line can be priced',
      NEW.branch_id, juris
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_line_premises_rate';
  END IF;

  IF NEW.tax_rate_bps <> required_ THEN
    RAISE EXCEPTION
      'order_line_premises_rate: branch % is a specified premises for FY %, where every line is taxed at %bps, but line % carries %bps',
      NEW.branch_id, platform.fy_start_year(bdate, 4::smallint), required_,
      NEW.id, NEW.tax_rate_bps
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_line_premises_rate';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER order_line_premises_rate
  AFTER INSERT OR UPDATE ON app.order_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_order_line_premises_rate();
