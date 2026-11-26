-- ###########################################################################
-- EVERY PLAN STATES EVERY KEY, BECAUSE AN ABSENT KEY DENIES.
--
-- Plans used to carry `limits.branches` and `features.inventory` only. Routes
-- are now gated on recipes, suppliers, purchasing, a report tier and a tablet
-- limit (routeRegistry `plan`, packages/shared constants/plans.ts). A version
-- that says nothing about `devices` would refuse every tablet enrolment, so
-- existing versions and the documents published from them are backfilled here.
--
-- The backfill only ADDS keys (`defaults || existing`: the right-hand side wins),
-- so nothing a Super Admin already set is changed. The values reproduce what
-- each plan was sold as:
--   recipes, suppliers, purchasing, advanced reports  = what `inventory` was
--   full reports                                       = Max only
--   devices                                            = 2 x branches
-- which gives Basic 2, Pro 6 and Max 20 tablets -- ENTITLEMENTS exactly.
--
-- Documents get a NEW version rather than an edit: a document is a record of
-- what was published, and the tenant-plane cache orders by version.
-- ###########################################################################

UPDATE platform.plan_version pv
   SET limits = jsonb_build_object(
                  'devices', 2 * COALESCE((pv.limits ->> 'branches')::int, 0)
                ) || pv.limits,
       features = jsonb_build_object(
                    'inventory',        false,
                    'recipes',          COALESCE((pv.features ->> 'inventory')::boolean, false),
                    'suppliers',        COALESCE((pv.features ->> 'inventory')::boolean, false),
                    'purchasing',       COALESCE((pv.features ->> 'inventory')::boolean, false),
                    'reports_advanced', COALESCE((pv.features ->> 'inventory')::boolean, false),
                    'reports_full',     p.key = 'max'
                  ) || pv.features
  FROM platform.plan p
 WHERE p.id = pv.plan_id;

INSERT INTO platform.entitlement_document
  (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
SELECT d.tenant_id,
       d.version + 1,
       d.plan_key,
       d.plan_version,
       d.status,
       jsonb_build_object('devices', 2 * COALESCE((d.limits ->> 'branches')::int, 0)) || d.limits,
       jsonb_build_object(
         'inventory',        false,
         'recipes',          COALESCE((d.features ->> 'inventory')::boolean, false),
         'suppliers',        COALESCE((d.features ->> 'inventory')::boolean, false),
         'purchasing',       COALESCE((d.features ->> 'inventory')::boolean, false),
         'reports_advanced', COALESCE((d.features ->> 'inventory')::boolean, false),
         'reports_full',     d.plan_key = 'max'
       ) || d.features,
       'migration 0059: plan feature keys'
  FROM (SELECT DISTINCT ON (tenant_id) *
          FROM platform.entitlement_document
         ORDER BY tenant_id, version DESC) d;

-- ###########################################################################
-- A FIRST DOCUMENT FOR EVERY RESTAURANT THAT NEVER HAD ONE.
--
-- Provisioning did not publish a document (it does now), so a restaurant
-- created from the console had none, and with plan gates live it would be
-- refused every gated route. The same projection `publishEntitlement` makes:
-- the live subscription's plan version, with the tenant status mapped onto the
-- document's five states. Runs after the backfill above, so it copies the
-- complete key set.
-- ###########################################################################
INSERT INTO platform.entitlement_document
  (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
SELECT t.id,
       1,
       p.key,
       pv.version,
       CASE t.status
         WHEN 'active'    THEN 'active'
         WHEN 'past_due'  THEN 'past_due'
         WHEN 'soft_lock' THEN 'soft_lock'
         WHEN 'hard_lock' THEN 'hard_lock'
         ELSE 'suspended'
       END,
       pv.limits,
       pv.features,
       'migration 0059: first document'
  FROM platform.tenant t
  JOIN platform.subscription s
    ON s.tenant_id = t.id AND s.status IN ('trialing', 'active', 'past_due')
  JOIN platform.plan_version pv ON pv.id = s.plan_version_id
  JOIN platform.plan p ON p.id = pv.plan_id
 WHERE NOT EXISTS (
         SELECT 1 FROM platform.entitlement_document d WHERE d.tenant_id = t.id);
