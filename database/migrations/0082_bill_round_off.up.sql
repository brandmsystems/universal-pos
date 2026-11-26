-- A bill is paid to the nearest rupee: Round off is its own line.
--
-- ###########################################################################
-- THE TOTAL STAYS THE TAX DOCUMENT; THE PAYABLE IS WHAT IS COLLECTED.
--
-- `total_minor` is still subtotal + tax, summed from the lines -- what the GST
-- return reads and what `assert_billing_invariants` (1) reconciles. The round-off
-- is not a supply and carries no tax; it is the paise between that total and
-- the whole rupee the customer pays: under 50 paise rounds DOWN, 50 or more UP
-- (190.05 -> 190, 264.50 -> 265). `payable_minor` is GENERATED from the two, so
-- the amount collected can never disagree with the bill it settles.
--
-- `rounding_rule` is the POSITIVE discriminator: a bill made before this rule
-- is `none` and keeps a round-off of 0 -- it was right when it was made, and a
-- paid bill must not start owing paise. `bill_round_off_matches_rule` derives
-- the round-off from the total for `nearest_rupee`, so no writer can choose it.
-- This is the platform invoice's Round Off (Billing automation, CLAUDE.md), on
-- the restaurant's own bill.
-- ###########################################################################

ALTER TABLE app.bill
  ADD COLUMN rounding_rule text NOT NULL DEFAULT 'none'
    CONSTRAINT bill_rounding_rule_known CHECK (rounding_rule IN ('none', 'nearest_rupee')),
  ADD COLUMN round_off_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN payable_minor bigint GENERATED ALWAYS AS (total_minor + round_off_minor) STORED,
  ADD CONSTRAINT bill_round_off_matches_rule CHECK (
    CASE rounding_rule
      WHEN 'none' THEN round_off_minor = 0
      WHEN 'nearest_rupee' THEN round_off_minor =
        CASE WHEN total_minor % 100 >= 50 THEN 100 - total_minor % 100 ELSE -(total_minor % 100) END
      ELSE false
    END
  );

-- 3. now settles against the PAYABLE: tenders never exceed it, and equal it
-- once settled. 1, 2 and 4 are unchanged from 0052.
CREATE OR REPLACE FUNCTION app.assert_billing_invariants() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  target_bill uuid;
  target_tenant uuid;
  offending record;
BEGIN
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

  -- 2. No order line is allocated across bills beyond 100%.
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

  -- 3. Tenders never exceed what is PAYABLE, and match it exactly once settled.
  --    SUM(amount) - SUM(rounding) = payable (= total + round off).
  SELECT b.id, b.status, b.payable_minor,
         COALESCE(sum(t.amount_minor - t.rounding_minor), 0) AS tendered
    INTO offending
    FROM app.bill b
    LEFT JOIN app.tender t ON t.tenant_id = b.tenant_id AND t.bill_id = b.id
   WHERE b.tenant_id = target_tenant AND b.id = target_bill AND b.status <> 'void'
   GROUP BY b.id, b.status, b.payable_minor
  HAVING COALESCE(sum(t.amount_minor - t.rounding_minor), 0) > b.payable_minor
      OR (b.status = 'settled'
          AND COALESCE(sum(t.amount_minor - t.rounding_minor), 0) <> b.payable_minor);

  IF FOUND THEN
    RAISE EXCEPTION 'bill % is % with tenders netting % against a payable of %',
      offending.id, offending.status, offending.tendered, offending.payable_minor
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

-- Bills still being paid move to the rule: they are not final, and paying them
-- to the rupee is the point. A bill already paid to the rupee short of its
-- total (190 on 190.05) is then paid in full, and says so.
UPDATE app.bill
   SET rounding_rule = 'nearest_rupee',
       round_off_minor = CASE WHEN total_minor % 100 >= 50 THEN 100 - total_minor % 100 ELSE -(total_minor % 100) END
 WHERE status = 'open';

UPDATE app.bill b
   SET status = 'settled', settled_at = now(), version = version + 1
 WHERE b.status = 'open' AND b.payable_minor > 0
   AND b.payable_minor = (SELECT COALESCE(sum(t.amount_minor - t.rounding_minor), 0)
                            FROM app.tender t WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id);

-- Once tendered, the round-off is as fixed as the total it was derived from.
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
      NEW.recipient_gstin, NEW.recipient_legal_name, NEW.recipient_state_code,
      NEW.rounding_rule, NEW.round_off_minor)
     IS DISTINCT FROM
     (OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.split_kind, OLD.bill_no,
      OLD.tax_treatment, OLD.tax_jurisdiction, OLD.premises_class,
      OLD.supplier_state_code, OLD.supplier_gstin,
      OLD.supplier_gst_registration, OLD.place_of_supply_state_code,
      OLD.recipient_gstin, OLD.recipient_legal_name, OLD.recipient_state_code,
      OLD.rounding_rule, OLD.round_off_minor) THEN
    RAISE EXCEPTION
      'bill % has been tendered against: its figures and its tax identity are immutable',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;
