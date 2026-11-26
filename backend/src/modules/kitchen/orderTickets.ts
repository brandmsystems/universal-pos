import type { TenantContext } from '../../core/database/tenantContext.js';
import { loadTicket, renderTicket } from './printWorker.js';

/**
 * An order's kitchen tickets, as the KOT screen shows them after a send: which
 * kitchen, which printer, and whether the paper went.
 *
 * READ ONLY, and it reads the print_job rows the fire transaction wrote -- there is
 * no second printing path. The ticket TEXT is the worker's own `renderTicket`, so
 * a copy printed on the tablet is word for word what the kitchen printer got.
 *
 * `status` is the NEWEST job for the ticket (fire or reprint), because that is the
 * one a waiter pressing "Print again" is waiting on.
 */

export type TicketPrintStatus = 'printed' | 'waiting' | 'failed';

export interface OrderTicket {
  readonly kotId: string;
  readonly stationName: string;
  readonly reference: string;
  readonly sendNo: number;
  readonly firedAt: string;
  readonly lines: readonly { name: string; quantity: number; note: string | null }[];
  readonly print: {
    readonly jobId: string;
    readonly status: TicketPrintStatus;
    readonly printerName: string;
    readonly usedFallback: boolean;
    readonly failureReason: string | null;
  } | null;
  /** What a copy printed on this tablet says. Marked a reprint once the kitchen has one. */
  readonly ticketText: string;
  /** Nothing on it is still queued or being prepared. */
  readonly ready: boolean;
  /**
   * KOT says when this food is ready: the restaurant runs WITHOUT a kitchen
   * screen (`markTicketReady` refuses otherwise). False where a kitchen screen
   * runs, and the KOT screen then shows exactly what it always has. Decided here
   * so the screen never second-guesses the server.
   */
  readonly kotMarksReady: boolean;
}

export class OrderUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'order_unknown';
  constructor(orderId: string) {
    super(`no order ${orderId} at this branch`);
    this.name = 'OrderUnknownError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function orderTickets(
  context: TenantContext,
  params: { branchId: string | null; orderId: string },
): Promise<readonly OrderTicket[]> {
  // An unknown order is refused, not answered with an empty list: "nothing sent
  // yet" and "wrong order" must not look the same on the screen.
  if (!UUID.test(params.orderId)) throw new OrderUnknownError(params.orderId);
  const exists = await context.client.query(
    `SELECT 1 FROM app.sales_order WHERE tenant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) AND id = $3`,
    [context.tenantId, params.branchId, params.orderId],
  );
  if (exists.rowCount === 0) throw new OrderUnknownError(params.orderId);

  const result = await context.client.query<{
    kot_id: string; station_name: string; sequence_no: number | null; local_reference: string | null;
    fire_no: number; fired_at: string;
    lines: { name: string; quantity: number; note: string | null }[];
    job_id: string | null; job_status: string | null; printer_name: string | null;
    used_fallback: boolean | null; failure_reason: string | null; any_accepted: boolean;
    ready: boolean;
  }>(
    `SELECT k.id AS kot_id, st.name AS station_name, k.sequence_no, k.local_reference,
            f.fire_no, f.fired_at::text AS fired_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'name', kl.name_snapshot, 'quantity', kl.quantity, 'note', kl.note)
                        ORDER BY kl.created_at)
                        FROM app.kot_line kl
                       WHERE kl.tenant_id = k.tenant_id AND kl.kot_id = k.id
                         AND kl.state <> 'cancelled'), '[]'::jsonb) AS lines,
            j.id AS job_id, j.status AS job_status,
            (SELECT p.name FROM app.printer p
              WHERE p.tenant_id = j.tenant_id
                AND p.id = CASE WHEN j.used_fallback THEN j.fallback_printer_id ELSE j.printer_id END)
              AS printer_name,
            j.used_fallback, j.failure_reason,
            EXISTS (SELECT 1 FROM app.print_job a
                     WHERE a.tenant_id = k.tenant_id AND a.kot_id = k.id
                       AND a.status = 'accepted') AS any_accepted,
            NOT EXISTS (SELECT 1 FROM app.kot_line kl
                         WHERE kl.tenant_id = k.tenant_id AND kl.kot_id = k.id
                           AND kl.state IN ('queued', 'preparing')) AS ready
       FROM app.kot_fire f
       JOIN app.kot k ON k.tenant_id = f.tenant_id AND k.fire_id = f.id
       JOIN app.kitchen_station st ON st.tenant_id = k.tenant_id AND st.id = k.station_id
       LEFT JOIN LATERAL (
         SELECT * FROM app.print_job pj
          WHERE pj.tenant_id = k.tenant_id AND pj.kot_id = k.id
          ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1
       ) j ON true
      WHERE f.tenant_id = $1 AND ($2::uuid IS NULL OR f.branch_id = $2) AND f.order_id = $3
      ORDER BY f.fired_at, f.fire_no, st.name`,
    [context.tenantId, params.branchId, params.orderId],
  );

  const tickets: OrderTicket[] = [];
  for (const r of result.rows) {
    // The worker's own loader, so the tablet copy is the printer's paper.
    const ticket = await loadTicket(context.client, context.tenantId, r.kot_id);
    tickets.push({
      kotId: r.kot_id,
      stationName: r.station_name,
      reference: r.sequence_no !== null ? `#${r.sequence_no}` : (r.local_reference ?? '#UNASSIGNED'),
      sendNo: r.fire_no,
      firedAt: r.fired_at,
      lines: r.lines,
      print: r.job_id === null ? null : {
        jobId: r.job_id,
        status: r.job_status === 'accepted' ? 'printed' : r.job_status === 'failed' ? 'failed' : 'waiting',
        printerName: r.printer_name ?? '',
        usedFallback: r.used_fallback ?? false,
        failureReason: r.failure_reason,
      },
      ticketText: renderTicket(
        { origin: r.any_accepted ? 'reprint' : 'fire', usedFallback: false }, ticket),
      ready: r.ready,
      // Always: with the kitchen screen removed, KOT is the one place that says so.
      kotMarksReady: true,
    });
  }
  return tickets;
}

