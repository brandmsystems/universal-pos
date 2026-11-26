-- KOT and Billing on one order, and two plans.
--
-- ###########################################################################
-- 1. THE ORDER'S STAGE: KOT OWNS IT, THEN BILLING DOES.
--
-- One session, one order, one bill -- never a KOT copy and a Billing copy. What
-- changes hands is OWNERSHIP, and it is a positive column rather than an
-- inference from "a bill exists": KOT marks the party ready for billing, the
-- domain then refuses every order edit (add, change, remove, send, join, move),
-- and billing refuses to start on a party still being ordered.
-- ###########################################################################
ALTER TABLE app.table_session
  ADD COLUMN stage text NOT NULL DEFAULT 'ordering'
    CONSTRAINT table_session_stage_known CHECK (stage IN ('ordering', 'billing')),
  ADD COLUMN billing_ready_at timestamptz,
  ADD COLUMN billing_ready_by_user_id uuid,
  ADD CONSTRAINT table_session_billing_ready_by_fk
    FOREIGN KEY (tenant_id, billing_ready_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT table_session_stage_consistent CHECK (
    (stage = 'billing') = (billing_ready_at IS NOT NULL AND billing_ready_by_user_id IS NOT NULL)
  );

-- A session already billed before this migration is in billing: its money has
-- been written, so KOT must not reopen it by default.
UPDATE app.table_session s
   SET stage = 'billing',
       billing_ready_at = COALESCE(
         (SELECT min(b.generated_at) FROM app.bill b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id),
         s.opened_at),
       billing_ready_by_user_id = COALESCE(
         (SELECT b.generated_by_user_id FROM app.bill b
           WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id ORDER BY b.generated_at LIMIT 1),
         s.opened_by_user_id)
 WHERE EXISTS (SELECT 1 FROM app.bill b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id);

CREATE INDEX table_session_billing_queue_idx
  ON app.table_session (tenant_id, branch_id, business_date)
  WHERE stage = 'billing' AND status = 'open';

-- ###########################################################################
-- 2. PLAN TERMS: `kot` IN, STOCK AND THE MAX-ONLY TIER OUT.
--
-- `kot` is the separate order-taking flow (KOT staff, kitchen tickets, the
-- kitchen screen). Every plan that had stock control was a multi-staff plan,
-- so that flag is the honest seed for it. The four stock flags and
-- `reports_full` are removed: nothing reads them any more, and a version
-- carrying a flag no route checks is a promise nobody keeps.
-- ###########################################################################
UPDATE platform.plan_version pv
   SET features = (pv.features - 'inventory' - 'recipes' - 'suppliers' - 'purchasing' - 'reports_full')
                  || jsonb_build_object('kot', COALESCE((pv.features ->> 'inventory')::boolean, false));

-- ###########################################################################
-- 3. MAX IS RETIRED; ITS RESTAURANTS MOVE TO PRO NOW.
--
-- Done as a plan change is done: the open Max segment ends and a Pro segment
-- begins at the same instant, so the no-overlap constraint and invoicing see
-- one continuous history, already-invoiced segments are untouched, and the
-- subscription points at Pro. A pending change TO Max is revoked -- it would
-- move a restaurant onto a plan that no longer exists.
-- ###########################################################################
DO $$
DECLARE
  pro_plan_id    uuid;
  pro_version_id uuid;
  moving         record;
  cut            timestamptz;
BEGIN
  SELECT pv.plan_id, pv.id INTO pro_plan_id, pro_version_id
    FROM platform.plan_version pv JOIN platform.plan p ON p.id = pv.plan_id
   WHERE p.key = 'pro' AND pv.published_at IS NOT NULL
   ORDER BY pv.version DESC LIMIT 1;

  IF pro_version_id IS NOT NULL THEN
    FOR moving IN
      SELECT s.id AS subscription_id, s.tenant_id
        FROM platform.subscription s
        JOIN platform.plan_version pv ON pv.id = s.plan_version_id
        JOIN platform.plan p ON p.id = pv.plan_id
       WHERE p.key = 'max'
    LOOP
      cut := now();
      UPDATE platform.subscription_segment seg
         SET ends_at = GREATEST(cut, seg.starts_at + interval '1 millisecond')
       WHERE seg.subscription_id = moving.subscription_id AND seg.ends_at IS NULL
      RETURNING seg.ends_at INTO cut;

      INSERT INTO platform.subscription_segment
        (id, tenant_id, subscription_id, plan_id, plan_version_id, quantity, starts_at)
      SELECT gen_random_uuid(), moving.tenant_id, moving.subscription_id, pro_plan_id, pro_version_id,
             COALESCE((SELECT seg.quantity FROM platform.subscription_segment seg
                        WHERE seg.subscription_id = moving.subscription_id
                        ORDER BY seg.starts_at DESC LIMIT 1), 1),
             COALESCE(cut, now())
       WHERE EXISTS (SELECT 1 FROM platform.subscription_segment seg
                      WHERE seg.subscription_id = moving.subscription_id);

      UPDATE platform.subscription SET plan_id = pro_plan_id, plan_version_id = pro_version_id
       WHERE id = moving.subscription_id;
    END LOOP;
  END IF;

  UPDATE platform.scheduled_subscription_change c
     SET status = 'revoked', revoked_at = now()
    FROM platform.plan p
   WHERE p.id = c.target_plan_id AND p.key = 'max' AND c.status = 'pending';

  UPDATE platform.plan SET status = 'retired' WHERE key = 'max';
END $$;

-- ###########################################################################
-- 4. EVERY RESTAURANT GETS A NEW ENTITLEMENT DOCUMENT.
--
-- The documents hold a copy of the features, so the terms above reach no
-- restaurant until one is published. Same projection as 0059: the live
-- subscription's plan version, the latest document's status carried forward.
-- The Redis copy expires within its five-minute TTL.
-- ###########################################################################
INSERT INTO platform.entitlement_document
  (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
       'migration 0064: KOT and Billing; Basic and Pro only'
  FROM (SELECT DISTINCT ON (tenant_id) tenant_id, version, status
          FROM platform.entitlement_document ORDER BY tenant_id, version DESC) d
  JOIN platform.subscription s
    ON s.tenant_id = d.tenant_id AND s.status IN ('trialing', 'active', 'past_due')
  JOIN platform.plan_version pv ON pv.id = s.plan_version_id
  JOIN platform.plan p ON p.id = pv.plan_id;
