-- Bug fix to 0020, not a change of mind.
--
-- kitchen_station.code was free text unique per branch, while the menu (which is
-- tenant-level) has to route by code. Two branches spelling the same station
-- `grill` and `grill_station` silently breaks routing at one of them -- the same
-- class as the enumerated APP_TABLE regex: a free-text key that something else
-- derives from is a drift vector.
--
-- The vocabulary is tenant-level; each branch REALISES the codes it actually has.
CREATE TABLE app.station_code (
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  code       text        NOT NULL
             CONSTRAINT station_code_format CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT station_code_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, code)
);

CREATE TRIGGER station_code_set_updated_at
  BEFORE UPDATE ON app.station_code
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.station_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.station_code
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Adopt whatever codes already exist so the FK can be added without data loss.
INSERT INTO app.station_code (tenant_id, code, name)
SELECT DISTINCT tenant_id, code, code FROM app.kitchen_station
ON CONFLICT (tenant_id, code) DO NOTHING;

ALTER TABLE app.kitchen_station
  ADD CONSTRAINT kitchen_station_code_fk
  FOREIGN KEY (tenant_id, code) REFERENCES app.station_code (tenant_id, code)
    ON UPDATE CASCADE ON DELETE RESTRICT;
