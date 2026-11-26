-- The tax jurisdiction becomes a stated fact, and the head vocabulary becomes
-- reference data instead of literals in a trigger.
--
-- ###########################################################################
-- WHY, AND WHAT THIS IS NOT.
--
-- DECIDED, by the owner: one product for the whole world, India first. That is
-- not the same as "make the tax engine international", and this migration does
-- not do that. It does the thing that has to happen FIRST, which is to make the
-- India-shaped parts SAY that they are India-shaped, so that a tenant sold to
-- somebody else is refused loudly instead of quietly billed under Indian rules.
--
-- Before this, `app.assert_bill_line_heads_match_treatment` named CGST, SGST
-- and IGST as string literals and required the intra-state pair to sit at equal
-- rates. `tax_class_rate_halves` required an even number of basis points for
-- the same reason. Both are correct for India and wrong everywhere else -- and
-- the even-rate CHECK in particular REFUSED an ordinary US combined rate
-- (California's 7.25% is 725bps, odd), so a restaurant there could not have
-- entered its own rate at all. Migration 0050 introduced that CHECK with a
-- comment calling it a stated exclusion. This is the migration that pays for it.
--
-- WHAT REPLACES THE LITERALS: a head is a NAMED SHARE OF THE HEADLINE RATE.
-- India intra-state is CGST 5000bps + SGST 5000bps of the rate; inter-state is
-- IGST 10000. A US combined rate splits into state/county/city at uneven
-- shares. Both are the same shape, and neither needs the rate to be even --
-- `splitHeads` allocates the line's tax across the shares with the
-- largest-remainder allocator the combo pricing already uses, so the heads sum
-- to the line's tax EXACTLY whatever the shares are.
--
-- THE RISK, NAMED: this moves a guard from code into data, and a wrong data row
-- silently loosens it. Three things hold it down.
--   1. `katkitchen_app` gets SELECT and nothing else on all three tables below.
--      Only the owner-role seed writes them.
--   2. A deferred constraint trigger refuses a taxable treatment whose shares
--      do not sum to 10000, in either direction of the write.
--   3. `tests/tax/jurisdiction.test.ts` asserts the seeded IN rows against the
--      constant in `src/tax/in/heads.ts` in BOTH directions, so a hand-edited
--      row fails a test rather than filing a wrong return.
-- And the app-side trigger REFUSES a taxable treatment with no head rows at
-- all, rather than passing it: absence is not permission.
--
-- ON THE CROSS-SCHEMA READ: the app trigger below reads `platform.tax_head`.
-- Migration 0001 says `app` must stay relocatable to its own database, and that
-- warning is about a shared FUNCTION -- `app.set_updated_at` and
-- `platform.set_updated_at` are two copies for exactly that reason. A READ of
-- immutable global reference data is the dependency `app.branch.tenant_id`
-- already has on `platform.tenant`, which the schema invariants call the
-- permitted direction. `platform` is defined by 0001 as "control plane +
-- immutable global reference data", and this is the second thing.
-- ###########################################################################

CREATE TABLE platform.tax_jurisdiction (
  code              text        PRIMARY KEY
                    CONSTRAINT tax_jurisdiction_code_format CHECK (code ~ '^[A-Z]{2}$'),
  name              text        NOT NULL,

  -- ###########################################################################
  -- `declared` IS THE POINT OF THIS COLUMN.
  --
  -- A jurisdiction may be listed here -- so a tenant can be provisioned against
  -- it, and so the refusal can NAME it -- long before anybody has written its
  -- rules. `src/tax/registry.ts` refuses a bill in a `declared` jurisdiction
  -- with a sentence saying which country and that its rules are not built.
  --
  -- The alternative is a jurisdiction nobody can select, which means a US
  -- customer is either turned away at the door or quietly given India's rules.
  -- The first is a business decision and the second is a defect.
  -- ###########################################################################
  status            text        NOT NULL
                    CONSTRAINT tax_jurisdiction_status_known
                    CHECK (status IN ('implemented', 'declared')),

  -- The country calling code, WITHOUT a plus. `src/crm/phone.ts` had 91
  -- hardcoded as a default parameter, so a bare ten-digit US number became an
  -- Indian one with no error and no way to find the customer again. The default
  -- WAS the bug; the parameter is required now and this is where it comes from.
  default_dial_code text        NOT NULL
                    CONSTRAINT tax_jurisdiction_dial_code_format
                    CHECK (default_dial_code ~ '^[0-9]{1,4}$'),

  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform.tax_jurisdiction IS
  'Immutable global reference data: the tax regimes this product knows about. '
  'status=implemented means src/tax/<code>/ exists and a bill can be raised; '
  'declared means a tenant may be provisioned against it and every bill is '
  'refused by name until the rules are written.';


-- The treatments a jurisdiction's supplies can be made under. India has the
-- four `app.bill.tax_treatment` already permits; another regime has its own
-- (domestic / intra-community / reverse charge; origin / destination sourcing),
-- and they are NOT renamings of India's.
CREATE TABLE platform.tax_treatment (
  jurisdiction_code text     NOT NULL
                    REFERENCES platform.tax_jurisdiction (code) ON DELETE RESTRICT,
  key               text     NOT NULL
                    CONSTRAINT tax_treatment_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name              text     NOT NULL,

  -- ###########################################################################
  -- WHAT THE HEADS ON A DOCUMENT UNDER THIS TREATMENT MUST LOOK LIKE.
  --
  -- THREE POSITIONS, NOT TWO, AND THE THIRD ONE IS WHY THIS IS NOT A BOOLEAN.
  --
  -- The first draft of this migration had `carries_tax boolean` and mapped
  -- India's `unstated` to false. That is wrong, and the whole test suite said
  -- so: `unstated` does not mean "no tax was collected", it means "tax WAS
  -- collected and nobody recorded which head it belongs to". 0050 wrote it onto
  -- bills that charged tax at a branch with no state code, and 0050's own
  -- version of the line trigger SKIPPED it for exactly that reason. Calling it
  -- non-taxable made the trigger demand that those lines carry no tax, which
  -- refused documents that legitimately exist.
  --
  --   required   -- tax is collected and reported under this treatment's heads.
  --                 Shares must sum to 10000, and a line's head set must match.
  --   none       -- no tax is collected. A line must carry no tax and no head.
  --   unrecorded -- tax may have been collected and the head is not
  --                 reconstructable. NOTHING is asserted about the line; the
  --                 outward-supply return refuses the period instead
  --                 (gst_period_has_unstated_treatment), which is the only
  --                 honest answer: the amount is right, the head is unknown,
  --                 and inventing one is the failure 0037 sets out in capitals.
  --
  -- `unrecorded` carries no head rows either -- there is nothing to record --
  -- so it is not a hole in the shares guard below.
  -- ###########################################################################
  head_rule         text     NOT NULL
                    CONSTRAINT tax_treatment_head_rule_known
                    CHECK (head_rule IN ('required', 'none', 'unrecorded')),

  PRIMARY KEY (jurisdiction_code, key)
);


CREATE TABLE platform.tax_head (
  jurisdiction_code text     NOT NULL,
  treatment_key     text     NOT NULL,

  -- CGST, SGST, IGST, VAT, GST, PST, STATE, COUNTY. Printed on the document, so
  -- it is the statutory abbreviation and not a description.
  name              text     NOT NULL
                    CONSTRAINT tax_head_name_format CHECK (name ~ '^[A-Z][A-Z0-9 ]{0,15}$'),

  -- ###########################################################################
  -- A SHARE OF THE HEADLINE RATE, IN BASIS POINTS OF IT. NOT A RATE.
  --
  -- 5000 is half. India intra-state is two heads at 5000 each; inter-state is
  -- one at 10000. A US combined rate splits into three uneven shares. Storing a
  -- RATE here instead would make every tax class need its own head rows, and
  -- the shares are the part that is a property of the JURISDICTION rather than
  -- of the dish.
  -- ###########################################################################
  share_bps         integer  NOT NULL
                    CONSTRAINT tax_head_share_range
                    CHECK (share_bps > 0 AND share_bps <= 10000),

  -- Print order, and the order the allocator distributes the remainder in --
  -- so an odd paisa lands on the same head every time rather than wherever a
  -- sort happened to put it.
  ordinal           smallint NOT NULL CONSTRAINT tax_head_ordinal_positive CHECK (ordinal > 0),

  PRIMARY KEY (jurisdiction_code, treatment_key, name),
  CONSTRAINT tax_head_treatment_fk
  FOREIGN KEY (jurisdiction_code, treatment_key)
    REFERENCES platform.tax_treatment (jurisdiction_code, key) ON DELETE RESTRICT,
  CONSTRAINT tax_head_ordinal_unique UNIQUE (jurisdiction_code, treatment_key, ordinal)
);


-- ###########################################################################
-- THE SHARES MUST ACCOUNT FOR THE WHOLE RATE. ASSERTED AT COMMIT.
--
-- Shares summing to 9500 means every bill under that treatment collects 95% of
-- the tax it charged and the document still adds up -- the failure mode this
-- whole family of guards exists for. A CHECK cannot see across rows, so it is a
-- DEFERRABLE constraint trigger, and it fires from BOTH tables: adding a
-- taxable treatment with no heads is as wrong as adding a head that unbalances
-- one, and only one of those two writes touches `tax_head`.
-- ###########################################################################
CREATE FUNCTION platform.assert_tax_shares_whole() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  juris     text;
  treatment text;
  rule      text;
  total     integer;
  heads     integer;
BEGIN
  -- ########################################################################
  -- BRANCHED EXPLICITLY, AND THIS IS NOT STYLE.
  --
  -- plpgsql resolves record field access at RUNTIME, so a single expression
  -- naming both `NEW.key` and `NEW.treatment_key` raises on whichever table it
  -- was NOT fired from -- and `OLD` is unassigned on INSERT, `NEW` on DELETE.
  -- `app.assert_billing_invariants` carries the same comment for the same
  -- reason, and the first draft of this function ignored it and failed on the
  -- seed with "record new has no field treatment_key".
  -- ########################################################################
  IF TG_TABLE_NAME = 'tax_treatment' THEN
    IF TG_OP = 'DELETE' THEN
      juris := OLD.jurisdiction_code; treatment := OLD.key;
    ELSE
      juris := NEW.jurisdiction_code; treatment := NEW.key;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      juris := OLD.jurisdiction_code; treatment := OLD.treatment_key;
    ELSE
      juris := NEW.jurisdiction_code; treatment := NEW.treatment_key;
    END IF;
  END IF;

  SELECT t.head_rule INTO rule
    FROM platform.tax_treatment t
   WHERE t.jurisdiction_code = juris AND t.key = treatment;
  -- The treatment was deleted in this same transaction. Its heads went with it
  -- or the FK refused them; either way there is nothing left to balance.
  IF rule IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(h.share_bps), 0), count(*) INTO total, heads
    FROM platform.tax_head h
   WHERE h.jurisdiction_code = juris AND h.treatment_key = treatment;

  IF rule = 'required' THEN
    IF heads = 0 THEN
      RAISE EXCEPTION
        'tax_shares_whole: %/% collects tax and has no head, so every bill under it would charge tax under no head at all',
        juris, treatment
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tax_shares_whole';
    END IF;
    IF total <> 10000 THEN
      RAISE EXCEPTION
        'tax_shares_whole: %/% has % head(s) whose shares sum to %bps, not 10000 -- every bill under it would collect %.2f%% of the tax it charged',
        juris, treatment, heads, total, (total / 100.0)
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tax_shares_whole';
    END IF;
  ELSIF heads > 0 THEN
    -- `none` and `unrecorded` both land here. Neither has a head to report
    -- under: one because no tax was taken, the other because nobody knows.
    RAISE EXCEPTION
      'tax_shares_whole: %/% has head_rule %, so it may carry no head; it has %',
      juris, treatment, rule, heads
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tax_shares_whole';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER tax_head_shares_whole
  AFTER INSERT OR UPDATE OR DELETE ON platform.tax_head
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_tax_shares_whole();

CREATE CONSTRAINT TRIGGER tax_treatment_shares_whole
  AFTER INSERT OR UPDATE ON platform.tax_treatment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_tax_shares_whole();


-- ###########################################################################
-- READ-ONLY TO THE APPLICATION ROLE.
--
-- These three tables are a GUARD expressed as data. A plane that could write
-- them could widen the guard it is bound by, which is the whole objection to
-- moving a rule out of code. `db/seed.ts` runs as the owner; nothing else
-- writes here. Same posture as the audit parents and `stock_movement`.
-- ###########################################################################
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON platform.tax_jurisdiction, platform.tax_treatment, platform.tax_head
  FROM katkitchen_app;


-- ###########################################################################
-- INDIA, AND ONLY INDIA.
--
-- Seeded here rather than in `db/seed.ts` because `app.bill.tax_jurisdiction`
-- below carries a foreign key to it and the backfill needs the row to exist in
-- the same transaction. `db/seed.ts` re-asserts it idempotently so the two
-- cannot drift.
--
-- `none` collects nothing. `unstated` is migration 0050's legacy value and is
-- `unrecorded`, NOT `none`: those bills DID charge tax and the head cannot be
-- reconstructed. It is listed rather than omitted so the trigger recognises it
-- as a defined treatment -- an undefined one RAISES, which would make every
-- pre-0050 bill unamendable.
-- ###########################################################################
INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
VALUES ('IN', 'India', 'implemented', '91');

INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule) VALUES
  ('IN', 'intra_state', 'Intra-state supply', 'required'),
  ('IN', 'inter_state', 'Inter-state supply', 'required'),
  ('IN', 'none',        'No tax collected',   'none'),
  ('IN', 'unstated',    'Head not recorded',  'unrecorded');

