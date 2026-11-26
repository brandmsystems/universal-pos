import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * The table session: one party, from sit-down to settled.
 *
 * A session is not a table. A party moving from table 4 to table 7 keeps ONE
 * session with two rows in `table_session_table`, which is why the lease keys on
 * the session and not the table -- a table-keyed lease would split at the move
 * and hand table 7 to a second device.
 */

export class TableOccupiedError extends Error {
  readonly code = 'table_occupied';
  constructor(readonly diningTableId: string, readonly sessionId: string) {
    super(`dining table ${diningTableId} already has open session ${sessionId}`);
    this.name = 'TableOccupiedError';
  }
}

export class SessionNotOpenError extends Error {
  readonly code = 'session_not_open';
  constructor(readonly sessionId: string) {
    super(`table session ${sessionId} is not open`);
    this.name = 'SessionNotOpenError';
  }
}

export class SessionHasUnsettledMoneyError extends Error {
  readonly code = 'session_has_unsettled_money';
  constructor(readonly sessionId: string, readonly outstandingMinor: number) {
    super(
      `table session ${sessionId} has ${outstandingMinor} outstanding and cannot close. ` +
        'Closing a session with money on it loses the debt silently.',
    );
    this.name = 'SessionHasUnsettledMoneyError';
  }
}

export interface OpenSessionRequest {
  readonly branchId: string;
  readonly diningTableIds: readonly string[];
  readonly guestCount?: number | null;
}

export interface OpenedSession {
  readonly sessionId: string;
  readonly orderId: string;
  readonly businessDate: string;
  readonly version: number;
}

/**
 * The business date is derived SERVER-SIDE from the branch, never sent.
 *
 * A restaurant's day ends at 3am, so it is branch timezone plus
 * `business_day_starts_at` -- not UTC midnight, and certainly not the tablet's
 * idea of today. A device with a wrong clock would otherwise file a night's
 * trade under two dates, and the sold-out reset (which is keyed by business
 * date, and is what makes "resets daily" true with no reset job) would fire in
 * the middle of service.
 */
