-- The reasons recorded for post-signup resets are lost with the column. Stated
-- so a rollback after real resets is a choice rather than a surprise.
ALTER TABLE platform.tenant_owner_invite DROP CONSTRAINT IF EXISTS tenant_owner_invite_reissue_reason_present;
ALTER TABLE platform.tenant_owner_invite DROP COLUMN IF EXISTS reissue_reason;
