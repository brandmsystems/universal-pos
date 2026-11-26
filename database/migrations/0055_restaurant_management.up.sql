-- ###########################################################################
-- DEACTIVATION IS NOT A RUNG ON THE LADDER.
--
-- Every status `tenant_status_known` allowed until now is a point on the
-- suspension ladder, and every one of them but `active` means "has not paid
-- since day 0" -- which is exactly what `tenant_delinquency_consistent` says.
-- A Super Admin switching a restaurant off is a different fact: a decision
-- with a name and a reason against it, not a clock. Moving such a tenant to
-- hard_lock would have forged a day 0, and the ladder job would then have
-- walked it on to retention and purge on a schedule nobody chose.
--
-- CLAUDE.md anticipated this: "Voluntary termination gets its own status in
-- Phase 1 and this predicate relaxes to set-membership then." This is that
-- relaxation, for the Super Admin's switch.
--
-- The biconditional becomes `status IN ('active','deactivated') = no day 0`.
-- So a deactivated tenant is never delinquent, and the ladder job -- which only
-- ever selects `delinquent_since IS NOT NULL` -- can never touch one. Only an
-- ACTIVE tenant may be deactivated (enforced in `tenantAdmin.ts`): switching
-- off a delinquent tenant would have to clear day 0, which is how a debt gets
-- hidden.
-- ###########################################################################

ALTER TABLE platform.tenant DROP CONSTRAINT tenant_status_known;
ALTER TABLE platform.tenant ADD CONSTRAINT tenant_status_known CHECK (status IN (
  'active', 'past_due', 'soft_lock', 'hard_lock', 'retention', 'purge_pending',
  'purged', 'deactivated'));

ALTER TABLE platform.tenant DROP CONSTRAINT tenant_delinquency_consistent;
ALTER TABLE platform.tenant ADD CONSTRAINT tenant_delinquency_consistent CHECK (
  (status IN ('active', 'deactivated')) = (delinquent_since IS NULL));

-- The decision, its reason and its author move together or not at all. The
-- status is the discriminator; these three are what an investigation reads.
ALTER TABLE platform.tenant
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivation_reason text,
  ADD COLUMN deactivated_by_platform_user_id uuid
    REFERENCES platform.platform_user (id) ON DELETE RESTRICT;

ALTER TABLE platform.tenant ADD CONSTRAINT tenant_deactivation_consistent CHECK (
  (status = 'deactivated') = (deactivated_at IS NOT NULL)
  AND (deactivated_at IS NULL) = (deactivation_reason IS NULL)
  AND (deactivated_at IS NULL) = (deactivated_by_platform_user_id IS NULL));

ALTER TABLE platform.tenant ADD CONSTRAINT tenant_deactivation_reason_present CHECK (
  deactivation_reason IS NULL OR length(btrim(deactivation_reason)) >= 3);

COMMENT ON COLUMN platform.tenant.deactivated_at IS
  'Set exactly while status = deactivated. Reactivation clears it; the history '
  'lives in platform_audit_log, which records both transitions with their reason.';

-- ###########################################################################
-- A SALESPERSON HAS A PHONE NUMBER.
--
-- Nullable: most platform staff never need one on record, and a NOT NULL here
-- would put a placeholder number into every existing row. Format-checked
-- loosely -- digits, spaces, brackets, dashes, an optional leading plus -- so
-- the column cannot hold a note or an email pasted into the wrong field.
-- ###########################################################################
ALTER TABLE platform.platform_user ADD COLUMN phone text;
ALTER TABLE platform.platform_user ADD CONSTRAINT platform_user_phone_format CHECK (
  phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{5,19}$');
