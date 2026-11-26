-- Gateway integration, dunning, and the usage rollup the downgrade check reads.
-- Control plane only.

-- ###########################################################################
-- USAGE FLOWS UP, AS AGGREGATES.
--
-- The over-quota downgrade check needs to know how many branches a tenant has.
-- It must NOT ask schema `app` -- the control plane never queries tenant data.
-- It reads this, written by a daily rollup job on the tenant side.
-- ###########################################################################
CREATE TABLE platform.usage_counter (
  tenant_id     uuid   NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  metric        text   NOT NULL
                CONSTRAINT usage_metric_format CHECK (metric ~ '^[a-z][a-z0-9_.]*$'),
  as_of_date    date   NOT NULL,
  value         bigint NOT NULL CHECK (value >= 0),
  recorded_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, metric, as_of_date)
);

CREATE INDEX usage_counter_latest_idx
  ON platform.usage_counter (tenant_id, metric, as_of_date DESC);


-- ###########################################################################
-- A WEBHOOK IS NEVER THE SOLE SOURCE OF TRUTH.
--
-- Delivery is at-least-once, out of order, and replayable by anyone who can
-- reach the endpoint. So: signature verification is mandatory, the gateway's own
-- event id is the idempotency key, and a reconciliation job against the gateway's
-- API is what makes a MISSED webhook self-heal. A system that only learns by
-- webhook has no way to discover what it never received.
-- ###########################################################################
CREATE TABLE platform.gateway_event (
  id                uuid        PRIMARY KEY,
  gateway           text        NOT NULL
                    CONSTRAINT gateway_known CHECK (gateway IN ('razorpay', 'stripe', 'manual')),

  -- The gateway's id, not ours. Replay protection lives here: a redelivered or
  -- attacker-replayed event collides and is recognised rather than reprocessed.
  gateway_event_id  text        NOT NULL,
  event_type        text        NOT NULL,

  -- The gateway's own ordering stamp. Out-of-order delivery is normal, so state
  -- transitions are guarded on this being newer -- the same monotonic protection
  -- as entitlement_document.version, for the same reason.
  gateway_created_at timestamptz NOT NULL,

  tenant_id         uuid        REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  payload           jsonb       NOT NULL,

  -- Recorded, not assumed. An event that failed verification is kept as evidence
  -- of an attempted forgery and must never be processed.
  signature_verified boolean    NOT NULL,

  status            text        NOT NULL DEFAULT 'pending'
                    CONSTRAINT gateway_event_status_known
                    CHECK (status IN ('pending', 'processed', 'ignored', 'rejected', 'failed')),
  status_detail     text,

  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,

  CONSTRAINT gateway_event_idempotent UNIQUE (gateway, gateway_event_id),
  CONSTRAINT gateway_event_processed_consistent
  CHECK ((status IN ('processed', 'ignored')) = (processed_at IS NOT NULL)),
  -- An unverified event may only ever be rejected. It cannot reach any other
  -- terminal state, so no code path can process one by omission.
  CONSTRAINT gateway_event_unverified_is_rejected
  CHECK (signature_verified OR status IN ('pending', 'rejected'))
);

CREATE INDEX gateway_event_unprocessed_idx
  ON platform.gateway_event (gateway, received_at) WHERE status = 'pending';
CREATE INDEX gateway_event_by_tenant_idx
  ON platform.gateway_event (tenant_id, gateway_created_at DESC);


