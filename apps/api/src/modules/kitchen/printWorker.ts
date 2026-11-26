import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { networkTransport } from './printTransport.js';
import { counterNumber } from '@universalpos/shared';

/**
 * The print worker.
 *
 * ###########################################################################
 * THE ROW IS CREATED IN THE FIRE TRANSACTION. THE ATTEMPT IS NOT.
 *
 * That boundary was decided in Phase 3 and this worker must not widen it.
 * Printing is I/O against a device that fails constantly, and holding the fire
 * transaction across it puts a paper jam in the critical path of the till.
 *
 * For the same reason the CLAIM is not a held lock either: a transaction open
 * across a network printer's timeout blocks the queue behind it. Claims are
 * stamped and reclaimed by age, exactly as in the outbox.
 * ###########################################################################
 *
 * Runs as katkitchen_app under a per-tenant GUC, never as the owner.
 *
 * ###########################################################################
 * WHY THIS ITERATES TENANTS AND THE OUTBOX DRAIN DOES NOT.
 *
 * `platform.outbox` is a control-plane table with no RLS, so that worker claims
 * globally with SKIP LOCKED and sets the GUC per message. `app.print_job` is a
 * TENANT table under RLS: the claim query itself cannot read a row without a
 * tenant context, and the only way to read across tenants would be to run as the
 * owner -- exempt from RLS, which is the posture this exists to avoid.
 *
 * So iteration is forced here, and with it the starvation risk the outbox design
 * was able to sidestep. The bound is a PER-TENANT CAP per cycle: every tenant is
 * served every cycle, so a branch with a dead printer consumes its own budget and
 * nothing else's. Same reasoning as the rollup not abandoning at the first bad
 * tenant.
 * ###########################################################################
 */

export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

export interface PrintJob {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly kotId: string;
  readonly printerId: string;
  readonly printerName: string;
  readonly fallbackPrinterId: string | null;
  readonly fallbackPrinterName: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly origin: 'fire' | 'reprint';
  readonly usedFallback: boolean;
}

/** Injected, so the worker is testable without a printer and swappable per transport. */
export interface PrintTransport {
  send(params: { printerId: string; content: string; printer?: PrinterEndpoint }): Promise<void>;
}

/** Where the target printer is, read in the same scoped read as the ticket. */
export interface PrinterEndpoint {
  readonly connectionKind: string;
  readonly address: string | null;
}

export interface TicketLine {
  readonly name: string;
  readonly quantity: number;
  readonly note: string | null;
  /** Add-ons cooked WITH this dish. One routed to a station of its own is a line there instead. */
  readonly addOns?: readonly string[];
}

export interface TicketContext {
  readonly stationName: string;
  readonly sequenceNo: number | null;
  readonly localReference: string | null;
  readonly lines: readonly TicketLine[];
  /** The header a cook and a runner read: whose order, which table, when. */
  readonly header?: {
    readonly restaurantName: string;
    readonly timezone: string;
    readonly firedAt: string;
    /** This order's nth send to the kitchen -- "send 2" means more for a table already eating. */
    readonly sendNo: number;
    readonly serviceType: 'dine_in' | 'parcel';
    readonly tables: readonly string[];
    readonly parcelNo: number | null;
    readonly pickupName: string | null;
    readonly covers: number | null;
    readonly waiter: string | null;
  };
}

/** 32 columns: what a 58 mm roll holds, and comfortably inside an 80 mm one. */
const WIDTH = 32;
const rule = '-'.repeat(WIDTH);
const centre = (text: string): string =>
  text.length >= WIDTH ? text : `${' '.repeat(Math.floor((WIDTH - text.length) / 2))}${text}`;
const pair = (left: string, right: string): string =>
  right === '' ? left
    : left.length + right.length + 1 > WIDTH ? `${left}\n${right}`
      : `${left}${' '.repeat(WIDTH - left.length - right.length)}${right}`;

