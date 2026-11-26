-- A cancelled order stays cancelled: its status predates this migration (0027)
-- and the reports already exclude it. Only the stamps go, so the consistency
-- CHECK goes with them.
ALTER TABLE app.sales_order
  DROP CONSTRAINT sales_order_cancel_reason_present,
  DROP CONSTRAINT sales_order_cancellation_consistent,
  DROP CONSTRAINT sales_order_cancelled_by_fk,
  DROP COLUMN cancel_reason,
  DROP COLUMN cancelled_by_user_id,
  DROP COLUMN cancelled_at;
