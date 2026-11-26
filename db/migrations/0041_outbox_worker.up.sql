-- What the outbox needs before a worker can drain it safely.

-- ###########################################################################
-- STATUS IS A POSITIVE DECLARATION, NOT AN ABSENCE.
--
-- `delivered_at IS NULL` was doing the work of four different states: waiting,
-- in flight, given up on, and done. A message a worker died holding is
-- indistinguishable from one nobody has touched, and a message that will never
-- succeed is indistinguishable from one about to. Absence is never a
-- discriminator.
-- ###########################################################################
ALTER TABLE platform.outbox
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
    CONSTRAINT outbox_status_known
    CHECK (status IN ('pending', 'claimed', 'delivered', 'dead_letter')),

  -- The tenant whose data the consumer will touch, so the dispatcher can set the
  -- RLS GUC without parsing the payload. NULL for a genuinely platform-wide
  -- message; a consumer that touches app tables refuses one.
  ADD COLUMN tenant_id uuid REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  -- ##########################################################################
  -- ORDERED GROUPS.
  --
  -- Stock deductions replayed from an offline device must apply in BUSINESS-DATE
  -- order, not arrival order: weighted average cost is order-dependent, and
  -- applying Tuesday before Monday values Monday's issue against Tuesday's basis.
  --
  -- Ordering is per GROUP, not global. Everything outside a group drains freely.
  -- ##########################################################################
  ADD COLUMN ordered_group text,
  ADD COLUMN order_seq bigint,

  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN dead_letter_reason text,

  -- Per message, so a consumer known to be flaky can be given more rope without
  -- changing the worker.
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0);

-- Rows written before this migration carried their state in delivered_at.
UPDATE platform.outbox SET status = 'delivered' WHERE delivered_at IS NOT NULL;

ALTER TABLE platform.outbox
  ADD CONSTRAINT outbox_status_consistent
  CHECK (
    CASE status
      WHEN 'pending'  THEN delivered_at IS NULL AND claimed_at IS NULL
                           AND dead_lettered_at IS NULL
      WHEN 'claimed'  THEN delivered_at IS NULL AND claimed_at IS NOT NULL
                           AND claimed_by IS NOT NULL AND dead_lettered_at IS NULL
      WHEN 'delivered' THEN delivered_at IS NOT NULL AND dead_lettered_at IS NULL
      -- A terminal state must say WHY. "It failed" is as useless as an
      -- unattributed audit row.
      WHEN 'dead_letter' THEN dead_lettered_at IS NOT NULL
                           AND dead_letter_reason IS NOT NULL
                           AND delivered_at IS NULL
      ELSE false
    END
  ),
  -- An ordered message needs both halves or neither: a group with no sequence
  -- cannot be ordered, and a sequence with no group orders nothing.
  ADD CONSTRAINT outbox_ordering_complete
  CHECK ((ordered_group IS NULL) = (order_seq IS NULL));

DROP INDEX IF EXISTS platform.outbox_pending_idx;
CREATE INDEX outbox_claimable_idx
  ON platform.outbox (available_at) WHERE status = 'pending';
CREATE INDEX outbox_ordered_group_idx
  ON platform.outbox (ordered_group, order_seq)
  WHERE ordered_group IS NOT NULL AND status IN ('pending', 'claimed');
-- The reclaim sweep, and the health widget's stuck-claim count.
CREATE INDEX outbox_claimed_idx ON platform.outbox (claimed_at) WHERE status = 'claimed';
CREATE INDEX outbox_dead_letter_idx
  ON platform.outbox (dead_lettered_at) WHERE status = 'dead_letter';
