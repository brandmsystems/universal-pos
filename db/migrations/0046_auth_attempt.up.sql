-- Credential events, per the decision in CLAUDE.md: their own table, and the
-- audit log is not extended.
--
-- ###########################################################################
-- WHY THIS IS IN `platform` AND NOT IN `app`.
--
-- An `app` table is tenant-isolated by RLS, and every one of them is asserted to
-- be. This table cannot be: a failed login has no established tenant, which is
-- the same fact that keeps it out of the audit log. The rows with the highest
-- security value are exactly the ones with no tenant to isolate them by --
-- an unknown email, an unenrolled device, a PIN tried against three branches.
--
-- A NOT NULL tenant_id would silently drop those rows. An RLS policy would
-- reject them at insert, because the pre-auth registrar holds a plain pool
-- connection with no `app.current_tenant_id()` set -- there is no tenant GUC at
-- login time, by definition.
--
-- The cost is named rather than hidden: a tenant owner cannot yet see failed
-- PIN attempts against their own devices, and that is an operationally real
-- question (shared PINs, someone walking the manager PIN space). The read path
-- is superadmin-only today. A tenant-visible view is deliberately deferred and
-- recorded as open in CLAUDE.md.
-- ###########################################################################
CREATE TABLE platform.auth_attempt (
  id                 uuid        PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),

  method             text        NOT NULL,
  outcome            text        NOT NULL,

  -- The rejection reason, verbatim from the PinRejection / EnrolmentFailure
  -- unions. Reported rather than a boolean, for the same reason quarantine
  -- reports which of five things happened: whoever resolves one needs to know.
  reason             text,

  -- CASCADE, not RESTRICT. Every other tenant FK restricts because the row is a
  -- record somebody is accountable for; this one is telemetry with a 30-day
  -- retention, and blocking `platform.tenant.purge` on it would make short-lived
  -- telemetry outlive the tenant it describes.
  tenant_id          uuid        REFERENCES platform.tenant (id) ON DELETE CASCADE,

  -- ###########################################################################
  -- THE SUBJECT AS CLAIMED, NEVER AS RESOLVED.
  --
  -- This is the string that was typed. It is not a foreign key and must not
  -- become one: the whole point is to record attempts against subjects that do
  -- not exist, and an FK would reject precisely those rows. Capped so a 1MB
  -- request body cannot become a 1MB telemetry row.
  -- ###########################################################################
  claimed_subject    text,

  -- Set only where a real user was resolved. NOT a foreign key, in either
  -- direction: `platform` may not depend on `app`, exactly as `app` may not
  -- depend on a function in `platform`. Relocatability is the constraint.
  resolved_user_id   uuid,
  branch_id          uuid,
  device_fingerprint text,

  ip                 inet,
  user_agent         text,
  request_id         text        NOT NULL,

  CONSTRAINT auth_attempt_method_known
  CHECK (method IN ('password', 'pin', 'refresh', 'device_enrol')),

  CONSTRAINT auth_attempt_outcome_known
  CHECK (outcome IN ('success', 'rejected')),

  -- Biconditional, both directions. A rejection with no reason is unactionable;
  -- a success carrying one is a contradiction that would make every "why did
  -- this fail" query wrong.
  CONSTRAINT auth_attempt_reason_iff_rejected
  CHECK ((outcome = 'rejected') = (reason IS NOT NULL)),

  -- A resolved user implies a resolved tenant. The reverse does not hold: a
  -- known tenant with a wrong PIN resolves no user.
  CONSTRAINT auth_attempt_resolved_user_implies_tenant
  CHECK (resolved_user_id IS NULL OR tenant_id IS NOT NULL),

  CONSTRAINT auth_attempt_claimed_subject_bounded
  CHECK (claimed_subject IS NULL OR length(claimed_subject) <= 320),
  CONSTRAINT auth_attempt_device_fingerprint_bounded
  CHECK (device_fingerprint IS NULL OR length(device_fingerprint) <= 200),
  CONSTRAINT auth_attempt_user_agent_bounded
  CHECK (user_agent IS NULL OR length(user_agent) <= 1000)
);

-- The three questions this table exists to answer, and nothing else.
CREATE INDEX auth_attempt_recent_idx
  ON platform.auth_attempt (occurred_at DESC);
CREATE INDEX auth_attempt_by_subject_idx
  ON platform.auth_attempt (claimed_subject, occurred_at DESC)
  WHERE outcome = 'rejected';
CREATE INDEX auth_attempt_by_device_idx
  ON platform.auth_attempt (device_fingerprint, occurred_at DESC)
  WHERE outcome = 'rejected';
CREATE INDEX auth_attempt_by_tenant_idx
  ON platform.auth_attempt (tenant_id, occurred_at DESC);

-- ###########################################################################
-- INSERT-ONLY FOR THE APP, BUT NOT APPEND-ONLY FOREVER.
--
-- No `deny_mutation` trigger here, and the difference from the audit log is the
-- point: that trigger fires for EVERY role, so it would block the retention
-- purge as surely as a tamper. The audit log is never purged, so it can afford
-- the trigger. Telemetry with a retention window cannot.
--
-- So the posture is grants: the app may INSERT and SELECT and nothing else, and
-- the purge runs as the owner. A fix-up run through the migration role is
-- possible here where it is not on the audit log -- accepted deliberately,
-- because the alternative is a table that cannot honour its own retention.
-- ###########################################################################
REVOKE ALL ON platform.auth_attempt FROM katkitchen_app;
GRANT INSERT, SELECT ON platform.auth_attempt TO katkitchen_app;
GRANT SELECT ON platform.auth_attempt TO katkitchen_platform_readonly;

-- Not partitioned, unlike the audit log, and the reason is the write path rather
-- than the volume: an audit row shares a transaction with every mutation in the
-- product, so converting it later would have been a maintenance window on the
-- busiest table in the schema. This table is written once per login and purged
-- at 30 days, so it never gets large enough for the conversion to hurt.
--
-- Retention is a fixed constant (AUTH_ATTEMPT_RETENTION_DAYS in
-- src/auth/authAttempt.ts) rather than tenant policy: it is a platform-wide
-- security-telemetry window and there is no tenant-visible read path to tune it
-- against yet. Revisit with the tenant-visible view.
CREATE FUNCTION platform.purge_auth_attempts(retain_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  removed integer;
BEGIN
  DELETE FROM platform.auth_attempt
   WHERE occurred_at < now() - make_interval(days => retain_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;
