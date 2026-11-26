DELETE FROM platform.platform_setting WHERE key IN (
  'dunning.retry_offset_days', 'dunning.max_attempts',
  'invoice.due_days', 'invoice.gst_rate_bps', 'invoice.sac_code');
DROP TABLE IF EXISTS platform.dunning_outreach;
DROP TABLE IF EXISTS platform.dunning_attempt;
DROP TABLE IF EXISTS platform.gateway_payment;
DROP TABLE IF EXISTS platform.gateway_event;
DROP TABLE IF EXISTS platform.usage_counter;
