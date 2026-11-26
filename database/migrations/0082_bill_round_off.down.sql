-- A round-off already collected is a record of money taken, and must survive the
-- rollback: it moves onto the bill's last capture as tender rounding (amount -
-- rounding = applied). Tenders netted to the payable (total + round off); adding
-- the round-off to rounding nets them to the total again, which is what the 0052
-- invariant below checks: 190 paid on 190.05 with -5 round-off -> rounding -5,
-- 190 - (-5) = 190.05. Uncollected round-offs (no tender yet) carry nothing.
UPDATE app.tender t
   SET rounding_minor = t.rounding_minor + b.round_off_minor
  FROM app.bill b
 WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id AND b.round_off_minor <> 0
   AND t.id = (SELECT t2.id FROM app.tender t2
                WHERE t2.tenant_id = b.tenant_id AND t2.bill_id = b.id AND t2.kind = 'capture'
                ORDER BY t2.tendered_at DESC, t2.id DESC LIMIT 1);

CREATE OR REPLACE FUNCTION app.deny_tendered_bill_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.assert_billing_invariants() RETURNS trigger
LANGUAGE plpgsql AS $function$
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
$function$;

-- Check the moved round-offs now, under the restored invariant, rather than at a
-- COMMIT that a later rollback step's ALTER TABLE on tender would otherwise
-- find still pending. Only this trigger, and back to its deferred default at
-- once: SET CONSTRAINTS lasts the transaction, and a rollback run as one
-- transaction must not leave every other deferred check immediate.
SET CONSTRAINTS app.tender_invariants IMMEDIATE;
SET CONSTRAINTS app.tender_invariants DEFERRED;

ALTER TABLE app.bill
  DROP CONSTRAINT bill_round_off_matches_rule,
  DROP COLUMN payable_minor,
  DROP COLUMN round_off_minor,
  DROP COLUMN rounding_rule;
