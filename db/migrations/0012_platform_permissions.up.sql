-- The control-plane permission catalogue. Deliberately a separate table from
-- platform.permission, not a risk_class or a namespace on the same one: a join
-- that could accidentally hand a platform role a tenant key is a boundary
-- crossing, and the cheapest way to prevent it is for the two vocabularies to
-- have no shared storage.
CREATE TABLE platform.platform_permission (
  key         text        PRIMARY KEY
              CONSTRAINT platform_permission_key_format
              CHECK (key ~ '^platform\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module      text        NOT NULL,
  name        text        NOT NULL,
  description text,
  risk_class  text        NOT NULL DEFAULT 'none'
              CONSTRAINT platform_permission_risk_class_known
              CHECK (risk_class IN ('none', 'financial', 'escalation', 'privacy')),
  is_dangerous boolean    GENERATED ALWAYS AS (risk_class <> 'none') STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_permission_module_idx ON platform.platform_permission (module);

-- The key format CHECK is the enforcement: every control-plane key is prefixed
-- `platform.`, so a tenant key cannot be inserted here even by mistake.
CREATE TABLE platform.platform_role_permission (
  platform_role_id uuid        NOT NULL
                   REFERENCES platform.platform_role (id) ON DELETE CASCADE,
  permission_key   text        NOT NULL
                   REFERENCES platform.platform_permission (key) ON DELETE RESTRICT,
  granted_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (platform_role_id, permission_key)
);

CREATE INDEX platform_role_permission_by_key_idx
  ON platform.platform_role_permission (permission_key);
