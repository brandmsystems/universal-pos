-- The lease becomes a bearer credential, not a claim the client makes about
-- itself.
--
-- ###########################################################################
-- WHY A TOKEN AND NOT THE DEVICE ID.
--
-- `lease: 'required'` was, until now, a header-PRESENCE check: any non-empty
-- `X-Lease-Token` satisfied it, and `requireLease` -- which resolves the real
-- lease row and is correct -- had exactly one caller in the whole tree, a test.
-- A device that had just been force-released could keep POSTing lines online,
-- which is the precise failure the lease exists to prevent, and it is the
-- failure force release deliberately creates a window for on the assumption
-- that later writes are refused.
--
-- The device id cannot be the credential. It is not a secret: it appears in
-- audit rows, in KOT local references, in logs, and it is stable across claims.
-- Stability is the disqualifying property, not secrecy: a token that does not
-- change across claims cannot distinguish "you still hold the lease you queued
-- this operation under" from "the lease was taken away from you and later
-- granted back". The client queue already assumes it can -- it attaches the
-- token the operation was ENQUEUED under, so that a stranded batch arrives
-- carrying the OLD token and is quarantined rather than merged. That assumption
-- was unmet on the server side.
--
-- So: one token per CLAIM row. A claim mints it; renewal keeps it (a renewing
-- terminal must not have to re-plumb its queue mid-service); release and force
-- release end that row, and the next claim -- same device or another -- is a new
-- row with a new token. The token is therefore a lease EPOCH identifier, which
-- is what the quarantine rule needs, and a secret, which is what the online
-- write path needs.
-- ###########################################################################
ALTER TABLE app.table_session_lease
  ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid();

-- Tenant-scoped and unique: the guard looks the lease up BY token, so a
-- collision would be a cross-session write authority. Tenant-scoped because
-- every lookup already carries the tenant from a verified claim, and a global
-- unique index on a tenant table is a cross-tenant probe surface.
CREATE UNIQUE INDEX table_session_lease_token_uk
  ON app.table_session_lease (tenant_id, token);
