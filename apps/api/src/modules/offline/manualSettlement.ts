import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Money that changed hands outside the system during an outage.
 *
 * ###########################################################################
 * THIS IS NOT OFFLINE SETTLEMENT.
 *
 * The bill is generated online and the tender is recorded online, after the
 * fact. What is being recorded is that a manual card machine or a cash envelope
 * took the money while the terminal was down -- a different and auditable thing.
 * No device ever decides, offline, that a bill is settled; that would admit
 * double-settlement, which is unrecoverable.
 *
 * It exists because the alternative is not "this never happens". Staff WILL take
 * money on a manual card machine during an outage, and if the product has no home
 * for it they will invent one: a note in the till, a WhatsApp message, a figure
 * keyed in as cash days later. Giving it a mandatory reference, an authoriser and
 * a reason code turns an off-book workaround into a reportable line.
 * ###########################################################################
 */

export class ManualSettlementIncompleteError extends Error {
  readonly statusCode = 422;
  readonly code = 'manual_settlement_incomplete';
  constructor(readonly missing: readonly string[]) {
    super(
      `manual settlement requires ${missing.join(', ')}. ` +
        'A manual tender without a reference is an unverifiable assertion that money arrived.',
    );
    this.name = 'ManualSettlementIncompleteError';
  }
}

export interface ManualTenderParams {
  readonly billId: string;
  readonly method: 'cash' | 'card' | 'upi' | 'wallet' | 'voucher' | 'other';
  readonly amountMinor: number;
  readonly roundingMinor?: number;
  /** The card slip number, the cash envelope id -- what the operator can produce. */
  readonly operatorReference: string;
  readonly reasonId: string;
  /** Manager or above: payment.settle.manual is financial-transaction class. */
  readonly authorisedByUserId: string;
  readonly tenderedByUserId: string;
}

/**
 * Records the tender. The completeness rule is enforced by CHECK at the schema
 * level too -- this raises a typed error first so the caller gets a usable
 * message rather than a constraint name.
 */
export async function recordManualSettlement(
  context: TenantContext,
  params: ManualTenderParams,
): Promise<{ tenderId: string }> {
  const missing: string[] = [];
  if (!params.operatorReference?.trim()) missing.push('an operator reference');
  if (!params.reasonId) missing.push('a reason code');
  if (!params.authorisedByUserId) missing.push('an authorising manager');
  if (missing.length > 0) throw new ManualSettlementIncompleteError(missing);

  if (params.amountMinor <= 0) {
    throw new Error('a manual settlement records money received; the amount must be positive');
  }

  const tenderId = randomUUID();
  await context.client.query(
    `INSERT INTO app.tender
       (id, tenant_id, bill_id, kind, method, amount_minor, rounding_minor, reference,
        reason_id, tendered_by_user_id, settled_offline_manually, operator_reference,
        authorised_by_user_id)
     VALUES ($1, $2, $3, 'capture', $4, $5, $6, $7, $8, $9, true, $7, $10)`,
    [tenderId, context.tenantId, params.billId, params.method, params.amountMinor,
     params.roundingMinor ?? 0, params.operatorReference.trim(), params.reasonId,
     params.tenderedByUserId, params.authorisedByUserId],
  );

  return { tenderId };
}

export interface ManualSettlementRow {
  readonly tenderId: string;
  readonly billId: string;
  readonly amountMinor: number;
  readonly method: string;
  readonly operatorReference: string;
  readonly authorisedByUserId: string;
  readonly tenderedAt: string;
}

/**
 * The exception report's TRANSACTION section reads this. It derives from
 * risk_subclass rather than an enumerated key list, so `payment.settle.manual`
 * lands there without anyone editing the report -- but the rows themselves are
 * worth a dedicated read, because "money we took outside the system last week" is
 * a question an owner asks directly.
 */
export async function manualSettlementsForPeriod(
  context: TenantContext,
  params: { branchId: string; fromDate: string; toDate: string },
): Promise<readonly ManualSettlementRow[]> {
  const result = await context.client.query<{
    id: string; bill_id: string; amount_minor: string; method: string;
    operator_reference: string; authorised_by_user_id: string; tendered_at: string;
  }>(
    `SELECT t.id, t.bill_id, t.amount_minor::text, t.method, t.operator_reference,
            t.authorised_by_user_id, t.tendered_at::text
       FROM app.tender t
       JOIN app.bill b ON b.tenant_id = t.tenant_id AND b.id = t.bill_id
      WHERE t.tenant_id = $1 AND b.branch_id = $2
        AND t.settled_offline_manually
        AND b.business_date BETWEEN $3::date AND $4::date
      ORDER BY t.tendered_at`,
    [context.tenantId, params.branchId, params.fromDate, params.toDate],
  );

  return result.rows.map((r) => ({
    tenderId: r.id,
    billId: r.bill_id,
    amountMinor: Number(r.amount_minor),
    method: r.method,
    operatorReference: r.operator_reference,
    authorisedByUserId: r.authorised_by_user_id,
    tenderedAt: r.tendered_at,
  }));
}
