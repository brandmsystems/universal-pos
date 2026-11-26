-- kitchen_station is a RESOURCE. kds is a ROLE. They are structurally distinct
-- and nothing here references app.role -- asserted by an introspection test, not
-- left to the fact that nobody has conflated them yet.

CREATE TABLE app.kitchen_station (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id     uuid        NOT NULL,
  code          text        NOT NULL CONSTRAINT kitchen_station_code_format CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name          text        NOT NULL,
  display_order integer     NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT kitchen_station_status_known CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kitchen_station_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT kitchen_station_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT kitchen_station_code_unique_per_branch UNIQUE (tenant_id, branch_id, code)
);

CREATE TRIGGER kitchen_station_set_updated_at
  BEFORE UPDATE ON app.kitchen_station
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE app.printer (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id           uuid        NOT NULL,
  name                text        NOT NULL,

  connection_kind     text        NOT NULL
                      CONSTRAINT printer_connection_known
                      CHECK (connection_kind IN ('network', 'usb', 'bluetooth', 'cloud')),
  address             text,

  -- A real column, not a convention. A station with no reachable printer is a
  -- service outage: the ticket does not print, the kitchen does not cook, and the
  -- table waits. Making the fallback part of the schema means the retry path in
  -- Phase 3 has somewhere to look rather than somewhere to guess.
  fallback_printer_id uuid,

  status              text        NOT NULL DEFAULT 'active'
                      CONSTRAINT printer_status_known CHECK (status IN ('active', 'archived')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT printer_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT printer_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT printer_fallback_fk
  FOREIGN KEY (tenant_id, fallback_printer_id) REFERENCES app.printer (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT printer_fallback_is_not_self CHECK (fallback_printer_id IS DISTINCT FROM id),
  CONSTRAINT printer_name_unique_per_branch UNIQUE (tenant_id, branch_id, name)
);

CREATE INDEX printer_by_branch_idx ON app.printer (tenant_id, branch_id, status);

CREATE TRIGGER printer_set_updated_at
  BEFORE UPDATE ON app.printer
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Cardinality, decided now so Phase 3's print_job has a resolved routing to queue
-- against: MANY-TO-MANY.
--
--   One station may have several printers -- a busy grill runs two so a jam does
--   not stop service.
--   One printer may serve several stations -- a small kitchen runs one printer
--   for grill, fry and cold.
--
-- Neither direction is the rare case, so a nullable column on either side would
-- have been wrong.
CREATE TABLE app.station_printer (
  tenant_id  uuid        NOT NULL,
  station_id uuid        NOT NULL,
  printer_id uuid        NOT NULL,
  -- Exactly one primary per station; the others are parallel capacity, and the
  -- fallback chain on printer handles failure.
  is_primary boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, station_id, printer_id),

  CONSTRAINT station_printer_station_fk
  FOREIGN KEY (tenant_id, station_id) REFERENCES app.kitchen_station (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT station_printer_printer_fk
  FOREIGN KEY (tenant_id, printer_id) REFERENCES app.printer (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX station_printer_one_primary_per_station
  ON app.station_printer (tenant_id, station_id)
  WHERE is_primary;

CREATE INDEX station_printer_by_printer_idx ON app.station_printer (tenant_id, printer_id);

ALTER TABLE app.kitchen_station ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kitchen_station
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.printer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.printer
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.station_printer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.station_printer
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
