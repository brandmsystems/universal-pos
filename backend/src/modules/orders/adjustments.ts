import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { assertTakesOrderChanges } from './session.js';

/**
 * Void, comp and discount.
 *
 * ###########################################################################
 * AN ADJUSTMENT IS A NEW ROW. IT NEVER UPDATES THE ROW IT ADJUSTS.
 *
 * `SUM(quantity)` is the truth, and it is the truth because the sign is real:
 *
 *   void      quantity < 0    the food was not delivered, or was binned
 *   comp      quantity = 0    the food WAS delivered, free
 *   discount  quantity = 0    money off, nothing about the food
 *
 * Void and comp differ in exactly one number and it is the important one. "How
 * many did we make" and "how many did we sell" are different questions, and this
 * is where they separate: a comp was made and served, so production stands and
 * only money goes to zero.
 *
 * NEITHER reverses a stock deduction. The kitchen consumed the ingredients when
 * it started cooking, which is the same rule that forbids deducting at payment.
 * There is no code path here that touches stock, and there must not be one.
 * ###########################################################################
 */

export type AdjustmentKind = 'void' | 'comp' | 'discount';

export class AdjustmentExceedsOriginalError extends Error {
  readonly code = 'adjustment_exceeds_original';
  constructor(readonly lineId: string, readonly why: string) {
    super(`adjustment against line ${lineId} exceeds the original: ${why}`);
    this.name = 'AdjustmentExceedsOriginalError';
  }
}

export class LineNotFiredError extends Error {
  readonly code = 'line_not_fired';
  constructor(readonly lineId: string) {
    super(
      `order line ${lineId} has not fired. Before the kitchen sees it a change is ` +
        'a correction (order.line.remove), not a void: forcing typo corrections ' +
        'into void rows is what makes the exception report unreadable.',
    );
    this.name = 'LineNotFiredError';
  }
}

export class DiscountExceedsAuthorityError extends Error {
  readonly code = 'discount_exceeds_authority';
  constructor(readonly requestedMinor: number, readonly why: string) {
    super(`discount of ${requestedMinor} exceeds this user's authority: ${why}`);
    this.name = 'DiscountExceedsAuthorityError';
  }
}

export class ReasonRequiredError extends Error {
  readonly code = 'reason_required';
  constructor(readonly kind: AdjustmentKind) {
    super(
      `a ${kind} requires a reason code. For every risky key the real control is ` +
        'the reason plus the report, not the permission.',
    );
    this.name = 'ReasonRequiredError';
  }
}

interface TargetLine {
  id: string;
  branch_id: string;
  order_id: string;
  kind: string;
  display_name: string;
  unit_price_minor: string;
  quantity: number;
  fired_at: string | null;
  net_quantity: string;
  net_money: string;
}

/**
 * The target is read FOR UPDATE, and the running net is read with it.
 *
 * Two voids of the same line racing would each see the full quantity available
 * and both succeed; the deferred trigger would catch the result at COMMIT, but
 * only for whichever transaction committed second, and the error would name a
 * constraint rather than the concurrent void. Locking the target row makes the
 * second one wait and then see the first one's effect.
 */