export async function currentBusinessDate(
  context: TenantContext,
  branchId: string,
): Promise<string> {
  const result = await context.client.query<{ business_date: string }>(
    `SELECT app.business_date(b.timezone, b.business_day_starts_at, now())::text
              AS business_date
       FROM app.branch b WHERE b.tenant_id = $1 AND b.id = $2`,
    [context.tenantId, branchId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`unknown branch ${branchId}`);
  return row.business_date;
}

/**
 * Opening a session and its first order is one transaction.
 *
 * A session with no order is a state every read path would have to handle and
 * no caller wants: the waiter sat a party down in order to take an order. The
 * order is created open and empty rather than lazily on the first line, so
 * `addLine` never has to decide whether to create one -- which is where a race
 * between two waiters on the same table would produce two orders.
 */
export async function openSession(
  context: TenantContext,
  request: OpenSessionRequest,
  actorUserId: string,
): Promise<OpenedSession> {
  const businessDate = await currentBusinessDate(context, request.branchId);
  await assertTablesAtBranch(context, request.branchId, request.diningTableIds);

  // A table already carrying an open session is a real conflict, not a merge:
  // two parties on one bill is how a table walks out paying for half.
  const occupied = await context.client.query<{ dining_table_id: string; session_id: string }>(
    `SELECT tst.dining_table_id, tst.session_id
       FROM app.table_session_table tst
       JOIN app.table_session s ON s.tenant_id = tst.tenant_id AND s.id = tst.session_id
      WHERE tst.tenant_id = $1 AND tst.dining_table_id = ANY($2::uuid[])
        AND tst.detached_at IS NULL AND s.status = 'open'`,
    [context.tenantId, [...request.diningTableIds]],
  );
  const clash = occupied.rows[0];
  if (clash) throw new TableOccupiedError(clash.dining_table_id, clash.session_id);

  const sessionId = randomUUID();
  await context.client.query(
    `INSERT INTO app.table_session
       (id, tenant_id, branch_id, business_date, guest_count, opened_by_user_id)
     VALUES ($1, $2, $3, $4::date, $5, $6)`,
    [sessionId, context.tenantId, request.branchId, businessDate,
     request.guestCount ?? null, actorUserId],
  );

  for (const diningTableId of request.diningTableIds) {
    await context.client.query(
      `INSERT INTO app.table_session_table
         (id, tenant_id, session_id, dining_table_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), context.tenantId, sessionId, diningTableId],
    );
  }

  const orderId = randomUUID();
  await context.client.query(
    // The mode is the order's from here on (0083): every line of it is priced
    // one way, whatever the branch is switched to later.
    `INSERT INTO app.sales_order
       (id, tenant_id, branch_id, session_id, business_date, created_by_user_id, prices_include_tax)
     SELECT $1, $2, $3, $4, $5::date, $6, b.tax_calculation_mode = 'reverse'
       FROM app.branch b WHERE b.tenant_id = $2 AND b.id = $3 FOR SHARE OF b`,
    [orderId, context.tenantId, request.branchId, sessionId, businessDate, actorUserId],
  );

  return { sessionId, orderId, businessDate, version: 1 };
}

/** A party moving tables. One session, a second attachment row. */
export async function moveSession(
  context: TenantContext,
  params: { sessionId: string; fromDiningTableId: string; toDiningTableId: string },
): Promise<void> {
  const session = await lockOpenSession(context, params.sessionId);
  if (session.service_type !== 'dine_in') throw new ServiceTypeMismatchError(params.sessionId, 'dine_in');
  if (session.seating === 'counter') throw new SessionAtCounterError(params.sessionId);
  if (session.stage === 'billing') throw new OrderInBillingError(params.sessionId);
  await assertTablesAtBranch(context, session.branch_id, [params.toDiningTableId]);

  const occupied = await context.client.query<{ session_id: string }>(
    `SELECT tst.session_id
       FROM app.table_session_table tst
       JOIN app.table_session s ON s.tenant_id = tst.tenant_id AND s.id = tst.session_id
      WHERE tst.tenant_id = $1 AND tst.dining_table_id = $2
        AND tst.detached_at IS NULL AND s.status = 'open' AND tst.session_id <> $3`,
    [context.tenantId, params.toDiningTableId, params.sessionId],
  );
  const clash = occupied.rows[0];
  if (clash) throw new TableOccupiedError(params.toDiningTableId, clash.session_id);

  await context.client.query(
    `UPDATE app.table_session_table SET detached_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND dining_table_id = $3
        AND detached_at IS NULL`,
    [context.tenantId, params.sessionId, params.fromDiningTableId],
  );
  await context.client.query(
    `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), context.tenantId, params.sessionId, params.toDiningTableId],
  );
}

/**
 * Closing refuses while money is outstanding.
 *
 * A closed session is invisible to the floor, so closing one that still owes
 * money does not lose a table -- it loses the debt. The check is a positive
 * assertion that every bill is settled, not an absence of open bills: a session
 * with no bill at all has nothing outstanding and closes fine.
 */
export async function closeSession(
  context: TenantContext,
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  const session = await context.client.query<{ status: string }>(
    `SELECT status FROM app.table_session
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, sessionId],
  );
  if (session.rows[0]?.status !== 'open') throw new SessionNotOpenError(sessionId);

  const outstanding = await context.client.query<{ outstanding: string }>(
    // A void tender is a NEW row with a negative amount, not a flag on the
    // original -- rule 9. So the plain sum is already net, and filtering for
    // "not voided" would double-count the void by removing neither side.
    // Against the PAYABLE (0082), net of any tender round-off, as takePayment counts it.
    `SELECT (COALESCE(sum(b.payable_minor), 0)
             - COALESCE((SELECT sum(t.amount_minor - t.rounding_minor)
                           FROM app.tender t
                           JOIN app.bill tb ON tb.tenant_id = t.tenant_id AND tb.id = t.bill_id
                          WHERE t.tenant_id = $1 AND tb.session_id = $2
                            AND tb.status <> 'void'), 0))::text AS outstanding
       FROM app.bill b
      WHERE b.tenant_id = $1 AND b.session_id = $2 AND b.status <> 'void'`,
    [context.tenantId, sessionId],
  );
  const owed = Number(outstanding.rows[0]?.outstanding ?? 0);
  if (owed > 0) throw new SessionHasUnsettledMoneyError(sessionId, owed);

  await context.client.query(
    `UPDATE app.table_session
        SET status = 'closed', closed_at = now(), closed_by_user_id = $3,
            version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, sessionId, actorUserId],
  );
  // The tables go back to the floor. `table_session_one_live_attachment_per_table`
  // counts live attachments whatever the session's status, so a closed session
  // that kept its tables made them unseatable for good.
  await context.client.query(
    `UPDATE app.table_session_table SET detached_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND detached_at IS NULL`,
    [context.tenantId, sessionId],
  );
}

