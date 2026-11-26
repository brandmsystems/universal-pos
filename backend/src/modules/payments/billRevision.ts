import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { addLine } from '../orders/orderEntry.js';
import { voidLine } from '../orders/adjustments.js';
import { currentBusinessDate } from '../orders/session.js';
import { fireOrder } from '../kitchen/fire.js';
import { generateBill, recordRefund, TENDER_METHODS, type GeneratedBill, type TenderMethod } from './billing.js';
import { assertMayEditDay, type EditAuthority } from './dayEnd.js';

/**
 * Editing a bill (0086). An edit never rewrites a bill or a payment:
 *
 *   UNPAID  nothing collected: the bill is voided -- kept, with its number --
 *           the items are changed on the order and the bill is REISSUED under
 *           a new number, from the order lines like any bill.
 *   PAID    the bill and its payments stand. Items added go on a SUPPLEMENTARY
 *           bill, collected by the till through the ordinary payment flow; items
 *           taken off are refunded as a credit note against the bill (a manager
 *           only, on a fully paid bill).
 *
 * Removal is a void row against the order line (rule 7) and an addition is an
 * ordinary order line, priced from the menu and sent to the kitchen like any
 * other -- so totals, tax and round-off are the server's, by the same
 * functions every bill uses. The revision row records who, why, in which
 * capacity, and the bill before and after.
 *
 * WHO MAY EDIT WHAT is `assertMayEditDay`: the till today's bills until the day
 * is submitted, and after that only while a manager's Allow POS Bill Editing is
 * on (the revision then names that grant); a manager any day, a submitted one
 * only once reopened. On top of
 * that the till may not take an item off a paid bill -- that hands money back,
 * which is a refund and a manager's.
 */

export class BillEditReasonRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'bill_edit_reason_required';
  constructor() {
    super('say why the bill is being edited (5 to 500 characters); it is kept with the edit');
    this.name = 'BillEditReasonRequiredError';
  }
}

export class BillEditInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'bill_edit_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'BillEditInvalidError';
  }
}

export class BillEditUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'bill_edit_unknown';
  constructor(readonly billId: string) {
    super(`no bill ${billId} at this branch`);
    this.name = 'BillEditUnknownError';
  }
}

export class BillEditStaleError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_edit_stale';
  constructor(readonly billId: string) {
    super('this bill changed since it was opened (edited or paid); open it again to see it as it is now');
    this.name = 'BillEditStaleError';
  }
}

export class BillEditNotEditableError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_edit_not_editable';
  constructor(why: string) {
    super(why);
    this.name = 'BillEditNotEditableError';
  }
}

export class BillEditReducesPaidBillError extends Error {
  readonly statusCode = 403;
  readonly code = 'bill_edit_reduces_paid_bill';
  constructor() {
    super('this bill is paid: taking an item off hands money back, which is a refund a manager makes. The till may add items.');
    this.name = 'BillEditReducesPaidBillError';
  }
}

export class BillEditEmptiesBillError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_edit_empties_bill';
  constructor() {
    super('this edit takes every item off the bill; that is cancelling the order (unpaid) or refunding it (paid), not an edit');
    this.name = 'BillEditEmptiesBillError';
  }
}

export interface RemoveRequest { readonly lineId: string; readonly quantity: number }
export interface AddRequest {
  readonly menuItemId: string;
  readonly quantity: number;
  readonly modifierOptionIds?: readonly string[];
  readonly choices?: readonly { readonly choiceGroupId: string; readonly menuItemId: string }[];
}

export interface ReviseBillRequest {
  readonly billId: string;
  /** The token's branch; null for a restaurant-wide (owner) session. */
  readonly branchId: string | null;
  readonly authority: EditAuthority;
  readonly expectedVersion: unknown;
  readonly reason: unknown;
  readonly remove?: unknown;
  readonly add?: unknown;
  readonly refundMethod?: unknown;
  readonly editedByUserId: string;
}

