import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { enqueue } from '../notifications/outbox.js';
import { assertTakesOrderChanges } from '../orders/session.js';

/**
 * Firing a KOT.
 *
 * ATOMIC across stations: one transaction covering every kot row, every kot_line,
 * both sequence allocations, the print_job rows, the stock-deduction outbox
 * message and the audit row. Any failure fires nothing -- three of four stations
 * receiving a ticket is worse than none, because the kitchen starts cooking half
 * an order and nobody knows the other half is missing.
 */

/**
 * THE GLOBAL LOCK ORDER.
 *
 *   request_claim -> table_session -> fire_sequence
 *                 -> station counters (sorted by station id) -> inserts
 *
 * Sorting station counters alone only stops two fires deadlocking against EACH
 * OTHER. It does nothing about a fire deadlocking against the fire counter, the
 * session's optimistic update, or the claim row -- four lock-acquiring resources
 * in one transaction. Every path that touches more than one acquires them in this
 * order, and the written rule is worth more than the sort because the sort covers
 * one pair out of six.
 */
export const FIRE_LOCK_ORDER = [
  'request_claim',
  'table_session',
  'fire_sequence',
  'kot_sequence(sorted by station_id)',
  'inserts',
] as const;

export interface FireRequest {
  readonly branchId: string;
  readonly orderId: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly firedByUserId: string;
  readonly businessDate: string;
}

export interface FiredStation {
  readonly kotId: string;
  readonly stationId: string;
  readonly sequenceNo: number;
  readonly lineCount: number;
}

export interface FireResult {
  readonly fireId: string;
  readonly fireNo: number;
  readonly stations: readonly FiredStation[];
}

export class SessionVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'session_version_conflict';
  constructor(readonly currentVersion: number | null) {
    super(
      currentVersion === null
        ? 'the table session no longer exists'
        : `the table session has moved on (now at version ${currentVersion}); re-read and retry`,
    );
    this.name = 'SessionVersionConflictError';
  }
}

export class NothingToFireError extends Error {
  readonly statusCode = 422;
  readonly code = 'nothing_to_fire';
  constructor() {
    super('no unfired lines on this order');
    this.name = 'NothingToFireError';
  }
}

interface RoutedLine {
  order_line_id: string;
  station_id: string;
  source: 'item' | 'modifier';
  modifier_option_id: string | null;
  quantity: number;
  name_snapshot: string;
  note: string | null;
}

/**
 * Resolves every unfired line to the station that will make it -- including
 * modifier options that route elsewhere, which is why one order line can produce
 * entries on two KOTs.
 */
async function resolveRouting(
  context: TenantContext,
  branchId: string,
  orderId: string,
): Promise<readonly RoutedLine[]> {
  const result = await context.client.query<RoutedLine>(
    `WITH unfired AS (
       SELECT ol.id, ol.menu_item_id, ol.quantity, ol.display_name, ol.modifiers,
              ol.note
         FROM app.order_line ol
        WHERE ol.tenant_id = $1 AND ol.order_id = $2
          AND ol.fired_at IS NULL
          AND ol.kind IN ('item', 'combo_component')
     ),
     item_routes AS (
       SELECT u.id AS order_line_id,
              COALESCE(r.kitchen_station_id, ks.id) AS station_id,
              'item'::text AS source,
              NULL::uuid AS modifier_option_id,
              u.quantity,
              u.display_name AS name_snapshot,
              -- "no onions" travels with the ITEM, not the modifier: a note is
              -- an instruction about the dish, and attaching it to a modifier
              -- entry would send it to whichever station makes the add-on.
              u.note
         FROM unfired u
         JOIN app.menu_item mi ON mi.tenant_id = $1 AND mi.id = u.menu_item_id
         LEFT JOIN app.branch_item_routing r
           ON r.tenant_id = $1 AND r.branch_id = $3 AND r.menu_item_id = u.menu_item_id
         LEFT JOIN app.kitchen_station ks
           ON ks.tenant_id = $1 AND ks.branch_id = $3 AND ks.code = mi.station_code
              AND ks.status = 'active'
     ),
     modifier_routes AS (
       SELECT u.id AS order_line_id,
              ks.id AS station_id,
              'modifier'::text AS source,
              mo.id AS modifier_option_id,
              u.quantity,
              mo.name AS name_snapshot,
              NULL::text AS note
         FROM unfired u
         CROSS JOIN LATERAL jsonb_array_elements(u.modifiers) AS m(value)
         JOIN app.modifier_option mo
           ON mo.tenant_id = $1 AND mo.id = (m.value ->> 'option_id')::uuid
         JOIN app.kitchen_station ks
           ON ks.tenant_id = $1 AND ks.branch_id = $3 AND ks.code = mo.station_code
              AND ks.status = 'active'
        WHERE mo.station_code IS NOT NULL
     )
     SELECT * FROM item_routes
     UNION ALL
     SELECT * FROM modifier_routes`,
    [context.tenantId, orderId, branchId],
  );

  const unroutable = result.rows.filter((r) => r.station_id === null);
  if (unroutable.length > 0) {
    // Should be impossible: listing-time validation refuses an item the branch
    // cannot route. If it happens, refuse rather than guess a station.
    throw new Error(
      `unroutable at fire time: ${unroutable.map((u) => u.name_snapshot).join(', ')}`,
    );
  }
  return result.rows;
}