export class TableUnavailableError extends Error {
  readonly code = 'table_unavailable';
  constructor(readonly diningTableIds: readonly string[]) {
    super(`dining table(s) ${diningTableIds.join(', ')} are not active tables at this branch`);
    this.name = 'TableUnavailableError';
  }
}

export class TableRequiredError extends Error {
  readonly code = 'table_required';
  constructor() {
    super('a dine-in party sits at a table; choose at least one, or open a parcel instead');
    this.name = 'TableRequiredError';
  }
}

export class LastTableError extends Error {
  readonly code = 'session_last_table';
  constructor(readonly sessionId: string) {
    super('this is the party\'s only table; move the party, or settle and close, instead of unjoining it');
    this.name = 'LastTableError';
  }
}

export class TableNotInSessionError extends Error {
  readonly code = 'table_not_in_session';
  constructor(readonly diningTableId: string, readonly sessionId: string) {
    super(`dining table ${diningTableId} is not part of this party`);
    this.name = 'TableNotInSessionError';
  }
}

/** A counter dine-in order (Basic, no tables) is seated nowhere: there is no table to join, leave or move to. */
export class SessionAtCounterError extends Error {
  readonly code = 'session_at_counter';
  constructor(readonly sessionId: string) {
    super('this dine-in order is numbered at the counter and has no table to join, leave or move');
    this.name = 'SessionAtCounterError';
  }
}

export class ServiceTypeMismatchError extends Error {
  readonly code = 'service_type_mismatch';
  constructor(readonly sessionId: string, readonly expected: ServiceType) {
    super(expected === 'parcel'
      ? 'that is a dine-in table, not a parcel'
      : 'a parcel has no table to join or unjoin');
    this.name = 'ServiceTypeMismatchError';
  }
}

export class ParcelNotReadyError extends Error {
  readonly code = 'parcel_not_ready';
  constructor(readonly sessionId: string) {
    super('the kitchen has not finished this parcel; send every item and wait for Ready');
    this.name = 'ParcelNotReadyError';
  }
}

export class ParcelAlreadyPickedUpError extends Error {
  readonly code = 'parcel_already_picked_up';
  constructor(readonly sessionId: string) {
    super('this parcel has already been handed over');
    this.name = 'ParcelAlreadyPickedUpError';
  }
}

export type ServiceType = 'dine_in' | 'parcel';
/** Where a party sits: at tables, or numbered at the counter (parcels, and dine-in on Basic). */
export type Seating = 'table' | 'counter';

async function assertTablesAtBranch(
  context: TenantContext,
  branchId: string,
  diningTableIds: readonly string[],
): Promise<void> {
  if (diningTableIds.length === 0) throw new TableRequiredError();
  const found = await context.client.query<{ id: string }>(
    `SELECT id FROM app.dining_table
      WHERE tenant_id = $1 AND branch_id = $2 AND id = ANY($3::uuid[]) AND status = 'active'`,
    [context.tenantId, branchId, [...diningTableIds]],
  );
  const known = new Set(found.rows.map((r) => r.id));
  const missing = diningTableIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new TableUnavailableError(missing);
}

