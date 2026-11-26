-- Tenant-plane identity. Every table here carries tenant_id NOT NULL; RLS
-- policies arrive in 0006.
--
-- The recurring UNIQUE (tenant_id, id) constraints look redundant against the
-- primary key. They are the FK targets that make a cross-tenant child row
-- structurally impossible rather than merely guarded: a membership pointing at
-- tenant A's user and tenant B's role is rejected by the database, with no
-- application code involved.

CREATE TABLE app.branch (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  code       text        NOT NULL,
  name       text        NOT NULL,
  -- IANA zone, copied from the tenant default at insert. Rule 8: stored UTC,
  -- branch timezone applied at presentation only.
  timezone   text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT branch_status_known CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT branch_code_unique_per_tenant UNIQUE (tenant_id, code),
  CONSTRAINT branch_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX branch_tenant_status_idx ON app.branch (tenant_id, status);

CREATE TRIGGER branch_set_updated_at
  BEFORE UPDATE ON app.branch
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Named app_user, not user: unqualified `user` in Postgres silently resolves to
-- the session user, which is not a bug you want in the identity table.
--
-- Holds no secret of any kind -- see app.credential.
CREATE TABLE app.app_user (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  -- Nullable: a waiter who only ever taps a PIN has no email address, and
  -- forcing a fake one to satisfy NOT NULL is how waiter3@nowhere.local ends up
  -- in production. Postgres treats NULLs as distinct, so any number of
  -- email-less staff coexist under the unique constraint below.
  email             extensions.citext,
  phone             text,
  full_name         text        NOT NULL,
  -- The alternative human identifier for staff with no email.
  employee_code     text,

  status            text        NOT NULL DEFAULT 'invited'
                    CONSTRAINT app_user_status_known
                    CHECK (status IN ('invited', 'active', 'suspended', 'disabled')),
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_user_email_unique_per_tenant UNIQUE (tenant_id, email),
  CONSTRAINT app_user_employee_code_unique_per_tenant UNIQUE (tenant_id, employee_code),
  CONSTRAINT app_user_tenant_id_key UNIQUE (tenant_id, id),

  CONSTRAINT app_user_has_an_identifier
  CHECK (email IS NOT NULL OR employee_code IS NOT NULL)
);

CREATE INDEX app_user_tenant_status_idx ON app.app_user (tenant_id, status);

CREATE TRIGGER app_user_set_updated_at
  BEFORE UPDATE ON app.app_user
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Authentication: who you are. Tenant-scoped, deliberately NOT branch-scoped --
-- authorization is membership's job, and revoking a waiter at one location
-- revokes a membership, not a credential.
--
-- PIN login is identified: staff tap name/photo, then enter the PIN, so the PIN
-- disambiguates one already-known user rather than acting as a lookup key.
-- That is why there is no deterministic lookup column, no HMAC and no pepper:
-- anonymous PIN-only login would need database-enforced uniqueness over a
-- salted hash, which requires an application-held pepper whose custody is a
-- permanent liability. Verification is one argon2id check against one known row.
--
-- sso is deliberately absent from the type set. Real SSO needs per-tenant IdP
-- config, domain verification and JIT provisioning rules; two nullable columns
-- without those is the half of the design someone builds against. Adding a
-- CHECK value later is a one-line reversible migration.
CREATE TABLE app.credential (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  user_id              uuid        NOT NULL,

  type                 text        NOT NULL
                       CONSTRAINT credential_type_known CHECK (type IN ('password', 'pin')),
  secret_hash          text        NOT NULL,

  status               text        NOT NULL DEFAULT 'active'
                       CONSTRAINT credential_status_known
                       CHECK (status IN ('active', 'revoked', 'expired')),

  -- Lockout lives here, not on app_user. A user-level counter means five bad PIN
  -- guesses at a terminal lock the manager out of the web admin, and lets anyone
  -- at a shared POS lock out a colleague one at a time.
  -- Policy: short, exponential, never indefinite (60s doubling, capped) plus a
  -- manager override -- an indefinite PIN lock mid-service is an outage.
  failed_attempt_count integer     NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
  locked_until         timestamptz,

  last_used_at         timestamptz,
  expires_at           timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credential_user_fk
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT credential_revocation_consistent
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- Partial on status = 'active' so revoked rows are retained for reuse policy
-- without blocking reissue.
CREATE UNIQUE INDEX credential_one_active_password_per_user
  ON app.credential (tenant_id, user_id)
  WHERE type = 'password' AND status = 'active';

CREATE UNIQUE INDEX credential_one_active_pin_per_user
  ON app.credential (tenant_id, user_id)
  WHERE type = 'pin' AND status = 'active';

CREATE INDEX credential_tenant_user_idx ON app.credential (tenant_id, user_id);

CREATE TRIGGER credential_set_updated_at
  BEFORE UPDATE ON app.credential
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE app.role (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key                     text        NOT NULL
                          CONSTRAINT role_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name                    text        NOT NULL,
  description             text,
  is_system               boolean     NOT NULL DEFAULT false,

  assignable_scope        text        NOT NULL DEFAULT 'any'
                          CONSTRAINT role_assignable_scope_known
                          CHECK (assignable_scope IN ('tenant_only', 'branch_only', 'any')),

  -- System roles are locked; customisation is clone-then-edit. Recorded so
  -- support can reason about drift, and so a newly added permission key can be
  -- offered to the custom roles that descend from the role it belongs to.
  cloned_from_role_id     uuid,
  -- Backs the dismissible "N permissions added since this role was created".
  permissions_reviewed_at timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT role_key_unique_per_tenant UNIQUE (tenant_id, key),
  CONSTRAINT role_tenant_id_key UNIQUE (tenant_id, id),

  -- FK target for membership. Redundant as a constraint (implied by the one
  -- above) but Postgres requires an FK target with a unique constraint on
  -- exactly the referenced columns, so it cannot be stood in for.
  CONSTRAINT role_tenant_id_scope_key UNIQUE (tenant_id, id, assignable_scope),

  -- SET NULL with a column list (PG15+): without it, ON DELETE SET NULL would
  -- try to null tenant_id too, which is NOT NULL.
  CONSTRAINT role_cloned_from_fk
  FOREIGN KEY (tenant_id, cloned_from_role_id)
    REFERENCES app.role (tenant_id, id) ON DELETE SET NULL (cloned_from_role_id),

  CONSTRAINT role_system_is_not_a_clone
  CHECK (is_system = false OR cloned_from_role_id IS NULL)
);

CREATE INDEX role_tenant_system_idx ON app.role (tenant_id, is_system);
CREATE INDEX role_cloned_from_idx ON app.role (tenant_id, cloned_from_role_id)
  WHERE cloned_from_role_id IS NOT NULL;

CREATE TRIGGER role_set_updated_at
  BEFORE UPDATE ON app.role
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE app.role_permission (
  tenant_id          uuid        NOT NULL,
  role_id            uuid        NOT NULL,
  permission_key     text        NOT NULL
                     REFERENCES platform.permission (key) ON DELETE RESTRICT,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  -- NULL for seeded system-role grants, which have no granting user.
  granted_by_user_id uuid,

  PRIMARY KEY (tenant_id, role_id, permission_key),

  CONSTRAINT role_permission_role_fk
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES app.role (tenant_id, id) ON DELETE CASCADE,

  CONSTRAINT role_permission_granted_by_fk
  FOREIGN KEY (tenant_id, granted_by_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX role_permission_by_key_idx ON app.role_permission (tenant_id, permission_key);


-- Authorization: where you may act. The same user can be Manager at Branch A
-- and Cashier at Branch B -- two rows. Effective permissions are the union of
-- all active memberships in scope.
CREATE TABLE app.membership (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL,
  user_id               uuid        NOT NULL,
  -- NULL means tenant-wide scope.
  branch_id             uuid,
  role_id               uuid        NOT NULL,

  -- Denormalised from role and pinned by the composite FK below. A CHECK cannot
  -- reference another table, so without this copy nothing stops
  -- membership(role_id = owner, branch_id = <uuid>).
  role_assignable_scope text        NOT NULL,

  status                text        NOT NULL DEFAULT 'active'
                        CONSTRAINT membership_status_known
                        CHECK (status IN ('active', 'revoked')),
  granted_by_user_id    uuid,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT membership_user_fk
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT membership_branch_fk
  FOREIGN KEY (tenant_id, branch_id)
    REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,

  -- ON UPDATE CASCADE is doing real work: narrowing a custom role from 'any' to
  -- 'tenant_only' cascades the new value into every membership row, each then
  -- re-checked against membership_scope_agrees. If any branch-scoped membership
  -- contradicts the narrowing, the role UPDATE itself aborts -- transactionally,
  -- with no trigger and no application check.
  CONSTRAINT membership_role_fk
  FOREIGN KEY (tenant_id, role_id, role_assignable_scope)
    REFERENCES app.role (tenant_id, id, assignable_scope)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT membership_granted_by_fk
  FOREIGN KEY (tenant_id, granted_by_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT membership_scope_agrees
  CHECK (
       (role_assignable_scope = 'tenant_only' AND branch_id IS NULL)
    OR (role_assignable_scope = 'branch_only' AND branch_id IS NOT NULL)
    OR (role_assignable_scope = 'any')
  ),

  CONSTRAINT membership_revocation_consistent
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- NULLS NOT DISTINCT (PG15+): without it, SQL treats NULLs as distinct and the
-- same tenant-wide grant could be inserted unlimited times.
-- Partial on status = 'active': revoked rows are retained, and a retained row
-- must never permanently block re-granting that exact combination.
CREATE UNIQUE INDEX membership_unique_active_grant
  ON app.membership (tenant_id, user_id, branch_id, role_id)
  NULLS NOT DISTINCT
  WHERE status = 'active';

CREATE INDEX membership_active_by_user_idx
  ON app.membership (tenant_id, user_id)
  WHERE status = 'active';
CREATE INDEX membership_by_branch_idx ON app.membership (tenant_id, branch_id);
CREATE INDEX membership_by_role_idx ON app.membership (tenant_id, role_id);

CREATE TRIGGER membership_set_updated_at
  BEFORE UPDATE ON app.membership
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
