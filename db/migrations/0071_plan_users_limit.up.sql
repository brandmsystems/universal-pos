-- Restaurant user accounts become a plan limit: Basic 4, Standard 8, Pro 25.
--
-- ###########################################################################
-- 1. EVERY VERSION STATES `users`, BECAUSE AN ABSENT LIMIT DENIES.
--
-- `assertWithinLimit` treats a missing key as zero, so a version without
-- `users` would refuse every staff invite the moment this ships. The three
-- standard plans take the numbers in ENTITLEMENTS (packages/shared); any other
-- version -- retired Max, a hand-made one -- takes 25, the most generous of
-- them, so no restaurant on an unusual plan loses the ability to add staff.
--
-- Only ADDING someone is ever refused. A restaurant already above its limit
-- keeps every account it has: the count is checked on invite, on create and on
-- switching an account back on, never on sign-in -- the same rule as tablets,
-- and for the same reason: a plan term must never take a working restaurant
-- offline.
-- ###########################################################################
UPDATE platform.plan_version pv
   SET limits = pv.limits || jsonb_build_object('users',
         CASE p.key WHEN 'basic' THEN 4 WHEN 'standard' THEN 8 ELSE 25 END)
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND NOT pv.limits ? 'users';

-- ###########################################################################
-- 2. EVERY RESTAURANT GETS A NEW ENTITLEMENT DOCUMENT, AND THE CACHE HEARS.
--
-- The same projection as 0067: documents hold a copy of the limits, so nothing
-- above reaches a restaurant until one is published.
-- ###########################################################################
WITH published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
         'migration 0071: restaurant users are a plan limit'
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