/** The session row, locked: every change to who sits where goes through it. */
async function lockOpenSession(
  context: TenantContext,
  sessionId: string,
): Promise<{ branch_id: string; service_type: ServiceType; seating: Seating; picked_up_at: string | null; stage: string }> {
  const found = await context.client.query<{
    status: string; branch_id: string; service_type: ServiceType; seating: Seating; picked_up_at: string | null; stage: string;
  }>(
    `SELECT status, branch_id, service_type, seating, picked_up_at::text, stage
       FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, sessionId],
  );
  const row = found.rows[0];
  if (row?.status !== 'open') throw new SessionNotOpenError(sessionId);
  return row;
}

/**
 * More people arrive and need the next table: the table joins the SAME session,
 * so there is still one order, one kitchen history and one bill. The original
 * tables keep their own attachment rows -- nothing is concatenated.
 */
export async function joinTable(
  context: TenantContext,
  params: { sessionId: string; diningTableId: string },
): Promise<void> {
  const session = await lockOpenSession(context, params.sessionId);
  if (session.service_type !== 'dine_in') throw new ServiceTypeMismatchError(params.sessionId, 'dine_in');
  if (session.seating === 'counter') throw new SessionAtCounterError(params.sessionId);
  if (session.stage === 'billing') throw new OrderInBillingError(params.sessionId);
  await assertTablesAtBranch(context, session.branch_id, [params.diningTableId]);

  const live = await context.client.query<{ session_id: string }>(
    `SELECT session_id FROM app.table_session_table
      WHERE tenant_id = $1 AND dining_table_id = $2 AND detached_at IS NULL`,
    [context.tenantId, params.diningTableId],
  );
  const holder = live.rows[0]?.session_id;
  if (holder === params.sessionId) return;
  if (holder !== undefined) throw new TableOccupiedError(params.diningTableId, holder);

  try {
    await context.client.query(
      `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), context.tenantId, params.sessionId, params.diningTableId],
    );
  } catch (error) {
    // Two tablets joining the same free table at once: the partial unique index
    // decides, and the loser is told the table is taken rather than "already exists".
    if ((error as { code?: unknown }).code === '23505') {
      throw new TableOccupiedError(params.diningTableId, 'another party');
    }
    throw error;
  }
}

/**
 * The guests separate. The table goes back to the floor; the order and every
 * line on it stay with the party, so nothing is duplicated and nothing is lost.
 * Paying separately is Split bill's job, which already divides one bill by
 * guest, by line or by amount.
 */
export async function unjoinTable(
  context: TenantContext,
  params: { sessionId: string; diningTableId: string },
): Promise<void> {
  const session = await lockOpenSession(context, params.sessionId);
  if (session.service_type !== 'dine_in') throw new ServiceTypeMismatchError(params.sessionId, 'dine_in');
  if (session.seating === 'counter') throw new SessionAtCounterError(params.sessionId);
  if (session.stage === 'billing') throw new OrderInBillingError(params.sessionId);

  const live = await context.client.query<{ dining_table_id: string }>(
    `SELECT dining_table_id FROM app.table_session_table
      WHERE tenant_id = $1 AND session_id = $2 AND detached_at IS NULL`,
    [context.tenantId, params.sessionId],
  );
  const tables = live.rows.map((r) => r.dining_table_id);
  if (!tables.includes(params.diningTableId)) {
    throw new TableNotInSessionError(params.diningTableId, params.sessionId);
  }
  if (tables.length === 1) throw new LastTableError(params.sessionId);

  await context.client.query(
    `UPDATE app.table_session_table SET detached_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND dining_table_id = $3 AND detached_at IS NULL`,
    [context.tenantId, params.sessionId, params.diningTableId],
  );
}

export class GuestCountInvalidError extends Error {
  readonly code = 'guest_count_invalid';
  constructor() {
    super('guests must be a whole number from 1 to 500');
    this.name = 'GuestCountInvalidError';
  }
}

