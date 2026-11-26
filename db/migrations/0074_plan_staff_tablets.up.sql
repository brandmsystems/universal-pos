-- Basic has no staff tablets: one person, one till, no setup codes.
--
-- ###########################################################################
-- A setup code exists to hand a tablet to a member of STAFF, who then signs
-- in on it with a PIN. Basic is one person at one till -- the owner's own
-- computer, signed in with their email and password (`POST /admin/till`) -- so
-- on Basic the code, the pairing step and the "type it in on the tablet"
-- instructions are a workflow nobody needs. `staff_tablets` is a plan term,
-- like the kitchen screen: the plan decides, and the setup-code route answers
-- 402 naming Standard where it is off.
--
-- Every version states it, because an absent feature denies: Basic `false`,
-- every other version `true` -- what each already had, so nothing is taken
-- from Standard, Pro or an unusual plan. Tablets already set up on a Basic
-- restaurant keep working; only issuing a NEW code is refused.
-- ###########################################################################
UPDATE platform.plan_version pv
   SET features = pv.features || jsonb_build_object('staff_tablets', p.key <> 'basic')
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND NOT pv.features ? 'staff_tablets';

WITH published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
         'migration 0074: staff tablets are a plan term; Basic has none'
    FROM (SELECT DISTINCT ON (tenant_id) tenant_id, version, status
            FROM platform.entitlement_document ORDER BY tenant_id, version DESC) d
    JOIN platform.subscription s
      ON s.tenant_id = d.tenant_id AND s.status IN ('trialing', 'active', 'past_due')
    JOIN platform.plan_version pv ON pv.id = s.plan_version_id
    JOIN platform.plan p ON p.id = pv.plan_id
  RETURNING tenant_id, version
)
INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
SELECT gen_random_uuid(), 'entitlement.invalidate', tenant_id::text || ':' || version::text,
       jsonb_build_object('tenantId', tenant_id, 'version', version)
  FROM published
ON CONFLICT (topic, dedupe_key) DO NOTHING;
