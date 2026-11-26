import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * The parcel counter: every parcel still open, whatever day it started, plus
 * today's finished ones -- and where each stands. A parcel left unpaid at the
 * day's end is still owed, and still needs a home on a screen.
 *
 * The status is DERIVED, never stored. "Preparing" and "Ready" are facts about
 * the kitchen lines, "Picked up" is the handover stamp and "Completed" is the
 * session closing after payment -- a stored status column would be a second
 * opinion about each of those, and it would drift from the first.
 */

export type ParcelStatus = 'new' | 'preparing' | 'ready' | 'picked_up' | 'completed' | 'cancelled';

export interface ParcelRow {
  readonly sessionId: string;
  readonly orderId: string | null;
  /** The day the parcel started; earlier than today for a leftover. Parcel
   *  numbers restart each day, so the pair is what identifies one. */
  readonly businessDate: string;
  /** Started on an earlier business day and still open: a leftover to clear. */
  readonly leftover: boolean;
  readonly parcelNo: number;
  readonly pickupName: string | null;
  readonly itemCount: number;
  /** Before tax, minor units, as text. */
  readonly amountMinor: string;
  readonly openedAt: string;
  readonly status: ParcelStatus;
  readonly billed: boolean;
}

export async function listParcels(
  context: TenantContext,
  params: { branchId: string; businessDate: string; serviceType?: 'parcel' | 'dine_in' },
): Promise<readonly ParcelRow[]> {
  const result = await context.client.query<{
    session_id: string; order_id: string | null; business_date: string; leftover: boolean;
    parcel_no: number; pickup_name: string | null;
    item_count: number; amount_minor: string; opened_at: string;
    status: ParcelStatus; billed: boolean;
  }>(
    `SELECT s.id AS session_id, so.id AS order_id, s.parcel_no, s.pickup_name,
            s.business_date::text AS business_date, s.business_date < $3::date AS leftover,
            s.opened_at::text AS opened_at,
            COALESCE(lines.items, 0)::int AS item_count,
            COALESCE(lines.amount, 0)::text AS amount_minor,
            COALESCE(lines.billed, false) AS billed,
            CASE
              WHEN so.status = 'cancelled'         THEN 'cancelled'
              WHEN s.status = 'closed'             THEN 'completed'
              WHEN s.picked_up_at IS NOT NULL      THEN 'picked_up'
              WHEN COALESCE(kit.sent, 0) = 0       THEN 'new'
              WHEN kit.cooking > 0 OR lines.unsent > 0 THEN 'preparing'
              ELSE 'ready'
            END AS status
       FROM app.table_session s
       LEFT JOIN LATERAL (
         SELECT so.id, so.status FROM app.sales_order so
          WHERE so.tenant_id = s.tenant_id AND so.session_id = s.id
          ORDER BY so.created_at LIMIT 1
       ) so ON true
       LEFT JOIN LATERAL (
         SELECT sum(ol.quantity) FILTER (WHERE ol.kind IN ('item', 'combo_parent')) AS items,
                sum(ol.line_total_minor) FILTER (WHERE ol.kind <> 'combo_parent') AS amount,
                count(*) FILTER (WHERE ol.kind IN ('item', 'combo_parent') AND ol.fired_at IS NULL) AS unsent,
                EXISTS (SELECT 1 FROM app.bill b
                         WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id
                           AND b.status <> 'void') AS billed
           FROM app.order_line ol
          WHERE ol.tenant_id = s.tenant_id AND ol.order_id = so.id
       ) lines ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS sent,
                count(*) FILTER (WHERE kl.state IN ('queued', 'preparing')) AS cooking
           FROM app.kot_line kl
           JOIN app.kot k ON k.tenant_id = kl.tenant_id AND k.id = kl.kot_id
           JOIN app.kot_fire kf ON kf.tenant_id = k.tenant_id AND kf.id = k.fire_id
          WHERE kf.tenant_id = s.tenant_id AND kf.order_id = so.id AND kl.source = 'item'
       ) kit ON true
      WHERE s.tenant_id = $1 AND s.branch_id = $2 AND s.service_type = $4 AND s.seating = 'counter'
        AND (s.status = 'open' OR s.business_date = $3::date)
      ORDER BY s.business_date, s.parcel_no`,
    [context.tenantId, params.branchId, params.businessDate, params.serviceType ?? 'parcel'],
  );
  return result.rows.map((r) => ({
    sessionId: r.session_id,
    orderId: r.order_id,
    businessDate: r.business_date,
    leftover: r.leftover,
    parcelNo: r.parcel_no,
    pickupName: r.pickup_name,
    itemCount: r.item_count,
    amountMinor: r.amount_minor,
    openedAt: r.opened_at,
    status: r.status,
    billed: r.billed,
  }));
}
