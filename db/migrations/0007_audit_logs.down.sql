DROP FUNCTION IF EXISTS app.ensure_audit_partitions(integer);
DROP FUNCTION IF EXISTS platform.ensure_audit_partitions(integer);

DROP TRIGGER IF EXISTS tenant_audit_log_append_only ON app.tenant_audit_log;
DROP TRIGGER IF EXISTS platform_audit_log_append_only ON platform.platform_audit_log;

DROP POLICY IF EXISTS tenant_isolation ON app.tenant_audit_log;

-- Dropping a partitioned table drops its partitions, DEFAULT included, along
-- with their per-partition policies.
DROP TABLE IF EXISTS app.tenant_audit_log;
DROP TABLE IF EXISTS platform.platform_audit_log;

DROP FUNCTION IF EXISTS app.deny_mutation();
DROP FUNCTION IF EXISTS platform.deny_mutation();
