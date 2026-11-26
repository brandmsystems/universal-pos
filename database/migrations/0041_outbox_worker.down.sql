DROP INDEX IF EXISTS platform.outbox_dead_letter_idx;
DROP INDEX IF EXISTS platform.outbox_claimed_idx;
DROP INDEX IF EXISTS platform.outbox_ordered_group_idx;
DROP INDEX IF EXISTS platform.outbox_claimable_idx;
CREATE INDEX outbox_pending_idx
  ON platform.outbox (available_at) WHERE delivered_at IS NULL;
ALTER TABLE platform.outbox
  DROP CONSTRAINT IF EXISTS outbox_ordering_complete,
  DROP CONSTRAINT IF EXISTS outbox_status_consistent,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS dead_letter_reason,
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS order_seq,
  DROP COLUMN IF EXISTS ordered_group,
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS status;
