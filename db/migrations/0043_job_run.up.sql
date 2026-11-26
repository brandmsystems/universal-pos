-- The job run ledger.
--
-- ###########################################################################
-- "IT FAILED" AND "IT NEVER RAN" ARE DIFFERENT ALERTS, AND THE SECOND IS THE
-- ONE THAT GOES UNNOTICED.
--
-- A failing job is loud: something raises, something logs. A job that stopped
-- being scheduled is silent, and the system keeps working for a while because
-- most of these jobs exist to absorb slow drift -- the DEFAULT audit partition
-- swallows inserts for weeks before anyone notices the partition job died.
--
-- Not-having-run cannot be derived from anything the job itself writes, because
-- a job that did not run writes nothing. So it is derived from the REGISTRY
-- (what should have run) against this table (what did), and the absence is the
-- finding.
-- ###########################################################################
CREATE TABLE platform.job_run (
  id           uuid        PRIMARY KEY,
  job_name     text        NOT NULL
               CONSTRAINT job_run_name_format CHECK (job_name ~ '^[a-z][a-z0-9_.]*$'),

  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,

  outcome      text
               CONSTRAINT job_run_outcome_known
               CHECK (outcome IS NULL
                   OR outcome IN ('succeeded', 'failed', 'skipped_locked')),

  -- On failure: what went wrong. On success: whatever the postcondition proved,
  -- so a run that did nothing is distinguishable from one that worked.
  detail       text,
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms >= 0),

  -- Which host ran it. A job flapping between two schedulers is a different
  -- problem from a job failing, and looks identical without this.
  ran_by       text        NOT NULL,

  CONSTRAINT job_run_finished_consistent
  CHECK ((finished_at IS NOT NULL) = (outcome IS NOT NULL)
     AND (finished_at IS NOT NULL) = (duration_ms IS NOT NULL))
);

-- The health query: the most recent run per job, and the most recent SUCCESS,
-- which are different questions.
CREATE INDEX job_run_recent_idx ON platform.job_run (job_name, started_at DESC);
CREATE INDEX job_run_success_idx
  ON platform.job_run (job_name, finished_at DESC) WHERE outcome = 'succeeded';

-- An in-flight run has no finished_at, so a job that hung is visible as a row
-- that never closed rather than as an absence.
CREATE INDEX job_run_in_flight_idx ON platform.job_run (started_at) WHERE finished_at IS NULL;
