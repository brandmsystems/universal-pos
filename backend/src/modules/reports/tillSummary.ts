import type { TenantContext } from '../../database/tenantContext.js';

/**
 * The till's own X-read: what ONE person took at ONE branch, by day, week or
 * month.
 *
 * ###########################################################################
 * NOT A REPORT, AND THAT IS WHY A CASHIER MAY SEE IT.
 *
 * Separation of duties denies whoever takes the money every `report.*` key:
 * the person at the till must not be the one who reconciles the record of it.
 * This reads nothing anyone ELSE did -- every row is scoped to tenders the
 * signed-in person recorded (`tender.tendered_by_user_id`), so it is the
 * cashier's own drawer, not the restaurant's books. Its key,
 * `till.summary.view`, is a TILL key (capabilities.ts), held and withheld
 * with the till.
 *
 * Scope: the bills this person took a payment on, at this branch, whose
 * business date is in the period -- day, week, month, or a range of business
 * dates the person chose (`from`/`to`). A chosen range widens WHEN, never WHO
 * or WHERE: the person and the branch stay the token's. A bill's own figures (total, tax, items)
 * are the bill's; `collectedMinor` and the method totals are only this
 * person's tenders, net of the voids they recorded.
 * ###########################################################################
 */

export type TillPeriod = 'day' | 'week' | 'month';

export const TILL_PERIODS: readonly TillPeriod[] = ['day', 'week', 'month'];

/** What a summary covers: a named period, or a chosen range of business dates. */
export type TillRange = TillPeriod | 'custom';

/** The longest chosen range, in business dates, both ends counted: a bounded read on the till. */
export const TILL_RANGE_MAX_DAYS = 366;

export class TillPeriodUnknownError extends Error {
  readonly statusCode = 400;
  readonly code = 'till_period_unknown';
  constructor(readonly period: unknown) {
    super('choose a period: day, week or month');
    this.name = 'TillPeriodUnknownError';
  }
}

export type TillRangeProblem = 'incomplete' | 'malformed' | 'reversed' | 'future' | 'too_long';

