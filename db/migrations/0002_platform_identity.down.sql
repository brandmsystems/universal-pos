DROP TRIGGER IF EXISTS platform_user_set_updated_at ON platform.platform_user;
DROP INDEX IF EXISTS platform.platform_user_role_idx;
DROP TABLE IF EXISTS platform.platform_user;
DROP TABLE IF EXISTS platform.platform_role;