function stamp(iso: string, timeZone: string): { date: string; time: string } {
  const at = new Date(iso);
  return {
    date: new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(at),
    time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at),
  };
}

/**
 * ###########################################################################
 * A FALLBACK COPY SAYS SO, ON THE PAPER.
 *
 * Falling back sends a grill ticket to the fry printer. That is better than
 * nothing ONLY if the ticket says where it should have gone. Without the banner
 * a cook at the fry station silently starts grill work -- worse than no ticket,
 * because nobody knows it happened and nobody is looking for it.
 *
 * A reprint says so too, for the opposite reason: so a second copy on the pass
 * is not mistaken for a second order.
 * ###########################################################################
 */
export function renderTicket(
  job: Pick<PrintJob, 'origin' | 'usedFallback'>,
  ticket: TicketContext,
  fallbackFrom?: { intendedPrinterName: string } | null,
): string {
  const header: string[] = [];

  if (job.usedFallback && fallbackFrom) {
    header.push(
      '*** FALLBACK COPY ***',
      `*** INTENDED FOR: ${fallbackFrom.intendedPrinterName.toUpperCase()} ***`,
      '*** that printer is unreachable -- check before cooking ***',
    );
  }
  if (job.origin === 'reprint') {
    header.push('*** REPRINT -- NOT A NEW ORDER ***');
  }

  const reference = ticket.sequenceNo !== null
    ? `#${ticket.sequenceNo}`
    : (ticket.localReference ?? '#UNASSIGNED');
  const h = ticket.header;

  const top: string[] = h === undefined
    ? [`${ticket.stationName}   ${reference}`]
    : (() => {
      const at = stamp(h.firedAt, h.timezone);
      const number = counterNumber(h);
      const where = number !== null
        ? `${h.serviceType === 'parcel' ? 'PARCEL' : 'DINE-IN'} ${number}${h.pickupName ? ` ${h.pickupName}` : ''}`
        : `Table: ${h.tables.length === 0 ? '-' : h.tables.join(' + ')}`;
      return [
        centre(h.restaurantName.toUpperCase()),
        centre(`KOT ${reference}${h.sendNo > 1 ? `  (send ${h.sendNo})` : ''}`),
        rule,
        pair(`Date: ${at.date}`, `Time: ${at.time}`),
        pair(where, h.covers !== null && h.serviceType !== 'parcel' ? `Covers: ${h.covers}` : ''),
        ...(h.waiter ? [`Waiter: ${h.waiter}`] : []),
        `Kitchen: ${ticket.stationName}`,
        rule,
        'Qty Item',
      ];
    })();

  const body = ticket.lines.flatMap((l) => [
    `${String(l.quantity).padStart(2)} x ${l.name}`,
    ...(l.addOns ?? []).map((a) => `      + ${a}`),
    ...(l.note ? [`      * ${l.note}`] : []),
  ]);
  const items = ticket.lines.reduce((sum, l) => sum + l.quantity, 0);

  return [
    ...header,
    ...top,
    ...(h === undefined ? [rule] : []),
    ...body,
    ...(h === undefined ? [] : [rule, `Items: ${items}`]),
  ].join('\n');
}

/**
 * ###########################################################################
 * A BRANCH WITH A PRINT AGENT IS THE AGENT'S, NOT THE SERVER'S.
 *
 * Hosted in the cloud, the server cannot reach a printer on the restaurant's
 * network; the agent, running there, can. So while a branch has an ACTIVE agent
 * the server worker leaves its jobs alone and they wait for the agent -- even
 * while it is offline. Taking them over after a timeout would spend every
 * attempt against a printer the server cannot reach and walk a ticket to
 * failed during a till reboot. A stale claim is still reclaimed by age, so a
 * crashed agent strands nothing.
 * ###########################################################################
 */
export type ClaimScope = { readonly by: 'worker' } | { readonly by: 'agent'; readonly branchId: string };

