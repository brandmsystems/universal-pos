DROP INDEX IF EXISTS app.tenant_audit_log_by_impersonation_idx;

ALTER TABLE app.tenant_audit_log
  DROP CONSTRAINT IF EXISTS tenant_audit_log_attribution_exact;
ALTER TABLE app.tenant_audit_log
  DROP CONSTRAINT IF EXISTS tenant_audit_log_actor_kind_known;

ALTER TABLE app.tenant_audit_log
  DROP COLUMN actor_system_job,
  DROP COLUMN impersonation_session_id,
  DROP COLUMN actor_kind;

DROP TRIGGER IF EXISTS impersonation_session_append_only ON platform.impersonation_session;
DROP FUNCTION IF EXISTS platform.deny_impersonation_rewrite();

DROP INDEX IF EXISTS platform.impersonation_session_by_actor_idx;
DROP INDEX IF EXISTS platform.impersonation_session_live_idx;
DROP TABLE IF EXISTS platform.impersonation_session;
