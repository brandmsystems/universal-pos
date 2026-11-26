-- ###########################################################################
-- A SETUP LINK ISSUED AFTER THE MANAGER SIGNED UP IS A PASSWORD RESET, AND IT
-- CARRIES A REASON.
--
-- Until now a restaurant could only get a new setup link BEFORE its manager
-- had signed up; afterwards it was refused, because a link that can set a new
-- password on a live account is a way into that restaurant. The decision now is
-- to allow it -- a manager who has forgotten their password needs a way back in
-- -- but never silently: the reason is required and kept on the invite row, next
-- to who issued it and when. The audit row cannot hold it, because the route's
-- result is the link itself and must never be written to a log.
-- ###########################################################################
ALTER TABLE platform.tenant_owner_invite ADD COLUMN reissue_reason text;

ALTER TABLE platform.tenant_owner_invite ADD CONSTRAINT tenant_owner_invite_reissue_reason_present
  CHECK (reissue_reason IS NULL OR length(btrim(reissue_reason)) >= 3);
