ALTER TABLE platform.platform_user DROP CONSTRAINT IF EXISTS platform_user_phone_format;
ALTER TABLE platform.platform_user DROP COLUMN IF EXISTS phone;

-- ###########################################################################
-- A DEACTIVATED TENANT HAS NO HOME IN THE OLD STATUS SET, AND THIS PICKS ONE.
--
-- The narrowed CHECK refuses the value, so the rows must move first. `active`
-- is chosen over any ladder rung deliberately: hard_lock would need a forged
-- day 0, and the ladder job would then advance a tenant nobody billed towards
-- retention and purge. Returning to active RE-OPENS LOGIN for a restaurant a
-- Super Admin switched off -- stated here so whoever runs this is choosing it.
-- The decision itself survives in platform_audit_log.
-- ###########################################################################
-- The constraint that ties status to the deactivation columns goes FIRST: it
-- would refuse this very UPDATE (active with deactivated_at still set). Found
-- by the reversibility gate on a database holding a deactivated tenant -- the
-- only place this rollback could ever fail.
ALTER TABLE platform.tenant DROP CONSTRAINT IF EXISTS tenant_deactivation_reason_present;
ALTER TABLE platform.tenant DROP CONSTRAINT IF EXISTS tenant_deactivation_consistent;

UPDATE platform.tenant
   SET status = 'active', status_changed_at = now()
 WHERE status = 'deactivated';

ALTER TABLE platform.tenant
  DROP COLUMN IF EXISTS deactivated_by_platform_user_id,
  DROP COLUMN IF EXISTS deactivation_reason,
  DROP COLUMN IF EXISTS deactivated_at;

ALTER TABLE platform.tenant DROP CONSTRAINT tenant_delinquency_consistent;
ALTER TABLE platform.tenant ADD CONSTRAINT tenant_delinquency_consistent CHECK (
  (status = 'active') = (delinquent_since IS NULL));

ALTER TABLE platform.tenant DROP CONSTRAINT tenant_status_known;
ALTER TABLE platform.tenant ADD CONSTRAINT tenant_status_known CHECK (status IN (
  'active', 'past_due', 'soft_lock', 'hard_lock', 'retention', 'purge_pending',
  'purged'));
