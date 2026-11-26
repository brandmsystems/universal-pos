import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Every order still open, whatever day it started -- the manager's view of what
 * is holding a table or owed money.
 *
 * Not filtered by business date, deliberately: the floor and the tills each show
 * their own day, and an order left open past the day's end is exactly the one
 * a manager needs to find. Oldest first, so the leftovers lead.
 */

export interface OpenOrderRow {
  readonly sessionId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly businessDate: string;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly tables: readonly string[];
  readonly stage: 'ordering' | 'billing';
  readonly itemCount: number;
  /** Before tax, from the order lines; minor units as text. */
  readonly amountMinor: string;
  /** Across live bills; null until a bill exists. */
  readonly billedMinor: string | null;
  readonly paidMinor: string;
  readonly openedAt: string;
}

export async function listOpenOrders(
  context: TenantContext,
  params: { branchId: string | null },
): Promise<readonly OpenOrderRow[]> {
  const result = await context.client.query<{
    session_id: string; branch_id: string; branch_name: string; business_date: string;
    service_type: 'dine_in' | 'parcel'; parcel_no: number | null; pickup_name: string | null;
    tables: string[]; stage: 'ordering' | 'billing'; item_count: number; amount_minor: string;
    billed_minor: string | null; paid_minor: string; opened_at: string;
  }>(
    `SELECT s.id AS session_id, s.branch_id, br.name AS branch_name,
            s.business_date::text AS business_date,
            s.service_type, s.parcel_no, s.pickup_name, s.stage,
            s.opened_at::text AS opened_at,
            COALESCE((SELECT array_agg(t.identifier ORDER BY t.identifier)
                        FROM app.table_session_table tst
                        JOIN app.dining_table t ON t.tenant_id = tst.tenant_id AND t.id = tst.dining_table_id
                       WHERE tst.tenant_id = s.tenant_id AND tst.session_id = s.id
                         AND tst.detached_at IS NULL), '{}') AS tables,
            COALESCE(lines.items, 0)::int AS item_count,
            COALESCE(lines.amount, 0)::text AS amount_minor,
            bills.billed::text AS billed_minor,
            COALESCE(bills.paid, 0)::text AS paid_minor
       FROM app.table_session s
       JOIN app.branch br ON br.tenant_id = s.tenant_id AND br.id = s.branch_id
       LEFT JOIN LATERAL (
         SELECT sum(ol.quantity) FILTER (WHERE ol.kind IN ('item', 'combo_parent')) AS items,
                sum(ol.line_total_minor) FILTER (WHERE ol.kind <> 'combo_parent') AS amount
           FROM app.order_line ol
           JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
          WHERE ol.tenant_id = s.tenant_id AND so.session_id = s.id
       ) lines ON true
       LEFT JOIN LATERAL (
         SELECT sum(b.payable_minor) AS billed,
                (SELECT sum(tn.amount_minor - tn.rounding_minor)
                   FROM app.tender tn
                   JOIN app.bill tb ON tb.tenant_id = tn.tenant_id AND tb.id = tn.bill_id
                  WHERE tn.tenant_id = s.tenant_id AND tb.session_id = s.id AND tb.status <> 'void') AS paid
           FROM app.bill b
          WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status <> 'void'
         HAVING count(*) > 0
       ) bills ON true
      WHERE s.tenant_id = $1 AND s.status = 'open'
        AND ($2::uuid IS NULL OR s.branch_id = $2)
      ORDER BY s.business_date, s.opened_at`,
    [context.tenantId, params.branchId],
  );
  return result.rows.map((r) => ({
    sessionId: r.session_id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    businessDate: r.business_date,
    serviceType: r.service_type,
    parcelNo: r.parcel_no,
    pickupName: r.pickup_name,
    tables: r.tables,
    stage: r.stage,
    itemCount: r.item_count,
    amountMinor: r.amount_minor,
    billedMinor: r.billed_minor,
    paidMinor: r.paid_minor,
    openedAt: r.opened_at,
  }));
}
