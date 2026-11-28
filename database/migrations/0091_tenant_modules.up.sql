-- Which modules a tenant has switched on (Phase 1 of the multi-business product).
--
-- The registry (shared businessTypes.ts) is the definition of what a module IS and
-- which ones a business type starts with; this table is what THIS tenant has. It is
-- control-plane configuration: the tenant plane never reads it, it reads the
-- entitlement document, which now carries the enabled modules beside the plan's
-- features. Whether a key is a known module is the registry's to say and is checked
-- in code; a table copy of the list would only agree until someone added a type.
CREATE TABLE platform.tenant_module (
  tenant_id   uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  module_key  text        NOT NULL CONSTRAINT tenant_module_key_shape CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled     boolean     NOT NULL DEFAULT true,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);

ALTER TABLE platform.entitlement_document
  ADD COLUMN modules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Every tenant before this migration is a restaurant (0089 defaulted it), so it
-- keeps exactly what a restaurant had: the six modules below. Nothing is switched off.
INSERT INTO platform.tenant_module (tenant_id, module_key)
SELECT t.id, m.key
  FROM platform.tenant t
 CROSS JOIN (VALUES ('pos'), ('menu'), ('tables'), ('kitchen'), ('kot'), ('printing')) AS m(key)
 WHERE t.business_type = 'restaurant';

-- The documents already published and cached carry the same six, so a deploy does not
-- refuse an existing restaurant until its next publish.
UPDATE platform.entitlement_document d
   SET modules = '{"pos":true,"menu":true,"tables":true,"kitchen":true,"kot":true,"printing":true}'::jsonb
  FROM platform.tenant t
 WHERE t.id = d.tenant_id AND t.business_type = 'restaurant';
