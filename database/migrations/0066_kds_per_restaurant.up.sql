-- ###########################################################################
-- THE KITCHEN SCREEN IS A PER-RESTAURANT CHOICE, NOT A PLAN TERM.
--
-- Pro sells the KOT flow (`features.kot`): order-taking staff, kitchen
-- tickets, the hand-over to billing. Whether the kitchen works from a screen
-- (KDS) or from the printed tickets alone is how that restaurant runs, decided
-- by the Sales Person at the sale -- so it lives on the restaurant, and plan
-- versions keep saying nothing about it.
--
-- DEFAULT true, because every restaurant that exists today has the kitchen
-- screen whenever its plan has KOT; switching it off silently would take a
-- working kitchen screen away mid-service. New restaurants on a plan with KOT
-- state it explicitly at provisioning.
-- ###########################################################################
ALTER TABLE platform.tenant
  ADD COLUMN kds_enabled boolean NOT NULL DEFAULT true;

-- ###########################################################################
-- IT FLOWS DOWN IN THE ENTITLEMENT DOCUMENT, AND AN ABSENT KEY DENIES.
--
-- `publishEntitlement` now writes `features.kds` from this column. A document
-- published before it has no `kds` key, and absent denies -- so every
-- restaurant's newest document is republished here with `kds: true` (what the
-- column says for every existing row), as a NEW version, the way 0059 did.
-- The invalidation goes through the outbox like any publish, so the tenant
-- plane's cache drops the old document rather than serving it for its TTL.
-- ###########################################################################
WITH latest AS (
  SELECT DISTINCT ON (tenant_id) *
    FROM platform.entitlement_document
   ORDER BY tenant_id, version DESC
), published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, d.plan_key, d.plan_version, d.status, d.limits,
         d.features || jsonb_build_object('kds', t.kds_enabled),
         'migration 0066: kds per restaurant'
    FROM latest d
    JOIN platform.tenant t ON t.id = d.tenant_id
  RETURNING tenant_id, version
)
INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
SELECT gen_random_uuid(), 'entitlement.invalidate', tenant_id::text || ':' || version::text,
       jsonb_build_object('tenantId', tenant_id, 'version', version)
  FROM published
ON CONFLICT (topic, dedupe_key) DO NOTHING;
