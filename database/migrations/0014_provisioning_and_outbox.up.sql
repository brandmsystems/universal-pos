-- Provisioning must be idempotent under retry AND under concurrent duplicate.
--
-- The idempotency key carries a UNIQUE constraint, so two simultaneous requests
-- with the same key do not race to create two tenants -- one inserts, the other
-- gets a unique violation and reads the winner's result. Application-side
-- "check then insert" cannot do this; only the constraint can.
CREATE TABLE platform.provisioning_request (
  idempotency_key text        PRIMARY KEY
                  CONSTRAINT provisioning_key_length CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  -- DEFERRABLE INITIALLY DEFERRED, and that is load-bearing.
  --
  -- The claim row must be inserted BEFORE the tenant exists: the primary key on
  -- idempotency_key is what arbitrates two concurrent requests, and it can only
  -- do that if it is written first. An immediate FK would reject the claim for
  -- pointing at a tenant that is two statements away from existing.
  --
  -- The PK is still checked immediately -- uniqueness is not deferred -- so the
  -- race is decided at the moment of the claim and the FK is verified at COMMIT.
  tenant_id       uuid        NOT NULL
                  REFERENCES platform.tenant (id) ON DELETE RESTRICT
                  DEFERRABLE INITIALLY DEFERRED,
  request_digest  bytea       NOT NULL,
  requested_by_platform_user_id uuid
                  REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provisioning_request_tenant_idx ON platform.provisioning_request (tenant_id);

-- Side effects never run inline in the provisioning transaction: an email that
-- fails must not roll back a tenant, and a tenant that rolls back must not have
-- sent an email.
--
-- Delivery is AT LEAST ONCE. A worker can crash between handing a message to a
-- downstream system and marking it delivered, so the same message will sometimes
-- arrive twice. Every consumer must therefore be idempotent -- keyed on
-- dedupe_key, which is stable across redeliveries of the same logical event.
CREATE TABLE platform.outbox (
  id           uuid        PRIMARY KEY,
  topic        text        NOT NULL,
  dedupe_key   text        NOT NULL,
  payload      jsonb       NOT NULL,

  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   text,
  delivered_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_dedupe_unique UNIQUE (topic, dedupe_key)
);

-- The drain query: undelivered, due, oldest first.
CREATE INDEX outbox_pending_idx
  ON platform.outbox (available_at)
  WHERE delivered_at IS NULL;

-- A consumer-side ledger. At-least-once delivery means the consumer, not the
-- broker, is responsible for exactly-once EFFECT -- this is where that is made
-- true rather than assumed.
CREATE TABLE platform.outbox_consumption (
  consumer   text        NOT NULL,
  topic      text        NOT NULL,
  dedupe_key text        NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (consumer, topic, dedupe_key)
);
