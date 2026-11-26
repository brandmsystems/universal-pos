-- Parcel / takeaway, and joining tables to an open session.
--
-- A parcel is a table_session with no table. Everything downstream of the
-- session -- the lease, the order, fire, KOT, bill, split, tender, close --
-- already keys on the session and never on a table, so it works unchanged.
-- What a parcel needs that a table does not: a number to call out, an
-- optional name, and the moment it was handed over.
--
-- Joining tables needs no schema: table_session_table has always allowed a
-- session several live attachments, and table_session_one_live_attachment_per_table
-- already makes "one table, one live session" the database's decision. "A
-- dine-in session keeps at least one table" and "a parcel never has one" count
-- rows in another table, which a CHECK cannot do, so they live in the domain
-- (orders/session.ts), under the session row lock.

ALTER TABLE app.table_session
  ADD COLUMN service_type text NOT NULL DEFAULT 'dine_in'
    CONSTRAINT table_session_service_type_known CHECK (service_type IN ('dine_in', 'parcel')),
  ADD COLUMN parcel_no integer,
  -- The name called out at the counter ("Rahul"), not a customer record.
  -- A phone is NOT stored here: it goes on the bill through the existing
  -- customer attach (customer.create), so the number stays under
  -- app.customer's masking and erasure and its own permission key.
  ADD COLUMN pickup_name text
    CONSTRAINT table_session_pickup_name_shape
    CHECK (pickup_name IS NULL OR (length(btrim(pickup_name)) BETWEEN 1 AND 40)),
  ADD COLUMN picked_up_at timestamptz,
  ADD COLUMN picked_up_by_user_id uuid,
  ADD CONSTRAINT table_session_picked_up_by_fk
    FOREIGN KEY (tenant_id, picked_up_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- The parcel fields exist exactly when it is a parcel; a positive column,
  -- not "parcel_no IS NULL", is the discriminator.
  ADD CONSTRAINT table_session_parcel_shape CHECK (
    CASE service_type
      WHEN 'parcel'  THEN parcel_no IS NOT NULL AND parcel_no > 0
      WHEN 'dine_in' THEN parcel_no IS NULL AND pickup_name IS NULL AND picked_up_at IS NULL
    END
  ),
  ADD CONSTRAINT table_session_pickup_consistent
    CHECK ((picked_up_at IS NULL) = (picked_up_by_user_id IS NULL));

CREATE UNIQUE INDEX table_session_parcel_no_unique
  ON app.table_session (tenant_id, branch_id, business_date, parcel_no)
  WHERE service_type = 'parcel';

-- Per branch per business date, by counter row: the increment rolls back with
-- an aborted open, so the numbers called out at the counter have no gaps.
CREATE TABLE app.parcel_sequence (
  tenant_id     uuid    NOT NULL,
  branch_id     uuid    NOT NULL,
  business_date date    NOT NULL,
  next_no       integer NOT NULL DEFAULT 0 CHECK (next_no >= 0),
  PRIMARY KEY (tenant_id, branch_id, business_date),
  CONSTRAINT parcel_sequence_branch_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.parcel_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.parcel_sequence
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Repair: closeSession never detached its tables, and the one-live-attachment
-- index counts a closed session's attachment as live, so every table whose
-- party had closed could never be seated again. closeSession now detaches;
-- this releases the ones already stuck. Not undone by the down: it is a
-- correction of state no code should have produced.
UPDATE app.table_session_table tst
   SET detached_at = GREATEST(s.closed_at, tst.attached_at)
  FROM app.table_session s
 WHERE s.tenant_id = tst.tenant_id AND s.id = tst.session_id
   AND s.status = 'closed' AND tst.detached_at IS NULL;
