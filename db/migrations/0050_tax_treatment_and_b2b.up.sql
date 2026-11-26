-- The tax HEAD -- CGST+SGST or IGST -- becomes a derived, stamped, guarded
-- property of the bill, and stops being a string a tenant typed.
--
-- ###########################################################################
-- WHAT WAS ACTUALLY WRONG.
--
-- `app.tax_component.name` was free text. No CHECK, no vocabulary, no route
-- that wrote it -- only `seed-demo.mts` inserting 'CGST' and 'SGST' with an
-- owner connection. `src/reporting/gstReturn.ts` buckets a return by matching
-- that text exactly:
--
--     FILTER (WHERE c.value ->> 'name' = 'CGST')
--
-- So a restaurant whose tax class carried one component named 'GST 5%' got a
-- correct bill, a correct total, correct money in the drawer -- and a return
-- reporting ZERO under every head while the bills it was built from carried
-- tax. `reconcileReturnToBills` would have caught it, which is the only reason
-- this is a landmine rather than a filed misstatement, and it is a check
-- somebody has to remember to run.
--
-- Worse, the head could not follow the supply. The components were fixed on the
-- tax class, so a bill whose place of supply was another state still printed
-- CGST+SGST. Migration 0037 states the consequence for the platform plane in
-- capitals: the amount is right and the document is worthless, because credit
-- claimed under the wrong head is disallowed. The tenant plane had no
-- equivalent guard at all.
--
-- THE FIX IS TO STOP STORING THE HEAD AS A CONFIGURATION.
--
-- The tenant states a RATE (`tax_class.rate_bps`, already there, already
-- snapshotted onto the order line). The head is derived at bill time from the
-- supplier's state and the place of supply by exactly one function, stamped on
-- the document, and asserted by the database. A tenant cannot misname it
-- because a tenant no longer names it.
-- ###########################################################################

-- ###########################################################################
-- THE SUPPLIER'S STATE, ON THE DOCUMENT.
--
-- 0039 stamped `supplier_gstin` and `place_of_supply_state_code` but not the
-- supplier's own state code as a fact in its own right. Reading it out of the
-- GSTIN works only while there IS a GSTIN, and an `unstated` branch charges tax
-- with no GSTIN at all -- which is precisely the case where a head has to be
-- decided.
-- ###########################################################################
-- ###########################################################################
-- WHY THE BACKFILL RUNS WITH `bill_invariants` DISABLED.
--
-- `bill_invariants` is a per-row DEFERRABLE INITIALLY DEFERRED constraint
-- trigger, so an UPDATE that touches every bill queues one pending event per
-- row -- and Postgres refuses `ALTER TABLE` on a table with pending trigger
-- events, which is what `SET NOT NULL` and the CHECKs below are.
--
-- Firing them instead (`SET CONSTRAINTS ALL IMMEDIATE`) would make this
-- migration re-assert every bill's line-sum and tender balance across the whole
-- install, and FAIL on any pre-existing inconsistency that has nothing to do
-- with this change. A migration that adds three columns must not be the thing
-- that discovers a bad bill from 2025 -- and it must not silently repair one
-- either.
--
-- Disabled, not dropped, and only for the span of the backfill: the columns
-- being written here cannot affect what that trigger asserts. It is a
-- statement about lines summing to figures, and no figure moves below.
-- ###########################################################################
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;

ALTER TABLE app.bill
  ADD COLUMN supplier_state_code text
  CONSTRAINT bill_supplier_state_code_format
  CHECK (supplier_state_code IS NULL OR supplier_state_code ~ '^[0-9]{2}$'),

  -- The recipient's state. Snapshotted for the same reason its GSTIN is: a
  -- company that relocates must not retitle last year's invoices.
  ADD COLUMN recipient_state_code text
  CONSTRAINT bill_recipient_state_code_format
  CHECK (recipient_state_code IS NULL OR recipient_state_code ~ '^[0-9]{2}$'),

  ADD COLUMN tax_treatment text;

-- The GSTIN carries the state in characters 1-2, so where one was stamped it is
-- the authority. Where none was, the branch's own state code is the best
-- available answer -- and where that is null too the bill genuinely cannot say,
-- which the `unstated` treatment below records rather than guesses.
UPDATE app.bill b
   SET supplier_state_code = COALESCE(substring(b.supplier_gstin, 1, 2), br.state_code)
  FROM app.branch br
 WHERE br.tenant_id = b.tenant_id AND br.id = b.branch_id;

