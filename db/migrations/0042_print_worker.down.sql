-- The two metric catalogue rows are deliberately LEFT IN PLACE.
--
-- ###########################################################################
-- A ROLLBACK MUST NOT DESTROY A RECORD OF SOMETHING THAT HAPPENED.
--
-- This used to DELETE them, and it could not work: 0040 added
-- `usage_counter_metric_fk` from platform.usage_counter (metric, metric_kind),
-- with no ON DELETE action, so the delete is refused the moment any tenant has
-- metered a single print job -- which is every real deployment. Rolling back
-- 0042 in production was impossible, and nothing said so because no down had
-- ever been executed. `tests/db/reversibility.test.ts` found it on its first run.
--
-- Deleting the dependent counters first would make the statement succeed and
-- would throw away billing input to undo a code change. So the catalogue rows
-- stay: they are inert without the print worker, `0042.up` re-inserts them with
-- ON CONFLICT (metric) DO NOTHING, and metering history outlives a rollback.
-- ###########################################################################

DROP INDEX IF EXISTS app.print_job_failed_idx;
DROP INDEX IF EXISTS app.print_job_claimed_idx;
DROP INDEX IF EXISTS app.print_job_claimable_idx;

ALTER TABLE app.print_job
  DROP CONSTRAINT IF EXISTS print_job_status_consistent,
  DROP CONSTRAINT IF EXISTS print_job_fallback_consistent,
  DROP CONSTRAINT IF EXISTS print_job_reprint_attributed,
  DROP CONSTRAINT IF EXISTS print_job_fallback_from_fk,
  DROP CONSTRAINT IF EXISTS print_job_requester_fk,
  DROP CONSTRAINT IF EXISTS print_job_reprint_fk,
  DROP COLUMN IF EXISTS fallback_from_printer_id,
  DROP COLUMN IF EXISTS used_fallback,
  DROP COLUMN IF EXISTS requested_by_user_id,
  DROP COLUMN IF EXISTS reprint_of_job_id,
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS failure_reason,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS claimed_at,
  DROP CONSTRAINT IF EXISTS print_job_status_known,
  DROP CONSTRAINT IF EXISTS print_job_tenant_id_key;

UPDATE app.print_job SET status = 'printed' WHERE status = 'accepted';
UPDATE app.print_job SET status = 'pending' WHERE status = 'claimed';

ALTER TABLE app.print_job
  ADD CONSTRAINT print_job_status_known
  CHECK (status IN ('pending', 'printing', 'printed', 'failed', 'abandoned'));

ALTER TABLE app.print_job RENAME COLUMN available_at TO next_attempt_at;
ALTER TABLE app.print_job RENAME COLUMN accepted_at TO printed_at;

ALTER TABLE app.print_job
  ADD CONSTRAINT print_job_printed_consistent
  CHECK ((status = 'printed') = (printed_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS print_job_pending_idx
  ON app.print_job (tenant_id, next_attempt_at) WHERE status IN ('pending', 'failed');
