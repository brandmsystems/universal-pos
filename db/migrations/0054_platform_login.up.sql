-- ###########################################################################
-- THE CONTROL PLANE HAD A LOCK AND NO DOOR.
--
-- `platform.platform_user` has carried `password_hash`, `failed_login_count`,
-- `locked_until` and `last_login_at` since migration 0002 -- the whole apparatus
-- of a password login, lockout curve included. No route has ever performed that
-- login. Every authentication route in the product is tenant-scoped
-- (`/api/auth/:tenantSlug/...`), and `platformRoute` reads its actor from a JWT
-- `sub` that nothing in the product could mint.
--
-- So all 28 control-plane routes were reachable only by a token signed by hand,
-- and four columns on `platform_user` were written by nothing. Same shape as
-- every other defect this repo has found -- a guard that exists, is correct, and
-- is joined to the running system by nothing -- sitting at the front door.
--
-- This migration does the one schema thing that login needs: give the attempt
-- log somewhere to put a PLATFORM subject.
-- ###########################################################################

-- ###########################################################################
-- WHY A SECOND COLUMN RATHER THAN REUSING `resolved_user_id`.
--
-- 0046 constrains `resolved_user_id IS NULL OR tenant_id IS NOT NULL`: a
-- resolved user implies a resolved tenant. That is right and must stay -- an
-- app_user is meaningless without the tenant it belongs to, and a row naming one
-- without the other cannot be read back safely.
--
-- A platform user has NO tenant, by definition. Putting one in
-- `resolved_user_id` would either violate that constraint or force a fake tenant
-- into the row. And the two id spaces point at different tables, so one column
-- holding both would be a foreign key that cannot be declared -- which is how a
-- log stops being evidence.
-- ###########################################################################
ALTER TABLE platform.auth_attempt
  ADD COLUMN platform_user_id uuid
    REFERENCES platform.platform_user (id) ON DELETE RESTRICT;

COMMENT ON COLUMN platform.auth_attempt.platform_user_id IS
  'The control-plane user a successful platform login resolved to. Mutually '
  'exclusive with tenant_id and resolved_user_id: an attempt belongs to exactly '
  'one plane, and a row claiming both is a row nobody can read back.';

-- The planes are mutually exclusive, and it is asserted rather than assumed.
-- Without this a platform attempt could carry a tenant id, and the first person
-- to read the log during an incident would have to guess which plane a row
-- belonged to.
ALTER TABLE platform.auth_attempt
  ADD CONSTRAINT auth_attempt_one_plane
  CHECK (platform_user_id IS NULL OR (tenant_id IS NULL AND resolved_user_id IS NULL));

-- Reading the log by subject is the question an incident actually asks -- "what
-- did this account do" -- and without an index it is a sequential scan of a
-- partitioned, retention-managed table.
CREATE INDEX auth_attempt_platform_user_idx
  ON platform.auth_attempt (platform_user_id, occurred_at DESC)
  WHERE platform_user_id IS NOT NULL;