export async function setGuestCount(
  context: TenantContext,
  params: { sessionId: string; guestCount: number },
): Promise<void> {
  if (!Number.isInteger(params.guestCount) || params.guestCount < 1 || params.guestCount > 500) {
    throw new GuestCountInvalidError();
  }
  const session = await lockOpenSession(context, params.sessionId);
  if (session.stage === 'billing') throw new OrderInBillingError(params.sessionId);
  await context.client.query(
    `UPDATE app.table_session SET guest_count = $3 WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, params.sessionId, params.guestCount],
  );
}

export interface OpenParcelRequest {
  readonly branchId: string;
  readonly pickupName?: string | null;
}

export interface OpenedParcel extends OpenedSession {
  readonly parcelNo: number;
}

/**
 * A parcel is a session with no table. The order is created with it for the
 * same reason `openSession` creates one: `addLine` never decides whether to.
 */
export async function openParcel(
  context: TenantContext,
  request: OpenParcelRequest,
  actorUserId: string,
): Promise<OpenedParcel> {
  return openAtCounter(context, request, actorUserId, 'parcel');
}

/**
 * Dine-in where the restaurant has no tables (Basic): numbered at the counter
 * from the SAME counter as parcels, so two orders called out at one counter
 * never share a number. Everything downstream -- lease, fire, KOT, bill,
 * tender, close -- keys on the session and works unchanged.
 */
export async function openCounterDineIn(
  context: TenantContext,
  request: OpenParcelRequest,
  actorUserId: string,
): Promise<OpenedParcel> {
  return openAtCounter(context, request, actorUserId, 'dine_in');
}

async function openAtCounter(
  context: TenantContext,
  request: OpenParcelRequest,
  actorUserId: string,
  serviceType: ServiceType,
): Promise<OpenedParcel> {
  const businessDate = await currentBusinessDate(context, request.branchId);
  const name = request.pickupName?.trim();

  const counter = await context.client.query<{ next_no: number }>(
    `INSERT INTO app.parcel_sequence (tenant_id, branch_id, business_date, next_no)
     VALUES ($1, $2, $3::date, 1)
     ON CONFLICT (tenant_id, branch_id, business_date)
     DO UPDATE SET next_no = app.parcel_sequence.next_no + 1
     RETURNING next_no`,
    [context.tenantId, request.branchId, businessDate],
  );
  const parcelNo = counter.rows[0]!.next_no;

  const sessionId = randomUUID();
  await context.client.query(
    `INSERT INTO app.table_session
       (id, tenant_id, branch_id, business_date, opened_by_user_id,
        service_type, seating, parcel_no, pickup_name)
     VALUES ($1, $2, $3, $4::date, $5, $8, 'counter', $6, $7)`,
    [sessionId, context.tenantId, request.branchId, businessDate, actorUserId,
     parcelNo, name !== undefined && name.length > 0 ? name : null, serviceType],
  );

  const orderId = randomUUID();
  await context.client.query(
    // The mode is the order's from here on (0083): every line of it is priced
    // one way, whatever the branch is switched to later.
    `INSERT INTO app.sales_order
       (id, tenant_id, branch_id, session_id, business_date, created_by_user_id, prices_include_tax)
     SELECT $1, $2, $3, $4, $5::date, $6, b.tax_calculation_mode = 'reverse'
       FROM app.branch b WHERE b.tenant_id = $2 AND b.id = $3 FOR SHARE OF b`,
    [orderId, context.tenantId, request.branchId, sessionId, businessDate, actorUserId],
  );

  return { sessionId, orderId, businessDate, version: 1, parcelNo };
}

/**
 * Handed over the counter. Refused while anything is unsent or still cooking:
 * a parcel handed over half-made is a customer who comes back.
 */
export async function markParcelPickedUp(
  context: TenantContext,
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  const session = await lockOpenSession(context, sessionId);
  if (session.service_type !== 'parcel') throw new ServiceTypeMismatchError(sessionId, 'parcel');
  if (session.picked_up_at !== null) throw new ParcelAlreadyPickedUpError(sessionId);

  const pending = await context.client.query<{ unsent: string; cooking: string; sent: string }>(
    `SELECT
       (SELECT count(*) FROM app.order_line ol
          JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
         WHERE ol.tenant_id = $1 AND so.session_id = $2
           AND ol.kind IN ('item', 'combo_parent') AND ol.fired_at IS NULL)::text AS unsent,
       (SELECT count(*) FROM app.kot_line kl
          JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
          JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
         WHERE kl.tenant_id = $1 AND so.session_id = $2
           AND kl.state IN ('queued', 'preparing'))::text AS cooking,
       (SELECT count(*) FROM app.kot_line kl
          JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
          JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
         WHERE kl.tenant_id = $1 AND so.session_id = $2)::text AS sent`,
    [context.tenantId, sessionId],
  );
  const row = pending.rows[0]!;
  if (Number(row.sent) === 0 || Number(row.unsent) > 0 || Number(row.cooking) > 0) {
    throw new ParcelNotReadyError(sessionId);
  }

  await context.client.query(
    `UPDATE app.table_session
        SET picked_up_at = now(), picked_up_by_user_id = $3
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, sessionId, actorUserId],
  );
}

