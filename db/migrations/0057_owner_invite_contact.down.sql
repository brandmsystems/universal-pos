ALTER TABLE platform.tenant_owner_invite DROP CONSTRAINT IF EXISTS tenant_owner_invite_phone_format;
ALTER TABLE platform.tenant_owner_invite
  DROP COLUMN IF EXISTS invitee_phone,
  DROP COLUMN IF EXISTS invitee_name;
