-- Staff-invite attempts are 30-day telemetry, not a record anything derives
-- from; they are dropped rather than relabelled, as 0056's down does.
DELETE FROM platform.auth_attempt WHERE method = 'staff_invite';
ALTER TABLE platform.auth_attempt DROP CONSTRAINT auth_attempt_method_known;
ALTER TABLE platform.auth_attempt ADD CONSTRAINT auth_attempt_method_known CHECK (
  method IN ('password', 'pin', 'refresh', 'device_enrol', 'owner_invite'));

DROP INDEX app.staff_invite_one_pending_per_code;

-- An invite with no email cannot survive the NOT NULL coming back. A pending
-- one is only an unused setup code; an accepted one has already done its work
-- (the user, credential and membership it created stay).
DELETE FROM app.staff_invite WHERE email IS NULL;

ALTER TABLE app.staff_invite
  DROP CONSTRAINT staff_invite_credential_needs_identifier,
  DROP CONSTRAINT staff_invite_identified,
  DROP COLUMN credential_type,
  DROP COLUMN phone,
  DROP COLUMN employee_code,
  ALTER COLUMN email SET NOT NULL;

DROP TABLE platform.tenant_logo;

ALTER TABLE platform.tenant
  DROP COLUMN theme_color,
  DROP COLUMN address;
