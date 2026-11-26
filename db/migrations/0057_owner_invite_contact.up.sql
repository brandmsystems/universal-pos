-- ###########################################################################
-- WHO THE RESTAURANT MANAGER IS, AS THE CONTROL PLANE IS ALLOWED TO KNOW IT.
--
-- A salesperson's book lists each restaurant's manager by name and phone. The
-- name already travels in the provisioning request and is written to
-- `app.app_user` -- which the control plane must never read. So the contact
-- the SALE recorded is kept where the sale is: on the invite, in `platform`.
-- It is what the manager was invited as, not a live mirror of their profile;
-- a manager who later changes their phone inside the restaurant changes it
-- there, and this column says what the salesperson was given.
-- ###########################################################################
ALTER TABLE platform.tenant_owner_invite
  ADD COLUMN invitee_name text,
  ADD COLUMN invitee_phone text;

ALTER TABLE platform.tenant_owner_invite ADD CONSTRAINT tenant_owner_invite_phone_format CHECK (
  invitee_phone IS NULL OR invitee_phone ~ '^\+?[0-9][0-9 ()-]{5,19}$');
