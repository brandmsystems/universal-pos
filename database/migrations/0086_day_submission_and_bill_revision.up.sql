-- Day end and bill editing.
--
-- ###########################################################################
-- 1. A SUBMITTED DAY IS A ROW, AND A REOPENING IS A STAMP ON IT.
--
-- The till submits the business day once its bills are reviewed: the bill count
-- and the day's figures as they stood are kept on the row, so "what was handed
-- over" is never recomputed from bills that may since have changed. While a
-- `submitted` row stands, no till may change a bill of that day.
--
-- Only a manager reopens it, with a reason, and the reopening is stamped on the
-- SAME row (status `reopened`), never by deleting it. Submitting again after a
-- reopening is a new row. A day with bills made after its submission (orders
-- taken before the business day ended) may be submitted again; the earlier row
-- is then `superseded`, never rewritten. One live submission per branch per day,
-- by a partial unique index, so a double tap cannot submit a day twice.
-- ###########################################################################
CREATE TABLE app.day_submission (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id             uuid        NOT NULL,
  business_date         date        NOT NULL,
  status                text        NOT NULL DEFAULT 'submitted'
                        CONSTRAINT day_submission_status_known
                        CHECK (status IN ('submitted', 'reopened', 'superseded')),
  submitted_by_user_id  uuid        NOT NULL,
  submitted_at          timestamptz NOT NULL DEFAULT now(),

  -- The day as it was handed over. Non-void bills only; voided ones are counted apart.
  bill_count            integer     NOT NULL CHECK (bill_count >= 0),
  void_bill_count       integer     NOT NULL CHECK (void_bill_count >= 0),
  sales_minor           bigint      NOT NULL CHECK (sales_minor >= 0),
  tax_minor             bigint      NOT NULL CHECK (tax_minor >= 0),
  payable_minor         bigint      NOT NULL,
  collected_minor       bigint      NOT NULL,
  refunded_minor        bigint      NOT NULL CHECK (refunded_minor >= 0),
  methods               jsonb       NOT NULL DEFAULT '[]'::jsonb
                        CONSTRAINT day_submission_methods_array CHECK (jsonb_typeof(methods) = 'array'),

  reopened_by_user_id   uuid,
  reopened_at           timestamptz,
  reopen_reason         text
                        CONSTRAINT day_submission_reopen_reason_length
                        CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 5 AND 500),
  superseded_at         timestamptz,

  CONSTRAINT day_submission_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT day_submission_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT day_submission_submitter_fk
  FOREIGN KEY (tenant_id, submitted_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT day_submission_reopener_fk
  FOREIGN KEY (tenant_id, reopened_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- A reopening carries who, when and why, all three or none; so does nothing else.
  CONSTRAINT day_submission_reopen_consistent CHECK (
    (status = 'reopened') = (reopened_at IS NOT NULL)
    AND (reopened_at IS NULL) = (reopened_by_user_id IS NULL)
    AND (reopened_at IS NULL) = (reopen_reason IS NULL)
  ),
  CONSTRAINT day_submission_superseded_consistent CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX day_submission_one_live
  ON app.day_submission (tenant_id, branch_id, business_date) WHERE status = 'submitted';
CREATE INDEX day_submission_by_day ON app.day_submission (tenant_id, branch_id, business_date);

ALTER TABLE app.day_submission ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.day_submission
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE DELETE, TRUNCATE ON app.day_submission FROM katkitchen_app;

-- What was handed over never changes; only a live submission moves, and only
-- forward (reopened, or superseded by a later submission of the same day).
CREATE FUNCTION app.day_submission_transition() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF (NEW.tenant_id, NEW.branch_id, NEW.business_date, NEW.submitted_by_user_id, NEW.submitted_at,
      NEW.bill_count, NEW.void_bill_count, NEW.sales_minor, NEW.tax_minor, NEW.payable_minor,
      NEW.collected_minor, NEW.refunded_minor, NEW.methods)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.branch_id, OLD.business_date, OLD.submitted_by_user_id, OLD.submitted_at,
      OLD.bill_count, OLD.void_bill_count, OLD.sales_minor, OLD.tax_minor, OLD.payable_minor,
      OLD.collected_minor, OLD.refunded_minor, OLD.methods) THEN
    RAISE EXCEPTION 'day submission %: what was submitted is a record and does not change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'day submission % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER day_submission_transition
  BEFORE UPDATE ON app.day_submission
  FOR EACH ROW EXECUTE FUNCTION app.day_submission_transition();

-- ###########################################################################
-- 2. EVERY EDIT OF A BILL IS A REVISION ROW, APPEND-ONLY.
--
-- An edit never changes a bill in place. An unpaid bill is voided (kept, with
-- its number) and REISSUED; a paid one keeps its payments untouched and gets a
-- SUPPLEMENTARY bill for items added (collected through the normal payment
-- flow) and a REFUND, a credit note, for items taken off. This row ties the
-- edited bill to what replaced or followed it, with who, when, why, the
-- capacity it was made in (`pos` before day end, or `manager`) and, for a
-- manager edit of a submitted day, the reopening that allowed it.
--
-- The before and after images are the bill's own lines and figures, as the
-- server computed them.
-- ###########################################################################
ALTER TABLE app.refund ADD CONSTRAINT refund_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE app.bill_revision (
  id                     uuid        PRIMARY KEY,
  tenant_id              uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id              uuid        NOT NULL,
  business_date          date        NOT NULL,
  bill_id                uuid        NOT NULL,
  replacement_bill_id    uuid,
  supplementary_bill_id  uuid,
  refund_id              uuid,
  authority              text        NOT NULL
                         CONSTRAINT bill_revision_authority_known CHECK (authority IN ('pos', 'manager')),
  day_submission_id      uuid,
  reason                 text        NOT NULL
                         CONSTRAINT bill_revision_reason_length CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  edited_by_user_id      uuid        NOT NULL,
  edited_at              timestamptz NOT NULL DEFAULT now(),
  before                 jsonb       NOT NULL,
  after                  jsonb       NOT NULL,
  before_payable_minor   bigint      NOT NULL,
  after_payable_minor    bigint      NOT NULL,

  CONSTRAINT bill_revision_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT bill_revision_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_replacement_fk
  FOREIGN KEY (tenant_id, replacement_bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_supplementary_fk
  FOREIGN KEY (tenant_id, supplementary_bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_refund_fk
  FOREIGN KEY (tenant_id, refund_id) REFERENCES app.refund (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_submission_fk
  FOREIGN KEY (tenant_id, day_submission_id) REFERENCES app.day_submission (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_revision_editor_fk
  FOREIGN KEY (tenant_id, edited_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- A till edit is never made on a submitted day, so it never names a reopening.
  CONSTRAINT bill_revision_pos_never_on_submitted_day CHECK (authority = 'manager' OR day_submission_id IS NULL),
  -- Reissued (unpaid), or followed by a supplementary bill and/or a refund (paid), never
  -- both. A paid bill may also lose a line that carried no money, which moves none.
  CONSTRAINT bill_revision_outcome CHECK (
    replacement_bill_id IS NULL OR (supplementary_bill_id IS NULL AND refund_id IS NULL)
  ),
  CONSTRAINT bill_revision_images_objects CHECK (jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object')
);

CREATE INDEX bill_revision_by_bill ON app.bill_revision (tenant_id, bill_id);
CREATE INDEX bill_revision_by_replacement ON app.bill_revision (tenant_id, replacement_bill_id)
  WHERE replacement_bill_id IS NOT NULL;
CREATE INDEX bill_revision_by_supplementary ON app.bill_revision (tenant_id, supplementary_bill_id)
  WHERE supplementary_bill_id IS NOT NULL;

ALTER TABLE app.bill_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_revision
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON app.bill_revision FROM katkitchen_app;

-- ###########################################################################
-- 3. THE REASON CODE AN EDIT'S VOIDS AND REFUNDS CARRY.
--
-- A void line and a refund each reference a reason of their kind. An edit's
-- own words are its reason (on the revision row and on each adjustment's note);
-- the code says only that it was a bill correction. Seeded for every existing
-- restaurant here, and for new ones by DEFAULT_ADJUSTMENT_REASONS.
-- ###########################################################################
INSERT INTO app.adjustment_reason (id, tenant_id, key, name)
SELECT gen_random_uuid(), t.id, 'bill_corrected', 'Bill corrected'
  FROM platform.tenant t
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO app.adjustment_reason_kind (tenant_id, reason_id, kind)
SELECT r.tenant_id, r.id, k.kind
  FROM app.adjustment_reason r
 CROSS JOIN (VALUES ('void'), ('refund')) AS k (kind)
 WHERE r.key = 'bill_corrected'
ON CONFLICT (tenant_id, reason_id, kind) DO NOTHING;