INSERT INTO platform.tax_head (jurisdiction_code, treatment_key, name, share_bps, ordinal) VALUES
  ('IN', 'intra_state', 'CGST', 5000, 1),
  ('IN', 'intra_state', 'SGST', 5000, 2),
  ('IN', 'inter_state', 'IGST', 10000, 1);


-- ###########################################################################
-- THE TENANT STATES ITS JURISDICTION, AND THERE IS NO DEFAULT.
--
-- NOT NULL with NO DEFAULT, deliberately: `provisionTenant` has to name it, so
-- a tenant cannot be created without somebody deciding which country's rules
-- apply. A DEFAULT of 'IN' would be the same class of mistake as the phone
-- module's dial code -- correct for every tenant that exists today and silently
-- wrong for the first one that is not Indian.
--
-- The backfill IS 'IN' and that is a FACT rather than a guess: every tenant in
-- every existing deployment was sold to an Indian restaurant, the product had
-- no other rules, and `branch.state_code` is a two-digit Indian state code on
-- all of them.
--
-- On the TENANT and not the branch, by decision: a restaurant group with
-- branches in two countries is two tenants. That is a real exclusion -- it also
-- means two subscriptions and two invoices -- and it is the right one for now,
-- because the alternative is splitting every return, every gapless numbering
-- series and every currency per branch.
-- ###########################################################################
ALTER TABLE platform.tenant ADD COLUMN tax_jurisdiction text;

