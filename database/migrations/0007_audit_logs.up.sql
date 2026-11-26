-- Two audit tables, one per plane. A tenant-plane route cannot write to
-- platform_audit_log without breaching hard boundary #1, and the
-- via_impersonation tag is specified to live in "the tenant's own audit log".
--
-- Both are partitioned monthly from this first migration, while they are empty.
-- The audit row is written in the same transaction as the mutation, so in
-- Phase 3 every order becomes an audit write; converting a large table to
-- partitioned later is a maintenance window.

-- One per schema rather than shared: app must stay relocatable to its own
-- database, so it may not depend on a function in platform.
CREATE FUNCTION platform.deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not permitted on %.%',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;

CREATE FUNCTION app.deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not permitted on %.%',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;


-- The partition key must be in the primary key. That is a Postgres requirement,
-- not a preference: id alone stays unique in practice via UUIDv7, but the
-- database only guarantees the pair.
CREATE TABLE platform.platform_audit_log (
  id                     uuid        NOT NULL,
  occurred_at            timestamptz NOT NULL DEFAULT now(),

  -- NULL means a system or scheduled-job actor.
  actor_platform_user_id uuid        REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  -- Snapshots, so the row survives later anonymisation of the actor.
  actor_email            extensions.citext NOT NULL,
  actor_role_key         text        NOT NULL,

  action                 text        NOT NULL,
  target_type            text        NOT NULL,
  target_id              text,
  target_tenant_id       uuid        REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  before                 jsonb,
  after                  jsonb,
  -- Payloads are capped at 64KB per side application-side; a pathological
  -- payload degrades to a marked row instead of bloating the write path.
  payload_truncated      boolean     NOT NULL DEFAULT false,

  ip                     inet,
  user_agent             text,
  -- Correlates the row to the application logs for the same request.
  request_id             text        NOT NULL,

  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX platform_audit_log_by_tenant_idx
  ON platform.platform_audit_log (target_tenant_id, occurred_at DESC);
CREATE INDEX platform_audit_log_by_actor_idx
  ON platform.platform_audit_log (actor_platform_user_id, occurred_at DESC);
CREATE INDEX platform_audit_log_by_action_idx
  ON platform.platform_audit_log (action, occurred_at DESC);


CREATE TABLE app.tenant_audit_log (
  id                uuid        NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid,

  -- NULL means a system or scheduled-job actor.
  actor_user_id     uuid,
  -- Snapshot. Name rather than email is the NOT NULL one because app_user.email
  -- is nullable: a PIN-only waiter has no address to snapshot.
  actor_name        text        NOT NULL,
  actor_email       extensions.citext,

  action            text        NOT NULL,
  target_type       text        NOT NULL,
  target_id         text,

  before            jsonb,
  after             jsonb,
  payload_truncated boolean     NOT NULL DEFAULT false,

  ip                inet,
  user_agent        text,
  request_id        text        NOT NULL,

  -- Phase 1 adds impersonation_session and the FK to it. The flag itself is
  -- specified now: every write during impersonation is tagged in the tenant's
  -- own audit log.
  via_impersonation boolean     NOT NULL DEFAULT false,

  PRIMARY KEY (id, occurred_at),

  CONSTRAINT tenant_audit_log_branch_fk
  FOREIGN KEY (tenant_id, branch_id)
    REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT tenant_audit_log_actor_fk
  FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
) PARTITION BY RANGE (occurred_at);

CREATE INDEX tenant_audit_log_by_tenant_idx
  ON app.tenant_audit_log (tenant_id, occurred_at DESC);
CREATE INDEX tenant_audit_log_by_actor_idx
  ON app.tenant_audit_log (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX tenant_audit_log_by_action_idx
  ON app.tenant_audit_log (tenant_id, action, occurred_at DESC);


-- Append-only, enforced twice. Grants alone do not help if a fix-up is run
-- through the migration role; a trigger alone does not stop a TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE ON platform.platform_audit_log FROM katkitchen_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app.tenant_audit_log FROM katkitchen_app;

-- Row-level triggers on a partitioned parent propagate to every partition,
-- including ones created later (PG13+). This is why the trigger is the primary
-- guard for partitions and the grants are the braces.
CREATE TRIGGER platform_audit_log_append_only
  BEFORE UPDATE OR DELETE ON platform.platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();

CREATE TRIGGER tenant_audit_log_append_only
  BEFORE UPDATE OR DELETE ON app.tenant_audit_log
  FOR EACH ROW EXECUTE FUNCTION app.deny_mutation();

ALTER TABLE app.tenant_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_audit_log
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- Neither grants nor RLS propagate to new partitions.
--
-- ALTER DEFAULT PRIVILEGES only affects objects created afterward BY THAT ROLE,
-- so this job must run as katkitchen_owner or the revokes silently do not apply.
--
-- RLS is worse: enabling it on the parent governs access THROUGH the parent, but
-- a partition named directly enforces its own relrowsecurity and its own
-- policies, and a fresh partition has neither -- so monthly partitions would be
-- readable cross-tenant by anyone who names them. Both fixes are applied here,
-- in the same transaction as CREATE TABLE: policies on the partition, and
-- REVOKE ALL so direct access is impossible regardless of policy state.
CREATE FUNCTION platform.ensure_audit_partitions(months_ahead integer DEFAULT 3)
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

CREATE FUNCTION app.ensure_audit_partitions(months_ahead integer DEFAULT 3)
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


-- The DEFAULT partition is mandatory, not a nicety. An insert with no matching
-- partition raises; because the audit row shares the mutation's transaction,
-- a missing partition does not fail auditing -- it fails EVERY WRITE IN THE
-- PRODUCT. Monitoring asserts this partition stays empty; a non-empty default
-- is the alert that the partition job has stopped.
CREATE TABLE platform.platform_audit_log_default
  PARTITION OF platform.platform_audit_log DEFAULT;
REVOKE ALL ON platform.platform_audit_log_default
  FROM katkitchen_app, katkitchen_platform_readonly;

CREATE TABLE app.tenant_audit_log_default
  PARTITION OF app.tenant_audit_log DEFAULT;
REVOKE ALL ON app.tenant_audit_log_default
  FROM katkitchen_app, katkitchen_platform_readonly;
ALTER TABLE app.tenant_audit_log_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_audit_log_default
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

SELECT platform.ensure_audit_partitions(3);
SELECT app.ensure_audit_partitions(3);
