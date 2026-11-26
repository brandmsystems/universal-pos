-- ############################################################################
-- ONE DEFINITION OF THE PARTITION DDL, ADDRESSABLE BY MONTH.
--
-- `ensure_audit_partitions(months_ahead)` loops from the CURRENT month forward,
-- so there was no way to create a partition for a month in the past. That had a
-- consequence nobody chose: a test fixture writing backdated audit rows -- which
-- the exception report's baseline-versus-period ranking requires -- had nowhere
-- to put them but the DEFAULT partition.
--
-- The default partition is monitored, and a non-empty one is the alert that the
-- partition job has stopped. Leaving fixtures to fill it permanently means that
-- alert can never be honestly exercised locally, and on the day it fires for
-- real someone dismisses it as the known noise. That is the same reasoning that
-- put a statement-mode PgBouncer in the local stack: a check whose failing
-- direction is never observed is a check nobody has shown to work.
--
-- So the per-month DDL is factored into its own function, taking the month as a
-- parameter, and the forward-window job becomes a loop over it. There is still
-- exactly ONE copy of the CREATE TABLE, the REVOKE and the RLS policy -- a
-- second copy in a test helper would be the "derived, or merely adjacent?"
-- failure, drifting from the migration the first time a grant changes.
-- ############################################################################

-- ---------------------------------------------------------------- platform ---
CREATE FUNCTION platform.ensure_audit_partition_for(when_ts timestamptz)
RETURNS boolean
LANGUAGE plpgsql AS $fn$
DECLARE
  start_ts timestamptz := date_trunc('month', when_ts);
  end_ts   timestamptz := date_trunc('month', when_ts) + interval '1 month';
  part     text        := 'platform_audit_log_' || to_char(date_trunc('month', when_ts), 'YYYY_MM');
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'platform' AND c.relname = part
  ) THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'CREATE TABLE platform.%I PARTITION OF platform.platform_audit_log '
    'FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
  -- Grants do not propagate to new partitions, and ALTER DEFAULT PRIVILEGES only
  -- affects objects created afterward BY THAT ROLE -- so this must run as
  -- katkitchen_owner or the revoke silently does not apply.
  EXECUTE format(
    'REVOKE ALL ON platform.%I FROM katkitchen_app, katkitchen_platform_readonly', part);

  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION platform.ensure_audit_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  m       integer;
  created integer := 0;
BEGIN
  FOR m IN 0..months_ahead LOOP
    IF platform.ensure_audit_partition_for(
         date_trunc('month', now()) + make_interval(months => m)) THEN
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;

-- --------------------------------------------------------------------- app ---
-- RLS does not propagate to a new partition either: enabling it on the parent
-- governs access THROUGH the parent, while a partition accessed directly
-- enforces its own relrowsecurity and its own policies. Both are created in the
-- same transaction as the CREATE TABLE.
CREATE FUNCTION app.ensure_audit_partition_for(when_ts timestamptz)
RETURNS boolean
LANGUAGE plpgsql AS $fn$
DECLARE
  start_ts timestamptz := date_trunc('month', when_ts);
  end_ts   timestamptz := date_trunc('month', when_ts) + interval '1 month';
  part     text        := 'tenant_audit_log_' || to_char(date_trunc('month', when_ts), 'YYYY_MM');
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = part
  ) THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.tenant_audit_log '
    'FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
  EXECUTE format(
    'REVOKE ALL ON app.%I FROM katkitchen_app, katkitchen_platform_readonly', part);
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', part);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON app.%I '
    'USING (tenant_id = app.current_tenant_id()) '
    'WITH CHECK (tenant_id = app.current_tenant_id())', part);

  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION app.ensure_audit_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  m       integer;
  created integer := 0;
BEGIN
  FOR m IN 0..months_ahead LOOP
    IF app.ensure_audit_partition_for(
         date_trunc('month', now()) + make_interval(months => m)) THEN
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;
