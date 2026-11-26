-- Impersonation: the one sanctioned crossing of the plane boundary.

CREATE TABLE platform.impersonation_session (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  platform_user_id    uuid        NOT NULL REFERENCES platform.platform_user (id) ON DELETE RESTRICT,

  -- Typed, not free text: a reason nobody can aggregate is a reason nobody reads.
  reason_code         text        NOT NULL
                      CONSTRAINT impersonation_reason_known
                      CHECK (reason_code IN ('support_ticket', 'incident', 'data_correction',
                                             'onboarding_assist', 'compliance_request')),
  reason_detail       text        NOT NULL
                      CONSTRAINT impersonation_reason_detail_substantive
                      CHECK (length(btrim(reason_detail)) >= 10),

  -- Read-only by default. Write is a separate flag with its own reason.
  write_enabled       boolean     NOT NULL DEFAULT false,
  write_reason_code   text,
  write_reason_detail text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,

  revoked_at          timestamptz,
  revoked_by_platform_user_id uuid REFERENCES platform.platform_user (id) ON DELETE RESTRICT,

  ip                  inet,
  user_agent          text,

  -- The 60-minute cap lives HERE, not on the token. `exp <= iat + 3600` caps a
  -- token; reissue for eight hours and the cap is decorative. The session row is
  -- the thing that cannot be extended.
  CONSTRAINT impersonation_max_60_minutes
  CHECK (expires_at <= created_at + interval '60 minutes'),
  CONSTRAINT impersonation_expiry_after_start CHECK (expires_at > created_at),

  CONSTRAINT impersonation_write_needs_its_own_reason
  CHECK (write_enabled = false
         OR (write_reason_code IS NOT NULL AND length(btrim(write_reason_detail)) >= 10)),

  CONSTRAINT impersonation_revocation_consistent
  CHECK ((revoked_at IS NOT NULL) = (revoked_by_platform_user_id IS NOT NULL))
);

CREATE INDEX impersonation_session_live_idx
  ON platform.impersonation_session (tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX impersonation_session_by_actor_idx
  ON platform.impersonation_session (platform_user_id, created_at DESC);

-- Append-only, with exactly one permitted transition: the one-way revocation
-- stamp. Nothing else about a session may ever change -- not the reason, not the
-- expiry, not the write flag -- so a session cannot be quietly widened after the
-- fact. CLAUDE.md's blanket "append-only" is refined to this precise rule.
CREATE FUNCTION platform.deny_impersonation_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'impersonation sessions are append-only: DELETE is not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'impersonation session % is already revoked', OLD.id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'the only permitted update to an impersonation session is revocation'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.platform_user_id, NEW.reason_code, NEW.reason_detail,
      NEW.write_enabled, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.platform_user_id, OLD.reason_code, OLD.reason_detail,
      OLD.write_enabled, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'revocation may not alter any other field of an impersonation session'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER impersonation_session_append_only
  BEFORE UPDATE OR DELETE ON platform.impersonation_session
  FOR EACH ROW EXECUTE FUNCTION platform.deny_impersonation_rewrite();


-- Attribution becomes a three-way switch on an EXPLICIT discriminator.
--
-- Keying on nullness would make absence the discriminator, and absence is never a
-- good one -- the same reasoning that made `audit: 'none'` beat a missing field,
-- and a NULL ACL on schema public a failure rather than an absence of grants.
--
-- 'system' is a positive declaration and must name the job: "the system did it"
-- is as useless as unattributed.
ALTER TABLE app.tenant_audit_log
  ADD COLUMN actor_kind text,
  -- Soft reference to platform.impersonation_session(id), validated in the
  -- repository. NOT an FK: schema app must stay separable into its own database,
  -- and impersonation_session is mutable operational control-plane state on the
  -- hottest path in the product -- neither the tenant root nor immutable seeded
  -- reference data.
  ADD COLUMN impersonation_session_id uuid,
  ADD COLUMN actor_system_job text;

-- The append-only trigger denies UPDATE to everyone, owner included, so the
-- backfill has to disable it for the duration. Same move as the move-then-attach
-- partition runbook.
ALTER TABLE app.tenant_audit_log DISABLE TRIGGER tenant_audit_log_append_only;

UPDATE app.tenant_audit_log
   SET actor_kind = 'user'
 WHERE authorising_membership_id IS NOT NULL;

-- Rows written before attribution was total. Named rather than left null: the
-- backfill itself is the job that produced them.
UPDATE app.tenant_audit_log
   SET actor_kind = 'system', actor_system_job = 'pre_attribution_backfill'
 WHERE actor_kind IS NULL;

ALTER TABLE app.tenant_audit_log ENABLE TRIGGER tenant_audit_log_append_only;

ALTER TABLE app.tenant_audit_log ALTER COLUMN actor_kind SET NOT NULL;

ALTER TABLE app.tenant_audit_log
  ADD CONSTRAINT tenant_audit_log_actor_kind_known
  CHECK (actor_kind IN ('user', 'impersonation', 'system'));

ALTER TABLE app.tenant_audit_log
  ADD CONSTRAINT tenant_audit_log_attribution_exact
  CHECK (
    CASE actor_kind
      WHEN 'user' THEN
        authorising_membership_id IS NOT NULL
        AND impersonation_session_id IS NULL
        AND actor_system_job IS NULL
      WHEN 'impersonation' THEN
        impersonation_session_id IS NOT NULL
        AND authorising_membership_id IS NULL
        AND actor_system_job IS NULL
      WHEN 'system' THEN
        actor_system_job IS NOT NULL
        AND authorising_membership_id IS NULL
        AND impersonation_session_id IS NULL
      ELSE false
    END
  );

CREATE INDEX tenant_audit_log_by_impersonation_idx
  ON app.tenant_audit_log (tenant_id, impersonation_session_id, occurred_at DESC)
  WHERE impersonation_session_id IS NOT NULL;

COMMENT ON COLUMN app.tenant_audit_log.actor_kind IS
  'Explicit attribution discriminator. Exactly one of authorising_membership_id, impersonation_session_id or actor_system_job is populated, selected by this column rather than inferred from nullness.';
