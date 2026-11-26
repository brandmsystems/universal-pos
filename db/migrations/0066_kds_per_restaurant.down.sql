-- The entitlement documents and outbox messages 0066 appended are LEFT: a
-- document is a record of what was published, and a rollback must not destroy
-- a record of something that happened (see 0042, 0059). Their `kds` key is read
-- by nothing once the gate is gone.
ALTER TABLE platform.tenant DROP COLUMN kds_enabled;
