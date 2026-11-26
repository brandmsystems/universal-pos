-- Allow POS Bill Editing: a manager lets the till edit today's submitted bills.
--
-- ###########################################################################
-- A GRANT BELONGS TO ONE SUBMISSION OF ONE BUSINESS DAY, AND IS OFF BY DEFAULT.
--
-- Submitting a day locks its bills for the till (0086). A manager may switch
-- the lock off for the TILL, for today only, without reopening the day: that is
-- a row here, naming the submission it relaxes. Switching it off again stamps
-- the same row (status `off`); it is never deleted. A later submission of the
-- day supersedes the submission and, with it, the grant: after every Submit Day
-- Bills the till is locked until a manager says otherwise.
--
-- The grant is honoured only while its submission is the day's current one and
-- the day is the branch's business day TODAY (`assertMayEditDay`, under the day
-- lock); a previous day never opens to the till, grant or not.
-- ###########################################################################
CREATE TABLE app.pos_edit_grant (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id            uuid        NOT NULL,
  business_date        date        NOT NULL,
  day_submission_id    uuid        NOT NULL,
  status               text        NOT NULL DEFAULT 'on'
                       CONSTRAINT pos_edit_grant_status_known CHECK (status IN ('on', 'off')),
  enabled_by_user_id   uuid        NOT NULL,
  enabled_at           timestamptz NOT NULL DEFAULT now(),
  reason               text        NOT NULL
                       CONSTRAINT pos_edit_grant_reason_length CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  disabled_by_user_id  uuid,
  disabled_at          timestamptz,

  CONSTRAINT pos_edit_grant_tenant_id_key UNIQUE (tenant_id, id),
  -- What a revision pins: the grant AND the submission it relaxed, together.
  CONSTRAINT pos_edit_grant_submission_key UNIQUE (tenant_id, id, day_submission_id),
  CONSTRAINT pos_edit_grant_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pos_edit_grant_submission_fk
  FOREIGN KEY (tenant_id, day_submission_id) REFERENCES app.day_submission (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pos_edit_grant_enabler_fk
  FOREIGN KEY (tenant_id, enabled_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pos_edit_grant_disabler_fk
  FOREIGN KEY (tenant_id, disabled_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- Switched off carries who and when, both or neither; so does nothing else.
  CONSTRAINT pos_edit_grant_off_consistent CHECK (
    (status = 'off') = (disabled_at IS NOT NULL) AND (disabled_at IS NULL) = (disabled_by_user_id IS NULL)
  )
);

-- One switched-on grant per submission: switching on twice is one grant.
CREATE UNIQUE INDEX pos_edit_grant_one_on
  ON app.pos_edit_grant (tenant_id, day_submission_id) WHERE status = 'on';
CREATE INDEX pos_edit_grant_by_day ON app.pos_edit_grant (tenant_id, branch_id, business_date);

ALTER TABLE app.pos_edit_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.pos_edit_grant
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE DELETE, TRUNCATE ON app.pos_edit_grant FROM katkitchen_app;

-- Who switched it on, when and why never changes; only `on` moves, to `off`.
CREATE FUNCTION app.pos_edit_grant_transition() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF (NEW.tenant_id, NEW.branch_id, NEW.business_date, NEW.day_submission_id,
      NEW.enabled_by_user_id, NEW.enabled_at, NEW.reason)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.branch_id, OLD.business_date, OLD.day_submission_id,
      OLD.enabled_by_user_id, OLD.enabled_at, OLD.reason) THEN
    RAISE EXCEPTION 'POS edit grant %: who allowed it, when and why is a record and does not change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'on' THEN
    RAISE EXCEPTION 'POS edit grant % is switched off and stays off; switching on again is a new grant', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER pos_edit_grant_transition
  BEFORE UPDATE ON app.pos_edit_grant
  FOR EACH ROW EXECUTE FUNCTION app.pos_edit_grant_transition();

-- ###########################################################################
-- A TILL EDIT OF A SUBMITTED DAY NAMES THE GRANT IT RAN UNDER.
--
-- 0086 said a till edit never names a submission. Now it may, and then it must
-- name the manager's grant too, pinned together so the grant is one that
-- relaxed THAT submission. A manager edit never names a grant.
-- ###########################################################################
ALTER TABLE app.bill_revision ADD COLUMN pos_edit_grant_id uuid;
ALTER TABLE app.bill_revision DROP CONSTRAINT bill_revision_pos_never_on_submitted_day;
ALTER TABLE app.bill_revision
  ADD CONSTRAINT bill_revision_grant_fk
  FOREIGN KEY (tenant_id, pos_edit_grant_id, day_submission_id)
  REFERENCES app.pos_edit_grant (tenant_id, id, day_submission_id) ON DELETE RESTRICT,
  ADD CONSTRAINT bill_revision_pos_on_submitted_day_needs_grant CHECK (
    CASE authority
      WHEN 'pos' THEN (day_submission_id IS NULL) = (pos_edit_grant_id IS NULL)
      ELSE pos_edit_grant_id IS NULL
    END
  );