UPDATE platform.tenant SET tax_jurisdiction = 'IN';

ALTER TABLE platform.tenant
  ALTER COLUMN tax_jurisdiction SET NOT NULL,
  ADD CONSTRAINT tenant_tax_jurisdiction_fk
  FOREIGN KEY (tax_jurisdiction) REFERENCES platform.tax_jurisdiction (code) ON DELETE RESTRICT;


-- ###########################################################################
-- AND IT TRAVELS ON THE DOCUMENT.
--
-- Stamped, not joined, for the reason every other column on this table is:
-- a tenant whose jurisdiction is ever corrected must not re-head three years of
-- bills. It is also what the trigger below reads, so the guard a bill was
-- issued under is the guard it is judged by.
--
-- `bill_invariants` is disabled across the backfill for the same reason as
-- migration 0050's: it is a per-row DEFERRABLE constraint trigger, so an UPDATE
-- touching every bill queues one pending event per row and Postgres refuses
-- ALTER TABLE on a table with pending events. Firing them instead would make
-- this migration re-assert every bill's line sums and tender balance across the
-- whole install, and FAIL on any pre-existing inconsistency that has nothing to
-- do with adding a column.
-- ###########################################################################
ALTER TABLE app.bill DISABLE TRIGGER bill_invariants;

