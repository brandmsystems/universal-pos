DROP TRIGGER IF EXISTS role_permission_system_locked ON app.role_permission;
DROP TRIGGER IF EXISTS role_system_locked ON app.role;
DROP FUNCTION IF EXISTS app.deny_system_role_mutation();
