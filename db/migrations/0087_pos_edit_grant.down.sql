-- A till edit made under a manager's grant is a record, and 0086 has no column
-- for the grant nor room for a till edit naming a submission. So the grant
-- that allowed it -- who, when, why, which submission -- moves INTO the
-- revision's after image before the columns go; the revision row itself stays.
-- The grants' own switching on and off is in the tenant audit log
-- (`day.pos_editing.enabled` / `.disabled`), which this does not touch.
--
-- The 0087 constraints go first: they are what forbid clearing the submission
-- on a till edit that still names its grant.
ALTER TABLE app.bill_revision DROP CONSTRAINT bill_revision_pos_on_submitted_day_needs_grant;
ALTER TABLE app.bill_revision DROP CONSTRAINT bill_revision_grant_fk;

UPDATE app.bill_revision rv
   SET after = rv.after || jsonb_build_object('posEditGrant', jsonb_build_object(
         'grantId', g.id, 'daySubmissionId', g.day_submission_id,
         'enabledByUserId', g.enabled_by_user_id, 'enabledAt', g.enabled_at, 'reason', g.reason)),
       day_submission_id = NULL
  FROM app.pos_edit_grant g
 WHERE g.tenant_id = rv.tenant_id AND g.id = rv.pos_edit_grant_id;

ALTER TABLE app.bill_revision DROP COLUMN pos_edit_grant_id;
ALTER TABLE app.bill_revision
  ADD CONSTRAINT bill_revision_pos_never_on_submitted_day CHECK (authority = 'manager' OR day_submission_id IS NULL);

DROP TABLE app.pos_edit_grant;
DROP FUNCTION app.pos_edit_grant_transition();
