-- The restaurants moved from Max stay on Pro, with their segments: a rollback
-- must not rewrite billing history. Max is offered again; the old feature
-- flags are restored from `kot` (the flag they seeded it from) and every
-- restaurant gets a document carrying them, so the previous code finds the
-- keys it gates on.
UPDATE platform.plan SET status = 'active' WHERE key = 'max';

UPDATE platform.plan_version pv
   SET features = (pv.features - 'kot') || jsonb_build_object(
         'inventory',    COALESCE((pv.features ->> 'kot')::boolean, false),
         'recipes',      COALESCE((pv.features ->> 'kot')::boolean, false),
         'suppliers',    COALESCE((pv.features ->> 'kot')::boolean, false),
         'purchasing',   COALESCE((pv.features ->> 'kot')::boolean, false),
         'reports_full', false);

INSERT INTO platform.entitlement_document
  (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
       'migration 0064 rolled back'
  FROM (SELECT DISTINCT ON (tenant_id) tenant_id, version, status
          FROM platform.entitlement_document ORDER BY tenant_id, version DESC) d
  JOIN platform.subscription s
    ON s.tenant_id = d.tenant_id AND s.status IN ('trialing', 'active', 'past_due')
  JOIN platform.plan_version pv ON pv.id = s.plan_version_id
  JOIN platform.plan p ON p.id = pv.plan_id;

DROP INDEX app.table_session_billing_queue_idx;
ALTER TABLE app.table_session
  DROP CONSTRAINT table_session_stage_consistent,
  DROP CONSTRAINT table_session_billing_ready_by_fk,
  DROP COLUMN billing_ready_by_user_id,
  DROP COLUMN billing_ready_at,
  DROP COLUMN stage;
