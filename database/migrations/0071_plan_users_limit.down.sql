-- The entitlement documents and outbox messages 0071 appended are LEFT: a
-- rollback must not destroy a record of something that happened (0042, 0059).
-- A restaurant's next publish reads the versions as they are restored here.
UPDATE platform.plan_version SET limits = limits - 'users';