ALTER TABLE app.bill ADD COLUMN tax_jurisdiction text;

UPDATE app.bill SET tax_jurisdiction = 'IN';

ALTER TABLE app.bill
  ALTER COLUMN tax_jurisdiction SET NOT NULL,
  ADD CONSTRAINT bill_tax_jurisdiction_fk
  FOREIGN KEY (tax_jurisdiction) REFERENCES platform.tax_jurisdiction (code) ON DELETE RESTRICT;

ALTER TABLE app.bill ENABLE TRIGGER bill_invariants;


-- The tax identity freezes at the first tender, and the jurisdiction is part of
-- it -- migration 0051's tuple with one more member. Which country's rules a
-- document was raised under is not a thing that may change after the customer
-- has paid.
CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no,
      NEW.tax_treatment, NEW.tax_jurisdiction, NEW.supplier_state_code, NEW.supplier_gstin,
      NEW.supplier_gst_registration, NEW.place_of_supply_state_code,
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.supplier_state_code, OLD.supplier_gstin,
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
-- THE RATE NO LONGER HAS TO BE EVEN.
--
-- `tax_class_rate_halves` existed because the intra-state split was two equal
-- halves computed as `rate_bps / 2`. It refused California's 7.25% -- 725bps --
-- so a US restaurant could not enter its own combined rate. The split is an
-- allocation over shares now, exact for any rate and any number of heads, so
-- the CHECK has nothing left to protect.
--
-- Removed rather than relaxed: a CHECK that no longer expresses a rule is worse
-- than no CHECK, because the next reader assumes it does.
--
-- IF EXISTS, AND THAT IS NOT DEFENSIVENESS. The DOWN migration deliberately
-- REFUSES to re-add this constraint once an odd rate is in use -- it cannot,
-- the rows violate it -- and says so in a NOTICE. So a down-then-up cycle on an
-- install where somebody has entered 7.25% arrives here with the constraint
-- already gone. Without IF EXISTS the re-apply fails, which is how a
-- reversibility test discovers that a migration is only reversible once. Found
-- exactly that way.
-- ###########################################################################
ALTER TABLE app.tax_class DROP CONSTRAINT IF EXISTS tax_class_rate_halves;


