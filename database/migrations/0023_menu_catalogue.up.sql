-- The menu is a TENANT-level catalogue. A two-outlet tenant maintains one menu.
-- Branch differences (listing, price, availability, routing exceptions) are 0024.

-- Tax class is statutory and belongs to the ITEM. Categories are merchandising
-- and get reorganised; a tax class that moves when someone renames a category is
-- a GST return that stops reconciling.
CREATE TABLE app.tax_class (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT tax_class_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  -- Basis points, integer. Same discipline as money: 5% is 500, never 0.05.
  rate_bps   integer     NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT tax_class_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_class_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT tax_class_key_unique_per_tenant UNIQUE (tenant_id, key)
);

CREATE TRIGGER tax_class_set_updated_at
  BEFORE UPDATE ON app.tax_class
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- CGST/SGST/IGST and their equivalents elsewhere. A child table rather than
-- columns because the split varies by jurisdiction and by transaction type.
CREATE TABLE app.tax_component (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  tax_class_id  uuid        NOT NULL,
  name          text        NOT NULL,
  rate_bps      integer     NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  display_order integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_component_class_fk
  FOREIGN KEY (tenant_id, tax_class_id) REFERENCES app.tax_class (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_component_name_unique UNIQUE (tenant_id, tax_class_id, name)
);

CREATE INDEX tax_component_by_class_idx ON app.tax_component (tenant_id, tax_class_id);


-- Merchandising ONLY. No tax class, no station, no availability, no price. If a
-- future column here would carry statutory or operational meaning, it belongs on
-- the item instead.
CREATE TABLE app.menu_category (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key           text        NOT NULL CONSTRAINT menu_category_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name          text        NOT NULL,
  parent_id     uuid,
  display_order integer     NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT menu_category_status_known CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT menu_category_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT menu_category_key_unique_per_tenant UNIQUE (tenant_id, key),
  CONSTRAINT menu_category_parent_fk
  FOREIGN KEY (tenant_id, parent_id) REFERENCES app.menu_category (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_category_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TRIGGER menu_category_set_updated_at
  BEFORE UPDATE ON app.menu_category
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE app.menu_item (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key           text        NOT NULL CONSTRAINT menu_item_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name          text        NOT NULL,
  description   text,

  kind          text        NOT NULL
                CONSTRAINT menu_item_kind_known CHECK (kind IN ('single', 'combo')),

  category_id   uuid,
  tax_class_id  uuid        NOT NULL,

  -- References the tenant VOCABULARY, not a branch's station: the menu is
  -- tenant-level and kitchen_station is branch-scoped, so the item names a code
  -- and each branch resolves it to its own station.
  --
  -- A combo carries no routing of its own -- its components route individually,
  -- which is why one order line can produce two KOT entries.
  station_code  text,

  -- MUTABLE, and safe only because of the priced-document rule: order lines
  -- snapshot price, modifier deltas, tax rate and display name at order time, so
  -- no bill ever dereferences this column.
  price_minor   bigint      NOT NULL CHECK (price_minor >= 0),

  -- Archived, never deleted or repurposed: an id that has appeared on a
  -- historical order must stay resolvable to what it was.
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT menu_item_status_known CHECK (status IN ('active', 'archived')),
  archived_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT menu_item_tenant_id_key UNIQUE (tenant_id, id),
  -- FK target for branch_menu_price's pinned catalogue copy.
  CONSTRAINT menu_item_tenant_id_price_key UNIQUE (tenant_id, id, price_minor),
  -- FK target that prevents a combo being nested inside a combo.
  CONSTRAINT menu_item_tenant_id_kind_key UNIQUE (tenant_id, id, kind),
  CONSTRAINT menu_item_key_unique_per_tenant UNIQUE (tenant_id, key),

  CONSTRAINT menu_item_category_fk
  FOREIGN KEY (tenant_id, category_id) REFERENCES app.menu_category (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_item_tax_class_fk
  FOREIGN KEY (tenant_id, tax_class_id) REFERENCES app.tax_class (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_item_station_code_fk
  FOREIGN KEY (tenant_id, station_code) REFERENCES app.station_code (tenant_id, code)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT menu_item_routing_matches_kind
  CHECK ((kind = 'single') = (station_code IS NOT NULL)),

  CONSTRAINT menu_item_archival_consistent
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX menu_item_by_category_idx ON app.menu_item (tenant_id, category_id);
CREATE INDEX menu_item_by_station_idx ON app.menu_item (tenant_id, station_code);

CREATE TRIGGER menu_item_set_updated_at
  BEFORE UPDATE ON app.menu_item
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Reusable and tenant-level: "sugar level" belongs to every drink. Copying it per
-- item would also give "less sugar" forty different ids, making "how often do
-- people order less sugar" unanswerable.
CREATE TABLE app.modifier_group (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT modifier_group_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,

  min_select smallint    NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  -- NULL means "bounded by the number of options in the group", not unlimited --
  -- the other bound still binds. Same reading as a NULL discount amount cap.
  max_select smallint,

  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT modifier_group_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT modifier_group_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT modifier_group_key_unique_per_tenant UNIQUE (tenant_id, key),
  CONSTRAINT modifier_group_bounds_ordered CHECK (max_select IS NULL OR max_select >= min_select)
);

CREATE TRIGGER modifier_group_set_updated_at
  BEFORE UPDATE ON app.modifier_group
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE app.modifier_option (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  modifier_group_id uuid        NOT NULL,
  key               text        NOT NULL CONSTRAINT modifier_option_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name              text        NOT NULL,

  -- Negative is legitimate: "no cheese -30". The invariant that a line total
  -- cannot go below zero is Phase 3's, not a CHECK here.
  price_delta_minor bigint      NOT NULL DEFAULT 0,

  -- NULL inherits the item's station. Non-NULL is "add a lassi" on a thali: the
  -- option is prepared somewhere else entirely.
  station_code      text,

  display_order     integer     NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'active'
                    CONSTRAINT modifier_option_status_known CHECK (status IN ('active', 'archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT modifier_option_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT modifier_option_key_unique UNIQUE (tenant_id, modifier_group_id, key),
  CONSTRAINT modifier_option_group_fk
  FOREIGN KEY (tenant_id, modifier_group_id) REFERENCES app.modifier_group (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT modifier_option_station_code_fk
  FOREIGN KEY (tenant_id, station_code) REFERENCES app.station_code (tenant_id, code)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX modifier_option_by_group_idx ON app.modifier_option (tenant_id, modifier_group_id, display_order);

CREATE TRIGGER modifier_option_set_updated_at
  BEFORE UPDATE ON app.modifier_option
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- The group is tenant-level; the ATTACHMENT is per item, with per-attachment
-- override of the bounds. Resolution is COALESCE(override, group default).
-- Overrides may widen or narrow: selection counts are not money, and "this burger
-- allows 5 toppings where the group defaults to 3" is ordinary.
CREATE TABLE app.menu_item_modifier_group (
  tenant_id           uuid        NOT NULL,
  menu_item_id        uuid        NOT NULL,
  modifier_group_id   uuid        NOT NULL,
  min_select_override smallint    CHECK (min_select_override IS NULL OR min_select_override >= 0),
  max_select_override smallint,
  display_order       integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, menu_item_id, modifier_group_id),

  CONSTRAINT menu_item_modifier_group_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_item_modifier_group_group_fk
  FOREIGN KEY (tenant_id, modifier_group_id) REFERENCES app.modifier_group (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_item_modifier_group_bounds_ordered
  CHECK (min_select_override IS NULL OR max_select_override IS NULL
         OR max_select_override >= min_select_override)
);

CREATE INDEX menu_item_modifier_group_by_group_idx
  ON app.menu_item_modifier_group (tenant_id, modifier_group_id);


-- A choice option must be a MENU ITEM, not a modifier option: it needs its own
-- tax class and its own station routing. That is why modifier_group cannot serve
-- here, and why deferring this would have reshaped combo_component after order
-- lines already referenced it.
CREATE TABLE app.combo_choice_group (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT combo_choice_group_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  min_select smallint    NOT NULL DEFAULT 1 CHECK (min_select >= 0),
  max_select smallint    NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT combo_choice_group_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT combo_choice_group_key_unique UNIQUE (tenant_id, key),
  CONSTRAINT combo_choice_group_bounds_ordered CHECK (max_select >= min_select)
);

CREATE TRIGGER combo_choice_group_set_updated_at
  BEFORE UPDATE ON app.combo_choice_group
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.combo_choice_option (
  tenant_id         uuid        NOT NULL,
  choice_group_id   uuid        NOT NULL,
  component_item_id uuid        NOT NULL,
  -- Denormalised and pinned so a combo cannot nest a combo.
  component_kind    text        NOT NULL DEFAULT 'single'
                    CONSTRAINT combo_choice_option_component_is_single CHECK (component_kind = 'single'),
  price_delta_minor bigint      NOT NULL DEFAULT 0,
  display_order     integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, choice_group_id, component_item_id),

  CONSTRAINT combo_choice_option_group_fk
  FOREIGN KEY (tenant_id, choice_group_id) REFERENCES app.combo_choice_group (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT combo_choice_option_item_fk
  FOREIGN KEY (tenant_id, component_item_id, component_kind)
    REFERENCES app.menu_item (tenant_id, id, kind) ON DELETE RESTRICT
);


CREATE TABLE app.combo_component (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  combo_item_id     uuid        NOT NULL,
  -- Denormalised and pinned: only a combo may have components.
  combo_kind        text        NOT NULL DEFAULT 'combo'
                    CONSTRAINT combo_component_parent_is_combo CHECK (combo_kind = 'combo'),

  -- Explicit discriminator, never inferred from which column is null.
  kind              text        NOT NULL
                    CONSTRAINT combo_component_kind_known CHECK (kind IN ('fixed', 'choice')),
  component_item_id uuid,
  component_kind    text,
  choice_group_id   uuid,

  quantity          smallint    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  display_order     integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT combo_component_combo_fk
  FOREIGN KEY (tenant_id, combo_item_id, combo_kind)
    REFERENCES app.menu_item (tenant_id, id, kind) ON DELETE RESTRICT,
  CONSTRAINT combo_component_item_fk
  FOREIGN KEY (tenant_id, component_item_id, component_kind)
    REFERENCES app.menu_item (tenant_id, id, kind) ON DELETE RESTRICT,
  CONSTRAINT combo_component_choice_fk
  FOREIGN KEY (tenant_id, choice_group_id)
    REFERENCES app.combo_choice_group (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT combo_component_shape_exact
  CHECK (
    CASE kind
      WHEN 'fixed'  THEN component_item_id IS NOT NULL AND component_kind = 'single'
                          AND choice_group_id IS NULL
      WHEN 'choice' THEN choice_group_id IS NOT NULL
                          AND component_item_id IS NULL AND component_kind IS NULL
      ELSE false
    END
  )
);

CREATE INDEX combo_component_by_combo_idx ON app.combo_component (tenant_id, combo_item_id, display_order);


ALTER TABLE app.tax_class ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_class
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.tax_component ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_component
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.menu_category ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.menu_category
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.menu_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.menu_item
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.modifier_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.modifier_group
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.modifier_option ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.modifier_option
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.menu_item_modifier_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.menu_item_modifier_group
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.combo_choice_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.combo_choice_group
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.combo_choice_option ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.combo_choice_option
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.combo_component ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.combo_component
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
