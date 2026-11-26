-- Invite attempts have nowhere to go under the narrowed CHECK. They are
-- security telemetry on a 30-day window, not a record anything derives from,
-- so they are dropped rather than relabelled as another method -- a row that
-- claimed to be a password attempt would be a lie in the one log read during
-- an incident.
DELETE FROM platform.auth_attempt WHERE method = 'owner_invite';
ALTER TABLE platform.auth_attempt DROP CONSTRAINT auth_attempt_method_known;
ALTER TABLE platform.auth_attempt ADD CONSTRAINT auth_attempt_method_known CHECK (
  method IN ('password', 'pin', 'refresh', 'device_enrol'));
