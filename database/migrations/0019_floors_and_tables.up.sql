CREATE TABLE app.floor (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id     uuid        NOT NULL,
  name          text        NOT NULL,
  display_order integer     NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT floor_status_known CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT floor_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT floor_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT floor_name_unique_per_branch UNIQUE (tenant_id, branch_id, name)
);

CREATE INDEX floor_by_branch_idx ON app.floor (tenant_id, branch_id, display_order);

CREATE TRIGGER floor_set_updated_at
  BEFORE UPDATE ON app.floor
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Tenant-defined reference data, not an enum. AC, non-AC, VIP, rooftop, cabana,
-- counter -- tenants invent categories nobody shipping the product thought of,
-- and a CHECK list would need a migration every time.
CREATE TABLE app.table_type (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT table_type_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT table_type_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT table_type_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT table_type_key_unique_per_tenant UNIQUE (tenant_id, key)
);

CREATE TRIGGER table_type_set_updated_at
  BEFORE UPDATE ON app.table_type
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- `table` is a reserved word; `dining_table` avoids quoting it everywhere and
-- avoids the class of bug where an unqualified `table` resolves to something else.
CREATE TABLE app.dining_table (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id     uuid        NOT NULL,
  floor_id      uuid        NOT NULL,
  table_type_id uuid,

  -- What the staff call it. Uniqueness is PER FLOOR, not per branch: a ground
  -- floor and a rooftop legitimately both have a table "1", and forcing
  -- branch-wide uniqueness makes staff rename tables to satisfy the database.
  identifier    text        NOT NULL,
  seats         smallint    NOT NULL CHECK (seats > 0),

  -- Archived, never deleted: a table that has appeared on a historical order
  -- must remain resolvable. Same pin as membership.
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT dining_table_status_known
                CHECK (status IN ('active', 'archived')),
  archived_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dining_table_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT dining_table_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT dining_table_floor_fk
  FOREIGN KEY (tenant_id, floor_id) REFERENCES app.floor (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT dining_table_type_fk
  FOREIGN KEY (tenant_id, table_type_id) REFERENCES app.table_type (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT dining_table_archival_consistent
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX dining_table_identifier_per_floor
  ON app.dining_table (tenant_id, floor_id, identifier);

CREATE INDEX dining_table_by_branch_idx
  ON app.dining_table (tenant_id, branch_id, status);

CREATE TRIGGER dining_table_set_updated_at
  BEFORE UPDATE ON app.dining_table
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.floor ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.floor
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.table_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.table_type
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.dining_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.dining_table
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
