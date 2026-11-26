-- Refunds need a scoped reason like every other adjustment.
ALTER TABLE app.adjustment_reason_kind
  DROP CONSTRAINT adjustment_reason_kind_known;
ALTER TABLE app.adjustment_reason_kind
  ADD CONSTRAINT adjustment_reason_kind_known
  CHECK (kind IN ('void', 'comp', 'discount', 'recall', 'refund'));

-- Bill numbers are read aloud and quoted in disputes: same counter mechanism, same
-- gaplessness guarantee, same disqualification of SEQUENCE.
CREATE TABLE app.bill_sequence (
  tenant_id     uuid    NOT NULL,
  branch_id     uuid    NOT NULL,
  business_date date    NOT NULL,
  next_no       integer NOT NULL DEFAULT 0 CHECK (next_no >= 0),

  PRIMARY KEY (tenant_id, branch_id, business_date),
  CONSTRAINT bill_sequence_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT
);


-- One bill per settlement; many bills per session.
CREATE TABLE app.bill (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id            uuid        NOT NULL,
  session_id           uuid        NOT NULL,
  business_date        date        NOT NULL,
  bill_no              integer     NOT NULL CHECK (bill_no > 0),

  split_kind           text        NOT NULL
                       CONSTRAINT bill_split_kind_known
                       CHECK (split_kind IN ('whole', 'by_line', 'by_guest', 'by_percentage')),

  status               text        NOT NULL DEFAULT 'open'
                       CONSTRAINT bill_status_known
                       CHECK (status IN ('open', 'settled', 'void')),
  version              integer     NOT NULL DEFAULT 1 CHECK (version > 0),

  -- Computed from the LINES' snapshotted rates, never from the catalogue. This is
  -- where the priced-document rule arrives at its destination.
  subtotal_minor       bigint      NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor            bigint      NOT NULL CHECK (tax_minor >= 0),
  total_minor          bigint      NOT NULL CHECK (total_minor >= 0),

  generated_at         timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id uuid        NOT NULL,
  settled_at           timestamptz,

  CONSTRAINT bill_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT bill_no_unique UNIQUE (tenant_id, branch_id, business_date, bill_no),
  CONSTRAINT bill_session_fk
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.table_session (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_user_fk
  FOREIGN KEY (tenant_id, generated_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT bill_total_is_subtotal_plus_tax CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT bill_settlement_consistent CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);

CREATE INDEX bill_by_session_idx ON app.bill (tenant_id, session_id);


CREATE TABLE app.bill_line (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  bill_id        uuid        NOT NULL,
  order_line_id  uuid        NOT NULL,

  -- Basis points of the order line carried by THIS bill. 10000 for a whole or
  -- by-line split; a fraction for a percentage split.
  share_bps      integer     NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),

  -- Snapshotted again at bill time, from the line's own snapshot.
  display_name   text        NOT NULL,
  guest_no       smallint,
  amount_minor   bigint      NOT NULL,
  tax_minor      bigint      NOT NULL,
  tax_rate_bps   integer,
  tax_components jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bill_line_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_line_order_line_fk
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES app.order_line (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_line_once_per_bill UNIQUE (tenant_id, bill_id, order_line_id)
);

CREATE INDEX bill_line_by_order_line_idx ON app.bill_line (tenant_id, order_line_id);


CREATE TABLE app.tender (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  bill_id            uuid        NOT NULL,

  kind               text        NOT NULL
                     CONSTRAINT tender_kind_known CHECK (kind IN ('capture', 'void')),
  method             text        NOT NULL
                     CONSTRAINT tender_method_known
                     CHECK (method IN ('cash', 'card', 'upi', 'wallet', 'voucher', 'other')),

  amount_minor       bigint      NOT NULL,
  -- Cash rounds to the nearest unit while card takes the exact figure. That
  -- difference is a RECORDED LINE, not a discrepancy to absorb: the day's
  -- rounding gain becomes a reportable figure rather than a monthly argument.
  --
  -- Reconciliation is  SUM(amount) - SUM(rounding) = bill total.
  rounding_minor     bigint      NOT NULL DEFAULT 0,

  reference          text,
  voids_tender_id    uuid,
  reason_id          uuid,

  tendered_by_user_id uuid       NOT NULL,
  tendered_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tender_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT tender_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tender_voids_fk
  FOREIGN KEY (tenant_id, voids_tender_id) REFERENCES app.tender (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tender_user_fk
  FOREIGN KEY (tenant_id, tendered_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- A void is a NEGATIVE ROW, not an update. Same family as order-line voids.
  CONSTRAINT tender_shape_exact
  CHECK (
    CASE kind
      WHEN 'capture' THEN amount_minor > 0 AND voids_tender_id IS NULL
      WHEN 'void'    THEN amount_minor < 0 AND voids_tender_id IS NOT NULL
      ELSE false
    END
  )
);

CREATE INDEX tender_by_bill_idx ON app.tender (tenant_id, bill_id);


-- A separate table because a refund happens days later against a CLOSED bill.
-- Manager only, reason code, and a reference to the original.
CREATE TABLE app.refund (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  bill_id             uuid        NOT NULL,
  original_tender_id  uuid,

  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  method              text        NOT NULL
                      CONSTRAINT refund_method_known
                      CHECK (method IN ('cash', 'card', 'upi', 'wallet', 'voucher', 'other')),

  reason_id           uuid        NOT NULL,
  kind                text        NOT NULL DEFAULT 'refund'
                      CONSTRAINT refund_kind_fixed CHECK (kind = 'refund'),
  note                text,

  refunded_by_user_id uuid        NOT NULL,
  refunded_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refund_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT refund_tender_fk
  FOREIGN KEY (tenant_id, original_tender_id) REFERENCES app.tender (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT refund_reason_fk
  FOREIGN KEY (tenant_id, reason_id, kind)
    REFERENCES app.adjustment_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT,
  CONSTRAINT refund_user_fk
  FOREIGN KEY (tenant_id, refunded_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX refund_by_bill_idx ON app.refund (tenant_id, bill_id);


-- Frozen on FIRST TENDER, same trigger shape as fired_at. A reprint six months
-- later must match the paper.
CREATE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tender
                  WHERE tenant_id = OLD.tenant_id AND bill_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.split_kind, NEW.bill_no)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no) THEN
    RAISE EXCEPTION 'bill % has been tendered against: its figures are immutable', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER bill_tendered_is_immutable
  BEFORE UPDATE ON app.bill
  FOR EACH ROW EXECUTE FUNCTION app.deny_tendered_bill_mutation();


-- The deferred family, extended. Nightly is too late for money.
CREATE FUNCTION app.assert_billing_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_bill uuid;
  target_tenant uuid;
  offending record;
BEGIN
  -- Branch explicitly: plpgsql resolves record field access at RUNTIME, so
  -- NEW.bill_id on a `bill` row raises even inside a CASE arm that is not taken,
  -- and NEW itself is unassigned on DELETE.
  IF TG_TABLE_NAME = 'bill' THEN
    IF TG_OP = 'DELETE' THEN
      target_tenant := OLD.tenant_id; target_bill := OLD.id;
    ELSE
      target_tenant := NEW.tenant_id; target_bill := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      target_tenant := OLD.tenant_id; target_bill := OLD.bill_id;
    ELSE
      target_tenant := NEW.tenant_id; target_bill := NEW.bill_id;
    END IF;
  END IF;

  -- 1. The bill's own lines sum to its figures, exactly.
  SELECT b.id,
         b.subtotal_minor,
         COALESCE(sum(l.amount_minor), 0) AS lines_subtotal,
         b.tax_minor,
         COALESCE(sum(l.tax_minor), 0) AS lines_tax
    INTO offending
    FROM app.bill b
    LEFT JOIN app.bill_line l ON l.tenant_id = b.tenant_id AND l.bill_id = b.id
   WHERE b.tenant_id = target_tenant AND b.id = target_bill AND b.status <> 'void'
   GROUP BY b.id, b.subtotal_minor, b.tax_minor
  HAVING b.subtotal_minor <> COALESCE(sum(l.amount_minor), 0)
      OR b.tax_minor <> COALESCE(sum(l.tax_minor), 0);

  IF FOUND THEN
    RAISE EXCEPTION 'bill % lines sum to %/% but the bill says %/%',
      offending.id, offending.lines_subtotal, offending.lines_tax,
      offending.subtotal_minor, offending.tax_minor
      USING ERRCODE = '23514';
  END IF;

  -- 2. No order line is allocated across bills beyond 100%. This is the one that
  --    catches a percentage split losing or duplicating a line, and it is the
  --    more important of the two.
  SELECT l.order_line_id, sum(l.share_bps) AS allocated
    INTO offending
    FROM app.bill_line l
    JOIN app.bill b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
   WHERE l.tenant_id = target_tenant
     AND b.status <> 'void'
     AND l.order_line_id IN (SELECT order_line_id FROM app.bill_line
                              WHERE tenant_id = target_tenant AND bill_id = target_bill)
   GROUP BY l.order_line_id
  HAVING sum(l.share_bps) > 10000;

  IF FOUND THEN
    RAISE EXCEPTION 'order line % is allocated %bps across bills; 10000 is the whole of it',
      offending.order_line_id, offending.allocated
      USING ERRCODE = '23514';
  END IF;

  -- 3. Tenders never exceed the bill, and match it exactly once settled.
  --    SUM(amount) - SUM(rounding) = total.
  SELECT b.id, b.status, b.total_minor,
         COALESCE(sum(t.amount_minor - t.rounding_minor), 0) AS tendered
    INTO offending
    FROM app.bill b
    LEFT JOIN app.tender t ON t.tenant_id = b.tenant_id AND t.bill_id = b.id
   WHERE b.tenant_id = target_tenant AND b.id = target_bill AND b.status <> 'void'
   GROUP BY b.id, b.status, b.total_minor
  HAVING COALESCE(sum(t.amount_minor - t.rounding_minor), 0) > b.total_minor
      OR (b.status = 'settled'
          AND COALESCE(sum(t.amount_minor - t.rounding_minor), 0) <> b.total_minor);

  IF FOUND THEN
    RAISE EXCEPTION 'bill % is % with tenders netting % against a total of %',
      offending.id, offending.status, offending.tendered, offending.total_minor
      USING ERRCODE = '23514';
  END IF;

  -- 4. Refunds never exceed what was actually taken.
  SELECT b.id,
         COALESCE((SELECT sum(r.amount_minor) FROM app.refund r
                    WHERE r.tenant_id = b.tenant_id AND r.bill_id = b.id), 0) AS refunded,
         COALESCE((SELECT sum(t.amount_minor) FROM app.tender t
                    WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id), 0) AS tendered
    INTO offending
    FROM app.bill b
   WHERE b.tenant_id = target_tenant AND b.id = target_bill;

  IF FOUND AND offending.refunded > offending.tendered THEN
    RAISE EXCEPTION 'bill % has been refunded % against tenders of %',
      offending.id, offending.refunded, offending.tendered
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER bill_invariants
  AFTER INSERT OR UPDATE ON app.bill
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_billing_invariants();

CREATE CONSTRAINT TRIGGER bill_line_invariants
  AFTER INSERT OR UPDATE OR DELETE ON app.bill_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_billing_invariants();

CREATE CONSTRAINT TRIGGER tender_invariants
  AFTER INSERT OR UPDATE OR DELETE ON app.tender
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_billing_invariants();

CREATE CONSTRAINT TRIGGER refund_invariants
  AFTER INSERT OR UPDATE ON app.refund
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_billing_invariants();


ALTER TABLE app.bill_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_sequence
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.bill ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.bill_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.tender ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tender
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.refund ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.refund
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