/* --------------------------------------------- KOT owns it, then Billing --- */

export class OrderInBillingError extends Error {
  readonly code = 'order_in_billing';
  constructor(readonly sessionId: string) {
    super('this order has been handed to billing, so it can no longer be changed. '
      + 'A manager can reopen it for KOT while no bill has been made.');
    this.name = 'OrderInBillingError';
  }
}

export class OrderNotReadyForBillingError extends Error {
  readonly code = 'order_not_ready_for_billing';
  constructor(readonly sessionId: string) {
    super('this order is still with KOT; it can be billed once it is marked ready for billing.');
    this.name = 'OrderNotReadyForBillingError';
  }
}

export class NothingToBillError extends Error {
  readonly code = 'nothing_to_bill';
  constructor(readonly sessionId: string) {
    super('there is nothing on this order to bill yet');
    this.name = 'NothingToBillError';
  }
}

export class UnsentItemsError extends Error {
  readonly code = 'items_not_sent';
  constructor(readonly sessionId: string, readonly unsent: number) {
    super(`${unsent} item(s) have not been sent to the kitchen; send them or remove them first`);
    this.name = 'UnsentItemsError';
  }
}

export class BillAlreadyMadeError extends Error {
  readonly code = 'bill_already_made';
  constructor(readonly sessionId: string) {
    super('a bill has already been made for this order, so it cannot go back to KOT; void the bill first');
    this.name = 'BillAlreadyMadeError';
  }
}

/**
 * The one guard every order change passes, before it touches a line.
 *
 * The session row is taken FOR UPDATE, first -- the head of the documented lock
 * order (claim -> session -> sequences -> lines) -- so a "ready for billing"
 * cannot land between this check and the write it guards. In the domain rather
 * than a route declaration because the offline sync path replays these same
 * functions: a guard in the HTTP layer is one a tablet coming back online walks
 * straight past.
 */
export async function assertTakesOrderChanges(
  context: TenantContext,
  ref: { readonly orderId: string } | { readonly lineId: string },
): Promise<void> {
  const found = 'orderId' in ref
    ? await context.client.query<{ id: string; stage: string }>(
      `SELECT s.id, s.stage FROM app.table_session s
         JOIN app.sales_order so ON so.tenant_id = s.tenant_id AND so.session_id = s.id
        WHERE s.tenant_id = $1 AND so.id = $2
          FOR UPDATE OF s`,
      [context.tenantId, ref.orderId])
    : await context.client.query<{ id: string; stage: string }>(
      `SELECT s.id, s.stage FROM app.table_session s
         JOIN app.sales_order so ON so.tenant_id = s.tenant_id AND so.session_id = s.id
         JOIN app.order_line ol ON ol.tenant_id = so.tenant_id AND ol.order_id = so.id
        WHERE s.tenant_id = $1 AND ol.id = $2
          FOR UPDATE OF s`,
      [context.tenantId, ref.lineId]);
  const row = found.rows[0];
  if (row?.stage === 'billing') throw new OrderInBillingError(row.id);
}

/**
 * KOT hands the order to Billing. From here the order is Billing's: every
 * order change is refused, and the KOT tablet's lease ends so the billing
 * terminal can take the session. Nothing is copied -- the same session, order
 * and lines are what Billing reads and bills.
 *
 * `requireAllSent` is the plan's: with KOT, an unsent item at hand-over is an
 * item the kitchen never saw. Without KOT (Basic) nothing is ever sent.
 */