-- A recipient GSTIN carries its own state in characters 1-2, so where one was
-- stamped the state code is not a new fact -- it is the same fact, read out of
-- the identifier that already holds it.
UPDATE app.bill
   SET recipient_state_code = substring(recipient_gstin, 1, 2)
 WHERE recipient_gstin IS NOT NULL AND recipient_state_code IS NULL;

-- ###########################################################################
-- FOUR VALUES, AND THE FOURTH IS WHY THIS MIGRATION RESTATES NOTHING.
--
-- `none`     -- no tax was charged. Every zero-tax bill, whatever the branch's
--               position: an unregistered branch, an all-exempt bill, a bill
--               raised before any of this existed.
-- `intra_state` -- place of supply equals the supplier's state. CGST + SGST.
-- `inter_state` -- it does not. IGST.
-- `unstated` -- TAX WAS CHARGED AND THE HEAD CANNOT BE RECONSTRUCTED, because
--               nobody ever recorded which state this branch trades in. That is
--               the true state of every taxed bill raised before this migration
--               at a branch with no GSTIN and no state code, and asserting a
--               head for them would be inventing the one fact a return turns
--               on.
--
-- `unstated` is not a position anyone can choose: the CHECK below permits it
-- only when the supplier state is genuinely absent. It drains as owners state
-- their branches' state codes, and `outwardSupplyReturn` refuses any period
-- containing one rather than filing a head it does not know.
-- ###########################################################################
UPDATE app.bill
   SET tax_treatment =
       CASE
         WHEN tax_minor = 0                    THEN 'none'
         WHEN supplier_state_code IS NULL      THEN 'unstated'
         WHEN place_of_supply_state_code IS NULL
           OR place_of_supply_state_code = supplier_state_code
                                               THEN 'intra_state'
         ELSE 'inter_state'
       END;

-- A pre-0039 bill has no place of supply stamped. Where the treatment above
-- landed on `intra_state` for that reason, the place of supply IS the supplier's
-- state -- restaurant service is performed at the restaurant -- so writing it is
-- recording the fact rather than assuming one.
UPDATE app.bill
   SET place_of_supply_state_code = supplier_state_code
 WHERE tax_treatment = 'intra_state' AND place_of_supply_state_code IS NULL;

ALTER TABLE app.bill
  ALTER COLUMN tax_treatment SET NOT NULL,

  ADD CONSTRAINT bill_tax_treatment_known
  CHECK (tax_treatment IN ('intra_state', 'inter_state', 'none', 'unstated')),

  -- ONE CHECK, FOUR ARMS, NO DEFAULT ARM. `ELSE false` means a value added to
  -- the vocabulary above without a rule here is refused rather than admitted
  -- unvalidated.
  ADD CONSTRAINT bill_tax_treatment_consistent
  CHECK (
    CASE tax_treatment
      WHEN 'intra_state' THEN supplier_state_code IS NOT NULL
                          AND place_of_supply_state_code IS NOT NULL
                          AND place_of_supply_state_code = supplier_state_code
      WHEN 'inter_state' THEN supplier_state_code IS NOT NULL
                          AND place_of_supply_state_code IS NOT NULL
                          AND place_of_supply_state_code <> supplier_state_code
      -- Not "no tax was due" -- no tax was CHARGED. The document is the subject.
      WHEN 'none'        THEN tax_minor = 0
      WHEN 'unstated'    THEN supplier_state_code IS NULL AND tax_minor > 0
      ELSE false
    END
  ),

  -- A B2B supply names its recipient, and the recipient's state agrees with the
  -- state inside their own GSTIN. Two chances to disagree is one too many.
  ADD CONSTRAINT bill_recipient_state_matches_gstin
  CHECK (recipient_gstin IS NULL
      OR (recipient_state_code IS NOT NULL
          AND substring(recipient_gstin, 1, 2) = recipient_state_code));

ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;

COMMENT ON COLUMN app.bill.tax_treatment IS
  'Derived at bill time by src/ops/taxHeads.ts and stamped, never joined. '
  'intra_state: CGST+SGST at half the line rate each. inter_state: IGST at the '
  'full rate. none: no tax charged. unstated: tax charged before the branch had '
  'a state code, head unreconstructable, refused by the outward-supply return.';


