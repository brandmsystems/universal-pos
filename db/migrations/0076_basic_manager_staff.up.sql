-- The manager manages staff on every plan again; Basic included.
--
-- ###########################################################################
-- 0075 made staff management a plan term (`staff_admin`, off on Basic) and
-- gave it to the Sales person instead. That was reversed by the next decision:
-- one login page for the manager and the staff, and the MANAGER creating staff
-- usernames and passwords from the manager dashboard. A term every plan holds
-- is no term, so it leaves every plan version, and the Sales person's
-- `platform.tenant.staff` key leaves the catalogue with its grants (the seed
-- also stops granting it; removing it here keeps databases where it was
-- seeded from carrying a key the constant no longer knows).
--
-- `tables` (0075) stays: Basic still has no floors or tables.
-- ###########################################################################
UPDATE platform.plan_version SET features = features - 'staff_admin' WHERE features ? 'staff_admin';

DELETE FROM platform.platform_role_permission WHERE permission_key = 'platform.tenant.staff';
DELETE FROM platform.platform_permission WHERE key = 'platform.tenant.staff';

WITH published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
         'migration 0076: staff management is no longer a plan term'
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
