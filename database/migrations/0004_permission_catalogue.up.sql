-- The permission catalogue is global, code-owned reference data with no
-- tenant_id, which is exactly why it lives in platform rather than app. Per-
-- tenant copies would let a tenant invent a key that no route ever checks.
--
-- Keys are seeded from the typed constant in a later migration, idempotently,
-- on every deploy. created_at is set when a key is FIRST inserted into this
-- database, which is what makes "N permissions added since this role was
-- created" (permission.created_at > role.created_at) exact on an existing
-- install and correctly empty on a fresh one.
CREATE TABLE platform.permission (
  key          text        PRIMARY KEY
               CONSTRAINT permission_key_format
               CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module       text        NOT NULL,
  name         text        NOT NULL,
  description  text,
  is_dangerous boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX permission_module_idx ON platform.permission (module);
CREATE INDEX permission_created_at_idx ON platform.permission (created_at);