async function lockTarget(context: TenantContext, lineId: string): Promise<TargetLine> {
  const result = await context.client.query<TargetLine>(
    `SELECT ol.id, ol.branch_id, ol.order_id, ol.kind, ol.display_name,
            ol.unit_price_minor::text, ol.quantity, ol.fired_at::text,
            COALESCE((SELECT sum(adj.quantity) FROM app.order_line adj
                       WHERE adj.tenant_id = ol.tenant_id AND adj.adjusts_line_id = ol.id),
                     0)::text AS net_quantity,
            COALESCE((SELECT sum(adj.line_total_minor) FROM app.order_line adj
                       WHERE adj.tenant_id = ol.tenant_id AND adj.adjusts_line_id = ol.id),
                     0)::text AS net_money
       FROM app.order_line ol
      WHERE ol.tenant_id = $1 AND ol.id = $2
        FOR UPDATE OF ol`,
    [context.tenantId, lineId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`unknown order line ${lineId}`);
  if (row.kind !== 'item' && row.kind !== 'combo_component') {
    throw new Error(
      `line ${lineId} is a ${row.kind} and carries no money to adjust; ` +
        'a combo is adjusted through its components',
    );
  }
  return row;
}

async function insertAdjustment(
  context: TenantContext,
  args: {
    target: TargetLine; kind: AdjustmentKind; quantity: number;
    lineTotalMinor: number; reasonId: string; note: string | null; actorUserId: string;
  },
): Promise<string> {
  const id = randomUUID();
  await context.client.query(
    `INSERT INTO app.order_line
       (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
        unit_price_minor, quantity, line_total_minor,
        adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
        adjustment_reason_id, adjustment_note, fired_at, created_by_user_id)
     SELECT $1, $2, $3, $4, $5, ol.menu_item_id, ol.display_name,
            ol.unit_price_minor, $6, $7,
            ol.id, ol.kind, ol.unit_price_minor,
            $8, $9, now(), $10
       FROM app.order_line ol
      WHERE ol.tenant_id = $2 AND ol.id = $11`,
    [
      id, context.tenantId, args.target.branch_id, args.target.order_id, args.kind,
      args.quantity, args.lineTotalMinor,
      args.reasonId, args.note, args.actorUserId, args.target.id,
    ],
  );
  return id;
}

export interface VoidRequest {
  readonly lineId: string;
  readonly quantity: number;
  readonly reasonId: string;
  readonly note?: string | null;
}

/**
 * Post-fire. The food was cooked and is being written off, so sales quantity
 * falls and the money goes with it.
 */
export async function voidLine(
  context: TenantContext,
  request: VoidRequest,
  actorUserId: string,
): Promise<string> {
  if (!request.reasonId) throw new ReasonRequiredError('void');
  await assertTakesOrderChanges(context, { lineId: request.lineId });
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new Error('void quantity must be a positive integer; the sign is applied here');
  }

  const target = await lockTarget(context, request.lineId);
  if (target.fired_at === null) throw new LineNotFiredError(request.lineId);

  const remaining = target.quantity + Number(target.net_quantity);
  if (request.quantity > remaining) {
    throw new AdjustmentExceedsOriginalError(
      request.lineId, `${remaining} of ${target.quantity} remain unvoided`);
  }

  const unitPrice = Number(target.unit_price_minor);
  return insertAdjustment(context, {
    target, kind: 'void',
    quantity: -request.quantity,
    lineTotalMinor: -(unitPrice * request.quantity),
    reasonId: request.reasonId, note: request.note ?? null, actorUserId,
  });
}

/**
 * The dish was delivered and the customer is not paying for it. Quantity stands
 * at zero -- production is unchanged, only the money moves.
 */
export async function compLine(
  context: TenantContext,
  request: VoidRequest,
  actorUserId: string,
): Promise<string> {
  if (!request.reasonId) throw new ReasonRequiredError('comp');
  await assertTakesOrderChanges(context, { lineId: request.lineId });
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new Error('comp quantity must be a positive integer');
  }

  const target = await lockTarget(context, request.lineId);
  if (target.fired_at === null) throw new LineNotFiredError(request.lineId);

  const unitPrice = Number(target.unit_price_minor);
  const money = unitPrice * request.quantity;
  const alreadyReduced = -Number(target.net_money);
  const original = unitPrice * target.quantity;
  if (alreadyReduced + money > original) {
    throw new AdjustmentExceedsOriginalError(
      request.lineId,
      `${original - alreadyReduced} of ${original} remains chargeable`);
  }

  return insertAdjustment(context, {
    target, kind: 'comp',
    // Zero, deliberately. A comp that moved quantity would understate production
    // and make "how many did we make" disagree with the kitchen.
    quantity: 0,
    lineTotalMinor: -money,
    reasonId: request.reasonId, note: request.note ?? null, actorUserId,
  });
}

