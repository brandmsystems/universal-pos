-- Tenant-plane staff invites. Deliberately NOT platform.tenant_owner_invite:
-- that table carries invited_by_platform_user_id and lives in the control plane,
-- so reusing it would put a control-plane writer inside tenant identity and add a
-- crossing the boundary rules do not permit.
--
-- The invite names the role AND the scope it will be granted at, because the
-- subset-grant rule has to be evaluated when the invite is ISSUED, not when it is
-- accepted -- by acceptance time the inviter may have lost the authority.
CREATE TABLE app.staff_invite (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  email                 extensions.citext NOT NULL,
  full_name             text        NOT NULL,

  role_id               uuid        NOT NULL,
  role_assignable_scope text        NOT NULL,
  branch_id             uuid,

  -- SHA-256 only. The raw token is shown once, to the inviter, and never stored.
  token_hash            bytea       NOT NULL UNIQUE,
  status                text        NOT NULL DEFAULT 'pending'
                        CONSTRAINT staff_invite_status_known
                        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at            timestamptz NOT NULL,

  accepted_at           timestamptz,
  accepted_user_id      uuid,

  invited_by_user_id    uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_invite_role_fk
  FOREIGN KEY (tenant_id, role_id, role_assignable_scope)
    REFERENCES app.role (tenant_id, id, assignable_scope)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT staff_invite_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT staff_invite_inviter_fk
  FOREIGN KEY (tenant_id, invited_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT staff_invite_accepted_user_fk
  FOREIGN KEY (tenant_id, accepted_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- The same scope agreement membership enforces, applied one step earlier: an
  -- invite that could not become a valid membership must not be issuable.
  CONSTRAINT staff_invite_scope_agrees
  CHECK (
       (role_assignable_scope = 'tenant_only' AND branch_id IS NULL)
    OR (role_assignable_scope = 'branch_only' AND branch_id IS NOT NULL)
    OR (role_assignable_scope = 'any')
  ),

  CONSTRAINT staff_invite_acceptance_consistent
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX staff_invite_one_pending_per_email
  ON app.staff_invite (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX staff_invite_by_role_idx ON app.staff_invite (tenant_id, role_id);

CREATE TRIGGER staff_invite_set_updated_at
  BEFORE UPDATE ON app.staff_invite
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.staff_invite ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.staff_invite
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
