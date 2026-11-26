-- Plans are versioned. Editing a plan creates a version; live subscriptions stay
-- on the version they were sold until explicitly migrated, so a price change
-- cannot silently re-price everyone who already bought.

CREATE TABLE platform.plan (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE
              CONSTRAINT plan_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text        NOT NULL,
  description text,
  status      text        NOT NULL DEFAULT 'active'
              CONSTRAINT plan_status_known CHECK (status IN ('active', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER plan_set_updated_at
  BEFORE UPDATE ON platform.plan
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE platform.plan_version (
  id            uuid        PRIMARY KEY,
  plan_id       uuid        NOT NULL REFERENCES platform.plan (id) ON DELETE RESTRICT,
  version       integer     NOT NULL CHECK (version >= 1),

  -- Integer minor units. Never float, never numeric-with-decimals: the exponent
  -- for a currency is NOT always 2 (JPY is 0, KWD is 3), so any hardcoded /100
  -- is a bug waiting for the first zero-decimal tenant. The exponent is resolved
  -- from currency at presentation, never assumed here.
  price_minor   bigint      NOT NULL CHECK (price_minor >= 0),
  currency      text        NOT NULL CONSTRAINT plan_version_currency_format
                CHECK (currency ~ '^[A-Z]{3}$'),
  billing_period text       NOT NULL
                CONSTRAINT plan_version_period_known
                CHECK (billing_period IN ('monthly', 'yearly')),

  -- Limits and feature flags, published verbatim into the entitlement document.
  limits        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  features      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  published_at  timestamptz,
  created_by_platform_user_id uuid REFERENCES platform.platform_user (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_version_unique UNIQUE (plan_id, version),
  -- FK target for subscription: pins the subscription to a version of a plan,
  -- so it cannot point at a version belonging to a different plan.
  CONSTRAINT plan_version_plan_id_key UNIQUE (plan_id, id)
);

CREATE INDEX plan_version_published_idx ON platform.plan_version (plan_id, published_at DESC);

CREATE TABLE platform.subscription (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  plan_id          uuid        NOT NULL,
  plan_version_id  uuid        NOT NULL,

  -- Commercial state only. The suspension ladder lives on tenant.status, which is
  -- a CACHE derived from delinquent_since plus the configurable thresholds. These
  -- two must never be kept in step by hand: this column says what was sold, that
  -- one says what access follows from it.
  status           text        NOT NULL DEFAULT 'trialing'
                   CONSTRAINT subscription_status_known
                   CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),

  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  cancel_at            timestamptz,
  cancelled_at         timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscription_version_belongs_to_plan
  FOREIGN KEY (plan_id, plan_version_id)
    REFERENCES platform.plan_version (plan_id, id) ON DELETE RESTRICT,

  CONSTRAINT subscription_period_ordered CHECK (current_period_end > current_period_start),
  CONSTRAINT subscription_cancellation_consistent
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- One live subscription per tenant. Cancelled and expired rows are retained.
CREATE UNIQUE INDEX subscription_one_live_per_tenant
  ON platform.subscription (tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE INDEX subscription_by_status_idx ON platform.subscription (status);

CREATE TRIGGER subscription_set_updated_at
  BEFORE UPDATE ON platform.subscription
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Ladder thresholds are configurable platform settings, not constants in code.
CREATE TABLE platform.platform_setting (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.platform_setting (key, value, description) VALUES
  ('ladder.soft_lock_days', '7',   'Days from delinquent_since to read-only.'),
  ('ladder.hard_lock_days', '15',  'Days from delinquent_since to login blocked.'),
  ('ladder.retention_days', '45',  'Days from delinquent_since to export-on-request.'),
  ('ladder.purge_days',     '135', 'Days from delinquent_since to anonymise and drop.');
