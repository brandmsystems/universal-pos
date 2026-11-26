-- The reason code leaves only where nothing has used it: a void or refund that
-- names it is a record, and the reason row stays with it.
DELETE FROM app.adjustment_reason r
 WHERE r.key = 'bill_corrected'
   AND NOT EXISTS (SELECT 1 FROM app.order_line ol
                    WHERE ol.tenant_id = r.tenant_id AND ol.adjustment_reason_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM app.refund f
                    WHERE f.tenant_id = r.tenant_id AND f.reason_id = r.id);

DROP TABLE app.bill_revision;
ALTER TABLE app.refund DROP CONSTRAINT refund_tenant_id_key;

DROP TABLE app.day_submission;
DROP FUNCTION app.day_submission_transition();