-- ###########################################################################
-- THE TAX IDENTITY FREEZES WITH THE FIGURES.
--
-- `deny_tendered_bill_mutation` froze subtotal, tax, total, split kind and bill
-- number on first tender, with the reason stated: a reprint six months later
-- must match the paper. It did not freeze WHO SUPPLIED WHAT TO WHOM UNDER WHICH
-- HEAD -- which is the half of a tax invoice a dispute is actually about. The
-- amounts were immutable while the treatment, the supplier's GSTIN and the
-- recipient's identity could all be rewritten after the customer had paid and
-- walked out.
--
-- Extended rather than duplicated: one trigger, one tuple, one place to read to
-- find out what a tendered bill may still change.
--
-- FIRST TENDER, not settlement, is the right boundary for the B2B fields too. A
-- company GSTIN is handed over BEFORE paying, so the field stays writable
-- exactly as long as it needs to be and no longer.
-- ###########################################################################
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.supplier_state_code, OLD.supplier_gstin,
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
-- THE COMPONENT SET MUST MATCH THE DECLARED TREATMENT. ASSERTED, NOT INTENDED.
--
-- 0037 does exactly this for `platform.invoice` and states why: an invoice whose
-- components contradict its own treatment must be UNISSUABLE, because the total
-- is right and the document is worthless. The tenant plane -- the one that
-- prints a bill for every diner in the country -- had no equivalent.
--
-- Deferred to COMMIT because the bill and its lines are written in one
-- transaction, and a nightly check would find the defect after the paper was
-- handed over and the figure was in a return.
--
-- `unstated` is skipped: those are pre-0050 documents whose head nobody
-- recorded, and inventing an assertion about them would be inventing the fact.
-- ###########################################################################
CREATE FUNCTION app.assert_bill_line_heads_match_treatment() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  treatment  text;
  bill_no_   integer;
  comps      jsonb;
  head_total bigint;
  names      text[];
  rates      integer[];
BEGIN
  SELECT b.tax_treatment, b.bill_no INTO treatment, bill_no_
    FROM app.bill b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.bill_id;

  -- The bill was deleted inside the same transaction. Nothing to assert.
  IF treatment IS NULL THEN RETURN NULL; END IF;
  IF treatment = 'unstated' THEN RETURN NULL; END IF;

  -- A jsonb `null` SCALAR is not an empty array, and COALESCE does not convert
  -- one into the other -- which is how 975 live rows came to make the outward
  -- supply return raise "cannot extract elements from a scalar" instead of
  -- producing a return. Normalised here so the assertion cannot be defeated by
  -- the same shape.
  comps := CASE WHEN jsonb_typeof(NEW.tax_components) = 'array'
                THEN NEW.tax_components ELSE '[]'::jsonb END;

  SELECT COALESCE(sum((c.value ->> 'amount_minor')::bigint), 0),
         array_agg(c.value ->> 'name' ORDER BY c.value ->> 'name'),
         array_agg((c.value ->> 'rate_bps')::integer ORDER BY c.value ->> 'name')
    INTO head_total, names, rates
    FROM jsonb_array_elements(comps) c;

  IF treatment = 'none' THEN
    IF NEW.tax_minor <> 0 OR jsonb_array_length(comps) <> 0 THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % carries no tax but line % has % in tax and % component(s)',
        bill_no_, NEW.id, NEW.tax_minor, jsonb_array_length(comps)
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
    RETURN NULL;
  END IF;

  -- A zero-rated line on an otherwise taxable bill: an exempt dish beside a
  -- taxable one. Legitimate, and it carries no component.
  IF NEW.tax_minor = 0 AND jsonb_array_length(comps) = 0 THEN RETURN NULL; END IF;

  IF head_total <> NEW.tax_minor THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % line % says % in tax but its heads sum to %',
      bill_no_, NEW.id, NEW.tax_minor, head_total
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  IF treatment = 'intra_state' THEN
    -- Two heads, equal rates. Not "contains CGST": a line carrying CGST and
    -- IGST together would satisfy that and is exactly the document 0037
    -- describes as worthless.
    IF names IS DISTINCT FROM ARRAY['CGST', 'SGST']
       OR rates[1] IS DISTINCT FROM rates[2] THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % is intra-state, so line % needs CGST and SGST at equal rates, not %',
        bill_no_, NEW.id, names
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
  ELSE
    IF names IS DISTINCT FROM ARRAY['IGST'] THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % is inter-state, so line % needs exactly IGST, not %',
        bill_no_, NEW.id, names
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER bill_line_heads_match_treatment
  AFTER INSERT OR UPDATE ON app.bill_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_bill_line_heads_match_treatment();


