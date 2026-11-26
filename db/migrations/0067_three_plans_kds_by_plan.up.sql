-- Three plans -- Basic, Standard, Pro -- and the kitchen screen decided by the plan.
--
-- ###########################################################################
-- 1. `kds` BECOMES A PLAN TERM; THE PER-RESTAURANT SWITCH GOES.
--
-- 0066 made the kitchen screen a choice the Sales Person stated per restaurant.
-- It is now what the plan sells: Pro has it, Basic and Standard do not. A
-- switch beside the plan is a second opinion that can disagree with what was
-- sold, so the column is dropped rather than kept in step.
--
-- Every version states `kds` explicitly, because an absent key denies. Each
-- version takes `kds = kot`: that is exactly what every restaurant had before
-- 0066 (and after it, by its default), so no restaurant loses a kitchen screen
-- it was using. A Pro restaurant that had switched it off gains it back.
-- ###########################################################################
UPDATE platform.plan_version
   SET features = features || jsonb_build_object('kds', COALESCE((features ->> 'kot')::boolean, false))
 WHERE NOT features ? 'kds';

ALTER TABLE platform.tenant DROP COLUMN kds_enabled;

-- ###########################################################################
-- 2. BASIC GAINS KOT.
--
-- Every plan now runs the order-taking flow with printed kitchen tickets; what
-- separates them is the kitchen screen, branches, tablets and reports. Done to
-- the versions in place, as 0064 did, so restaurants already on Basic gain it
-- without a plan change. Nothing is taken away.
-- ###########################################################################
UPDATE platform.plan_version pv
   SET features = pv.features || jsonb_build_object('kot', true)
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND p.key = 'basic';

-- ###########################################################################
-- 3. STANDARD: ONE OUTLET, KOT, NO KITCHEN SCREEN, MORE TABLETS AND REPORTS.
--
-- The same terms as `ENTITLEMENTS.standard` in packages/shared, which
-- `ensureStandardPlans` would also seed; ON CONFLICT keeps the two from
-- fighting. The price is a starting point -- a Super Admin publishes version 2.
-- ###########################################################################
INSERT INTO platform.plan (id, key, name, description)
VALUES (gen_random_uuid(), 'standard', 'Standard',
        'One outlet with KOT Staff, printed kitchen tickets, Billing Staff and reports.')
ON CONFLICT (key) DO UPDATE SET status = 'active';

INSERT INTO platform.plan_version
  (id, plan_id, version, price_minor, currency, billing_period, limits, features, published_at)
SELECT gen_random_uuid(), p.id, 1, 179900, 'INR', 'monthly',
       '{"branches": 1, "devices": 4}'::jsonb,
       '{"kot": true, "kds": false, "reports_advanced": true}'::jsonb,
       now()
  FROM platform.plan p
 WHERE p.key = 'standard'
ON CONFLICT (plan_id, version) DO NOTHING;

-- ###########################################################################
-- 4. EVERY RESTAURANT GETS A NEW ENTITLEMENT DOCUMENT, AND THE CACHE HEARS.
--
-- Same projection as 0064, plus the invalidation 0066 sent: the documents hold
-- a copy of the features, so nothing above reaches a restaurant until one is
-- published, and the tenant plane's cache must drop the old one rather than
-- serve it for its TTL.
-- ###########################################################################
WITH published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
         'migration 0067: three plans; the kitchen screen is a plan term'
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
