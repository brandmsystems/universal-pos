DROP FUNCTION IF EXISTS app.set_updated_at();
DROP FUNCTION IF EXISTS platform.set_updated_at();

ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA platform
  REVOKE SELECT ON TABLES FROM katkitchen_platform_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA app
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM katkitchen_app;
ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA platform
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM katkitchen_app;

-- No CASCADE. If a later migration failed to roll back cleanly, this must fail
-- loudly rather than quietly dropping tables that still hold rows.
DROP SCHEMA app;
DROP SCHEMA platform;
