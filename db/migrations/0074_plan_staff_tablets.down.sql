-- The entitlement documents and outbox messages 0074 appended are LEFT: a
-- rollback must not destroy a record of something that happened (0042, 0059).
UPDATE platform.plan_version SET features = features - 'staff_tablets';