/** Step 3 of the lock order. */
async function allocateFireNo(
  context: TenantContext,
  branchId: string,
  businessDate: string,
): Promise<number> {
  await context.client.query(
    `INSERT INTO app.fire_sequence (tenant_id, branch_id, business_date, next_no)
     VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [context.tenantId, branchId, businessDate],
  );
  const result = await context.client.query<{ next_no: number }>(
    `UPDATE app.fire_sequence SET next_no = next_no + 1
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3
      RETURNING next_no`,
    [context.tenantId, branchId, businessDate],
  );
  return result.rows[0]!.next_no;
}

/** Step 4 of the lock order: sorted by station id, always. */
async function allocateStationNos(
  context: TenantContext,
  branchId: string,
  businessDate: string,
  stationIds: readonly string[],
): Promise<Map<string, number>> {
  const sorted = [...stationIds].sort();
  const allocated = new Map<string, number>();

  for (const stationId of sorted) {
    await context.client.query(
      `INSERT INTO app.kot_sequence (tenant_id, branch_id, station_id, business_date, next_no)
       VALUES ($1, $2, $3, $4, 0) ON CONFLICT DO NOTHING`,
      [context.tenantId, branchId, stationId, businessDate],
    );
    const result = await context.client.query<{ next_no: number }>(
      `UPDATE app.kot_sequence SET next_no = next_no + 1
        WHERE tenant_id = $1 AND branch_id = $2 AND station_id = $3 AND business_date = $4
        RETURNING next_no`,
      [context.tenantId, branchId, stationId, businessDate],
    );
    allocated.set(stationId, result.rows[0]!.next_no);
  }

  return allocated;
}

export async function fireOrder(
  context: TenantContext,
  request: FireRequest,
): Promise<FireResult> {
  await assertTakesOrderChanges(context, { orderId: request.orderId });
  // #########################################################################
  // 1. THE CLAIM IS THE CALLER'S, AND THIS FUNCTION NO LONGER MAKES ONE.
  //
  // It used to claim here, under operation 'kot.fire', on the key its caller
  // had ALREADY claimed. `readClaim` refuses a key whose stored operation or
  // payload digest differs, so the second claim raised
  // `idempotency_key_reused` against the first -- and both callers make one:
  //
  //   HTTP     the registrar claims every /pos/ mutation, keyed on the header,
  //            under `POST /pos/order/:id/fire` with the request body. Operation
  //            mismatch, so every fire over HTTP answered 409.
  //   OFFLINE  the sync loop claims each operation under `op.kind` with
  //            `op.payload` -- the same operation name but a payload carrying
  //            `sessionVersion`, which this claim's payload omitted. Digest
  //            mismatch, so every offline fire raised at sync. That one predates
  //            the registrar change and no test covered it: `fireOrder` is
  //            called directly everywhere in the suite, so the double claim only
  //            exists when something dispatches it.
  //
  // One claim per operation, made by whoever received the operation. Replay is
  // not lost: both callers call `recordClaimResult`, so a second tap still gets
  // the same fire number back rather than merely a 200.
  // #########################################################################

  // 2. table_session -- optimistic, so a stale terminal is told to re-read rather
  //    than silently firing against a session someone else has moved on.
  const session = await context.client.query<{ version: number }>(
    `UPDATE app.table_session SET version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'open'
      RETURNING version`,
    [context.tenantId, request.sessionId, request.sessionVersion],
  );
  if (session.rowCount === 0) {
    const current = await context.client.query<{ version: number }>(
      `SELECT version FROM app.table_session WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, request.sessionId],
    );
    throw new SessionVersionConflictError(current.rows[0]?.version ?? null);
  }

  const routed = await resolveRouting(context, request.branchId, request.orderId);
  if (routed.length === 0) throw new NothingToFireError();

  // 3. fire_sequence -- one number for the whole fire, which is what a dispute is
  //    traced by. Station numbers do not identify "the thing sent at 20:14".
  const fireNo = await allocateFireNo(context, request.branchId, request.businessDate);
  const fireId = randomUUID();

  await context.client.query(
    `INSERT INTO app.kot_fire
       (id, tenant_id, branch_id, order_id, business_date, fire_no, fired_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fireId,
      context.tenantId,
      request.branchId,
      request.orderId,
      request.businessDate,
      fireNo,
      request.firedByUserId,
    ],
  );

  // 4. station counters, sorted
  const stationIds = [...new Set(routed.map((r) => r.station_id))];
  const stationNos = await allocateStationNos(
    context,
    request.branchId,
    request.businessDate,
    stationIds,
  );

  // 5. inserts
  const stations: FiredStation[] = [];
  for (const stationId of [...stationIds].sort()) {
    const kotId = randomUUID();
    const lines = routed.filter((r) => r.station_id === stationId);

    await context.client.query(
      `INSERT INTO app.kot
         (id, tenant_id, branch_id, fire_id, station_id, business_date, sequence_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        kotId,
        context.tenantId,
        request.branchId,
        fireId,
        stationId,
        request.businessDate,
        stationNos.get(stationId)!,
      ],
    );

    for (const line of lines) {
      await context.client.query(
        `INSERT INTO app.kot_line
           (id, tenant_id, kot_id, order_line_id, source, modifier_option_id,
            quantity, name_snapshot, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          context.tenantId,
          kotId,
          line.order_line_id,
          line.source,
          line.modifier_option_id,
          line.quantity,
          line.name_snapshot,
          line.note,
        ],
      );
    }

    // The print_job ROW is created here; the print ATTEMPT is not. A paper jam
    // must not sit in the critical path of the till.
    await context.client.query(
      `INSERT INTO app.print_job (id, tenant_id, branch_id, kot_id, printer_id, fallback_printer_id)
       SELECT $1, $2, $3, $4, sp.printer_id, p.fallback_printer_id
         FROM app.station_printer sp
         JOIN app.printer p ON p.tenant_id = sp.tenant_id AND p.id = sp.printer_id
        WHERE sp.tenant_id = $2 AND sp.station_id = $5 AND sp.is_primary
        LIMIT 1`,
      [randomUUID(), context.tenantId, request.branchId, kotId, stationId],
    );

    stations.push({
      kotId,
      stationId,
      sequenceNo: stationNos.get(stationId)!,
      lineCount: lines.length,
    });
  }

  // #########################################################################
  // THE COMBO PARENT IS FIRED TOO, EVEN THOUGH IT NEVER WENT TO A STATION.
  //
  // Routing deliberately excludes `kind = 'combo_parent'`: a combo is not cooked, its
  // components are, and each component goes to its own station. This stamp
  // copied that exclusion -- and the two are not the same question. Routing asks
  // "what does a kitchen make?". `fired_at` answers "may the till still change
  // this line?", and `editLine`/`removeLine` gate on exactly that:
  // `fired_at IS NULL` means a correction, not a void.
  //
  // So a combo parent stayed unfired forever. A waiter could re-key or delete
  // "Thali" as a pre-fire correction while the tandoor and the curry section
  // were already cooking its components -- no void row, no reason code, no
  // adjustment in the exception report, and the food still coming.
  //
  // The EXISTS reads the pre-update image, so it matches a parent whose
  // components are being fired in this same statement. It also repairs a parent
  // left NULL by an earlier fire, which is every combo fired before this fix.
  //
  // NOTE ON THE VALUE: `order_line.kind` says 'combo_parent'. `menu_item.kind`
  // says 'combo'. Two vocabularies for one idea, and the first draft of this fix
  // used the menu item's word -- so the OR matched no row and the whole change
  // was a no-op that every existing test still passed. The tests below are what
  // caught it; `order_line_kind_known` is the authority.
  // #########################################################################
  await context.client.query(
    `UPDATE app.order_line AS ol SET fired_at = now()
      WHERE ol.tenant_id = $1 AND ol.order_id = $2 AND ol.fired_at IS NULL
        AND (ol.kind IN ('item', 'combo_component')
             OR (ol.kind = 'combo_parent'
                 AND EXISTS (SELECT 1 FROM app.order_line c
                              WHERE c.tenant_id = ol.tenant_id
                                AND c.parent_line_id = ol.id
                                AND c.kind = 'combo_component')))`,
    [context.tenantId, request.orderId],
  );

  // Stock deducts AT FIRE. The kitchen consumed the ingredients when it started
  // cooking; deducting at payment corrupts inventory on every void and comp.
  // Phase 4 consumes this; at-least-once delivery is why the consumer dedupes.
  for (const station of stations) {
    await enqueue(context.client, {
      topic: 'inventory.deduct',
      dedupeKey: station.kotId,
      payload: {
        tenantId: context.tenantId,
        branchId: request.branchId,
        kotId: station.kotId,
        fireId,
        businessDate: request.businessDate,
      },
    });
  }

  // The RESULT is still stored, by the caller that made the claim: the registrar
  // stores what the handler returned, and the sync loop stores its own marker.
  const result: FireResult = { fireId, fireNo, stations };
  return result;
}
