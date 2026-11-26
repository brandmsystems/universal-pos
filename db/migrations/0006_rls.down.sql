DROP POLICY IF EXISTS tenant_isolation ON app.membership;
ALTER TABLE app.membership DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.role_permission;
ALTER TABLE app.role_permission DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.role;
ALTER TABLE app.role DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.credential;
ALTER TABLE app.credential DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.app_user;
ALTER TABLE app.app_user DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.branch;
ALTER TABLE app.branch DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS app.current_tenant_id();
