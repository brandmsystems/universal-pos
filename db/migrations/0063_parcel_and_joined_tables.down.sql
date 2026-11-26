-- The parcel sessions themselves stay, with their orders, KOTs and bills: only
-- the parcel number, pickup name and handover stamp go, and those are labels on
-- a record, not the record.
DROP TABLE app.parcel_sequence;
DROP INDEX app.table_session_parcel_no_unique;
ALTER TABLE app.table_session
  DROP CONSTRAINT table_session_pickup_consistent,
  DROP CONSTRAINT table_session_parcel_shape,
  DROP CONSTRAINT table_session_picked_up_by_fk,
  DROP COLUMN picked_up_by_user_id,
  DROP COLUMN picked_up_at,
  DROP COLUMN pickup_name,
  DROP COLUMN parcel_no,
  DROP COLUMN service_type;
