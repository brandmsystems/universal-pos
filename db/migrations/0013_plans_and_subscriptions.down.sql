DROP TABLE IF EXISTS platform.platform_setting;

DROP TRIGGER IF EXISTS subscription_set_updated_at ON platform.subscription;
DROP INDEX IF EXISTS platform.subscription_by_status_idx;
DROP INDEX IF EXISTS platform.subscription_one_live_per_tenant;
DROP TABLE IF EXISTS platform.subscription;

DROP INDEX IF EXISTS platform.plan_version_published_idx;
DROP TABLE IF EXISTS platform.plan_version;

DROP TRIGGER IF EXISTS plan_set_updated_at ON platform.plan;
DROP TABLE IF EXISTS platform.plan;
