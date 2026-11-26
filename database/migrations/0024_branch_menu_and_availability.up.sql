-- Branch-level differences from the tenant catalogue.
--
-- Listing and pricing are SEPARATE tables. Combining them looked tidy until the
-- FK proved otherwise: the pinned catalogue copy exists so a catalogue price rise
-- re-checks every override, but that would drag delisting rows -- which exist
-- solely to say "we don't sell this here" -- into the cascade, let one abort a
-- price change it has no opinion about, and force a NOT NULL price copy onto a
-- row that will never use one.

-- Absence means LISTED at catalogue price. Sparse, so adding an item or a branch
-- needs no maintenance and cannot drift.
CREATE TABLE app.branch_menu_listing (
  tenant_id       uuid        NOT NULL,
  branch_id       uuid        NOT NULL,
  menu_item_id    uuid        NOT NULL,
  listed          boolean     NOT NULL,
  delisted_reason text,
  updated_by_user_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, branch_id, menu_item_id),

  CONSTRAINT branch_menu_listing_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_menu_listing_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_menu_listing_user_fk
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER branch_menu_listing_set_updated_at
  BEFORE UPDATE ON app.branch_menu_listing
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- A row here exists only to ASSERT a price, so price_minor is NOT NULL and the
-- pinned catalogue copy is used by every row that carries one.
--
-- Overrides may only RAISE. A lower branch price would be an uncapped discount
-- channel with no reason code, routing around everything built for order.discount.
-- Lowering is a promotion: Phase 5, own key, own audit trail.
CREATE TABLE app.branch_menu_price (
  tenant_id             uuid        NOT NULL,
  branch_id             uuid        NOT NULL,
  menu_item_id          uuid        NOT NULL,

  price_minor           bigint      NOT NULL CHECK (price_minor >= 0),
  -- Pinned copy of the catalogue price, kept honest by ON UPDATE CASCADE. Same
  -- mechanism as role_assignable_scope on membership: raising the catalogue price
  -- rewrites every copy, each row re-checks, and if any override now sits below
  -- the new catalogue price the CATALOGUE PRICE CHANGE ABORTS -- naming the
  -- conflict rather than silently lifting branch prices nobody was looking at.
  catalogue_price_minor bigint      NOT NULL,

  updated_by_user_id    uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, branch_id, menu_item_id),

  CONSTRAINT branch_menu_price_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_menu_price_catalogue_fk
  FOREIGN KEY (tenant_id, menu_item_id, catalogue_price_minor)
    REFERENCES app.menu_item (tenant_id, id, price_minor)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT branch_menu_price_user_fk
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT branch_menu_price_may_only_raise
  CHECK (price_minor >= catalogue_price_minor)
);

CREATE TRIGGER branch_menu_price_set_updated_at
  BEFORE UPDATE ON app.branch_menu_price
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Named tenant reference data, not per-item time columns: a tenant defines
-- "Breakfast 07:00-11:00" once and attaches forty items. Per-item times mean
-- editing forty rows to move breakfast to 07:30.
CREATE TABLE app.service_period (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  -- NULL applies to every branch.
  branch_id     uuid,
  key           text        NOT NULL CONSTRAINT service_period_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name          text        NOT NULL,

  -- Bitmask, Monday = 1 through Sunday = 64. An array would not constrain.
  days_of_week  smallint    NOT NULL CHECK (days_of_week BETWEEN 1 AND 127),
  -- starts_at > ends_at means the period WRAPS midnight (22:00-02:00), which is
  -- ordinary for a late-night menu. Evaluated in branch-local time, never UTC.
  starts_at     time        NOT NULL,
  ends_at       time        NOT NULL,

  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT service_period_status_known CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_period_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT service_period_key_unique UNIQUE (tenant_id, key),
  CONSTRAINT service_period_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT service_period_not_instantaneous CHECK (starts_at <> ends_at)
);

CREATE TRIGGER service_period_set_updated_at
  BEFORE UPDATE ON app.service_period
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- No attachment at all means always available.
CREATE TABLE app.menu_item_service_period (
  tenant_id         uuid        NOT NULL,
  menu_item_id      uuid        NOT NULL,
  service_period_id uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, menu_item_id, service_period_id),

  CONSTRAINT menu_item_service_period_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT menu_item_service_period_period_fk
  FOREIGN KEY (tenant_id, service_period_id) REFERENCES app.service_period (tenant_id, id) ON DELETE RESTRICT
);


-- Keyed by BUSINESS DATE, which is what makes "resets daily" true with no reset
-- job to forget to run. Absence means available.
CREATE TABLE app.branch_item_availability (
  tenant_id     uuid        NOT NULL,
  branch_id     uuid        NOT NULL,
  menu_item_id  uuid        NOT NULL,
  business_date date        NOT NULL,

  state         text        NOT NULL
                CONSTRAINT branch_item_availability_state_known
                CHECK (state IN ('sold_out', 'available')),
  -- Phase 4 drives this from stock without needing a second table.
  source        text        NOT NULL DEFAULT 'manual'
                CONSTRAINT branch_item_availability_source_known
                CHECK (source IN ('manual', 'stock')),
  reason        text,
  set_by_user_id uuid,
  set_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, branch_id, menu_item_id, business_date),

  CONSTRAINT branch_item_availability_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_item_availability_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_item_availability_user_fk
  FOREIGN KEY (tenant_id, set_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- A stock-driven 86 has no human to attribute it to; a manual one must have one.
  CONSTRAINT branch_item_availability_attribution
  CHECK ((source = 'manual') = (set_by_user_id IS NOT NULL))
);


-- The exception to code-based routing: "at the airport, rolls come off the grill
-- rather than the tandoor". Absence means resolve by station_code.
CREATE TABLE app.branch_item_routing (
  tenant_id          uuid        NOT NULL,
  branch_id          uuid        NOT NULL,
  menu_item_id       uuid        NOT NULL,
  kitchen_station_id uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, branch_id, menu_item_id),

  CONSTRAINT branch_item_routing_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_item_routing_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_item_routing_station_fk
  FOREIGN KEY (tenant_id, kitchen_station_id) REFERENCES app.kitchen_station (tenant_id, id) ON DELETE RESTRICT
);


-- A restaurant's day ends at 3am, not at midnight, and never at UTC midnight.
-- The business date is what makes the sold-out table reset correctly.
ALTER TABLE app.branch
  ADD COLUMN business_day_starts_at time NOT NULL DEFAULT '00:00';

-- STABLE, not IMMUTABLE: AT TIME ZONE depends on the timezone database.
CREATE FUNCTION app.business_date(zone text, day_start time, at timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (((at AT TIME ZONE zone) - day_start::interval))::date
$$;

ALTER TABLE app.branch_menu_listing ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_menu_listing
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.branch_menu_price ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_menu_price
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.service_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.service_period
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.menu_item_service_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.menu_item_service_period
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.branch_item_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_item_availability
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.branch_item_routing ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch_item_routing
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
