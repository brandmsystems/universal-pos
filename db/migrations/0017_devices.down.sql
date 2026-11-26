DROP POLICY IF EXISTS tenant_isolation ON app.device_enrolment;
DROP TRIGGER IF EXISTS device_enrolment_set_updated_at ON app.device_enrolment;
DROP INDEX IF EXISTS app.device_enrolment_pending_idx;
DROP TABLE IF EXISTS app.device_enrolment;

DROP POLICY IF EXISTS tenant_isolation ON app.device;
DROP TRIGGER IF EXISTS device_set_updated_at ON app.device;
DROP INDEX IF EXISTS app.device_by_branch_idx;
DROP INDEX IF EXISTS app.device_active_fingerprint_per_tenant;
DROP TABLE IF EXISTS app.device;
