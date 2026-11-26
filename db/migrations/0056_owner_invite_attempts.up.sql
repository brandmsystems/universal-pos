-- ###########################################################################
-- REDEEMING AN OWNER INVITE IS A CREDENTIAL EVENT, SO IT IS LOGGED AS ONE.
--
-- `tenant_owner_invite` has held a token hash since phase 1 and nothing could
-- redeem it: a provisioned restaurant's manager had no way to set a password,
-- so no restaurant created through the console could ever sign in. The
-- redemption route this migration makes room for is public, takes a bearer
-- secret, and is exactly the kind of endpoint someone walks guesses against --
-- so its attempts belong beside password, PIN and enrolment attempts in
-- `platform.auth_attempt`, not nowhere.
-- ###########################################################################
ALTER TABLE platform.auth_attempt DROP CONSTRAINT auth_attempt_method_known;
ALTER TABLE platform.auth_attempt ADD CONSTRAINT auth_attempt_method_known CHECK (
  method IN ('password', 'pin', 'refresh', 'device_enrol', 'owner_invite'));
