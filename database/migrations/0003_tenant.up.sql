CREATE TABLE platform.tenant (
  id                          uuid        PRIMARY KEY,
  slug                        extensions.citext NOT NULL UNIQUE
                              CONSTRAINT tenant_slug_format
                              -- Cast to text explicitly: citext defines no regex
                              -- operator of its own, and this is what forces the
                              -- slug to be stored lowercase.
                              CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name                        text        NOT NULL,
  legal_name                  text,

  status                      text        NOT NULL DEFAULT 'active'
                              CONSTRAINT tenant_status_known
                              CHECK (status IN ('active', 'past_due', 'soft_lock',
                                                'hard_lock', 'retention',
                                                'purge_pending', 'purged')),
  status_changed_at           timestamptz NOT NULL DEFAULT now(),

  -- Day 0 of the suspension ladder. status_changed_at cannot supply it: once a
  -- tenant moves past_due -> soft_lock it becomes the soft_lock date and day 0
  -- is lost, but every threshold (7/15/45/135) is measured from day 0.
  -- Set on entry to past_due, cleared on return to active, never touched by
  -- intermediate transitions.
  delinquent_since            timestamptz,

  default_timezone            text        NOT NULL DEFAULT 'UTC',
  -- text, not char(3): char pads with spaces and compares surprisingly, for no
  -- performance gain.
  default_currency            text        NOT NULL
                              CONSTRAINT tenant_currency_format
                              CHECK (default_currency ~ '^[A-Z]{3}$'),
  default_locale              text        NOT NULL DEFAULT 'en',

  created_by_platform_user_id uuid        REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- A biconditional on purpose: it catches both directions. 'active' with a
  -- non-NULL delinquent_since is a stale day 0 that mis-dates the next
  -- delinquency; a ladder status with a NULL one has no computable threshold.
  -- Both operands are always proper booleans (status is NOT NULL, IS NULL never
  -- yields NULL), so this can never evaluate to NULL -- which a CHECK would
  -- silently treat as satisfied.
  CONSTRAINT tenant_delinquency_consistent
  CHECK ((status = 'active') = (delinquent_since IS NULL)),

  -- Guards a bug rather than a state. delinquent_since equals status_changed_at
  -- at entry and stays put while status_changed_at advances, so it can only be
  -- less-or-equal. Catches a reassignment on an intermediate transition on
  -- write, instead of silently re-basing day 0.
  CONSTRAINT tenant_delinquency_ordering
  CHECK (delinquent_since IS NULL OR delinquent_since <= status_changed_at)
);

CREATE INDEX tenant_status_idx ON platform.tenant (status);
CREATE INDEX tenant_delinquent_since_idx ON platform.tenant (delinquent_since)
  WHERE delinquent_since IS NOT NULL;

CREATE TRIGGER tenant_set_updated_at
  BEFORE UPDATE ON platform.tenant
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Control-plane owned: written by the platform provisioner, which has no tenant
-- context with which to set the RLS GUC. That is why it lives in platform
-- despite carrying a tenant_id -- the schema invariant is one-directional
-- (every app table has tenant_id), not a biconditional.
CREATE TABLE platform.tenant_owner_invite (
  id                          uuid        PRIMARY KEY,
  tenant_id                   uuid        NOT NULL
                              REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  email                       extensions.citext NOT NULL,

  -- SHA-256 of the token. The raw token is never stored, and there is no
  -- password column anywhere in this table: superadmin cannot set a tenant
  -- user's password, and the schema enforces that rather than a code review.
  token_hash                  bytea       NOT NULL UNIQUE,

  status                      text        NOT NULL DEFAULT 'pending'
                              CONSTRAINT tenant_owner_invite_status_known
                              CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at                  timestamptz NOT NULL,
  accepted_at                 timestamptz,

  -- Soft reference to app.app_user(id), validated in the repository. NOT an FK:
  -- platform -> app foreign keys are forbidden without exception, because one
  -- would make schema app impossible to relocate to its own database and so
  -- make hard boundary #1 unachievable.
  accepted_user_id            uuid,

  invited_by_platform_user_id uuid        NOT NULL
                              REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  sent_count                  integer     NOT NULL DEFAULT 1 CHECK (sent_count >= 1),
  last_sent_at                timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenant_owner_invite_acceptance_consistent
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_user_id IS NOT NULL))
);

-- Partial, so a revoked or expired invite never blocks re-inviting the address.
CREATE UNIQUE INDEX tenant_owner_invite_one_pending_per_email
  ON platform.tenant_owner_invite (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX tenant_owner_invite_tenant_idx
  ON platform.tenant_owner_invite (tenant_id);

CREATE TRIGGER tenant_owner_invite_set_updated_at
  BEFORE UPDATE ON platform.tenant_owner_invite
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
