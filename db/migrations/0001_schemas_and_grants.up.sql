-- Two schemas, one boundary. Replaces the base-repository exception list:
-- a list drifts, a schema boundary is mechanical.
--
--   platform  control plane + immutable global reference data
--   app       tenant plane; every table here has tenant_id NOT NULL + RLS

CREATE SCHEMA platform AUTHORIZATION katkitchen_owner;
CREATE SCHEMA app AUTHORIZATION katkitchen_owner;

GRANT USAGE ON SCHEMA platform TO katkitchen_app;
GRANT USAGE ON SCHEMA app TO katkitchen_app;

-- katkitchen_platform_readonly deliberately gets no USAGE on app. There is no
-- cross-tenant reader of tenant data; tenant-side reporting runs as
-- katkitchen_app under RLS.
GRANT USAGE ON SCHEMA platform TO katkitchen_platform_readonly;

-- Default privileges only apply to objects created afterward, by this role.
-- That is why the audit partition job must also run as katkitchen_owner --
-- otherwise new partitions land with no grants applied at all.
ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO katkitchen_app;
ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO katkitchen_app;
ALTER DEFAULT PRIVILEGES FOR ROLE katkitchen_owner IN SCHEMA platform
  GRANT SELECT ON TABLES TO katkitchen_platform_readonly;

-- Defined once per schema rather than shared. A function in platform used by
-- app triggers would be a cross-schema dependency, and app must stay
-- relocatable to its own database.
CREATE FUNCTION platform.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
