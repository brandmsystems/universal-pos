-- ###########################################################################
-- A RESET ISSUES A ONE-TIME LINK; THE STAFF MEMBER CHOOSES THE NEW SECRET.
--
-- `resetCredential` revokes and stops there, deliberately: an admin must never
-- choose, learn or be told a working PIN (modules/users/credentialReset.ts).
-- This is the missing second half. Not app.staff_invite, which creates a person
-- and a membership; a reset touches neither.
-- ###########################################################################
CREATE TABLE app.credential_setup (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  user_id            uuid        NOT NULL,
  credential_type    text        NOT NULL
                     CONSTRAINT credential_setup_type_known CHECK (credential_type IN ('password', 'pin')),
  token_hash         bytea       NOT NULL UNIQUE,
  status             text        NOT NULL DEFAULT 'pending'
                     CONSTRAINT credential_setup_status_known CHECK (status IN ('pending', 'used', 'revoked')),
  expires_at         timestamptz NOT NULL,
  issued_by_user_id  uuid        NOT NULL,
  used_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_setup_use_consistent CHECK ((status = 'used') = (used_at IS NOT NULL)),
  CONSTRAINT credential_setup_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credential_setup_issuer_fk
    FOREIGN KEY (tenant_id, issued_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

-- One live link per person per credential type: issuing a new one revokes the old.
CREATE UNIQUE INDEX credential_setup_one_pending
  ON app.credential_setup (tenant_id, user_id, credential_type) WHERE status = 'pending';

ALTER TABLE app.credential_setup ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credential_setup
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