interface BillImage {
  readonly billNo: number;
  readonly lines: readonly { readonly name: string; readonly quantity: number; readonly amountMinor: number; readonly taxMinor: number }[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly roundOffMinor: number;
  readonly payableMinor: number;
}

export interface ReviseBillResult {
  readonly revisionId: string;
  readonly authority: EditAuthority;
  readonly billId: string;
  readonly before: BillImage;
  /** The reissued bill (unpaid), or the original as it now stands plus what follows it (paid). */
  readonly after: BillImage;
  readonly replacementBill: { readonly billId: string; readonly billNo: number; readonly payableMinor: number } | null;
  readonly supplementaryBill: { readonly billId: string; readonly billNo: number; readonly payableMinor: number } | null;
  readonly refund: { readonly refundId: string; readonly amountMinor: number; readonly method: TenderMethod } | null;
  /** What the customer owes now on the bill this edit leaves to collect. */
  readonly collectMinor: number;
  /** What the customer's position moved by: supplementary payable less any refund, or new payable less old. */
  readonly differenceMinor: number;
}

const MAX_CHANGES = 50;

function isUuidish(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

function positiveQuantity(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 999) {
    throw new BillEditInvalidError(`${what} quantity is a whole number from 1 to 999`);
  }
  return value;
}

function parseChanges(request: ReviseBillRequest): { remove: RemoveRequest[]; add: AddRequest[]; reason: string } {
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw new BillEditReasonRequiredError();
  const rawRemove = request.remove ?? [];
  const rawAdd = request.add ?? [];
  if (!Array.isArray(rawRemove) || !Array.isArray(rawAdd)) throw new BillEditInvalidError('remove and add are lists');
  if (rawRemove.length + rawAdd.length === 0) throw new BillEditInvalidError('an edit takes something off or adds something');
  if (rawRemove.length > MAX_CHANGES || rawAdd.length > MAX_CHANGES) {
    throw new BillEditInvalidError(`at most ${MAX_CHANGES} removals and ${MAX_CHANGES} additions in one edit`);
  }
  const remove = rawRemove.map((r: unknown) => {
    const item = (r ?? {}) as Record<string, unknown>;
    if (!isUuidish(item['lineId'])) throw new BillEditInvalidError('each removal names a lineId from the bill');
    return { lineId: item['lineId'], quantity: positiveQuantity(item['quantity'], 'a removal') };
  });
  if (new Set(remove.map((r) => r.lineId)).size !== remove.length) {
    throw new BillEditInvalidError('name each line once, with the whole quantity to take off');
  }
  const add = rawAdd.map((a: unknown) => {
    const item = (a ?? {}) as Record<string, unknown>;
    if (!isUuidish(item['menuItemId'])) throw new BillEditInvalidError('each addition names a menuItemId');
    const options = item['modifierOptionIds'] ?? [];
    if (!Array.isArray(options) || !options.every(isUuidish)) throw new BillEditInvalidError('modifierOptionIds is a list of ids');
    const choices = item['choices'];
    if (choices !== undefined && !Array.isArray(choices)) throw new BillEditInvalidError('choices is a list');
    const added: AddRequest = {
      menuItemId: item['menuItemId'], quantity: positiveQuantity(item['quantity'], 'an addition'),
      modifierOptionIds: options as string[],
      ...(choices === undefined ? {} : { choices: choices as NonNullable<AddRequest['choices']> }),
    };
    return added;
  });
  return { remove, add, reason };
}

async function billImage(context: TenantContext, billId: string): Promise<BillImage> {
  const bill = await context.client.query<{
    bill_no: number; subtotal_minor: string; tax_minor: string; total_minor: string;
    round_off_minor: string; payable_minor: string;
  }>(
    `SELECT bill_no, subtotal_minor::text, tax_minor::text, total_minor::text, round_off_minor::text, payable_minor::text
       FROM app.bill WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, billId],
  );
  const lines = await context.client.query<{ name: string; quantity: number; amount_minor: string; tax_minor: string }>(
    `SELECT COALESCE(p.display_name, ol.display_name) AS name,
            max(CASE WHEN p.id IS NULL THEN ol.quantity + COALESCE((SELECT sum(v.quantity) FROM app.order_line v
                      WHERE v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id AND v.kind = 'void'), 0)
                 ELSE p.quantity END)::int AS quantity,
            sum(bl.amount_minor)::text AS amount_minor, sum(bl.tax_minor)::text AS tax_minor
       FROM app.bill_line bl
       JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
       LEFT JOIN app.order_line p ON p.tenant_id = ol.tenant_id AND p.id = ol.parent_line_id
      WHERE bl.tenant_id = $1 AND bl.bill_id = $2
      GROUP BY COALESCE(p.id, ol.id), COALESCE(p.display_name, ol.display_name)
      ORDER BY min(ol.created_at)`,
    [context.tenantId, billId],
  );
  const b = bill.rows[0]!;
  return {
    billNo: b.bill_no,
    lines: lines.rows.map((l) => ({
      name: l.name, quantity: l.quantity, amountMinor: Number(l.amount_minor), taxMinor: Number(l.tax_minor),
    })),
    subtotalMinor: Number(b.subtotal_minor), taxMinor: Number(b.tax_minor), totalMinor: Number(b.total_minor),
    roundOffMinor: Number(b.round_off_minor), payableMinor: Number(b.payable_minor),
  };
}

async function correctionReason(context: TenantContext): Promise<string> {
  const found = await context.client.query<{ id: string }>(
    `SELECT id FROM app.adjustment_reason WHERE tenant_id = $1 AND key = 'bill_corrected'`,
    [context.tenantId],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error('the bill_corrected reason is missing for this restaurant (0086 seeds it)');
  return id;
}

/** The refund for `quantity` of a billed line: its share of what the bill charged for it, tax included. */
async function refundFor(
  context: TenantContext, billId: string, lineId: string, quantity: number,
): Promise<number> {
  const found = await context.client.query<{ charged: string; billed: number }>(
    `SELECT (bl.amount_minor + bl.tax_minor)::text AS charged,
            (ol.quantity + COALESCE((SELECT sum(v.quantity) FROM app.order_line v
                                      WHERE v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id
                                        AND v.kind = 'void' AND v.created_at <= b.generated_at), 0))::int AS billed
       FROM app.bill_line bl
       JOIN app.bill b ON b.tenant_id = bl.tenant_id AND b.id = bl.bill_id
       JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
      WHERE bl.tenant_id = $1 AND bl.bill_id = $2 AND bl.order_line_id = $3`,
    [context.tenantId, billId, lineId],
  );
  const row = found.rows[0]!;
  return row.billed <= 0 ? 0 : Math.round((Number(row.charged) * quantity) / row.billed);
}

/**
 * Edit a bill. Lock order: the request claim (the registrar's), the day lock,
 * the session, then the bill -- the session before the bill, as everywhere.
 */
export async function reviseBill(context: TenantContext, request: ReviseBillRequest): Promise<ReviseBillResult> {
  const { remove, add, reason } = parseChanges(request);
  if (request.refundMethod !== undefined && request.refundMethod !== null
      && !TENDER_METHODS.includes(request.refundMethod as TenderMethod)) {
    throw new BillEditInvalidError(`unknown refund method ${String(request.refundMethod)}`);
  }

  const located = await context.client.query<{ branch_id: string; business_date: string; session_id: string }>(
    `SELECT branch_id, business_date::text, session_id FROM app.bill
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR branch_id = $3)`,
    [context.tenantId, request.billId, request.branchId],
  );
  const where = located.rows[0];
  if (where === undefined) throw new BillEditUnknownError(request.billId);
  const today = await currentBusinessDate(context, where.branch_id);
  const { submissionId, grantId } = await assertMayEditDay(context, {
    branchId: where.branch_id, businessDate: where.business_date, today, authority: request.authority,
  });

  const sessionFound = await context.client.query<{
    status: string; stage: string; billing_ready_at: string | null; billing_ready_by_user_id: string | null;
  }>(
    `SELECT status, stage, billing_ready_at::text, billing_ready_by_user_id
       FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, where.session_id],
  );
  const session = sessionFound.rows[0]!;
  const billFound = await context.client.query<{ status: string; split_kind: string; version: number; payable_minor: string }>(
    `SELECT status, split_kind, version, payable_minor::text FROM app.bill
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, request.billId],
  );
  const bill = billFound.rows[0]!;
  if (request.expectedVersion !== bill.version) throw new BillEditStaleError(request.billId);
  if (bill.status === 'void') {
    throw new BillEditNotEditableError('this bill was voided or replaced by an edit; edit the bill that replaced it');
  }
  if (bill.split_kind === 'by_percentage') {
    throw new BillEditNotEditableError('a bill split by percentage shares its lines with another bill and cannot be edited on its own');
  }
  if (session.stage !== 'billing' || session.billing_ready_at === null) {
    throw new BillEditNotEditableError('this order is back with the kitchen; finish it there');
  }

  const tendered = await context.client.query<{ net: string; largest: TenderMethod | null }>(
    `SELECT COALESCE(sum(amount_minor - rounding_minor), 0)::text AS net,
            (SELECT method FROM app.tender WHERE tenant_id = $1 AND bill_id = $2 AND kind = 'capture'
              GROUP BY method ORDER BY sum(amount_minor) DESC LIMIT 1) AS largest
       FROM app.tender WHERE tenant_id = $1 AND bill_id = $2`,
    [context.tenantId, request.billId],
  );
  const paidMinor = Number(tendered.rows[0]!.net);
  const paid = bill.status === 'settled' || paidMinor > 0;

  // What a removal may name: an item line of THIS bill. A combo is priced across
  // its components and is not taken apart here.
  if (remove.length > 0) {
    const onBill = await context.client.query<{ order_line_id: string; kind: string; parent_line_id: string | null }>(
      `SELECT bl.order_line_id, ol.kind, ol.parent_line_id
         FROM app.bill_line bl
         JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
        WHERE bl.tenant_id = $1 AND bl.bill_id = $2`,
      [context.tenantId, request.billId],
    );
    const items = new Set(onBill.rows.filter((r) => r.kind === 'item').map((r) => r.order_line_id));
    const combos = new Set(onBill.rows.flatMap((r) => (r.parent_line_id === null ? [] : [r.parent_line_id])));
    for (const r of remove) {
      if (combos.has(r.lineId)) throw new BillEditNotEditableError('a combo cannot be taken off a bill by an edit');
      if (!items.has(r.lineId)) throw new BillEditInvalidError(`line ${r.lineId} is not an item on this bill`);
    }
    if (paid && request.authority === 'pos') throw new BillEditReducesPaidBillError();
    if (paid && bill.status !== 'settled') {
      throw new BillEditNotEditableError('this bill is part paid: take the rest of the payment before taking items off');
    }
  }
  if (paid && add.length > 0 && where.business_date !== today) {
    throw new BillEditNotEditableError('items are added to a paid bill only on its own day, while the customer is there to pay for them');
  }

  const before = await billImage(context, request.billId);
  const actor = request.editedByUserId;

  // A bill's figures never change in place; its version moves so a second tap on
  // the same screen (or a stale one) is refused rather than applied twice.
  await context.client.query(
    `UPDATE app.bill SET version = version + 1 ${paid ? '' : ", status = 'void'"}
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, request.billId],
  );
  if (paid && add.length > 0 && session.status === 'closed') {
    // More to collect: the order goes back on the till's queue until it is paid.
    await context.client.query(
      `UPDATE app.table_session SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, where.session_id],
    );
  }

  // The order takes changes again for the length of this transaction only: the
  // session row is locked, so nothing else sees it between here and the restore.
  await context.client.query(
    `UPDATE app.table_session SET stage = 'ordering', billing_ready_at = NULL, billing_ready_by_user_id = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, where.session_id],
  );

  const reasonId = remove.length > 0 || paid ? await correctionReason(context) : null;
  for (const r of remove) {
    await voidLine(context, { lineId: r.lineId, quantity: r.quantity, reasonId: reasonId!, note: reason }, actor);
  }

  const addedMoneyLines: string[] = [];
  if (add.length > 0) {
    const order = await context.client.query<{ id: string }>(
      `SELECT id FROM app.sales_order WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at LIMIT 1`,
      [context.tenantId, where.session_id],
    );
    const orderId = order.rows[0]!.id;
    for (const a of add) {
      const line = await addLine(context, { orderId, ...a }, actor);
      addedMoneyLines.push(...(line.kind === 'combo_parent' ? line.componentLineIds : [line.lineId]));
    }
    const version = await context.client.query<{ version: number }>(
      `SELECT version FROM app.table_session WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, where.session_id],
    );
    // Sent to the kitchen like any added item: a ticket for what is new, and the
    // lines become fired records that only a void can change from here on.
    await fireOrder(context, {
      branchId: where.branch_id, orderId, sessionId: where.session_id,
      sessionVersion: version.rows[0]!.version, firedByUserId: actor, businessDate: today,
    });
  }

  await context.client.query(
    `UPDATE app.table_session SET stage = 'billing', billing_ready_at = $3::timestamptz, billing_ready_by_user_id = $4
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, where.session_id, session.billing_ready_at, session.billing_ready_by_user_id],
  );

  let replacement: GeneratedBill | null = null;
  let supplementary: GeneratedBill | null = null;
  let refund: { refundId: string; amountMinor: number; method: TenderMethod } | null = null;

  if (!paid) {
    const others = await context.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.bill
        WHERE tenant_id = $1 AND session_id = $2 AND status <> 'void'`,
      [context.tenantId, where.session_id],
    );
    const lineIds = await context.client.query<{ order_line_id: string }>(
      `SELECT order_line_id FROM app.bill_line WHERE tenant_id = $1 AND bill_id = $2`,
      [context.tenantId, request.billId],
    );
    const whole = bill.split_kind === 'whole' && others.rows[0]!.n === 0;
    replacement = await generateBill(context, {
      branchId: where.branch_id, sessionId: where.session_id, businessDate: where.business_date,
      generatedByUserId: actor,
      ...(whole ? { splitKind: 'whole' as const }
        : { splitKind: 'by_line' as const, lineIds: [...lineIds.rows.map((l) => l.order_line_id), ...addedMoneyLines] }),
    });
    if (replacement.lineCount === 0) throw new BillEditEmptiesBillError();
  } else {
    if (remove.length > 0) {
      const left = await context.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.bill_line bl
          WHERE bl.tenant_id = $1 AND bl.bill_id = $2
            AND (SELECT ol.line_total_minor + COALESCE(sum(v.line_total_minor), 0)
                   FROM app.order_line ol
                   LEFT JOIN app.order_line v ON v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id
                  WHERE ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
                  GROUP BY ol.line_total_minor) > 0`,
        [context.tenantId, request.billId],
      );
      if (left.rows[0]!.n === 0) throw new BillEditEmptiesBillError();
      let amount = 0;
      for (const r of remove) amount += await refundFor(context, request.billId, r.lineId, r.quantity);
      if (amount > 0) {
        const method = (request.refundMethod ?? tendered.rows[0]!.largest ?? 'cash') as TenderMethod;
        const made = await recordRefund(context, {
          billId: request.billId, branchId: where.branch_id, amountMinor: amount, method,
          reasonId: reasonId!, note: reason, refundedByUserId: actor,
        });
        refund = { refundId: made.refundId, amountMinor: amount, method };
      }
    }
    if (addedMoneyLines.length > 0) {
      supplementary = await generateBill(context, {
        branchId: where.branch_id, sessionId: where.session_id, businessDate: where.business_date,
        generatedByUserId: actor, splitKind: 'by_line', lineIds: addedMoneyLines,
      });
    }
  }

  const resultBill = replacement?.billId ?? request.billId;
  const image = await billImage(context, resultBill);
  const extra = (supplementary?.payableMinor ?? 0) - (refund?.amountMinor ?? 0);
  const after: BillImage = replacement !== null ? image : {
    ...image,
    // The customer's position: what the original asked, plus what follows it, less what went back.
    payableMinor: image.payableMinor + extra,
  };

  const revisionId = randomUUID();
  await context.client.query(
    `INSERT INTO app.bill_revision
       (id, tenant_id, branch_id, business_date, bill_id, replacement_bill_id, supplementary_bill_id, refund_id,
        authority, day_submission_id, pos_edit_grant_id, reason, edited_by_user_id, edited_at, before, after,
        before_payable_minor, after_payable_minor)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, clock_timestamp(), $14::jsonb, $15::jsonb,
             $16, $17)`,
    [
      revisionId, context.tenantId, where.branch_id, where.business_date, request.billId,
      replacement?.billId ?? null, supplementary?.billId ?? null, refund?.refundId ?? null,
      request.authority, submissionId, grantId, reason, actor,
      JSON.stringify(before), JSON.stringify(after), before.payableMinor, after.payableMinor,
    ],
  );

  return {
    revisionId, authority: request.authority, billId: request.billId, before, after,
    replacementBill: replacement === null ? null
      : { billId: replacement.billId, billNo: replacement.billNo, payableMinor: replacement.payableMinor },
    supplementaryBill: supplementary === null ? null
      : { billId: supplementary.billId, billNo: supplementary.billNo, payableMinor: supplementary.payableMinor },
    refund,
    collectMinor: replacement !== null ? replacement.payableMinor : (supplementary?.payableMinor ?? 0),
    differenceMinor: replacement !== null ? replacement.payableMinor - before.payableMinor : extra,
  };
}

/**
 * The same edit, run and rolled back: the server's own totals, tax and
 * round-off for the confirmation, with nothing kept. A savepoint rather than a
 * second calculation, so the preview cannot disagree with the edit.
 */
export async function previewBillRevision(
  context: TenantContext,
  request: ReviseBillRequest,
): Promise<ReviseBillResult & { preview: true }> {
  await context.client.query('SAVEPOINT bill_revision_preview');
  try {
    const result = await reviseBill(context, request);
    return { ...result, preview: true };
  } finally {
    await context.client.query('ROLLBACK TO SAVEPOINT bill_revision_preview');
    await context.client.query('RELEASE SAVEPOINT bill_revision_preview');
  }
}