export class TillRangeInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'till_range_invalid';
  constructor(readonly problem: TillRangeProblem) {
    super(`the date range is not usable: ${problem}`);
    this.name = 'TillRangeInvalidError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD, or null: 2026-02-30 is malformed, not 2 March. */
function isoDay(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value ? null : at;
}

/**
 * A chosen range of business dates, checked against today's business date. The
 * future holds no bills, so a range reaching past today is refused rather than
 * quietly cut short: the screen would otherwise label a range it did not read.
 */
export function chosenRange(from: unknown, to: unknown, today: string): { fromDate: string; toDate: string } {
  if (from === undefined || to === undefined || from === '' || to === '') throw new TillRangeInvalidError('incomplete');
  const start = isoDay(from);
  const end = isoDay(to);
  const now = isoDay(today);
  if (start === null || end === null || now === null) throw new TillRangeInvalidError('malformed');
  if (start > end) throw new TillRangeInvalidError('reversed');
  if (end > now) throw new TillRangeInvalidError('future');
  if ((end - start) / 86_400_000 + 1 > TILL_RANGE_MAX_DAYS) throw new TillRangeInvalidError('too_long');
  return { fromDate: from as string, toDate: to as string };
}

/**
 * The business dates a period covers, ending today. Weeks start on Monday and
 * months on the 1st, both counted in business dates (a 3am day end stays on
 * the right side), never calendar ones.
 */
export function periodRange(period: TillPeriod, today: string): { fromDate: string; toDate: string } {
  const date = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`not a business date: ${today}`);
  if (period === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (period === 'month') date.setUTCDate(1);
  return { fromDate: date.toISOString().slice(0, 10), toDate: today };
}

export interface TillBill {
  readonly billId: string;
  readonly billNo: number;
  readonly businessDate: string;
  readonly billedAt: string;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly seating: 'table' | 'counter';
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  /** To the nearest rupee (0082); 0 on a bill made before the rule. */
  readonly roundOffMinor: number;
  /** What the customer pays: total + round off. */
  readonly payableMinor: number;
  /** What THIS person took against it, net of their voids. */
  readonly collectedMinor: number;
}

export interface TillItem {
  readonly name: string;
  readonly quantity: number;
  readonly amountMinor: number;
}

export interface TillMethod {
  readonly method: string;
  readonly payments: number;
  readonly amountMinor: number;
}

export interface TillSummary {
  readonly period: TillRange;
  readonly fromDate: string;
  readonly toDate: string;
  readonly bills: readonly TillBill[];
  readonly items: readonly TillItem[];
  readonly methods: readonly TillMethod[];
  readonly totals: {
    readonly bills: number;
    readonly payments: number;
    readonly salesMinor: number;
    readonly taxMinor: number;
    readonly roundOffMinor: number;
    readonly payableMinor: number;
    readonly collectedMinor: number;
  };
}

/**
 * A chosen range when either end is given (and then `period` may only be
 * absent or 'custom'), otherwise the named period.
 */
export function resolveTillRange(
  params: { period: unknown; from?: unknown; to?: unknown; today: string },
): { period: TillRange; fromDate: string; toDate: string } {
  if (params.from !== undefined || params.to !== undefined || params.period === 'custom') {
    if (params.period !== undefined && params.period !== 'custom') throw new TillPeriodUnknownError(params.period);
    return { period: 'custom', ...chosenRange(params.from, params.to, params.today) };
  }
  const period = params.period ?? 'day';
  if (!TILL_PERIODS.includes(period as TillPeriod)) throw new TillPeriodUnknownError(period);
  return { period: period as TillPeriod, ...periodRange(period as TillPeriod, params.today) };
}

/** Bills at this branch in the period on which this person recorded a tender. */
const MINE = `
  SELECT DISTINCT b.id
    FROM app.tender t
    JOIN app.bill b ON b.tenant_id = t.tenant_id AND b.id = t.bill_id
   WHERE t.tenant_id = $1 AND t.tendered_by_user_id = $2 AND b.branch_id = $3
     AND b.status <> 'void'
     AND b.business_date BETWEEN $4::date AND $5::date`;

export async function tillSummary(
  context: TenantContext,
  params: { userId: string; branchId: string; period: unknown; from?: unknown; to?: unknown; today: string },
): Promise<TillSummary> {
  const { period, fromDate, toDate } = resolveTillRange(params);
  const args = [context.tenantId, params.userId, params.branchId, fromDate, toDate];

  const bills = await context.client.query<{
    bill_id: string; bill_no: number; business_date: string; billed_at: string;
    service_type: 'dine_in' | 'parcel'; seating: 'table' | 'counter'; parcel_no: number | null;
    pickup_name: string | null; subtotal_minor: string; tax_minor: string; total_minor: string;
    round_off_minor: string; payable_minor: string; collected_minor: string;
  }>(
    `SELECT b.id AS bill_id, b.bill_no, b.business_date::text AS business_date, b.generated_at::text AS billed_at,
            s.service_type, s.seating, s.parcel_no, s.pickup_name,
            b.subtotal_minor::text, b.tax_minor::text, b.total_minor::text,
            b.round_off_minor::text, b.payable_minor::text,
            COALESCE((SELECT sum(t.amount_minor - t.rounding_minor) FROM app.tender t
                       WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id
                         AND t.tendered_by_user_id = $2), 0)::text AS collected_minor
       FROM app.bill b
       JOIN app.table_session s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = $1 AND b.id IN (${MINE})
      ORDER BY b.business_date, b.bill_no`,
    args,
  );

  // Each printed line once: a combo is its parent (its components share the
  // parent's quantity), anything else is the line net of its voids. The amount
  // is the bill line's -- what was charged, after comps and discounts.
  const items = await context.client.query<{ name: string; quantity: string; amount_minor: string }>(
    `WITH printed AS (
       SELECT bl.bill_id,
              COALESCE(p.id, ol.id) AS line_id,
              COALESCE(p.display_name, bl.display_name) AS name,
              CASE WHEN p.id IS NULL
                   THEN ol.quantity + COALESCE((SELECT sum(v.quantity) FROM app.order_line v
                                                 WHERE v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id
                                                   AND v.kind = 'void'), 0)
                   ELSE p.quantity END AS quantity,
              bl.amount_minor
         FROM app.bill_line bl
         JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
         LEFT JOIN app.order_line p ON p.tenant_id = ol.tenant_id AND p.id = ol.parent_line_id
        WHERE bl.tenant_id = $1 AND bl.bill_id IN (${MINE})
     ), per_line AS (
       SELECT name, quantity, sum(amount_minor) AS amount_minor
         FROM printed GROUP BY bill_id, line_id, name, quantity
     )
     SELECT name, sum(quantity)::text AS quantity, sum(amount_minor)::text AS amount_minor
       FROM per_line GROUP BY name ORDER BY sum(amount_minor) DESC, name`,
    args,
  );

  const methods = await context.client.query<{ method: string; payments: string; amount_minor: string }>(
    `SELECT t.method,
            count(*) FILTER (WHERE t.kind = 'capture')::text AS payments,
            sum(t.amount_minor - t.rounding_minor)::text AS amount_minor
       FROM app.tender t
      WHERE t.tenant_id = $1 AND t.tendered_by_user_id = $2 AND t.bill_id IN (${MINE})
      GROUP BY t.method ORDER BY t.method`,
    args,
  );

  const billRows: TillBill[] = bills.rows.map((r) => ({
    billId: r.bill_id, billNo: r.bill_no, businessDate: r.business_date, billedAt: r.billed_at,
    serviceType: r.service_type, seating: r.seating, parcelNo: r.parcel_no, pickupName: r.pickup_name,
    subtotalMinor: Number(r.subtotal_minor), taxMinor: Number(r.tax_minor), totalMinor: Number(r.total_minor),
    roundOffMinor: Number(r.round_off_minor), payableMinor: Number(r.payable_minor),
    collectedMinor: Number(r.collected_minor),
  }));
  const methodRows: TillMethod[] = methods.rows.map((r) => ({
    method: r.method, payments: Number(r.payments), amountMinor: Number(r.amount_minor),
  }));

  return {
    period, fromDate, toDate,
    bills: billRows,
    items: items.rows.map((r) => ({ name: r.name, quantity: Number(r.quantity), amountMinor: Number(r.amount_minor) })),
    methods: methodRows,
    totals: {
      bills: billRows.length,
      payments: methodRows.reduce((n, m) => n + m.payments, 0),
      salesMinor: billRows.reduce((n, b) => n + b.totalMinor, 0),
      roundOffMinor: billRows.reduce((n, b) => n + b.roundOffMinor, 0),
      payableMinor: billRows.reduce((n, b) => n + b.payableMinor, 0),
      taxMinor: billRows.reduce((n, b) => n + b.taxMinor, 0),
      collectedMinor: methodRows.reduce((n, m) => n + m.amountMinor, 0),
    },
  };
}
