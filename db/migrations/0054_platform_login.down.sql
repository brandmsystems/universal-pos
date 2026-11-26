DROP INDEX IF EXISTS platform.auth_attempt_platform_user_idx;

ALTER TABLE platform.auth_attempt
  DROP CONSTRAINT IF EXISTS auth_attempt_one_plane;

-- Dropping the column destroys the record of who signed in to the control plane.
-- That is acceptable ONLY because this is a reversal of an unshipped change; a
-- reversal after the log has been read in anger is a different decision, and
-- there is no way for a migration to tell the two apart. Stated so the next
-- person is choosing rather than discovering.
ALTER TABLE platform.auth_attempt
  DROP COLUMN IF EXISTS platform_user_id;
