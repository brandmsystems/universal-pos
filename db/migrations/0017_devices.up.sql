-- A terminal is branch-scoped equipment. This is where the branch_id that was
-- removed from `credential` belongs: authentication is tenant-scoped (who you
-- are), the machine you authenticate FROM is branch-scoped.

CREATE TABLE app.device (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  -- NOT NULL: a device that belongs to no branch is a device nobody is
  -- responsible for.
  branch_id             uuid        NOT NULL,

  name                  text        NOT NULL,
  -- Client-generated, stable across restarts, matched at authentication. Not a
  -- secret: it identifies the machine, it does not authorise it.
  fingerprint           text        NOT NULL,

  status                text        NOT NULL DEFAULT 'active'
                        CONSTRAINT device_status_known
                        CHECK (status IN ('active', 'revoked')),

  registered_by_user_id uuid        NOT NULL,
  registered_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz,
  revoked_at            timestamptz,
  revoked_by_user_id    uuid,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_tenant_id_key UNIQUE (tenant_id, id),

  CONSTRAINT device_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT device_registered_by_fk
  FOREIGN KEY (tenant_id, registered_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT device_revoked_by_fk
  FOREIGN KEY (tenant_id, revoked_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT device_revocation_consistent
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)
         AND (revoked_at IS NOT NULL) = (revoked_by_user_id IS NOT NULL))
);

-- Partial, so a revoked device does not permanently burn its fingerprint.
CREATE UNIQUE INDEX device_active_fingerprint_per_tenant
  ON app.device (tenant_id, fingerprint)
  WHERE status = 'active';

CREATE INDEX device_by_branch_idx ON app.device (tenant_id, branch_id, status);

CREATE TRIGGER device_set_updated_at
  BEFORE UPDATE ON app.device
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Registration is an explicit act by a staff member holding device.register, not
-- self-service: a terminal that can enrol itself is a terminal an attacker can
-- enrol. The enrolment token is short-lived and single use, and only its hash is
-- stored -- same discipline as the invite tokens.
CREATE TABLE app.device_enrolment (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id          uuid        NOT NULL,

  token_hash         bytea       NOT NULL UNIQUE,
  status             text        NOT NULL DEFAULT 'pending'
                     CONSTRAINT device_enrolment_status_known
                     CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  expires_at         timestamptz NOT NULL,

  consumed_at        timestamptz,
  consumed_device_id uuid,

  issued_by_user_id  uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_enrolment_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT device_enrolment_issuer_fk
  FOREIGN KEY (tenant_id, issued_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT device_enrolment_device_fk
  FOREIGN KEY (tenant_id, consumed_device_id) REFERENCES app.device (tenant_id, id) ON DELETE RESTRICT,

  -- Single use, enforced rather than intended.
  CONSTRAINT device_enrolment_consumption_consistent
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL AND consumed_device_id IS NOT NULL))
);

CREATE INDEX device_enrolment_pending_idx
  ON app.device_enrolment (tenant_id, expires_at)
  WHERE status = 'pending';

CREATE TRIGGER device_enrolment_set_updated_at
  BEFORE UPDATE ON app.device_enrolment
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.device ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.device
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.device_enrolment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.device_enrolment
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
