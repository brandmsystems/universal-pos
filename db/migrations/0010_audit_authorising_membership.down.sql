DROP INDEX IF EXISTS app.tenant_audit_log_by_authorising_membership_idx;

ALTER TABLE app.tenant_audit_log
  DROP CONSTRAINT IF EXISTS tenant_audit_log_authorising_membership_fk;

ALTER TABLE app.tenant_audit_log DROP COLUMN authorising_membership_id;

ALTER TABLE app.membership DROP CONSTRAINT IF EXISTS membership_tenant_id_key;
