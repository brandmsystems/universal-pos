import type { TenantContext } from '../../database/tenantContext.js';

/**
 * The Billing screen's queue: every order KOT handed over that is still open,
 * whatever day it started, plus today's finished ones -- and where each stands.
 * An unpaid order does not stop being owed at midnight: filtering the open ones
 * to today hid yesterday's from the only screen that could settle them, while
 * the floor kept showing their tables taken. Read from the same session, order and bills KOT wrote -- there is no
 * billing copy of an order to fall out of step with it.
 *
 *   ready        handed over, no bill yet
 *   in_progress  billed, money still owed (or paid in full and not yet closed)
 *   completed    paid and closed
 *   cancelled    cancelled by a manager, nothing paid
 *
 * The figures are the server's, in one statement: the amount from the order's
 * snapshotted lines, and billed / paid from the bill and tender rows, summed
 * the same way the board sums them (a void tender is a negative row).
 *
 * `payment` says how much of the bill is paid -- none, part or all -- so a
 * screen never calls a printed, unpaid bill "part paid", and never compares the
 * two figures itself. A PAID order is listed on the day it was closed, not
 * only the day it started: an order left over from yesterday and paid today
 * belongs in today's completed list, not nowhere. A cancelled leftover still
 * leaves the queue -- nothing was taken for it today.
 */

export type QueueStatus = 'ready' | 'in_progress' | 'completed' | 'cancelled';
export type QueuePayment = 'none' | 'part' | 'full';

export interface QueueRow {
  readonly sessionId: string;
  readonly orderId: string | null;
  /** The day the order started; earlier than today for a leftover. */
  readonly businessDate: string;
  /** Started on an earlier business day and still open: a leftover to clear. */
  readonly leftover: boolean;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly tables: readonly string[];
  readonly itemCount: number;
  /** Before tax, from the order lines; minor units as text. */
  readonly amountMinor: string;
  /** Across the session's bills; null until a bill exists. */
  readonly billedMinor: string | null;
  readonly paidMinor: string;
  readonly payment: QueuePayment;
  readonly readyAt: string;
  readonly readyBy: string | null;
  readonly status: QueueStatus;
}

export async function listBillingQueue(
  context: TenantContext,
  params: { branchId: string; businessDate: string },
): Promise<readonly QueueRow[]> {
  const result = await context.client.query<{
    session_id: string; order_id: string | null; business_date: string; leftover: boolean;
    service_type: 'dine_in' | 'parcel';
    parcel_no: number | null; pickup_name: string | null; tables: string[];
    item_count: number; amount_minor: string; billed_minor: string | null; paid_minor: string;
    ready_at: string; ready_by: string | null; status: QueueStatus; payment: QueuePayment;
  }>(
    `SELECT s.id AS session_id, so.id AS order_id, s.service_type, s.parcel_no, s.pickup_name,
            s.business_date::text AS business_date, s.business_date < $3::date AS leftover,
            COALESCE((SELECT array_agg(t.identifier ORDER BY t.identifier)
                        FROM app.table_session_table tst
                        JOIN app.dining_table t ON t.tenant_id = tst.tenant_id AND t.id = tst.dining_table_id
                       WHERE tst.tenant_id = s.tenant_id AND tst.session_id = s.id
                         AND (tst.detached_at IS NULL OR tst.detached_at >= COALESCE(s.closed_at, 'infinity'))),
                     '{}') AS tables,
            COALESCE(lines.items, 0)::int AS item_count,
            COALESCE(lines.amount, 0)::text AS amount_minor,
            bills.billed::text AS billed_minor,
            COALESCE(bills.paid, 0)::text AS paid_minor,
            s.billing_ready_at::text AS ready_at,
            u.full_name AS ready_by,
            CASE WHEN so.status = 'cancelled' THEN 'cancelled'
                 WHEN s.status = 'closed' THEN 'completed'
                 WHEN bills.billed IS NULL THEN 'ready'
                 ELSE 'in_progress' END AS status,
            CASE WHEN bills.billed IS NULL OR COALESCE(bills.paid, 0) <= 0 THEN 'none'
                 WHEN bills.paid >= bills.billed THEN 'full'
                 ELSE 'part' END AS payment
       FROM app.table_session s
       JOIN app.branch br ON br.tenant_id = s.tenant_id AND br.id = s.branch_id
       LEFT JOIN app.app_user u ON u.tenant_id = s.tenant_id AND u.id = s.billing_ready_by_user_id
       LEFT JOIN LATERAL (
         SELECT so.id, so.status FROM app.sales_order so
          WHERE so.tenant_id = s.tenant_id AND so.session_id = s.id
          ORDER BY so.created_at LIMIT 1
       ) so ON true
       LEFT JOIN LATERAL (
         SELECT sum(ol.quantity) FILTER (WHERE ol.kind IN ('item', 'combo_parent')) AS items,
                sum(ol.line_total_minor) FILTER (WHERE ol.kind <> 'combo_parent') AS amount
           FROM app.order_line ol
          WHERE ol.tenant_id = s.tenant_id AND ol.order_id = so.id
       ) lines ON true
       LEFT JOIN LATERAL (
         -- What is owed is the payable (total + round off, 0082), not the total.
         SELECT sum(b.payable_minor) AS billed,
                (SELECT sum(tn.amount_minor - tn.rounding_minor)
                   FROM app.tender tn
                   JOIN app.bill tb ON tb.tenant_id = tn.tenant_id AND tb.id = tn.bill_id
                  WHERE tn.tenant_id = s.tenant_id AND tb.session_id = s.id AND tb.status <> 'void') AS paid
           FROM app.bill b
          WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status <> 'void'
         HAVING count(*) > 0
       ) bills ON true
      WHERE s.tenant_id = $1 AND s.branch_id = $2 AND s.stage = 'billing'
        -- Implied by the predicate below, and stated on the session's own columns
        -- so old sessions are dropped BEFORE the laterals run. Without it every
        -- billed session the branch ever had is read on each 5 s poll (a year:
        -- ~450 ms for 3 rows). A session closed on business date D was closed at
        -- or after D 00:00 local (business_date() subtracts a non-negative day
        -- start), which is after D - 14 h UTC: two days is a superset at any offset.
        AND (s.status = 'open' OR s.business_date = $3::date OR s.closed_at >= $3::date - interval '2 days')
        AND (s.status = 'open' OR s.business_date = $3::date
             OR (so.status IS DISTINCT FROM 'cancelled'
                 AND app.business_date(br.timezone, br.business_day_starts_at, s.closed_at) = $3::date))
      ORDER BY (s.status = 'closed'), s.business_date, s.billing_ready_at`,
    [context.tenantId, params.branchId, params.businessDate],
  );
  return result.rows.map((r) => ({
    sessionId: r.session_id,
    orderId: r.order_id,
    businessDate: r.business_date,
    leftover: r.leftover,
    serviceType: r.service_type,
    parcelNo: r.parcel_no,
    pickupName: r.pickup_name,
    tables: r.tables,
    itemCount: r.item_count,
    amountMinor: r.amount_minor,
    billedMinor: r.billed_minor,
    paidMinor: r.paid_minor,
    payment: r.payment,
    readyAt: r.ready_at,
    readyBy: r.ready_by,
    status: r.status,
  }));
}