export async function markReadyForBilling(
  context: TenantContext,
  params: { sessionId: string; requireAllSent: boolean },
  actorUserId: string,
): Promise<{ sessionId: string; stage: 'billing' }> {
  const found = await context.client.query<{ status: string; stage: string }>(
    `SELECT status, stage FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, params.sessionId]);
  const session = found.rows[0];
  if (session?.status !== 'open') throw new SessionNotOpenError(params.sessionId);
  if (session.stage === 'billing') return { sessionId: params.sessionId, stage: 'billing' };

  const lines = await context.client.query<{ items: string; unsent: string }>(
    `SELECT count(*) FILTER (WHERE ol.kind IN ('item', 'combo_parent'))::text AS items,
            -- A product is never sent to a kitchen, so it is never "unsent".
            count(*) FILTER (WHERE ol.kind IN ('item', 'combo_parent') AND ol.fired_at IS NULL
                               AND NOT EXISTS (SELECT 1 FROM app.menu_item p
                                                WHERE p.tenant_id = ol.tenant_id AND p.id = ol.menu_item_id
                                                  AND p.kind = 'product'))::text AS unsent
       FROM app.order_line ol
       JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
      WHERE ol.tenant_id = $1 AND so.session_id = $2`,
    [context.tenantId, params.sessionId]);
  const counts = lines.rows[0]!;
  if (Number(counts.items) === 0) throw new NothingToBillError(params.sessionId);
  if (params.requireAllSent && Number(counts.unsent) > 0) {
    throw new UnsentItemsError(params.sessionId, Number(counts.unsent));
  }

  await context.client.query(
    `UPDATE app.table_session
        SET stage = 'billing', billing_ready_at = now(), billing_ready_by_user_id = $3,
            version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, params.sessionId, actorUserId]);
  await endLeases(context, params.sessionId);
  return { sessionId: params.sessionId, stage: 'billing' };
}

/**
 * The controlled way back: a manager returns an order to KOT. Refused once a
 * bill exists -- the bill is a snapshot of the lines, and letting them move
 * underneath it is exactly the mismatch the stage exists to prevent.
 */
export async function reopenForOrdering(
  context: TenantContext,
  sessionId: string,
): Promise<{ sessionId: string; stage: 'ordering' }> {
  const found = await context.client.query<{ status: string; stage: string }>(
    `SELECT status, stage FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, sessionId]);
  const session = found.rows[0];
  if (session?.status !== 'open') throw new SessionNotOpenError(sessionId);
  if (session.stage === 'ordering') return { sessionId, stage: 'ordering' };
  const billed = await context.client.query(
    `SELECT 1 FROM app.bill WHERE tenant_id = $1 AND session_id = $2 AND status <> 'void' LIMIT 1`,
    [context.tenantId, sessionId]);
  if ((billed.rowCount ?? 0) > 0) throw new BillAlreadyMadeError(sessionId);
  await context.client.query(
    `UPDATE app.table_session
        SET stage = 'ordering', billing_ready_at = NULL, billing_ready_by_user_id = NULL,
            version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, sessionId]);
  await endLeases(context, sessionId);
  return { sessionId, stage: 'ordering' };
}

export class CancelReasonRequiredError extends Error {
  readonly code = 'cancel_reason_required';
  constructor() {
    super('say why the order is being cancelled (at least a few words); it is recorded with the order');
    this.name = 'CancelReasonRequiredError';
  }
}

export class OrderHasPaymentError extends Error {
  readonly code = 'order_has_payment';
  constructor(readonly sessionId: string) {
    super('money has been taken on this order, so it cannot be cancelled; refund it instead');
    this.name = 'OrderHasPaymentError';
  }
}

/**
 * An order nobody will pay for -- a walk-out before the food, a test order, a
 * party that never sat down. Without this the only way to free its tables was
 * to settle it with money that never arrived, which puts a fake sale in every
 * report.
 *
 * Refused once any money is in: a cancelled order with tenders against it is
 * a refund wearing a different name, and the refund path is where the till
 * controls are. Unpaid bills are voided rather than left open, so nothing is
 * owed on an order that no longer exists. Stock already deducted at fire stays
 * deducted -- the kitchen used it (rule 1) -- and lines still cooking are
 * stopped so the kitchen does not plate food for nobody.
 */
