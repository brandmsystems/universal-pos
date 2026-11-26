DROP TRIGGER IF EXISTS tenant_owner_invite_set_updated_at ON platform.tenant_owner_invite;
DROP TABLE IF EXISTS platform.tenant_owner_invite;

DROP TRIGGER IF EXISTS tenant_set_updated_at ON platform.tenant;
DROP INDEX IF EXISTS platform.tenant_delinquent_since_idx;
DROP INDEX IF EXISTS platform.tenant_status_idx;
DROP TABLE IF EXISTS platform.tenant;
