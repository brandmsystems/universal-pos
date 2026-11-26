-- Offline POS: the session lease, the sync batch, the quarantine, and the two
-- markers that keep late-arriving and out-of-band money honest.
--
-- The organising rule, so nobody widens the allowed set by accident:
--
--   An operation may go offline when its invariant is LOCAL to the aggregate the
--   device holds. It may not when the invariant is GLOBAL across devices.
--
-- "Money" was the original heuristic and it is a proxy: settlement is forbidden
-- because closing a bill is a consensus act, not because money is special. The
-- distinction matters because it tells you where to put the NEXT operation. It
-- also catches what the money heuristic misses -- firing a KOT is not local
-- either, unless something guarantees a single writer. That is the lease.


-- The lease is what makes "order lines merge" true. Without it, two terminals
-- holding the same session offline both fire the same lines: two KOTs, two stock
-- deductions, one order.
--
-- ###########################################################################
-- KEYED ON THE SESSION, NEVER ON THE TABLE.
--
-- A party moving from table 4 to table 7 keeps one session across both, and
-- `table_session_table` already models that as a relation. A lease keyed on the
-- table would split at the move, hand the second table to another device, and
-- reintroduce exactly the double-writer the lease exists to prevent.
-- ###########################################################################
CREATE TABLE app.table_session_lease (
  -- Its own identity, NOT the session. A session is leased many times over its
  -- life -- claimed, released at the end of a shift, claimed again by the next
  -- terminal -- and rule 11 says retained history must never block re-creation.
  -- Keying this on session_id would have let exactly one lease exist per session
  -- forever, silently making the partial unique index below decorative.
  id                uuid        PRIMARY KEY,
  session_id        uuid        NOT NULL,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  device_id         uuid        NOT NULL,

  claimed_at        timestamptz NOT NULL DEFAULT now(),

  -- ABSOLUTE, and renewal is the only thing that moves it. A device going
  -- offline therefore keeps its REMAINING window rather than being granted a
  -- fresh one -- that behaviour falls out of absolute expiry plus renew-only-
  -- while-online, with no separate mechanism to get wrong.
  expires_at        timestamptz NOT NULL,
  renewed_at        timestamptz,

  -- One-way, like the impersonation revocation stamp. A lease is never widened
  -- after the fact and never un-released.
  released_at       timestamptz,
  force_released_at timestamptz,
  force_released_by_user_id uuid,
  force_release_reason_id   uuid,

  CONSTRAINT table_session_lease_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT table_session_lease_session_fk
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.table_session (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_lease_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_lease_device_fk
  FOREIGN KEY (tenant_id, device_id) REFERENCES app.device (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_lease_forcer_fk
  FOREIGN KEY (tenant_id, force_released_by_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- Short by construction. The cap is on the ROW, not on any token, for the same
  -- reason the impersonation cap is: a duration enforced only where the lease is
  -- issued is decorative the moment something reissues it.
  -- Capped against the LAST GRANT, not the original claim. Capping against
  -- claimed_at would make renewal impossible -- the second grant is already past
  -- claimed_at + 15m -- which quietly turns "short and renewable" into "short and
  -- then dead", and a terminal mid-service loses its table.
  CONSTRAINT table_session_lease_duration_capped
  CHECK (expires_at <= COALESCE(renewed_at, claimed_at) + interval '15 minutes'),

  -- A force release is an escalation-class act and must be attributable and
  -- explained. Nullness is not the discriminator: the stamp and its attribution
  -- travel together or not at all.
  CONSTRAINT table_session_lease_force_release_attributed
  CHECK ((force_released_at IS NOT NULL)
       = (force_released_by_user_id IS NOT NULL AND force_release_reason_id IS NOT NULL))
);

CREATE INDEX table_session_lease_by_device_idx
  ON app.table_session_lease (tenant_id, device_id)
  WHERE released_at IS NULL AND force_released_at IS NULL;

-- One live lease per session. Partial per rule 11: a released lease must not
-- block the next claim.
CREATE UNIQUE INDEX table_session_lease_one_live
  ON app.table_session_lease (tenant_id, session_id)
  WHERE released_at IS NULL AND force_released_at IS NULL;

CREATE FUNCTION app.deny_lease_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.session_id <> NEW.session_id OR OLD.device_id <> NEW.device_id
     OR OLD.claimed_at <> NEW.claimed_at THEN
    RAISE EXCEPTION 'a lease cannot be reassigned; release it and claim a new one'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'lease release is one-way' USING ERRCODE = '42501';
  END IF;
  IF OLD.force_released_at IS NOT NULL
     AND NEW.force_released_at IS DISTINCT FROM OLD.force_released_at THEN
    RAISE EXCEPTION 'lease force-release is one-way' USING ERRCODE = '42501';
  END IF;
  -- Renewal may only ever move expiry FORWARD, and only on a live lease.
  IF NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION 'a lease cannot be shortened; force-release it instead'
      USING ERRCODE = '42501';
  END IF;
  IF (OLD.released_at IS NOT NULL OR OLD.force_released_at IS NOT NULL)
     AND NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'a dead lease cannot be renewed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER table_session_lease_is_append_only
  BEFORE UPDATE ON app.table_session_lease
  FOR EACH ROW EXECUTE FUNCTION app.deny_lease_rewrite();


-- The device-ordered operation log. One row per batch; operations are applied in
-- the order the device recorded them, per session, under the lease.
CREATE TABLE app.sync_batch (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  device_id         uuid        NOT NULL,

  -- Client-generated. The device numbers its own batches so a gap is visible.
  client_batch_no   bigint      NOT NULL CHECK (client_batch_no > 0),

  -- When the device went offline, by its own clock. Used only to decide
  -- staleness; server time decides everything that matters, exactly as the
  -- impersonation session row decides expiry rather than the token.
  offline_since     timestamptz NOT NULL,

  status            text        NOT NULL DEFAULT 'pending'
                    CONSTRAINT sync_batch_status_known
                    CHECK (status IN ('pending', 'applied', 'quarantined')),

  operation_count   integer     NOT NULL CHECK (operation_count >= 0),
  received_at       timestamptz NOT NULL DEFAULT now(),
  applied_at        timestamptz,

  CONSTRAINT sync_batch_tenant_id_key UNIQUE (tenant_id, id),
  -- Replay protection at the batch level, above the per-operation claims.
  CONSTRAINT sync_batch_device_no_unique UNIQUE (tenant_id, device_id, client_batch_no),
  CONSTRAINT sync_batch_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_batch_device_fk
  FOREIGN KEY (tenant_id, device_id) REFERENCES app.device (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT sync_batch_applied_consistent
  CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);

CREATE INDEX sync_batch_pending_idx
  ON app.sync_batch (tenant_id, branch_id, received_at) WHERE status = 'pending';


-- Quarantine is a HOLDING AREA, not a rejection. The batch survives intact so a
-- human can look at it; silently absorbing a week-old batch that corrupts the
-- cost basis is worse than making someone read it, and silently discarding it is
-- worse than both.
CREATE TABLE app.sync_quarantine (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id      uuid        NOT NULL,
  sync_batch_id  uuid        NOT NULL,

  reason         text        NOT NULL
                 CONSTRAINT sync_quarantine_reason_known
                 CHECK (reason IN ('lease_force_released', 'lease_expired', 'lease_conflict',
                                   'stale_beyond_window', 'forbidden_operation')),
  detail         text        NOT NULL,

  -- The batch as the device sent it. Kept verbatim: a quarantined batch is
  -- evidence, and paraphrasing evidence destroys it.
  payload        jsonb       NOT NULL,

  quarantined_at timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by_user_id uuid,
  resolution     text
                 CONSTRAINT sync_quarantine_resolution_known
                 CHECK (resolution IS NULL OR resolution IN ('applied', 'discarded')),

  CONSTRAINT sync_quarantine_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_quarantine_batch_fk
  FOREIGN KEY (tenant_id, sync_batch_id) REFERENCES app.sync_batch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_quarantine_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_quarantine_resolver_fk
  FOREIGN KEY (tenant_id, resolved_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT sync_quarantine_resolution_consistent
  CHECK ((resolved_at IS NOT NULL)
       = (resolved_by_user_id IS NOT NULL AND resolution IS NOT NULL))
);

CREATE INDEX sync_quarantine_open_idx
  ON app.sync_quarantine (tenant_id, branch_id, quarantined_at) WHERE resolved_at IS NULL;


-- The device-local ticket number, printed before the server assigned anything.
-- kot.sequence_no is already nullable precisely so this is possible; this column
-- is what makes the paper in the kitchen traceable to the row afterwards.
ALTER TABLE app.kot
  ADD COLUMN local_reference text
  CONSTRAINT kot_local_reference_format
  CHECK (local_reference IS NULL OR local_reference ~ '^L-[A-Za-z0-9]{4,12}-[0-9]{1,9}$');

-- A ticket fired offline must carry SOMETHING a human can read aloud. Server
-- sequence or device reference; never neither.
ALTER TABLE app.kot
  ADD CONSTRAINT kot_has_a_human_reference
  CHECK (sequence_no IS NOT NULL OR local_reference IS NOT NULL);


-- Movements replayed from a device that was offline. Ordering the drain by
-- business date fixes the common case -- a device syncing several days at once
-- -- but it CANNOT fix a device syncing after newer movements already shifted
-- the moving average. Anything older than the offline window is quarantined
-- rather than absorbed; within the window it is accepted and marked, so the
-- variance report can explain itself instead of being quietly wrong.
ALTER TABLE app.stock_movement
  ADD COLUMN synced_late boolean NOT NULL DEFAULT false;

CREATE INDEX stock_movement_synced_late_idx
  ON app.stock_movement (tenant_id, branch_id, business_date) WHERE synced_late;


-- Money that changed hands OUTSIDE the system during an outage, keyed in
-- afterwards.
--
-- This is NOT offline settlement. The bill is generated and the tender recorded
-- online, after the fact; what is being recorded is that a manual card machine or
-- a cash envelope took the money while the terminal was down. Staff will do this
-- with or without a feature, so it gets an auditable home rather than a
-- workaround nobody can report on.
ALTER TABLE app.tender
  ADD COLUMN settled_offline_manually boolean NOT NULL DEFAULT false,
  -- The card slip number, the cash envelope id -- whatever the operator can be
  -- asked to produce when the figures are challenged.
  ADD COLUMN operator_reference text,
  ADD COLUMN authorised_by_user_id uuid,
  ADD CONSTRAINT tender_manual_authoriser_fk
  FOREIGN KEY (tenant_id, authorised_by_user_id)
    REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- Every element or none. A manual settlement with no reference is an
  -- unverifiable assertion that money arrived, which is the thing this exists to
  -- prevent.
  ADD CONSTRAINT tender_manual_settlement_complete
  CHECK (
    settled_offline_manually = false
    OR (operator_reference IS NOT NULL AND length(trim(operator_reference)) > 0
        AND authorised_by_user_id IS NOT NULL AND reason_id IS NOT NULL)
  );

CREATE INDEX tender_manual_settlement_idx
  ON app.tender (tenant_id, tendered_at) WHERE settled_offline_manually;

ALTER TABLE app.table_session_lease ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.table_session_lease
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.sync_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_batch
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.sync_quarantine ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_quarantine
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
