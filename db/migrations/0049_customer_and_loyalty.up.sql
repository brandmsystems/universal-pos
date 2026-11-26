-- The customer becomes a record, and points become a ledger.
--
-- ###########################################################################
-- FIVE PERMISSION KEYS AND TWO ROUTES HAVE BEEN POINTING AT NOTHING.
--
-- `customer.view`, `customer.create`, `customer.edit`, `customer.pii.view` and
-- `customer.pii.export` have been in the catalogue since 0004. Two routes are
-- served -- `GET /admin/customers/:id/contact` and `POST /admin/customers/export`
-- -- and `src/privacy/piiAccess.ts` says in writing what it had to do about the
-- missing table:
--
--   "THE SUBJECT IS `app.app_user`, BECAUSE `app.customer` DOES NOT EXIST. The
--    route reads /admin/customers/:id/contact and the permission is described as
--    revealing a customer's phone and address, but no customer table has ever
--    been migrated."
--
-- So a route named for customers revealed STAFF records. `pii_access_log` has
-- carried a `customer_id` with no foreign key -- which is the only reason a
-- staff id could be stored there at all -- and every privacy-log row written so
-- far refers to a staff member.
--
-- This is the table. The FK on `pii_access_log.customer_id` is deliberately
-- STILL not added: the column now holds either a customer id or a staff id, and
-- `permission_key` is what discriminates them. Adding the FK would invalidate
-- every row written before today, which is the one thing an append-only privacy
-- log must never permit.
-- ###########################################################################

-- ###########################################################################
-- THE PHONE IS THE IDENTITY, AND IT IS STORED IN ONE SHAPE ONLY.
--
-- In India everyone has a mobile number and nobody has anything else in common
-- across restaurants, so the phone is the natural key. That makes normalisation
-- a correctness problem rather than a formatting preference: `9876543210`,
-- `+91 98765 43210` and `098765 43210` are one person, and storing them as
-- typed produces three customers, three point balances, and a diner who is told
-- they have no points.
--
-- So the column holds digits only, no `+`, no spaces, with the country code
-- included -- and `src/crm/phone.ts` is the single place that produces that
-- shape. The CHECK here is the backstop, not the rule.
--
-- ERASURE keeps the row. A DPDP erasure request cannot delete a customer whose
-- bills a GST return still has to account for, so the name goes, the phone is
-- replaced by a token that can never be dialled or re-matched, and the loyalty
-- and billing history stays referentially intact. Same posture as tenant purge,
-- which anonymises in place.
-- ###########################################################################
CREATE TABLE app.customer (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  phone              text        NOT NULL,
  -- Nullable and normal: a diner who gives a number at the till and not a name
  -- is the common case, and demanding one would make the cashier invent it.
  display_name       text,

  status             text        NOT NULL DEFAULT 'active'
                     CONSTRAINT customer_status_known
                     CHECK (status IN ('active', 'erased')),

  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Nullable BECAUSE of the online flow: a customer who registers themselves on
  -- a QR menu has no staff member behind the row, and filling this with whoever
  -- happened to be signed in would be a false attribution in the one table an
  -- erasure request is answered from.
  created_by_user_id uuid,
  erased_at          timestamptz,

  CONSTRAINT customer_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- One person per tenant, and NOT global: the same diner at two restaurants is
  -- two relationships, and a shared customer row would leak one tenant's
  -- customer list to another through the mere fact of a match.
  CONSTRAINT customer_phone_unique_per_tenant UNIQUE (tenant_id, phone),

  CONSTRAINT customer_phone_shape
  CHECK (CASE status
           -- Unmatchable and undiallable, and prefixed so it cannot be mistaken
           -- for a number by anything that reads this column.
           WHEN 'erased' THEN phone LIKE 'erased:%' AND display_name IS NULL
           ELSE phone ~ '^[1-9][0-9]{9,14}$'
         END),

  CONSTRAINT customer_erasure_consistent
  CHECK ((status = 'erased') = (erased_at IS NOT NULL))
);

