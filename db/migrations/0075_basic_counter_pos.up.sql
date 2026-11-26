-- Basic: no tables, and the Sales person manages the staff.
--
-- ###########################################################################
-- Two plan terms, stated on every version because an absent feature denies:
--
--   tables       floors, floor types and dining tables. Basic false.
--   staff_admin  the restaurant manages its own staff accounts. Basic false:
--                the Sales person creates them from the control plane.
--
-- Every other version gets true -- what it already had. Rows a Basic
-- restaurant already holds (tables, staff) are left: rows are records, and a
-- plan term only refuses ADDING.
--
-- Without tables, a dine-in order on Basic is numbered at the counter, like a
-- parcel. table_session.seating is the POSITIVE discriminator -- table or
-- counter -- rather than "has no table row", which a CHECK cannot see and
-- which would make absence the discriminator. A counter session carries the
-- counter number (parcel_no, now shared by parcels and counter dine-in, so
-- two orders called out at one counter never share a number); a table session
-- never does.
-- ###########################################################################
UPDATE platform.plan_version pv
   SET features = pv.features
                  || jsonb_build_object('tables', p.key <> 'basic')
                  || jsonb_build_object('staff_admin', p.key <> 'basic')
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND NOT (pv.features ? 'tables' AND pv.features ? 'staff_admin');

ALTER TABLE app.table_session
  ADD COLUMN seating text NOT NULL DEFAULT 'table'
    CONSTRAINT table_session_seating_known CHECK (seating IN ('table', 'counter'));
UPDATE app.table_session SET seating = 'counter' WHERE service_type = 'parcel';

ALTER TABLE app.table_session DROP CONSTRAINT table_session_parcel_shape;
ALTER TABLE app.table_session ADD CONSTRAINT table_session_parcel_shape CHECK (
  CASE
    WHEN service_type = 'parcel'
      THEN seating = 'counter' AND parcel_no IS NOT NULL AND parcel_no > 0
    WHEN seating = 'counter'
      THEN parcel_no IS NOT NULL AND parcel_no > 0 AND picked_up_at IS NULL
    ELSE parcel_no IS NULL AND pickup_name IS NULL AND picked_up_at IS NULL
  END
);

DROP INDEX app.table_session_parcel_no_unique;
CREATE UNIQUE INDEX table_session_parcel_no_unique
  ON app.table_session (tenant_id, branch_id, business_date, parcel_no)
  WHERE seating = 'counter';

WITH published AS (
  INSERT INTO platform.entitlement_document
    (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
  SELECT d.tenant_id, d.version + 1, p.key, pv.version, d.status, pv.limits, pv.features,
         'migration 0075: tables and staff management are plan terms; Basic has neither'
    FROM (SELECT DISTINCT ON (tenant_id) tenant_id, version, status
            FROM platform.entitlement_document ORDER BY tenant_id, version DESC) d
    JOIN platform.subscription s
      ON s.tenant_id = d.tenant_id AND s.status IN ('trialing', 'active', 'past_due')
    JOIN platform.plan_version pv ON pv.id = s.plan_version_id
    JOIN platform.plan p ON p.id = pv.plan_id
  RETURNING tenant_id, version
)
INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
SELECT gen_random_uuid(), 'entitlement.invalidate', tenant_id::text || ':' || version::text,
       jsonb_build_object('tenantId', tenant_id, 'version', version)
  FROM published
ON CONFLICT (topic, dedupe_key) DO NOTHING;