export interface DiscountRequest {
  readonly lineId: string;
  readonly reasonId: string;
  readonly percent?: number;
  readonly amountMinor?: number;
  readonly note?: string | null;
}

/**
 * The authority the acting membership union supplies. Passed in rather than
 * re-read: the permission check already resolved it, and re-reading would let
 * the two disagree.
 */
export interface DiscountAuthority {
  readonly discountPercentCap: number;
  readonly discountAmountCap: number | null;
}

/**
 * ###########################################################################
 * THE CAP IS THE CONTROL. THE KEY IS ONLY WHO MAY ASK.
 *
 * `order.discount` is binary and discount authority is a limit, so granting the
 * key with no ceiling grants unlimited comp. The cap is policy data on the role,
 * and the two columns are deliberately asymmetric:
 *
 *  - discount_percent_cap is NOT NULL DEFAULT 0. This is THE authority. Zero
 *    means none, so a role holding the key with the default can discount
 *    nothing until someone sets a cap deliberately -- new keys default deny.
 *  - discount_amount_cap is nullable, and NULL does NOT mean unlimited. It means
 *    the percentage is the only ceiling. The same reading as a NULL max_select.
 *
 * Both bind when both are set. There is no way to express unlimited authority,
 * because the percentage is NOT NULL and capped at 100 of a finite bill.
 * ###########################################################################
 */
export async function discountLine(
  context: TenantContext,
  request: DiscountRequest,
  authority: DiscountAuthority,
  actorUserId: string,
): Promise<string> {
  await assertTakesOrderChanges(context, { lineId: request.lineId });
  if (!request.reasonId) throw new ReasonRequiredError('discount');
  if ((request.percent === undefined) === (request.amountMinor === undefined)) {
    throw new Error('a discount is either a percentage or an amount, exactly one');
  }

  const target = await lockTarget(context, request.lineId);
  if (target.fired_at === null) throw new LineNotFiredError(request.lineId);

  const unitPrice = Number(target.unit_price_minor);
  const original = unitPrice * target.quantity;

  let amount: number;
  if (request.percent !== undefined) {
    if (!Number.isFinite(request.percent) || request.percent <= 0 || request.percent > 100) {
      throw new Error('a percentage discount must be within (0, 100]');
    }
    if (request.percent > authority.discountPercentCap) {
      throw new DiscountExceedsAuthorityError(
        original,
        `${request.percent}% requested, cap is ${authority.discountPercentCap}%`);
    }
    amount = Math.round((original * request.percent) / 100);
  } else {
    amount = request.amountMinor!;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('an amount discount must be a positive integer in minor units');
    }
    // An absolute amount is still checked against the PERCENTAGE cap, because
    // the percentage is the authority. Otherwise the amount form would be a way
    // to route around it -- exactly the shape of a lower branch price being an
    // uncapped discount channel.
    const impliedPercent = original === 0 ? 100 : (amount * 100) / original;
    if (impliedPercent > authority.discountPercentCap) {
      throw new DiscountExceedsAuthorityError(
        amount,
        `${impliedPercent.toFixed(2)}% of the line, cap is ${authority.discountPercentCap}%`);
    }
  }

  if (authority.discountAmountCap !== null && amount > authority.discountAmountCap) {
    throw new DiscountExceedsAuthorityError(
      amount, `absolute ceiling is ${authority.discountAmountCap}`);
  }

  const alreadyReduced = -Number(target.net_money);
  if (alreadyReduced + amount > original) {
    throw new AdjustmentExceedsOriginalError(
      request.lineId, `${original - alreadyReduced} of ${original} remains chargeable`);
  }

  return insertAdjustment(context, {
    target, kind: 'discount', quantity: 0, lineTotalMinor: -amount,
    reasonId: request.reasonId, note: request.note ?? null, actorUserId,
  });
}
