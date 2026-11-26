-- ###########################################################################
-- THE MANAGER'S SETUP FLOW: FLOOR TYPES, KITCHEN TYPES, ITEM BARCODE AND
-- PREPARATION TIME.
--
-- Floors, tables, stations, printers, categories, items and add-ons already
-- exist; what they lacked was a way for a manager to create them. This adds
-- the few columns the setup screens need and closes one hole found on the way.
-- ###########################################################################

-- A floor's type: AC, Non AC, VIP, Rooftop. Restaurant reference data like
-- table_type, and like it the list is the restaurant's own to extend.
CREATE TABLE app.floor_type (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key         text        NOT NULL
              CONSTRAINT floor_type_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text        NOT NULL
              CONSTRAINT floor_type_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  status      text        NOT NULL DEFAULT 'active'
              CONSTRAINT floor_type_status_known CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT floor_type_tenant_id_key UNIQUE (tenant_id, id)
);

-- Rule 11: an archived type must not block re-creating one with the same key.
CREATE UNIQUE INDEX floor_type_key_unique_active
  ON app.floor_type (tenant_id, key) WHERE status = 'active';

CREATE TRIGGER floor_type_set_updated_at
  BEFORE UPDATE ON app.floor_type
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.floor_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.floor_type
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- The four every restaurant starts with; provisioning seeds the same set.
INSERT INTO app.floor_type (id, tenant_id, key, name)
SELECT gen_random_uuid(), t.id, v.key, v.name
  FROM platform.tenant t
 CROSS JOIN (VALUES ('ac', 'AC'), ('non_ac', 'Non AC'), ('vip', 'VIP'), ('rooftop', 'Rooftop')) AS v (key, name);

ALTER TABLE app.floor ADD COLUMN floor_type_id uuid;
ALTER TABLE app.floor ADD CONSTRAINT floor_type_fk
  FOREIGN KEY (tenant_id, floor_type_id) REFERENCES app.floor_type (tenant_id, id) ON DELETE RESTRICT;

-- ###########################################################################
-- A TABLE'S FLOOR IS AT THE TABLE'S OWN BRANCH.
--
-- dining_table carried branch_id and floor_id with a foreign key to the floor
-- by id alone, so a table at branch A could name a floor at branch B -- and
-- the floor plan of A would then show a table that B's floor owns. Nothing
-- created tables except the seed, which never did it; the setup screens will,
-- so the pair is pinned now.
-- ###########################################################################
ALTER TABLE app.floor ADD CONSTRAINT floor_branch_scoped_key UNIQUE (tenant_id, branch_id, id);
ALTER TABLE app.dining_table ADD CONSTRAINT dining_table_floor_same_branch_fk
  FOREIGN KEY (tenant_id, branch_id, floor_id) REFERENCES app.floor (tenant_id, branch_id, id)
  ON DELETE RESTRICT;

-- ###########################################################################
-- FOOD OR BEVERAGE IS A PROPERTY OF THE KITCHEN'S CODE, NOT THE BRANCH STATION.
--
-- Items route by station CODE, which is tenant-wide; each branch realises the
-- code as its own kitchen_station. Putting the type on the branch station
-- would let "juice" be beverage at one branch and food at another, and an
-- item's type would depend on where it was sold.
-- ###########################################################################
ALTER TABLE app.station_code
  ADD COLUMN kind text NOT NULL DEFAULT 'food'
  CONSTRAINT station_code_kind_known CHECK (kind IN ('food', 'beverage'));

ALTER TABLE app.menu_item
  ADD COLUMN barcode text
    CONSTRAINT menu_item_barcode_format CHECK (barcode IS NULL OR barcode ~ '^[A-Za-z0-9-]{4,64}$'),
  ADD COLUMN prep_minutes smallint
    CONSTRAINT menu_item_prep_minutes_range CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 1 AND 240);

-- One active item per barcode, so a scan resolves to exactly one dish.
CREATE UNIQUE INDEX menu_item_barcode_unique_active
  ON app.menu_item (tenant_id, barcode) WHERE status = 'active' AND barcode IS NOT NULL;
