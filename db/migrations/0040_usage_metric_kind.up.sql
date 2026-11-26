-- ###########################################################################
-- A LEVEL AND A FLOW ARE NOT THE SAME NUMBER, AND THE QUOTA CHECK MUST NOT
-- COMPARE THEM THE SAME WAY.
--
-- `branches` is a LEVEL: how many exist as of that date. The current value is
-- the latest row, and a plan limit of 5 compares against it directly.
--
-- `orders.created` is a FLOW: how many happened ON that date. The latest row is
-- one day's worth, so a plan limit of "10,000 orders a month" compared against it
-- passes at 300 orders a day -- nine thousand over, reported as comfortably
-- inside. A flow has to be SUMMED across the period first.
--
-- Without this the reader cannot tell which it is holding, and the distinction is
-- invisible in the number itself.
-- ###########################################################################

-- The kind is a property of the METRIC, not of a row: `orders.created` is a flow
-- for every tenant on every date. So it lives here once, and the counter pins it
-- by composite FK -- the same denormalise-and-pin shape as
-- membership.role_assignable_scope.
--
-- The consequence that matters: a new metric CANNOT be written until it has been
-- declared here with its kind. Denied until justified, like a new permission key
-- defaulting deny.
CREATE TABLE platform.usage_metric (
  metric      text NOT NULL PRIMARY KEY
              CONSTRAINT usage_metric_name_format CHECK (metric ~ '^[a-z][a-z0-9_.]*$'),
  metric_kind text NOT NULL
              CONSTRAINT usage_metric_kind_known CHECK (metric_kind IN ('level', 'flow')),
  description text NOT NULL,

  -- The FK target. UNIQUE rather than relying on the PK because the counter pins
  -- the pair, not the name alone.
  CONSTRAINT usage_metric_kind_pair_key UNIQUE (metric, metric_kind)
);

INSERT INTO platform.usage_metric (metric, metric_kind, description) VALUES
  ('branches', 'level', 'Active branches as of the date. Compared directly against the plan limit.'),
  ('users',    'level', 'Active app_users as of the date.'),
  ('storage_bytes', 'level',
   'Approximate logical size of the tenant''s rows in the largest tables. Excludes indexes and TOAST overhead; it is an envelope, not a billing figure.'),
  ('orders.created', 'flow', 'Orders opened on the date. Summed across a period before comparison.')
ON CONFLICT (metric) DO NOTHING;

ALTER TABLE platform.usage_counter ADD COLUMN metric_kind text;

-- Anything written before this migration was a level.
UPDATE platform.usage_counter SET metric_kind = 'level' WHERE metric_kind IS NULL;
-- And anything whose name was never declared cannot be pinned, so it goes.
-- The table is a daily rollup: a discarded row is recomputed by the next run.
DELETE FROM platform.usage_counter c
 WHERE NOT EXISTS (SELECT 1 FROM platform.usage_metric m WHERE m.metric = c.metric);

ALTER TABLE platform.usage_counter
  ALTER COLUMN metric_kind SET NOT NULL,
  ADD CONSTRAINT usage_counter_metric_fk
  FOREIGN KEY (metric, metric_kind)
    REFERENCES platform.usage_metric (metric, metric_kind) ON UPDATE CASCADE;

COMMENT ON COLUMN platform.usage_counter.metric_kind IS
  'Pinned from platform.usage_metric. level = a stock, read as the latest value; flow = a rate, summed across the period.';