/** Claims within ONE tenant's RLS scope. Caller holds the transaction and GUC. */
export async function claimBatch(
  client: pg.ClientBase,
  params: { workerId: string; batchSize: number; scope?: ClaimScope },
): Promise<readonly PrintJob[]> {
  const scope = params.scope ?? { by: 'worker' };
  const result = await client.query<JobRow>(
    `WITH claimable AS (
       SELECT id FROM app.print_job pj
        WHERE status = 'pending' AND available_at <= now()
          AND CASE WHEN $3::uuid IS NULL
                   THEN NOT EXISTS (SELECT 1 FROM app.print_agent a
                                     WHERE a.tenant_id = pj.tenant_id AND a.branch_id = pj.branch_id
                                       AND a.status = 'active')
                   ELSE pj.branch_id = $3::uuid END
        ORDER BY available_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE app.print_job j
        SET status = 'claimed', claimed_at = now(), claimed_by = $1
       FROM claimable c
      WHERE j.id = c.id
      RETURNING ${JOB_COLUMNS}`,
    [params.workerId, params.batchSize, scope.by === 'agent' ? scope.branchId : null],
  );
  return result.rows.map(toJob);
}

interface JobRow {
  id: string; tenant_id: string; branch_id: string; kot_id: string;
  printer_id: string; printer_name: string;
  fallback_printer_id: string | null; fallback_printer_name: string | null;
  attempts: number; max_attempts: number; origin: 'fire' | 'reprint';
  used_fallback: boolean;
}

/** The job as both claimants read it, from a row aliased `j`. */
const JOB_COLUMNS = `j.id, j.tenant_id, j.branch_id, j.kot_id, j.printer_id,
                (SELECT name FROM app.printer p
                  WHERE p.tenant_id = j.tenant_id AND p.id = j.printer_id) AS printer_name,
                j.fallback_printer_id,
                (SELECT name FROM app.printer p
                  WHERE p.tenant_id = j.tenant_id AND p.id = j.fallback_printer_id)
                  AS fallback_printer_name,
                j.attempts, j.max_attempts, j.origin, j.used_fallback`;

function toJob(r: JobRow): PrintJob {
  return {
    id: r.id, tenantId: r.tenant_id, branchId: r.branch_id, kotId: r.kot_id,
    printerId: r.printer_id, printerName: r.printer_name,
    fallbackPrinterId: r.fallback_printer_id, fallbackPrinterName: r.fallback_printer_name,
    attempts: r.attempts, maxAttempts: r.max_attempts, origin: r.origin,
    usedFallback: r.used_fallback,
  };
}