CREATE INDEX customer_by_name_idx ON app.customer (tenant_id, display_name)
  WHERE status = 'active';


-- ###########################################################################
-- CONSENT IS A HISTORY, NOT A BOOLEAN.
--
-- A boolean column answers "may we message them today" and cannot answer "on
-- what basis, and who says so" -- which is the only question that matters when
-- a TRAI complaint or a DPDP notice arrives. A withdrawal that overwrites a
-- grant destroys the evidence that the grant ever existed, and the evidence is
-- the defence.
--
-- So: append-only, one row per statement, latest row per (customer, channel)
-- wins. ABSENCE MEANS NO CONSENT -- never asked and refused are different
-- facts, but they have the same consequence and the send path must treat an
-- empty result as "do not send" rather than as "not restricted".
-- ###########################################################################
CREATE TABLE app.customer_consent (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  customer_id        uuid        NOT NULL,

  channel            text        NOT NULL
                     CONSTRAINT customer_consent_channel_known
                     CHECK (channel IN ('whatsapp', 'sms', 'email', 'call')),
  granted            boolean     NOT NULL,

  -- How it was obtained. A campaign audit asks this before it asks anything
  -- else, and 'import' is the answer that makes a list legally worthless
  -- unless the evidence column says where it came from.
  source             text        NOT NULL
                     CONSTRAINT customer_consent_source_known
                     CHECK (source IN ('till', 'online', 'import', 'customer_request')),
  evidence           text,

  occurred_at        timestamptz NOT NULL DEFAULT now(),
  -- Null for 'online' and 'customer_request': the customer acted, not a staff
  -- member, and naming one would be the same false attribution.
  recorded_by_user_id uuid,

  CONSTRAINT customer_consent_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_consent_customer_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customer (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_consent_recorder_fk
  FOREIGN KEY (tenant_id, recorded_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- An imported grant with no stated provenance is exactly the row a regulator
  -- disallows, so the schema will not hold it.
  CONSTRAINT customer_consent_import_needs_evidence
  CHECK (source <> 'import' OR evidence IS NOT NULL),

  -- A till-recorded statement was made to somebody. Who, is the point.
  CONSTRAINT customer_consent_till_needs_actor
  CHECK (source <> 'till' OR recorded_by_user_id IS NOT NULL)
);

CREATE INDEX customer_consent_latest_idx
  ON app.customer_consent (tenant_id, customer_id, channel, occurred_at DESC);


-- ###########################################################################
-- THE PROGRAM, IN INTEGERS, ONE ROW PER TENANT.
--
-- Both rates are integers because both are money. A "1% cashback" stored as a
-- float is a rounding argument every single bill; `points_per_hundred` and
-- `redeem_paise_per_point` make the arithmetic exact and the liability
-- countable: outstanding points x redeem_paise_per_point is what the
-- restaurant owes its customers, in paise, exactly.
-- ###########################################################################
CREATE TABLE app.loyalty_program (
  tenant_id              uuid        PRIMARY KEY
                         REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  status                 text        NOT NULL DEFAULT 'inactive'
                         CONSTRAINT loyalty_program_status_known
                         CHECK (status IN ('active', 'inactive')),

  -- Points granted per ONE HUNDRED RUPEES of taxable value.
  points_per_hundred     integer     NOT NULL DEFAULT 0
                         CHECK (points_per_hundred >= 0),
  -- What one point is worth when spent, in paise. Separate from the earn rate
  -- on purpose: a restaurant that wants "earn 5, each worth 50p" can have it,
  -- and one that wants a 1:1 rupee has to say so.
  redeem_paise_per_point integer     NOT NULL DEFAULT 0
                         CHECK (redeem_paise_per_point >= 0),
  -- Below this, redemption is refused. Stops a 3-point redemption costing more
  -- in cashier time than it saves the diner.
  min_redeem_points      integer     NOT NULL DEFAULT 0
                         CHECK (min_redeem_points >= 0),

  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- An ACTIVE program that grants nothing and redeems nothing is a switch that
  -- appears on and does nothing, which is worse than being off.
  CONSTRAINT loyalty_program_active_is_configured
  CHECK (status <> 'active' OR (points_per_hundred > 0 AND redeem_paise_per_point > 0))
);


-- ###########################################################################
-- POINTS ARE A LEDGER. THE BALANCE IS SUM(points) AND IS NEVER STORED.
--
-- The same rule as `order_line`, where SUM(quantity) is the truth and a void is
-- a negative row: a stored balance is a second source of truth that drifts, and
-- the drift is discovered by a customer at a till in front of a queue.
--
-- Earn rows are written BY TRIGGER when a bill settles -- see below. Redeem
-- rows are written by the application, because they need a balance check and a
-- matching tender in the same transaction.
--
-- Append-only: UPDATE and DELETE revoked from katkitchen_app, same posture as
-- stock_movement and for the same reason.
-- ###########################################################################
CREATE TABLE app.loyalty_ledger (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  customer_id        uuid        NOT NULL,
  branch_id          uuid,
  business_date      date        NOT NULL,

  kind               text        NOT NULL
                     CONSTRAINT loyalty_kind_known
                     CHECK (kind IN ('earn', 'redeem', 'adjust', 'expire')),
  -- SIGNED, and the sign is real. Earn and a positive adjustment add; redeem,
  -- expiry and a negative adjustment subtract.
  points             integer     NOT NULL CONSTRAINT loyalty_points_nonzero CHECK (points <> 0),

  bill_id            uuid,
  reason_id          uuid,
  note               text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Null for 'earn' and 'expire': the system wrote them. A person is named on
  -- everything a person chose.
  created_by_user_id uuid,

  CONSTRAINT loyalty_ledger_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT loyalty_ledger_customer_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customer (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_ledger_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_ledger_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_ledger_reason_fk
  FOREIGN KEY (tenant_id, reason_id) REFERENCES app.adjustment_reason (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_ledger_actor_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT loyalty_ledger_shape_exact
  CHECK (
    CASE kind
      -- Earned against a specific bill, by the system.
      WHEN 'earn'   THEN points > 0 AND bill_id IS NOT NULL AND created_by_user_id IS NULL
      -- Spent against a specific bill, by a named cashier.
      WHEN 'redeem' THEN points < 0 AND bill_id IS NOT NULL AND created_by_user_id IS NOT NULL
      -- A manual correction: no bill, a named actor, and a reason code, which is
      -- the same control every other manual money adjustment carries.
      WHEN 'adjust' THEN bill_id IS NULL AND created_by_user_id IS NOT NULL
                         AND reason_id IS NOT NULL
      WHEN 'expire' THEN points < 0 AND bill_id IS NULL AND created_by_user_id IS NULL
      ELSE false
    END
  )
);

CREATE INDEX loyalty_ledger_by_customer_idx
  ON app.loyalty_ledger (tenant_id, customer_id, created_at DESC);

-- One redemption per bill. Not a convenience: two taps racing on one bill would
-- both pass an application balance check and both write, and the deferred
-- balance trigger would then refuse the whole transaction rather than the second
-- tap -- losing the first redemption too.
CREATE UNIQUE INDEX loyalty_one_redemption_per_bill
  ON app.loyalty_ledger (tenant_id, bill_id) WHERE kind = 'redeem';

-- Likewise one earn per bill, so a re-settled bill (void a tender, re-tender)
-- cannot pay out twice.
CREATE UNIQUE INDEX loyalty_one_earn_per_bill
  ON app.loyalty_ledger (tenant_id, bill_id) WHERE kind = 'earn';


-- ###########################################################################
-- THE BALANCE MAY NOT GO NEGATIVE, AND THE DATABASE IS THE AUTHORITY.
--
-- The application checks first, so the refusal a cashier sees names the
-- shortfall. This is what makes the check TRUE rather than probable: two
-- concurrent redemptions for one customer at two tills both read a sufficient
-- balance and both write, and no application check can see the other.
--
-- DEFERRED, because a redemption and its tender are one unit of work and the
-- intermediate states inside that transaction are not required to balance.
-- ###########################################################################
CREATE FUNCTION app.assert_loyalty_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject_customer uuid;
  balance bigint;
BEGIN
  subject_customer := COALESCE(NEW.customer_id, OLD.customer_id);

  SELECT COALESCE(sum(points), 0) INTO balance
    FROM app.loyalty_ledger
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND customer_id = subject_customer;

  IF balance < 0 THEN
    RAISE EXCEPTION
      'loyalty_balance_never_negative: customer % would be left at % points',
      subject_customer, balance
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'loyalty_balance_never_negative';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER loyalty_balance_never_negative
  AFTER INSERT OR UPDATE OR DELETE ON app.loyalty_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_loyalty_balance();


-- ###########################################################################
-- THE BILL NAMES ITS CUSTOMER, AND THE SNAPSHOT STAYS THE AUTHORITY.
--
-- `recipient_gstin` and `recipient_legal_name` are snapshotted onto the bill
-- and are what the GST return reads. This column does NOT replace them and must
-- not be read as the recipient: it is the CRM link, so "what did this diner
-- order last time" has an answer, and a customer who later corrects their name
-- must not thereby rewrite a filed return.
--
-- Nullable, permanently. A walk-in who gives no phone is the majority of trade
-- and the bill is complete without one -- which is the whole reason the till
-- asks rather than requires.
-- ###########################################################################
ALTER TABLE app.bill
  ADD COLUMN customer_id uuid,
  ADD CONSTRAINT bill_customer_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customer (tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX bill_by_customer_idx ON app.bill (tenant_id, customer_id, business_date DESC)
  WHERE customer_id IS NOT NULL;


-- ###########################################################################
-- A REDEMPTION IS A TENDER, NOT A DISCOUNT. THIS IS THE DESIGN DECISION.
--
-- Taking points off the LINES would reduce the taxable value, which means the
-- restaurant remits less GST because a customer spent loyalty points -- and
-- that is not what happened. The supply was made at its full value; the
-- customer settled part of it with something other than money.
--
-- So it is a tender method, and everything downstream is already correct
-- without changes: `bill_total_is_subtotal_plus_tax` holds, the GST return sees
-- the full taxable value, and the payment-mix report shows loyalty as its own
-- bucket -- which is exactly the figure an owner needs, because it is what the
-- programme cost them this month.
--
-- Its own method rather than reusing 'voucher': a gift voucher was sold for
-- money and a loyalty point was given away, and an owner reading the payment
-- mix must not have those in one row.
-- ###########################################################################
ALTER TABLE app.tender
  DROP CONSTRAINT tender_method_known,
  ADD CONSTRAINT tender_method_known
  CHECK (method IN ('cash', 'card', 'upi', 'wallet', 'voucher', 'loyalty', 'other'));


-- ###########################################################################
-- POINTS ARE EARNED BY TRIGGER, WHEN THE BILL SETTLES.
--
-- Not in `recordTender`, which is where the settle transition happens today.
-- There are three ways a bill can reach 'settled' -- the online tender path, the
-- offline sync replay, and a manual settlement keyed in after the fact -- and a
-- rule implemented in one of them is a rule the other two do not get. That is
-- this repository's most frequently found defect, and it has been found in the
-- fire path, the adjustment path and the tax path already.
--
-- EARNED ON THE TAXABLE VALUE, not the total. A diner does not earn loyalty on
-- the government's share of their bill; the restaurant would be paying rewards
-- out of money it never kept.
--
-- Integer arithmetic, floored: `subtotal_minor * points_per_hundred / 10000`.
-- ₹100 is 10000 paise, so at 5 points per hundred a ₹250 bill earns 12, not
-- 12.5. Floored rather than rounded, deliberately -- rounding up means the
-- programme pays out more than its stated rate and the liability figure is
-- wrong in the direction nobody checks.
--
-- Fires only for a bill that NAMES a customer and only while the programme is
-- active. The partial unique index makes a second earn on the same bill
-- impossible, so a void-and-re-tender cannot pay twice.
-- ###########################################################################
CREATE FUNCTION app.earn_loyalty_on_settlement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rate integer;
  earned integer;
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.points_per_hundred INTO rate
    FROM app.loyalty_program p
   WHERE p.tenant_id = NEW.tenant_id AND p.status = 'active';

  IF rate IS NULL OR rate = 0 THEN
    RETURN NULL;
  END IF;

  earned := (NEW.subtotal_minor * rate) / 10000;
  IF earned <= 0 THEN
    RETURN NULL;
  END IF;

  -- ON CONFLICT DO NOTHING against the partial unique index: a bill that
  -- settles, is reopened and settles again earns once. Silent by design -- the
  -- second settlement is not an error, it just does not pay again.
  INSERT INTO app.loyalty_ledger
    (id, tenant_id, customer_id, branch_id, business_date, kind, points, bill_id)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.customer_id, NEW.branch_id,
          NEW.business_date, 'earn', earned, NEW.id)
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END
$$;

CREATE TRIGGER bill_earns_loyalty
  AFTER UPDATE OF status ON app.bill
  FOR EACH ROW
  WHEN (NEW.status = 'settled' AND OLD.status <> 'settled')
  EXECUTE FUNCTION app.earn_loyalty_on_settlement();


-- ###########################################################################
-- STAFF PII GETS ITS OWN KEY, BECAUSE IT WAS BORROWING THE CUSTOMER'S.
--
-- `pii_access_permission_known` admitted only the two customer keys, and the
-- reveal route -- which actually read `app_user` -- logged staff reveals under
-- `customer.pii.view`. Now that both subjects exist, the log has to be able to
-- say which one was read, and the permission that authorised a staff reveal
-- must not be the one an owner grants for looking up a diner's phone.
-- ###########################################################################
ALTER TABLE app.pii_access_log
  DROP CONSTRAINT pii_access_permission_known,
  ADD CONSTRAINT pii_access_permission_known
  CHECK (permission_key IN ('customer.pii.view', 'customer.pii.export', 'user.pii.view')),

  DROP CONSTRAINT pii_access_shape_exact,
  ADD CONSTRAINT pii_access_shape_exact
  CHECK (
    CASE permission_key
      WHEN 'customer.pii.view' THEN customer_id IS NOT NULL AND query_descriptor IS NULL
      -- The same shape for a staff reveal: one subject, no descriptor. The
      -- column is named `customer_id` and now holds either kind of subject --
      -- which is why it carries no foreign key, and why the key above is what
      -- says who was read.
      WHEN 'user.pii.view'     THEN customer_id IS NOT NULL AND query_descriptor IS NULL
      WHEN 'customer.pii.export' THEN customer_id IS NULL AND query_descriptor IS NOT NULL
                                      AND result_count IS NOT NULL AND reason IS NOT NULL
      ELSE false
    END
  );


ALTER TABLE app.customer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.customer_consent ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_consent
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.loyalty_program ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.loyalty_program
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.loyalty_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.loyalty_ledger
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Append-only, both of them, for the same reason the stock ledger is: a record
-- whose purpose is to be believed later must not be editable by the plane that
-- produced it. A correction is a new row.
REVOKE UPDATE, DELETE, TRUNCATE ON app.loyalty_ledger FROM katkitchen_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app.customer_consent FROM katkitchen_app;
