-- What the print worker needs, and three decisions written into the schema.

-- ###########################################################################
-- 1. "printed" WAS A LIE. THE STATE IS NAMED `accepted`.
--
-- A thermal printer acknowledging bytes is not evidence that paper came out.
-- The device accepts the job with an empty paper roll, a jammed cutter, or a
-- ribbon nobody has changed, and reports success either way.
--
-- So the terminal success state is named for what we actually know. The honest
-- failure mode is a job that reports `accepted` while the kitchen sees nothing,
-- and no amount of retrying detects it.
--
-- The recourse is not in this table: the KDS shows the ticket regardless. PAPER
-- IS THE REDUNDANCY, NOT THE CHANNEL. That is why a print failure is a branch
-- degradation and not a service outage, and why it alerts the branch rather than
-- stopping the fire.
-- ###########################################################################
ALTER TABLE app.print_job RENAME COLUMN printed_at TO accepted_at;
ALTER TABLE app.print_job RENAME COLUMN next_attempt_at TO available_at;

ALTER TABLE app.print_job DROP CONSTRAINT IF EXISTS print_job_printed_consistent;
ALTER TABLE app.print_job DROP CONSTRAINT IF EXISTS print_job_status_known;

UPDATE app.print_job SET status = 'accepted' WHERE status = 'printed';
UPDATE app.print_job SET status = 'pending'  WHERE status IN ('printing', 'abandoned');

-- The composite FK target every other table in the schema has. print_job never
-- needed one until a job could reference another job.
ALTER TABLE app.print_job
  ADD CONSTRAINT print_job_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE app.print_job
  ADD CONSTRAINT print_job_status_known
  CHECK (status IN ('pending', 'claimed', 'accepted', 'failed')),

  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
  ADD COLUMN failure_reason text,

  -- ##########################################################################
  -- 2. A REPRINT IS A NEW JOB, NEVER A COUNTER ON THE OLD ONE.
  --
  -- A retry is the SYSTEM's repeated attempt at one unconfirmed delivery. A
  -- reprint is a HUMAN asking for another copy because the paper jammed. They
  -- are different events with different actors and different meanings, and
  -- folding them into one counter destroys both:
  --
  --   - `attempts = 3` would mean either "the hardware struggled" or "staff
  --     wanted copies", and nothing could tell them apart afterwards.
  --   - The failure-rate metric would count a kitchen that reprints a lot as
  --     failing hardware, which is the opposite of the truth.
  --   - A reprint has an actor and a reason; a retry has neither.
  --
  -- So a reprint is its own row, pointing at what it copies.
  -- ##########################################################################
  ADD COLUMN origin text NOT NULL DEFAULT 'fire'
    CONSTRAINT print_job_origin_known CHECK (origin IN ('fire', 'reprint')),
  ADD COLUMN reprint_of_job_id uuid,
  ADD COLUMN requested_by_user_id uuid,

  -- ##########################################################################
  -- 3. A FALLBACK COPY SAYS SO, ON THE PAPER.
  --
  -- Falling back sends a grill ticket to the fry printer. That is better than
  -- nothing ONLY if the ticket says where it should have gone -- otherwise a cook
  -- at the fry station silently starts grill work, which is worse than no ticket
  -- because nobody knows it happened.
  -- ##########################################################################
  ADD COLUMN used_fallback boolean NOT NULL DEFAULT false,
  ADD COLUMN fallback_from_printer_id uuid,

  ADD CONSTRAINT print_job_reprint_fk
  FOREIGN KEY (tenant_id, reprint_of_job_id) REFERENCES app.print_job (tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT print_job_requester_fk
  FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES app.app_user (tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT print_job_fallback_from_fk
  FOREIGN KEY (tenant_id, fallback_from_printer_id) REFERENCES app.printer (tenant_id, id)
    ON DELETE RESTRICT,

  -- A reprint must name who asked. "Somebody reprinted it" is as useless as an
  -- unattributed audit row.
  ADD CONSTRAINT print_job_reprint_attributed
  CHECK (origin = 'fire' OR (reprint_of_job_id IS NOT NULL AND requested_by_user_id IS NOT NULL)),

  ADD CONSTRAINT print_job_fallback_consistent
  CHECK (used_fallback = (fallback_from_printer_id IS NOT NULL)),

  ADD CONSTRAINT print_job_status_consistent
  CHECK (
    CASE status
      WHEN 'pending'  THEN accepted_at IS NULL AND claimed_at IS NULL AND failure_reason IS NULL
      WHEN 'claimed'  THEN accepted_at IS NULL AND claimed_at IS NOT NULL
                           AND claimed_by IS NOT NULL
      WHEN 'accepted' THEN accepted_at IS NOT NULL
      -- Terminal. It must say why: the manager walking to the printer needs to
      -- know whether it was unreachable or refused the job.
      WHEN 'failed'   THEN accepted_at IS NULL AND failure_reason IS NOT NULL
      ELSE false
    END
  );

CREATE INDEX print_job_claimable_idx
  ON app.print_job (tenant_id, available_at) WHERE status = 'pending';
CREATE INDEX print_job_claimed_idx
  ON app.print_job (claimed_at) WHERE status = 'claimed';
-- What the BRANCH's screen reads. Not platform system health: a jammed printer
-- is a problem for the manager standing twenty feet from it, and stock and
-- station data must not leave the tenant plane. Same distinction as
-- inventory.negative.
CREATE INDEX print_job_failed_idx
  ON app.print_job (tenant_id, branch_id, created_at DESC) WHERE status = 'failed';


-- The platform-level failure RATE crosses the plane boundary the only way
-- anything does: as a daily aggregate through usage_counter. System health reads
-- those two integers; it never reads app.print_job.
INSERT INTO platform.usage_metric (metric, metric_kind, description) VALUES
  ('print.jobs.total',  'flow', 'Print jobs created on the date, both fires and reprints. Keyed on created_at, not business date: printer health is a wall-clock concern.'),
  ('print.jobs.failed', 'flow', 'Print jobs that reached the terminal failed state on the date.')
ON CONFLICT (metric) DO NOTHING;