/** A job still held by `claimedBy`, or null: a result for a job it no longer holds changes nothing. */
export async function heldJob(client: pg.ClientBase, jobId: string, claimedBy: string): Promise<PrintJob | null> {
  const result = await client.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM app.print_job j
      WHERE j.id = $1 AND j.status = 'claimed' AND j.claimed_by = $2
      FOR UPDATE`,
    [jobId, claimedBy],
  );
  const row = result.rows[0];
  return row ? toJob(row) : null;
}

export async function endpointFor(client: pg.ClientBase, tenantId: string, printerId: string): Promise<PrinterEndpoint> {
  const result = await client.query<{ connection_kind: string; address: string | null }>(
    `SELECT connection_kind, address FROM app.printer WHERE tenant_id = $1 AND id = $2`,
    [tenantId, printerId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`printer ${printerId} not found`);
  return { connectionKind: row.connection_kind, address: row.address };
}

/**
 * Everything a kitchen ticket says, read once for the printer and the tablet
 * copy alike -- two readers of the same KOT building their own paper is how the
 * printed copy came to lack the add-ons the kitchen screen already showed.
 */
export async function loadTicket(
  client: pg.ClientBase,
  tenantId: string,
  kotId: string,
): Promise<TicketContext> {
  const head = await client.query<{
    station_name: string; sequence_no: number | null; local_reference: string | null;
    restaurant_name: string; timezone: string; fired_at: string; send_no: number;
    service_type: 'dine_in' | 'parcel'; parcel_no: number | null; pickup_name: string | null;
    covers: number | null; waiter: string | null; tables: string[];
  }>(
    // The restaurant's name is read from the tenant root, the row every app
    // table already points at; nothing else crosses the plane.
    `SELECT st.name AS station_name, k.sequence_no, k.local_reference,
            tn.name AS restaurant_name, br.timezone, f.fired_at::text AS fired_at,
            (SELECT count(*)::int FROM app.kot_fire f2
              WHERE f2.tenant_id = f.tenant_id AND f2.order_id = f.order_id
                AND (f2.fired_at, f2.id) <= (f.fired_at, f.id)) AS send_no,
            s.service_type, s.parcel_no, s.pickup_name, s.guest_count AS covers,
            u.full_name AS waiter,
            COALESCE((SELECT array_agg(t.identifier ORDER BY t.identifier)
                        FROM app.table_session_table tst
                        JOIN app.dining_table t ON t.tenant_id = tst.tenant_id AND t.id = tst.dining_table_id
                       WHERE tst.tenant_id = s.tenant_id AND tst.session_id = s.id
                         AND tst.attached_at <= f.fired_at
                         AND (tst.detached_at IS NULL OR tst.detached_at > f.fired_at)), '{}') AS tables
       FROM app.kot k
       JOIN app.kitchen_station st ON st.tenant_id = k.tenant_id AND st.id = k.station_id
       JOIN app.kot_fire f ON f.tenant_id = k.tenant_id AND f.id = k.fire_id
       JOIN app.sales_order so ON so.tenant_id = f.tenant_id AND so.id = f.order_id
       JOIN app.table_session s ON s.tenant_id = so.tenant_id AND s.id = so.session_id
       JOIN app.branch br ON br.tenant_id = k.tenant_id AND br.id = k.branch_id
       JOIN platform.tenant tn ON tn.id = k.tenant_id
       LEFT JOIN app.app_user u ON u.tenant_id = f.tenant_id AND u.id = f.fired_by_user_id
      WHERE k.tenant_id = $1 AND k.id = $2`,
    [tenantId, kotId],
  );
  const lines = await client.query<{ name_snapshot: string; quantity: number; note: string | null; add_ons: string[] }>(
    // The add-ons cooked WITH a dish come from the order line's snapshot, by the
    // same rule as the kitchen screen: fire writes a kitchen line only for an
    // add-on routed to a station of its own, which then prints there.
    `SELECT kl.name_snapshot, kl.quantity, kl.note,
            CASE WHEN kl.source = 'item' THEN COALESCE((
              SELECT array_agg(m.value ->> 'name' ORDER BY m.ordinality)
                FROM app.order_line ol
                CROSS JOIN LATERAL jsonb_array_elements(ol.modifiers) WITH ORDINALITY AS m(value, ordinality)
                LEFT JOIN app.modifier_option mo
                  ON mo.tenant_id = ol.tenant_id AND mo.id = (m.value ->> 'option_id')::uuid
               WHERE ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
                 AND mo.station_code IS NULL), '{}') ELSE '{}' END AS add_ons
       FROM app.kot_line kl
      WHERE kl.tenant_id = $1 AND kl.kot_id = $2 AND kl.state <> 'cancelled'
      ORDER BY kl.created_at, kl.source DESC`,
    [tenantId, kotId],
  );
  const row = head.rows[0];
  if (!row) throw new Error(`kot ${kotId} not found`);

  return {
    stationName: row.station_name,
    sequenceNo: row.sequence_no,
    localReference: row.local_reference,
    lines: lines.rows.map((l) => ({ name: l.name_snapshot, quantity: l.quantity, note: l.note, addOns: l.add_ons })),
    header: {
      restaurantName: row.restaurant_name,
      timezone: row.timezone,
      firedAt: row.fired_at,
      sendNo: row.send_no,
      serviceType: row.service_type,
      tables: row.tables,
      parcelNo: row.parcel_no,
      pickupName: row.pickup_name,
      covers: row.covers,
      waiter: row.waiter,
    },
  };
}

export interface PrintResult {
  readonly claimed: number;
  readonly accepted: number;
  readonly retried: number;
  readonly fellBack: number;
  readonly failed: number;
  readonly reclaimed: number;
}

/** Within the caller's tenant scope, like everything else that reads print_job. */
export async function reclaimStale(
  client: pg.ClientBase,
  params: { timeoutMs?: number } = {},
): Promise<number> {
  const result = await client.query(
    `UPDATE app.print_job
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL,
            last_error = COALESCE(last_error, 'claim expired; worker presumed dead')
      WHERE status = 'claimed'
        AND claimed_at < now() - ($1 || ' milliseconds')::interval`,
    [String(params.timeoutMs ?? CLAIM_TIMEOUT_MS)],
  );
  return result.rowCount ?? 0;
}

/**
 * One cycle.
 *
 * Escalation on failure: retry the primary with backoff; on exhausting it, move
 * to the fallback printer and RESET the attempt budget for that printer; on
 * exhausting the fallback too, fail terminally with a reason that names both.
 */
export async function printOnce(
  client: pg.ClientBase,
  params: {
    transport: PrintTransport;
    workerId?: string;
    /** Per TENANT, per cycle. The cap is what stops one bad printer starving
     *  every tenant behind it in the iteration. */
    batchSize?: number;
    claimTimeoutMs?: number;
    tenantIds?: readonly string[];
  },
): Promise<PrintResult> {
  const workerId = params.workerId ?? `printer-${randomUUID().slice(0, 8)}`;
  const batchSize = params.batchSize ?? 10;
  const timeout = params.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

  const tenants = params.tenantIds ?? (await client.query<{ id: string }>(
    `SELECT id FROM platform.tenant WHERE status <> 'purged' ORDER BY id`,
  )).rows.map((r) => r.id);

  let claimed = 0, accepted = 0, retried = 0, fellBack = 0, failed = 0, reclaimed = 0;

  const scoped = async <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };

  for (const tenantId of tenants) {
    let batch: readonly PrintJob[];
    try {
      reclaimed += await scoped(tenantId, () => reclaimStale(client, { timeoutMs: timeout }));
      batch = await scoped(tenantId, () => claimBatch(client, { workerId, batchSize }));
    } catch {
      // One tenant's failure must not abandon the rest -- the rollup's rule.
      continue;
    }
    claimed += batch.length;

    for (const job of batch) {
      try {
        const { target, content, printer } = await scoped(tenantId, () => jobPayload(client, job));

        // OUTSIDE any transaction: a network printer's timeout must not be held
        // open against the database, and a paper jam must never sit in the
        // critical path of the till.
        await params.transport.send({ printerId: target, content, printer });

        await scoped(tenantId, () => markAccepted(client, job.id));
        accepted += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const outcome = await scoped(tenantId, () => recordFailure(client, job, detail))
          .catch(() => 'retry' as const);
        if (outcome === 'failed') failed += 1;
        else if (outcome === 'fell_back') fellBack += 1;
        else retried += 1;
      }
    }
  }

  return { claimed, accepted, retried, fellBack, failed, reclaimed };
}

/** What one job prints and where: the same for the server worker and the print agent. */
export async function jobPayload(
  client: pg.ClientBase,
  job: PrintJob,
): Promise<{ target: string; content: string; printer: PrinterEndpoint }> {
  const target = job.usedFallback ? job.fallbackPrinterId! : job.printerId;
  const ticket = await loadTicket(client, job.tenantId, job.kotId);
  const printer = await endpointFor(client, job.tenantId, target);
  const content = renderTicket(job, ticket, job.usedFallback ? { intendedPrinterName: job.printerName } : null);
  return { target, content, printer };
}

/** ACCEPTED, not printed. The device took the bytes; whether paper came out is not something it can tell us. */
export async function markAccepted(client: pg.ClientBase, jobId: string): Promise<void> {
  await client.query(
    `UPDATE app.print_job
        SET status = 'accepted', accepted_at = now(),
            claimed_at = NULL, claimed_by = NULL
      WHERE id = $1`,
    [jobId],
  );
}

export async function recordFailure(
  client: pg.ClientBase,
  job: PrintJob,
  detail: string,
): Promise<'retry' | 'fell_back' | 'failed'> {
  const exhausted = job.attempts + 1 >= job.maxAttempts;

  if (exhausted && !job.usedFallback && job.fallbackPrinterId) {
    // Escalate to the fallback, and reset the budget: the new printer deserves
    // its own attempts, and the paper will say where the ticket should have gone.
    await client.query(
      `UPDATE app.print_job
          SET status = 'pending', attempts = 0, available_at = now(),
              claimed_at = NULL, claimed_by = NULL,
              used_fallback = true, fallback_from_printer_id = printer_id,
              last_error = $2
        WHERE id = $1`,
      [job.id, `primary printer exhausted: ${detail}`.slice(0, 2000)],
    );
    return 'fell_back';
  }

  if (exhausted) {
    await client.query(
      `UPDATE app.print_job
          SET status = 'failed', claimed_at = NULL, claimed_by = NULL,
              attempts = attempts + 1, last_error = $2,
              failure_reason = $3
        WHERE id = $1`,
      [job.id, detail.slice(0, 2000),
       job.usedFallback
         ? `both ${job.printerName} and fallback ${job.fallbackPrinterName} failed: ${detail}`
         : `${job.printerName} failed after ${job.maxAttempts} attempts and has no fallback: ${detail}`],
    );
    return 'failed';
  }

  await client.query(
    `UPDATE app.print_job
        SET status = 'pending', attempts = attempts + 1, claimed_at = NULL, claimed_by = NULL,
            last_error = $2,
            available_at = now() + least(interval '2 minutes',
                                         (interval '3 seconds' * power(2, attempts)))
      WHERE id = $1`,
    [job.id, detail.slice(0, 2000)],
  );
  return 'retry';
}

/**
 * A reprint is a NEW JOB. It is not a retry, and it is not a counter.
 *
 * A retry is the system attempting one unconfirmed delivery; a reprint is a human
 * asking for another copy. Folding them together would make a kitchen that
 * reprints look like failing hardware in the failure-rate metric, and would leave
 * nothing able to say afterwards which had happened.
 */
export async function requestReprint(
  client: pg.ClientBase,
  params: { tenantId: string; jobId: string; byUserId: string; printerId?: string; branchId?: string | null },
): Promise<{ jobId: string }> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(params.jobId)) throw new PrintJobUnknownError(params.jobId);
  const original = await client.query<{
    branch_id: string; kot_id: string; printer_id: string; fallback_printer_id: string | null;
  }>(
    `SELECT branch_id, kot_id, printer_id, fallback_printer_id
       FROM app.print_job WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)`,
    [params.tenantId, params.jobId, params.branchId ?? null],
  );
  const row = original.rows[0];
  // A branch-scoped caller asking for another branch's ticket gets the same
  // answer as a job that does not exist.
  if (!row) throw new PrintJobUnknownError(params.jobId);

  const id = randomUUID();
  await client.query(
    `INSERT INTO app.print_job
       (id, tenant_id, branch_id, kot_id, printer_id, fallback_printer_id,
        origin, reprint_of_job_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,'reprint',$7,$8)`,
    [id, params.tenantId, row.branch_id, row.kot_id,
     params.printerId ?? row.printer_id, row.fallback_printer_id,
     params.jobId, params.byUserId],
  );
  return { jobId: id };
}

export class PrintJobUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'print_job_unknown';
  constructor(jobId: string) {
    super(`no print job ${jobId} at this branch`);
    this.name = 'PrintJobUnknownError';
  }
}

export interface BranchPrintFailure {
  readonly jobId: string;
  readonly kotId: string;
  readonly printerName: string;
  readonly stationName: string;
  readonly failureReason: string;
  readonly usedFallback: boolean;
  readonly createdAt: string;
}

/**
 * The BRANCH's screen.
 *
 * Not platform system health: a jammed printer is a problem for the manager
 * standing twenty feet from it, and a superadmin can do nothing about it. Same
 * distinction as inventory.negative.
 */
export async function branchPrintFailures(
  client: pg.ClientBase,
  params: { tenantId: string; branchId: string },
): Promise<readonly BranchPrintFailure[]> {
  const result = await client.query<{
    id: string; kot_id: string; printer_name: string; station_name: string;
    failure_reason: string; used_fallback: boolean; created_at: string;
  }>(
    `SELECT j.id, j.kot_id, p.name AS printer_name, s.name AS station_name,
            j.failure_reason, j.used_fallback, j.created_at::text
       FROM app.print_job j
       JOIN app.printer p ON p.tenant_id = j.tenant_id AND p.id = j.printer_id
       JOIN app.kot k ON k.tenant_id = j.tenant_id AND k.id = j.kot_id
       JOIN app.kitchen_station s ON s.tenant_id = k.tenant_id AND s.id = k.station_id
      WHERE j.tenant_id = $1 AND j.branch_id = $2 AND j.status = 'failed'
      ORDER BY j.created_at DESC LIMIT 100`,
    [params.tenantId, params.branchId],
  );
  return result.rows.map((r) => ({
    jobId: r.id, kotId: r.kot_id, printerName: r.printer_name,
    stationName: r.station_name, failureReason: r.failure_reason,
    usedFallback: r.used_fallback, createdAt: r.created_at,
  }));
}

/**
 * The postcondition: no claim older than the timeout. A worker that died holding
 * jobs must not strand them, and the reclaim sweep at the head of each cycle is
 * what returns them.
 */
export async function verifyPrintDrain(
  client: pg.ClientBase,
  params: { claimTimeoutMs?: number; tenantIds?: readonly string[] } = {},
): Promise<readonly string[]> {
  const timeout = String(params.claimTimeoutMs ?? CLAIM_TIMEOUT_MS);

  // print_job is a TENANT table, so this reads per tenant under the GUC like
  // everything else. Passing an unscoped client works only for the owner, which
  // is exempt from RLS -- and a check that only passes as the owner is a check
  // that has never run in the posture the worker actually uses.
  const tenants = params.tenantIds ?? (await client.query<{ id: string }>(
    `SELECT id FROM platform.tenant WHERE status <> 'purged' ORDER BY id`,
  )).rows.map((r) => r.id);

  const stranded: string[] = [];
  for (const tenantId of tenants) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const result = await client.query<{ id: string; claimed_by: string }>(
        `SELECT id, claimed_by FROM app.print_job
          WHERE status = 'claimed'
            AND claimed_at < now() - ($1 || ' milliseconds')::interval`,
        [timeout],
      );
      for (const r of result.rows) stranded.push(`${r.id} (held by ${r.claimed_by})`);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }
  return stranded;
}

export async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('DATABASE_URL_APP is required: the print worker runs as katkitchen_app');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await printOnce(client, { transport: networkTransport() });
    console.log(
      `print drain: claimed ${result.claimed}, accepted ${result.accepted}, ` +
        `retried ${result.retried}, fell back ${result.fellBack}, failed ${result.failed}, ` +
        `reclaimed ${result.reclaimed}`,
    );

    const stranded = await verifyPrintDrain(client);
    if (stranded.length > 0) {
      console.error(`${stranded.length} print job(s) stranded in 'claimed': ${stranded.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
