-- Bootstrap step 1 of 2. Run as a superuser, connected to any database.
--   psql -v ON_ERROR_STOP=1 -f database/bootstrap/00_roles.sql
--
-- Passwords here are placeholders for local development. In every other
-- environment these roles are created by the platform provisioner with secrets
-- from the secret store; this file documents the exact shape they must have.

\set ON_ERROR_STOP on

-- Three roles, never two. None of them may bypass RLS: BYPASSRLS on the
-- application role silently disables tenant isolation everywhere at once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'katkitchen_owner') THEN
    CREATE ROLE katkitchen_owner LOGIN PASSWORD 'change_me' NOBYPASSRLS NOSUPERUSER NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'katkitchen_app') THEN
    CREATE ROLE katkitchen_app LOGIN PASSWORD 'change_me' NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'katkitchen_platform_readonly') THEN
    CREATE ROLE katkitchen_platform_readonly LOGIN PASSWORD 'change_me' NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  END IF;
END $$;

-- Defensive: re-assert on an existing cluster where a role may have drifted.
ALTER ROLE katkitchen_owner NOBYPASSRLS NOSUPERUSER;
ALTER ROLE katkitchen_app NOBYPASSRLS NOSUPERUSER;
ALTER ROLE katkitchen_platform_readonly NOBYPASSRLS NOSUPERUSER;

SELECT 'CREATE DATABASE katkitchen OWNER katkitchen_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'katkitchen') \gexec

-- Rule 8. Also makes date_trunc('month', now()) in the partition job
-- independent of whatever timezone the calling session happens to carry.
ALTER DATABASE katkitchen SET timezone = 'UTC';
