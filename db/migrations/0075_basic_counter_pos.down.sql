-- A counter dine-in order is a numbered, tableless session -- exactly the shape
-- of a parcel, the only tableless session the older schema knows. So the rows
-- are KEPT, as parcels, rather than deleted: a rollback must not destroy a
-- record of something that happened (0042, 0059). The entitlement documents and
-- outbox messages 0075 appended are left for the same reason.
UPDATE app.table_session
   SET service_type = 'parcel'
 WHERE seating = 'counter' AND service_type = 'dine_in';

DROP INDEX app.table_session_parcel_no_unique;
CREATE UNIQUE INDEX table_session_parcel_no_unique
  ON app.table_session (tenant_id, branch_id, business_date, parcel_no)
  WHERE service_type = 'parcel';

ALTER TABLE app.table_session DROP CONSTRAINT table_session_parcel_shape;
ALTER TABLE app.table_session ADD CONSTRAINT table_session_parcel_shape CHECK (
  CASE service_type
    WHEN 'parcel'  THEN parcel_no IS NOT NULL AND parcel_no > 0
    WHEN 'dine_in' THEN parcel_no IS NULL AND pickup_name IS NULL AND picked_up_at IS NULL
  END
);
ALTER TABLE app.table_session DROP COLUMN seating;

UPDATE platform.plan_version SET features = features - 'tables' - 'staff_admin';
