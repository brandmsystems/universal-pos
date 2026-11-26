-- Bootstrap step 2 of 2. Run as a superuser, connected to the database it sets up.
--   psql -v ON_ERROR_STOP=1 -d katkitchen -f database/bootstrap/01_database.sql
--
-- The database is named by current_database(), not spelled out, so the same
-- file sets up the test database (database/bootstrap/test_database.sh) exactly as it
-- sets up katkitchen. A copy for the test database would drift the first time
-- a grant changed here.
--
-- Everything from here on is owned by katkitchen_owner. Migrations run as that
-- role and must never need a superuser again.

\set ON_ERROR_STOP on

DO $$ BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO katkitchen_owner, katkitchen_app, katkitchen_platform_readonly',
    current_database());
END $$;

-- public is left in place (some tooling assumes it resolves) but stripped of
-- privileges, so nothing can be created there and no unqualified name can
-- accidentally resolve to something a user planted.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO katkitchen_owner;

-- citext lives here rather than in public, so revoking public above does not
-- take the type with it.
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION katkitchen_owner;
GRANT USAGE ON SCHEMA extensions TO katkitchen_app, katkitchen_platform_readonly;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;

-- search_path is set explicitly per role. Nothing relies on public being
-- present or usable, and the readonly role cannot even name schema app.
DO $$ BEGIN
  EXECUTE format('ALTER ROLE katkitchen_owner             IN DATABASE %I SET search_path = app, platform, extensions', current_database());
  EXECUTE format('ALTER ROLE katkitchen_app               IN DATABASE %I SET search_path = app, platform, extensions', current_database());
  EXECUTE format('ALTER ROLE katkitchen_platform_readonly IN DATABASE %I SET search_path = platform, extensions', current_database());
END $$;