export async function cancelOrder(
  context: TenantContext,
  params: { sessionId: string; reason: string; branchId: string | null },
  actorUserId: string,
): Promise<{ sessionId: string; branchId: string; voidedBills: number; stationIds: readonly string[] }> {
  const reason = params.reason.trim();
  if (reason.length < 5) throw new CancelReasonRequiredError();

  const found = await context.client.query<{ status: string; branch_id: string }>(
    // A branch-scoped session cancels only at its own branch; the owner's
    // branch-less session anywhere in the restaurant.
    `SELECT status, branch_id FROM app.table_session
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR branch_id = $3)
        FOR UPDATE`,
    [context.tenantId, params.sessionId, params.branchId]);
  const session = found.rows[0];
  if (session?.status !== 'open') throw new SessionNotOpenError(params.sessionId);

  // Net, because a void tender is a negative row (rule 9): a captured-then-voided
  // tender is no money in, and a settled bill is always money in.
  const money = await context.client.query<{ settled: boolean; paid: string }>(
    `SELECT bool_or(b.status = 'settled') AS settled,
            COALESCE((SELECT sum(t.amount_minor)
                        FROM app.tender t
                        JOIN app.bill tb ON tb.tenant_id = t.tenant_id AND tb.id = t.bill_id
                       WHERE t.tenant_id = $1 AND tb.session_id = $2 AND tb.status <> 'void'), 0)::text AS paid
       FROM app.bill b
      WHERE b.tenant_id = $1 AND b.session_id = $2 AND b.status <> 'void'`,
    [context.tenantId, params.sessionId]);
  const row = money.rows[0];
  if (row?.settled === true || Number(row?.paid ?? 0) !== 0) {
    throw new OrderHasPaymentError(params.sessionId);
  }

  const voided = await context.client.query(
    `UPDATE app.bill SET status = 'void', version = version + 1
      WHERE tenant_id = $1 AND session_id = $2 AND status = 'open'`,
    [context.tenantId, params.sessionId]);

  const stopped = await context.client.query<{ station_id: string }>(
    `WITH stopped AS (
       UPDATE app.kot_line kl SET state = 'cancelled'
         FROM app.order_line ol, app.sales_order so
        WHERE kl.tenant_id = $1 AND kl.state IN ('queued', 'preparing')
          AND ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
          AND so.tenant_id = ol.tenant_id AND so.id = ol.order_id AND so.session_id = $2
       RETURNING kl.tenant_id, kl.kot_id
     )
     SELECT DISTINCT k.station_id::text AS station_id
       FROM stopped s JOIN app.kot k ON k.tenant_id = s.tenant_id AND k.id = s.kot_id`,
    [context.tenantId, params.sessionId]);

  await context.client.query(
    `UPDATE app.sales_order
        SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $3,
            cancel_reason = $4, version = version + 1
      WHERE tenant_id = $1 AND session_id = $2 AND status <> 'cancelled'`,
    [context.tenantId, params.sessionId, actorUserId, reason]);

  await closeSession(context, params.sessionId, actorUserId);
  await endLeases(context, params.sessionId);
  return {
    sessionId: params.sessionId,
    branchId: session.branch_id,
    voidedBills: voided.rowCount ?? 0,
    stationIds: stopped.rows.map((r) => r.station_id),
  };
}

/** Ownership changed hands, so whichever terminal held the session lets go. */
async function endLeases(context: TenantContext, sessionId: string): Promise<void> {
  await context.client.query(
    `UPDATE app.table_session_lease SET released_at = now()
      WHERE tenant_id = $1 AND session_id = $2
        AND released_at IS NULL AND force_released_at IS NULL`,
    [context.tenantId, sessionId]);
}

/** Billing starts only on an order KOT has handed over. */
export async function assertInBilling(context: TenantContext, sessionId: string): Promise<void> {
  const found = await context.client.query<{ stage: string }>(
    `SELECT stage FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, sessionId]);
  if (found.rows[0]?.stage !== 'billing') throw new OrderNotReadyForBillingError(sessionId);
}
