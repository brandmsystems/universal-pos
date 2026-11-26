-- Control-plane identity. A platform_user is never a row in app.app_user:
-- no shared identity table, no is_superadmin boolean, no exceptions.

-- Fixed set, seeded, not user-creatable. Platform permission keys are Phase 1 --
-- nothing in the spec says what sales may do that support may not, and guessing
-- would be worse than waiting for the routes to exist.
CREATE TABLE platform.platform_role (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE
              CONSTRAINT platform_role_key_known
              CHECK (key IN ('super_admin', 'sales', 'support', 'billing', 'read_only')),
  name        text        NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- No updated_at: immutable seed data, so there is nothing to maintain.

CREATE TABLE platform.platform_user (
  id                          uuid        PRIMARY KEY,
  email                       extensions.citext NOT NULL UNIQUE,
  password_hash               text        NOT NULL,
  full_name                   text        NOT NULL,
  platform_role_id            uuid        NOT NULL
                              REFERENCES platform.platform_role (id) ON DELETE RESTRICT,
  status                      text        NOT NULL DEFAULT 'active'
                              CONSTRAINT platform_user_status_known
                              CHECK (status IN ('active', 'suspended', 'disabled')),
  last_login_at               timestamptz,
  failed_login_count          integer     NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until                timestamptz,
  password_changed_at         timestamptz NOT NULL DEFAULT now(),
  -- NULL only for the bootstrap superadmin, who has no creator.
  created_by_platform_user_id uuid        REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_user_role_idx ON platform.platform_user (platform_role_id);

CREATE TRIGGER platform_user_set_updated_at
  BEFORE UPDATE ON platform.platform_user
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
