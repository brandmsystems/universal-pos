ALTER TABLE platform.usage_counter
  DROP CONSTRAINT IF EXISTS usage_counter_metric_fk,
  DROP COLUMN IF EXISTS metric_kind;
DROP TABLE IF EXISTS platform.usage_metric;
