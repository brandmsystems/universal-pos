-- The entitlement documents and outbox messages 0067 appended are LEFT: a
-- rollback must not destroy a record of something that happened (0042, 0059).
-- A restaurant's next publish reads the restored column.

-- Standard goes if nothing was ever sold on it; otherwise it is retired, since
-- a subscription or segment pins its version (ON DELETE RESTRICT) and deleting
-- billing history to undo a code change is the thing 0042 refused to do.
DELETE FROM platform.plan_version pv
 USING platform.plan p
 WHERE p.id = pv.plan_id AND p.key = 'standard'
   AND NOT EXISTS (SELECT 1 FROM platform.subscription s WHERE s.plan_version_id = pv.id)
   AND NOT EXISTS (SELECT 1 FROM platform.subscription_segment g WHERE g.plan_version_id = pv.id)
   AND NOT EXISTS (SELECT 1 FROM platform.scheduled_subscription_change c WHERE c.target_plan_version_id = pv.id);
DELETE FROM platform.plan p
 WHERE p.key = 'standard'
   AND NOT EXISTS (SELECT 1 FROM platform.plan_version pv WHERE pv.plan_id = p.id);
UPDATE platform.plan SET status = 'retired' WHERE key = 'standard';

UPDATE platform.plan_version pv
   SET features = pv.features || jsonb_build_object('kot', false)
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND p.key = 'basic';

UPDATE platform.plan_version SET features = features - 'kds';

ALTER TABLE platform.tenant
  ADD COLUMN kds_enabled boolean NOT NULL DEFAULT true;
