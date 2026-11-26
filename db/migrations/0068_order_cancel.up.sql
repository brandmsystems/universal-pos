-- Cancelling an order that will never be paid.
--
-- ###########################################################################
-- A CANCELLATION HAS A NAME AND A REASON, OR IT IS NOT ONE.
--
-- `sales_order.status` has admitted 'cancelled' since 0027, and the sales
-- reports have excluded it since, but nothing could write it: an order nobody
-- would pay for held its tables until someone paid it with fake money. The
-- write now exists (`order.cancel`), and the CHECK makes the status and its
-- stamps move together -- a cancelled order with no actor is a sale that
-- vanished with nobody to ask about it.
-- ###########################################################################
ALTER TABLE app.sales_order
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_user_id uuid,
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT sales_order_cancelled_by_fk
    FOREIGN KEY (tenant_id, cancelled_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT sales_order_cancellation_consistent CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL
                              AND cancelled_by_user_id IS NOT NULL
                              AND cancel_reason IS NOT NULL)
  ),
  ADD CONSTRAINT sales_order_cancel_reason_present CHECK (
    cancel_reason IS NULL OR length(btrim(cancel_reason)) >= 5
  );