-- ###########################################################################
-- app.tax_component AND app.order_line.tax_components GO.
--
-- Not tidying. Both are the defect.
--
-- `tax_component.name` was free text with no CHECK and no write path in the
-- product -- only the demo seed. The outward-supply return matched that text
-- exactly to bucket a statutory figure, so a tenant naming a component
-- 'GST 5%' would have filed zeroes.
--
-- `order_line.tax_components` was WRITTEN AND NEVER READ except to be copied
-- verbatim onto the bill line. It carried `{name, rate_bps}` and no amount, so
-- the amount the return looked for was never there for any row the product
-- wrote; the 657 rows that HAD it were written directly by test fixtures, which
-- is why every GST assertion in the suite passed against a shape production
-- never produced.
--
-- The rate stays where it belongs -- `order_line.tax_rate_bps`, snapshotted at
-- order time, which is the figure the priced-document rule is about. The SPLIT
-- of that rate is a property of the SUPPLY, decided at bill time when the place
-- of supply is known, and it cannot be pre-computed onto an order line that has
-- no place of supply yet.
--
-- The down migration recreates both. It cannot recreate the component ROWS, and
-- says so rather than pretending: they were configuration nothing read.
-- ###########################################################################
-- ###########################################################################
-- A CREDIT NOTE MAY STATE ITS HEADS INSTEAD OF A SINGLE RATE.
--
-- `refund_tax_snapshot_complete` required `tax_rate_bps` whenever the snapshot
-- was present. A full refund of a bill carrying 5% food and 12% something else
-- reverses a real, known tax under two heads and HAS NO SINGLE RATE, so the
-- constraint made the only unambiguous case unrepresentable -- which is part of
-- why nothing ever wrote the snapshot at all.
--
-- The completeness rule is now: state a rate, or state the heads. Both remain
-- bound by taxable + tax = amount, because a refund is money handed back and
-- the figure is the figure.
-- ###########################################################################
ALTER TABLE app.refund
  DROP CONSTRAINT refund_tax_snapshot_complete,
  ADD CONSTRAINT refund_tax_snapshot_complete
  CHECK (
    (taxable_minor IS NULL AND tax_minor IS NULL AND tax_rate_bps IS NULL)
    OR (taxable_minor IS NOT NULL AND tax_minor IS NOT NULL
        AND taxable_minor + tax_minor = amount_minor
        AND (tax_rate_bps IS NOT NULL OR jsonb_typeof(tax_components) = 'array'))
  );


-- ###########################################################################
-- THE RATE MUST HALVE. REFUSED AT CONFIGURATION, NOT AT THE TILL.
--
-- An intra-state supply is CGST and SGST at HALF the headline rate each, and
-- the two must sum back to it exactly -- `platform.assert_invoice_consistent`
-- already requires equal rates on the control plane. An odd rate in basis
-- points cannot do that.
--
-- The alternative to this CHECK is `componentsForLine` throwing while a cashier
-- is standing in front of a customer, for a rate somebody typed weeks earlier.
-- So it is refused where it is entered. Every Indian GST rate is even in basis
-- points (500, 1200, 1800, 2800), and all 472 rows in the dev install already
-- satisfy this.
--
-- IT IS A STATED EXCLUSION: this narrows the product to jurisdictions whose
-- rates halve. 0023 said the split varies by jurisdiction, and it does -- but a
-- jurisdiction with an odd rate needs a different HEAD VOCABULARY as well as a
-- different arithmetic, so it is a larger change than relaxing one CHECK, and
-- this comment is the thing to read first when it comes.
-- ###########################################################################
ALTER TABLE app.tax_class
  ADD CONSTRAINT tax_class_rate_halves CHECK (rate_bps % 2 = 0);


DROP TABLE app.tax_component;

ALTER TABLE app.order_line DROP COLUMN tax_components;


-- ###########################################################################
-- WHETHER THE TILL ASKS A DINER FOR A COMPANY GSTIN.
--
-- `bill.recipient_gstin`, `recipient_legal_name`, `bill_b2b_named` and
-- `bill_b2b_idx` have existed since 0039 and NOTHING has ever written them, so
-- the entire B2B half of `outwardSupplyReturn` has been dead code returning an
-- empty list -- which reads as "this branch had no registered customers" rather
-- than "this product cannot record one".
--
-- DEFAULT FALSE, DELIBERATELY. Most restaurants never issue a B2B bill and the
-- field would be one more thing between a cashier and a queue. A shop that does
-- not turn this on behaves exactly as it does today and sees nothing new.
-- ###########################################################################
CREATE TABLE app.tenant_tax_setting (
  tenant_id           uuid        PRIMARY KEY REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  b2b_capture_enabled boolean     NOT NULL DEFAULT false,

  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid,

  CONSTRAINT tenant_tax_setting_actor_fk
  FOREIGN KEY (tenant_id, updated_by_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER tenant_tax_setting_set_updated_at
  BEFORE UPDATE ON app.tenant_tax_setting
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.tenant_tax_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_tax_setting
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