-- ###########################################################################
-- THE HEAD GUARD, READING THE VOCABULARY INSTEAD OF NAMING IT.
--
-- Three changes from 0050's version, all of them the same change: nothing here
-- knows the word CGST.
--
--   The NAME SET comes from `platform.tax_head` for the bill's own stamped
--   jurisdiction and treatment. A taxable treatment with NO head rows RAISES
--   rather than returning: absence is not permission, and a jurisdiction
--   somebody added to the catalogue without heads must not become a way to
--   issue untaxed-but-taxed documents.
--
--   The SHARE CHECK replaces "equal rates". Each head's amount must be within
--   one minor unit of its proportional share of the line's tax. That is
--   deliberately a tolerance and not an equality: the largest-remainder
--   allocator in `src/tax/heads.ts` distributes the remainder by ordinal, and
--   reimplementing that in plpgsql would be a second copy of the arithmetic --
--   which is precisely the defect this migration is undoing. One minor unit is
--   the widest a largest-remainder allocation can ever be from the exact
--   proportional value, so the tolerance is tight rather than generous.
--
--   The SUM CHECK is unchanged and is the one that actually protects the money:
--   the heads must sum to the line's tax exactly.
-- ###########################################################################
CREATE OR REPLACE FUNCTION app.assert_bill_line_heads_match_treatment() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  juris      text;
  treatment  text;
  rule       text;
  bill_no_   integer;
  comps      jsonb;
  head_total bigint;
  names      text[];
  expected   text[];
  offending  record;
