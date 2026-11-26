DROP TRIGGER IF EXISTS membership_set_updated_at ON app.membership;
DROP TABLE IF EXISTS app.membership;

DROP TABLE IF EXISTS app.role_permission;

DROP TRIGGER IF EXISTS role_set_updated_at ON app.role;
DROP TABLE IF EXISTS app.role;

DROP TRIGGER IF EXISTS credential_set_updated_at ON app.credential;
DROP TABLE IF EXISTS app.credential;

DROP TRIGGER IF EXISTS app_user_set_updated_at ON app.app_user;
DROP TABLE IF EXISTS app.app_user;

DROP TRIGGER IF EXISTS branch_set_updated_at ON app.branch;
DROP TABLE IF EXISTS app.branch;
