-- Restores the monolithic forward-only functions exactly as 0007 defined them,
-- then drops the per-month ones. Partitions already created are left in place:
-- dropping them would drop audit rows, and audit rows are append-only.

CREATE OR REPLACE FUNCTION platform.ensure_audit_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  m         integer;
  start_ts  timestamptz;
  end_ts    timestamptz;
  part      text;
  created   integer := 0;
BEGIN
  FOR m IN 0..months_ahead LOOP
    start_ts := date_trunc('month', now()) + make_interval(months => m);
    end_ts   := start_ts + interval '1 month';
    part     := 'platform_audit_log_' || to_char(start_ts, 'YYYY_MM');

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'platform' AND c.relname = part
    );

    EXECUTE format(
      'CREATE TABLE platform.%I PARTITION OF platform.platform_audit_log '
      'FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
    EXECUTE format(
      'REVOKE ALL ON platform.%I FROM katkitchen_app, katkitchen_platform_readonly', part);

    created := created + 1;
  END LOOP;

  RETURN created;
END
$fn$;

CREATE OR REPLACE FUNCTION app.ensure_audit_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  m         integer;
  start_ts  timestamptz;
  end_ts    timestamptz;
  part      text;
  created   integer := 0;
BEGIN
  FOR m IN 0..months_ahead LOOP
    start_ts := date_trunc('month', now()) + make_interval(months => m);
    end_ts   := start_ts + interval '1 month';
    part     := 'tenant_audit_log_' || to_char(start_ts, 'YYYY_MM');

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = part
    );

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

    created := created + 1;
  END LOOP;

  RETURN created;
END
$fn$;

DROP FUNCTION IF EXISTS app.ensure_audit_partition_for(timestamptz);
DROP FUNCTION IF EXISTS platform.ensure_audit_partition_for(timestamptz);