BEGIN
  SELECT b.tax_jurisdiction, b.tax_treatment, b.bill_no
    INTO juris, treatment, bill_no_
    FROM app.bill b
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.bill_id;

  -- The bill was deleted inside the same transaction. Nothing to assert.
  IF juris IS NULL THEN RETURN NULL; END IF;

  SELECT t.head_rule INTO rule
    FROM platform.tax_treatment t
   WHERE t.jurisdiction_code = juris AND t.key = treatment;

  IF rule IS NULL THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % declares treatment % in jurisdiction %, which the catalogue does not define',
      bill_no_, treatment, juris
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  -- A jsonb `null` SCALAR is not an empty array, and COALESCE does not convert
  -- one into the other -- which is how 975 live rows made the outward supply
  -- return raise "cannot extract elements from a scalar" instead of producing a
  -- return. Normalised here so the assertion cannot be defeated by that shape.
  comps := CASE WHEN jsonb_typeof(NEW.tax_components) = 'array'
                THEN NEW.tax_components ELSE '[]'::jsonb END;

  SELECT COALESCE(sum((c.value ->> 'amount_minor')::bigint), 0),
         array_agg(c.value ->> 'name' ORDER BY c.value ->> 'name')
    INTO head_total, names
    FROM jsonb_array_elements(comps) c;

  -- ########################################################################
  -- `unrecorded` IS SKIPPED, AND SKIPPING IT IS THE CORRECT ANSWER.
  --
  -- 0050's version of this function did `IF treatment = 'unstated' THEN RETURN
  -- NULL`. The literal is gone; the behaviour must not be. These lines DID
  -- charge tax at a branch with no state code, so there is a real amount and no
  -- knowable head -- asserting either "it must have heads" or "it must carry no
  -- tax" refuses a document that legitimately exists.
  --
  -- The refusal that matters for them is at FILING time, not at write time:
  -- `outwardSupplyReturn` raises `gst_period_has_unstated_treatment` and names
  -- the money rather than bucketing it under a guessed head.
  --
  -- The first draft of this migration modelled the treatment as "collects no
  -- tax" and therefore landed it on the arm below. Every fixture that bills at
  -- a stateless branch failed, which is how it was caught.
  -- ########################################################################
  IF rule = 'unrecorded' THEN RETURN NULL; END IF;

  IF rule = 'none' THEN
    IF NEW.tax_minor <> 0 OR jsonb_array_length(comps) <> 0 THEN
      RAISE EXCEPTION
        'bill_line_heads_match_treatment: bill % is % in %, which collects no tax, but line % has % in tax and % head(s)',
        bill_no_, treatment, juris, NEW.id, NEW.tax_minor, jsonb_array_length(comps)
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
    END IF;
    RETURN NULL;
  END IF;

  -- A zero-rated line on an otherwise taxable bill: an exempt dish beside a
  -- taxable one. Legitimate, and it carries no head.
  IF NEW.tax_minor = 0 AND jsonb_array_length(comps) = 0 THEN RETURN NULL; END IF;

  SELECT array_agg(h.name ORDER BY h.name) INTO expected
    FROM platform.tax_head h
   WHERE h.jurisdiction_code = juris AND h.treatment_key = treatment;

  IF expected IS NULL THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: % / % collects tax and the catalogue gives it no head, so no line under it can be issued',
      juris, treatment
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  IF head_total <> NEW.tax_minor THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % line % says % in tax but its heads sum to %',
      bill_no_, NEW.id, NEW.tax_minor, head_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  IF names IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % is % in % and needs exactly %, not %',
      bill_no_, treatment, juris, expected, names
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  -- Each head within one minor unit of its share. See the note above on why
  -- this is a tolerance rather than an equality.
  SELECT c.value ->> 'name' AS name,
         (c.value ->> 'amount_minor')::bigint AS got,
         h.share_bps
    INTO offending
    FROM jsonb_array_elements(comps) c
    JOIN platform.tax_head h
      ON h.jurisdiction_code = juris AND h.treatment_key = treatment
     AND h.name = c.value ->> 'name'
   WHERE abs((c.value ->> 'amount_minor')::bigint
             - (NEW.tax_minor::numeric * h.share_bps / 10000)) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'bill_line_heads_match_treatment: bill % line % puts % on % but its share is %bps of %',
      bill_no_, NEW.id, offending.got, offending.name, offending.share_bps, NEW.tax_minor
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_line_heads_match_treatment';
  END IF;

  RETURN NULL;
END
$fn$;