-- ###########################################################################
-- NEVER STORE A CARD NUMBER. The prohibition is absolute: token references only.
--
-- The CHECK below is not decoration. It refuses any value containing a 13-19
-- digit run, which is what a PAN looks like, so a bug that wrote one through this
-- column fails the INSERT instead of persisting it.
-- ###########################################################################
CREATE TABLE platform.gateway_payment (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  invoice_id         uuid        REFERENCES platform.invoice (id) ON DELETE RESTRICT,

  gateway            text        NOT NULL,
  gateway_payment_id text        NOT NULL,

  amount_minor       bigint      NOT NULL CHECK (amount_minor > 0),
  currency           text        NOT NULL
                     CONSTRAINT gateway_payment_currency_format CHECK (currency ~ '^[A-Z]{3}$'),

  status             text        NOT NULL
                     CONSTRAINT gateway_payment_status_known
                     CHECK (status IN ('pending', 'captured', 'failed', 'refunded')),
  failure_code       text,

  -- A gateway token, plus the last four and the brand for display. Nothing else
  -- about the instrument is ours to hold.
  method_token       text
                     CONSTRAINT gateway_payment_token_is_not_a_pan
                     CHECK (method_token IS NULL OR method_token !~ '[0-9]{13,19}'),
  method_brand       text,
  method_last4       text CONSTRAINT gateway_payment_last4_format
                     CHECK (method_last4 IS NULL OR method_last4 ~ '^[0-9]{4}$'),

  captured_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gateway_payment_idempotent UNIQUE (gateway, gateway_payment_id),
  CONSTRAINT gateway_payment_captured_consistent
  CHECK ((status = 'captured') = (captured_at IS NOT NULL))
);

CREATE INDEX gateway_payment_by_invoice_idx ON platform.gateway_payment (invoice_id);


-- Retry with backoff, because a first failure is usually a bank decline rather
-- than a delinquent customer. The schedule is a platform setting, not a constant.
CREATE TABLE platform.dunning_attempt (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  invoice_id     uuid        NOT NULL REFERENCES platform.invoice (id) ON DELETE RESTRICT,

  attempt_no     integer     NOT NULL CHECK (attempt_no > 0),
  scheduled_at   timestamptz NOT NULL,
  attempted_at   timestamptz,

  outcome        text
                 CONSTRAINT dunning_outcome_known
                 CHECK (outcome IS NULL
                     OR outcome IN ('succeeded', 'declined', 'error', 'abandoned')),
  gateway_error_code text,
  gateway_payment_id uuid REFERENCES platform.gateway_payment (id) ON DELETE RESTRICT,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dunning_attempt_unique UNIQUE (invoice_id, attempt_no),
  CONSTRAINT dunning_attempt_outcome_consistent
  CHECK ((attempted_at IS NOT NULL) = (outcome IS NOT NULL))
);

CREATE INDEX dunning_attempt_due_idx
  ON platform.dunning_attempt (scheduled_at) WHERE attempted_at IS NULL;


-- The one-click contact-owner from the Phase 1 spec. It LOGS: an outreach nobody
-- recorded is an outreach the next person repeats, and a tenant who has been
-- chased four times in a day is a tenant who leaves.
CREATE TABLE platform.dunning_outreach (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  invoice_id          uuid        REFERENCES platform.invoice (id) ON DELETE RESTRICT,

  channel             text        NOT NULL
                      CONSTRAINT dunning_outreach_channel_known
                      CHECK (channel IN ('email', 'phone', 'in_app')),
  contacted_by_platform_user_id uuid NOT NULL
                      REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dunning_outreach_by_tenant_idx
  ON platform.dunning_outreach (tenant_id, created_at DESC);


INSERT INTO platform.platform_setting (key, value, description) VALUES
  ('dunning.retry_offset_days', '[1, 3, 5, 7]',
   'Days after the previous attempt to retry a failed payment. A first failure is usually a bank decline; the ladder thresholds, not this list, decide suspension.'),
  ('dunning.max_attempts', '4',
   'Attempts before the invoice is abandoned to the ladder. Exhausting retries never itself suspends.'),
  ('invoice.due_days', '7', 'Days from issue to due date.'),
  ('invoice.gst_rate_bps', '1800', 'Headline GST rate on SaaS. Snapshotted per invoice line.'),
  ('invoice.sac_code', '"997331"', 'Licensing services for the right to use software.')
ON CONFLICT (key) DO NOTHING;