/* ------------------------------------------------- KOT marks food ready --- */
// Moved from the kitchen screen module when the kitchen screen was removed
// (Basic only): with no screen, KOT is the one place that says food is ready.

export class StaleKdsViewError extends Error {
  readonly statusCode = 409;
  readonly code = 'kds_version_conflict';
  constructor(readonly currentVersion: number | null) {
    super(
      currentVersion === null
        ? 'that kitchen line no longer exists'
        : `the line has moved on (now at version ${currentVersion}); the display should re-read`,
    );
    this.name = 'StaleKdsViewError';
  }
}

/**
 * KOT says the ticket's food is ready.
 *
 * Nobody else can -- no screen advances the lines -- and a line left 'queued'
 * reads as cooking forever: the floor says so, and a parcel can never be
 * handed over (`markParcelPickedUp` refuses while anything cooks). Every live
 * line not yet ready moves straight to 'ready'; 'served' and 'cancelled' are
 * untouched, so this is forward-only like every other move.
 *
 * It used to be refused where a kitchen screen ran, so only one place said
 * "ready". The screen is gone (Basic only), so this IS that one place -- on any
 * plan version, including a retired one that still names `kds`, where the
 * refusal would have left nobody able to release food.
 */
export async function markTicketReady(
  context: TenantContext,
  params: { kotId: string; branchId: string },
): Promise<{ kotId: string; marked: number }> {
  // Branch-scoped for the reason stated on `advanceLine`.
  const ticket = await context.client.query(
    `SELECT 1 FROM app.kot WHERE tenant_id = $1 AND id = $2 AND branch_id = $3`,
    [context.tenantId, params.kotId, params.branchId],
  );
  if (ticket.rowCount === 0) throw new StaleKdsViewError(null);

  const result = await context.client.query(
    `UPDATE app.kot_line SET state = 'ready', version = version + 1
      WHERE tenant_id = $1 AND kot_id = $2 AND state IN ('queued', 'preparing')`,
    [context.tenantId, params.kotId],
  );
  return { kotId: params.kotId, marked: result.rowCount ?? 0 };
}
