import type { TenantContext } from '../../core/database/tenantContext.js';
import { chosenRange, periodRange } from '../reporting/tillSummary.js';
import {
  dayBranch, dayStatuses, openDay, rangeFigures, type DayFigures, type DayStatus, type EditAuthority,
} from './dayEnd.js';

/**
 * Bill history: every bill of a branch, grouped by business day, with each
 * day's figures and whether it has been submitted (0086).
 *
 * Read by the till (`bill.view`) and by the manager screens. Every figure is the
 * bill's own snapshot -- nothing is recomputed from the menu or the branch.
 * `canEdit` is advisory, for the buttons; the edit itself decides again on the
 * server under the day lock (`assertMayEditDay`).
 */

export type HistoryPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export const HISTORY_PERIODS: readonly HistoryPeriod[] = ['today', 'yesterday', 'week', 'month', 'custom'];

/**
 * Where a bill stands for editing: today's open day, a past day, a submitted
 * day, a reopened one, or today's submitted day with Allow POS Bill Editing on.
 */
export type EditState = 'editable' | 'locked' | 'submitted' | 'reopened' | 'granted';

export class HistoryPeriodUnknownError extends Error {
  readonly statusCode = 400;
  readonly code = 'history_period_unknown';
  constructor(readonly period: unknown) {
    super('choose a period: today, yesterday, week, month, or custom with from and to');
    this.name = 'HistoryPeriodUnknownError';
  }
}

export class HistoryBillUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'history_bill_unknown';
  constructor(readonly billId: string) {
    super(`no bill ${billId} at this branch`);
    this.name = 'HistoryBillUnknownError';
  }
}

export interface HistoryBill {
  readonly billId: string;
  readonly billNo: number;
  readonly businessDate: string;
  readonly generatedAt: string;
  readonly generatedBy: string | null;
  readonly status: 'open' | 'settled' | 'void';
  readonly version: number;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly seating: 'table' | 'counter';
  /** The D-/P- number read aloud at the counter; null for a table order. */
  readonly orderNo: number | null;
  readonly pickupName: string | null;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly roundOffMinor: number;
  readonly payableMinor: number;
  readonly paidMinor: number;
  readonly refundedMinor: number;
  readonly outstandingMinor: number;
  readonly methods: readonly string[];
  readonly editState: EditState;
  readonly canEdit: boolean;
  /** The latest edit touching this bill: as the bill edited, or as the bill an edit produced. */
  readonly lastEdit: { readonly by: string | null; readonly at: string; readonly authority: EditAuthority } | null;
  /** This bill was edited and reissued as bill N. */
  readonly replacedByBillNo: number | null;
  /** This bill reissues, or adds to, bill N. */
  readonly revisesBillNo: number | null;
  readonly supplementary: boolean;
}

export interface HistoryDay extends DayStatus {
  readonly figures: DayFigures;
  readonly bills: readonly HistoryBill[];
}

export interface BillHistory {
  readonly period: HistoryPeriod;
  readonly fromDate: string;
  readonly toDate: string;
  readonly today: string;
  readonly query: string | null;
  readonly days: readonly HistoryDay[];
}

/** The business dates a period covers, ending today (or yesterday), counted in business dates. */
export function historyRange(
  params: { period: unknown; from?: unknown; to?: unknown; today: string },
): { period: HistoryPeriod; fromDate: string; toDate: string } {
  const period = (params.period ?? (params.from !== undefined || params.to !== undefined ? 'custom' : 'today')) as HistoryPeriod;
  switch (period) {
    case 'today': return { period, fromDate: params.today, toDate: params.today };
    case 'yesterday': {
      const day = new Date(`${params.today}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - 1);
      const iso = day.toISOString().slice(0, 10);
      return { period, fromDate: iso, toDate: iso };
    }
    case 'week': case 'month': return { period, ...periodRange(period, params.today) };
    case 'custom': return { period, ...chosenRange(params.from, params.to, params.today) };
    default: throw new HistoryPeriodUnknownError(period);
  }
}

/**
 * Search: digits find a bill number or a D-/P- number; `D-7` / `P-7` find that
 * counter order; anything else is the parcel's pickup name. There is no order
 * number apart from the D-/P- number, and no customer name apart from pickup.
 */
function searchTerms(q: unknown): { text: string | null; number: number | null; service: 'dine_in' | 'parcel' | null } {
  const text = typeof q === 'string' ? q.trim().slice(0, 60) : '';
  if (text === '') return { text: null, number: null, service: null };
  const counter = /^([dp])\s*-?\s*(\d{1,6})$/i.exec(text);
  if (counter) {
    return { text: null, number: Number(counter[2]), service: counter[1]!.toLowerCase() === 'd' ? 'dine_in' : 'parcel' };
  }
  if (/^#?\d{1,9}$/.test(text)) return { text: null, number: Number(text.replace('#', '')), service: null };
  return { text, number: null, service: null };
}

export function editStateOf(day: DayStatus, businessDate: string, today: string): EditState {
  if (day.state !== 'open' && day.posEditing?.on === true && businessDate === today) return 'granted';
  if (day.state === 'submitted') return 'submitted';
  if (day.state === 'reopened') return 'reopened';
  return businessDate === today ? 'editable' : 'locked';
}

/**
 * What the buttons offer; the edit decides again on the server. A grant opens
 * the day to the till, not to a manager: a manager still reopens a submitted day.
 */
export function mayEdit(viewer: EditAuthority, billStatus: string, day: DayStatus, state: EditState): boolean {
  if (billStatus === 'void') return false;
  if (viewer === 'pos') return state === 'editable' || state === 'granted';
  return day.state !== 'submitted';
}

interface BillRow {
  id: string; bill_no: number; business_date: string; generated_at: string; generated_by: string | null;
  status: 'open' | 'settled' | 'void'; version: number;
  service_type: 'dine_in' | 'parcel'; seating: 'table' | 'counter'; parcel_no: number | null; pickup_name: string | null;
  subtotal_minor: string; tax_minor: string; total_minor: string; round_off_minor: string; payable_minor: string;
  paid_minor: string; refunded_minor: string; methods: string[] | null;
  edited_by: string | null; edited_at: string | null; edit_authority: EditAuthority | null;
  replaced_by_no: number | null; revises_no: number | null; supplementary: boolean;
}

const BILL_SELECT = `
  SELECT b.id, b.bill_no, b.business_date::text AS business_date, b.generated_at::text AS generated_at,
         gu.full_name AS generated_by, b.status, b.version,
         s.service_type, s.seating, s.parcel_no, s.pickup_name,
         b.subtotal_minor::text, b.tax_minor::text, b.total_minor::text, b.round_off_minor::text,
         b.payable_minor::text,
         COALESCE((SELECT sum(t.amount_minor - t.rounding_minor) FROM app.tender t
                    WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id), 0)::text AS paid_minor,
         COALESCE((SELECT sum(r.amount_minor) FROM app.refund r
                    WHERE r.tenant_id = b.tenant_id AND r.bill_id = b.id), 0)::text AS refunded_minor,
         (SELECT array_agg(DISTINCT t.method ORDER BY t.method) FROM app.tender t
           WHERE t.tenant_id = b.tenant_id AND t.bill_id = b.id AND t.kind = 'capture') AS methods,
         last_edit.edited_by, last_edit.edited_at, last_edit.authority AS edit_authority,
         (SELECT nb.bill_no FROM app.bill_revision rv
            JOIN app.bill nb ON nb.tenant_id = rv.tenant_id AND nb.id = rv.replacement_bill_id
           WHERE rv.tenant_id = b.tenant_id AND rv.bill_id = b.id
           ORDER BY rv.edited_at DESC LIMIT 1) AS replaced_by_no,
         (SELECT ob.bill_no FROM app.bill_revision rv
            JOIN app.bill ob ON ob.tenant_id = rv.tenant_id AND ob.id = rv.bill_id
           WHERE rv.tenant_id = b.tenant_id
             AND (rv.replacement_bill_id = b.id OR rv.supplementary_bill_id = b.id)
           LIMIT 1) AS revises_no,
         EXISTS (SELECT 1 FROM app.bill_revision rv
                  WHERE rv.tenant_id = b.tenant_id AND rv.supplementary_bill_id = b.id) AS supplementary
    FROM app.bill b
    JOIN app.table_session s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    LEFT JOIN app.app_user gu ON gu.tenant_id = b.tenant_id AND gu.id = b.generated_by_user_id
    LEFT JOIN LATERAL (
      SELECT eu.full_name AS edited_by, rv.edited_at::text AS edited_at, rv.authority
        FROM app.bill_revision rv
        LEFT JOIN app.app_user eu ON eu.tenant_id = rv.tenant_id AND eu.id = rv.edited_by_user_id
       WHERE rv.tenant_id = b.tenant_id
         AND (rv.bill_id = b.id OR rv.replacement_bill_id = b.id OR rv.supplementary_bill_id = b.id)
       ORDER BY rv.edited_at DESC LIMIT 1
    ) last_edit ON true`;

function historyBill(row: BillRow, found: DayStatus | undefined, today: string, viewer: EditAuthority): HistoryBill {
  const day = found ?? openDay(row.business_date);
  const state = editStateOf(day, row.business_date, today);
  const payable = Number(row.payable_minor);
  const paid = Number(row.paid_minor);
  return {
    billId: row.id, billNo: row.bill_no, businessDate: row.business_date, generatedAt: row.generated_at,
    generatedBy: row.generated_by, status: row.status, version: row.version,
    serviceType: row.service_type, seating: row.seating,
    orderNo: row.seating === 'counter' ? row.parcel_no : null, pickupName: row.pickup_name,
    subtotalMinor: Number(row.subtotal_minor), taxMinor: Number(row.tax_minor), totalMinor: Number(row.total_minor),
    roundOffMinor: Number(row.round_off_minor), payableMinor: payable, paidMinor: paid,
    refundedMinor: Number(row.refunded_minor),
    outstandingMinor: row.status === 'void' ? 0 : Math.max(payable - paid, 0),
    methods: row.methods ?? [],
    editState: state,
    canEdit: mayEdit(viewer, row.status, day, state),
    lastEdit: row.edited_at === null ? null
      : { by: row.edited_by, at: row.edited_at, authority: row.edit_authority! },
    replacedByBillNo: row.replaced_by_no, revisesBillNo: row.revises_no, supplementary: row.supplementary,
  };
}

const HISTORY_LIMIT = 2000;

export async function billHistory(
  context: TenantContext,
  params: {
    branchId: string | null; viewer: EditAuthority; today: string;
    period: unknown; from?: unknown; to?: unknown; q?: unknown;
  },
): Promise<BillHistory> {
  const branchId = await dayBranch(context, params.branchId);
  const range = historyRange(params);
  const terms = searchTerms(params.q);
  const found = await context.client.query<BillRow>(
    `${BILL_SELECT}
      WHERE b.tenant_id = $1 AND b.branch_id = $2 AND b.business_date BETWEEN $3::date AND $4::date
        AND ($5::int IS NULL OR (CASE WHEN $6::text IS NULL THEN b.bill_no = $5 OR s.parcel_no = $5
                                       ELSE s.parcel_no = $5 AND s.service_type = $6 END))
        AND ($7::text IS NULL OR s.pickup_name ILIKE '%' || replace(replace($7, '%', '\\%'), '_', '\\_') || '%')
      ORDER BY b.business_date DESC, b.bill_no DESC
      LIMIT ${HISTORY_LIMIT}`,
    [context.tenantId, branchId, range.fromDate, range.toDate, terms.number, terms.service, terms.text],
  );
  const statuses = await dayStatuses(context, branchId, range.fromDate, range.toDate);
  const figures = await rangeFigures(context, branchId, range.fromDate, range.toDate);

  const byDay = new Map<string, HistoryBill[]>();
  for (const row of found.rows) {
    const list = byDay.get(row.business_date) ?? [];
    list.push(historyBill(row, statuses.get(row.business_date), params.today, params.viewer));
    byDay.set(row.business_date, list);
  }
  // A searched range lists only the days a bill matched; an unsearched one lists every day with bills.
  const dates = [...new Set([...byDay.keys(), ...(terms.text === null && terms.number === null ? figures.keys() : [])])]
    .sort().reverse();
  return {
    period: range.period, fromDate: range.fromDate, toDate: range.toDate, today: params.today,
    query: typeof params.q === 'string' && params.q.trim() !== '' ? params.q.trim() : null,
    days: dates.map((date) => ({
      ...(statuses.get(date) ?? openDay(date)),
      figures: figures.get(date)!,
      bills: byDay.get(date) ?? [],
    })),
  };
}

export interface BillDetailLine {
  /** The order line an edit names: the item line, or a combo's parent. */
  readonly lineId: string;
  readonly kind: 'item' | 'combo' | 'charge';
  readonly name: string;
  readonly addOns: readonly string[];
  readonly menuItemId: string | null;
  readonly modifierOptionIds: readonly string[];
  /** As billed. */
  readonly quantity: number;
  /** Still on the order now, after any later removal. */
  readonly remainingQuantity: number;
  readonly amountMinor: number;
  readonly taxMinor: number;
  readonly taxRateBps: number | null;
}

export interface BillDetail {
  readonly bill: HistoryBill;
  readonly lines: readonly BillDetailLine[];
  readonly tenders: readonly {
    readonly method: string; readonly kind: string; readonly amountMinor: number;
    readonly cashReceivedMinor: number | null; readonly at: string; readonly by: string | null;
  }[];
  readonly refunds: readonly {
    readonly amountMinor: number; readonly method: string; readonly at: string; readonly by: string | null;
    readonly note: string | null;
  }[];
  readonly revisions: readonly {
    readonly id: string; readonly authority: EditAuthority; readonly reason: string;
    readonly by: string | null; readonly at: string;
    readonly beforePayableMinor: number; readonly afterPayableMinor: number;
    readonly editedBillNo: number; readonly replacementBillNo: number | null;
    readonly supplementaryBillNo: number | null; readonly refundMinor: number | null;
    /** The reopening a manager's edit of a submitted day ran under. */
    readonly reopened: { readonly by: string | null; readonly at: string; readonly reason: string } | null;
    /** The manager's Allow POS Bill Editing a till edit of a submitted day ran under. */
    readonly allowedBy: { readonly by: string | null; readonly at: string; readonly reason: string } | null;
    readonly before: unknown; readonly after: unknown;
  }[];
  readonly day: DayStatus;
}

export async function billDetail(
  context: TenantContext,
  params: { billId: string; branchId: string | null; viewer: EditAuthority; today: string },
): Promise<BillDetail> {
  const found = await context.client.query<BillRow & { branch_id: string }>(
    `${BILL_SELECT.replace('SELECT b.id,', 'SELECT b.branch_id, b.id,')}
      WHERE b.tenant_id = $1 AND b.id = $2 AND ($3::uuid IS NULL OR b.branch_id = $3)`,
    [context.tenantId, params.billId, params.branchId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new HistoryBillUnknownError(params.billId);
  const day = (await dayStatuses(context, row.branch_id, row.business_date, row.business_date)).get(row.business_date)
    ?? openDay(row.business_date);

  const lines = await context.client.query<{
    line_id: string; kind: 'item' | 'combo' | 'charge'; name: string; modifiers: unknown; menu_item_id: string | null;
    quantity: number; remaining: number; amount_minor: string; tax_minor: string; tax_rate_bps: number | null;
  }>(
    // One printed line per item, combo (its components summed) or charge. The
    // billed quantity counts removals made BEFORE the bill; the remaining one
    // every removal since, so an edit knows what is still there to take off.
    `WITH printed AS (
       SELECT COALESCE(p.id, ol.id) AS line_id,
              CASE WHEN p.id IS NOT NULL THEN 'combo' WHEN ol.kind = 'charge' THEN 'charge' ELSE 'item' END AS kind,
              COALESCE(p.display_name, ol.display_name) AS name,
              COALESCE(p.modifiers, ol.modifiers) AS modifiers,
              COALESCE(p.menu_item_id, ol.menu_item_id) AS menu_item_id,
              CASE WHEN p.id IS NULL
                   THEN ol.quantity + COALESCE((SELECT sum(v.quantity) FROM app.order_line v
                                                 WHERE v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id
                                                   AND v.kind = 'void' AND v.created_at <= b.generated_at), 0)
                   ELSE p.quantity END AS quantity,
              CASE WHEN p.id IS NULL
                   THEN ol.quantity + COALESCE((SELECT sum(v.quantity) FROM app.order_line v
                                                 WHERE v.tenant_id = ol.tenant_id AND v.adjusts_line_id = ol.id
                                                   AND v.kind = 'void'), 0)
                   ELSE p.quantity END AS remaining,
              bl.amount_minor, bl.tax_minor, bl.tax_rate_bps, ol.created_at
         FROM app.bill_line bl
         JOIN app.bill b ON b.tenant_id = bl.tenant_id AND b.id = bl.bill_id
         JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
         LEFT JOIN app.order_line p ON p.tenant_id = ol.tenant_id AND p.id = ol.parent_line_id
        WHERE bl.tenant_id = $1 AND bl.bill_id = $2
     )
     SELECT line_id, kind, name, modifiers, menu_item_id, quantity::int, remaining::int,
            sum(amount_minor)::text AS amount_minor, sum(tax_minor)::text AS tax_minor,
            max(tax_rate_bps) AS tax_rate_bps
       FROM printed
      GROUP BY line_id, kind, name, modifiers, menu_item_id, quantity, remaining
      ORDER BY min(created_at)`,
    [context.tenantId, params.billId],
  );

  const tenders = await context.client.query<{
    method: string; kind: string; amount_minor: string; cash_received_minor: string | null; at: string; by: string | null;
  }>(
    `SELECT t.method, t.kind, (t.amount_minor - t.rounding_minor)::text AS amount_minor,
            t.cash_received_minor::text, t.tendered_at::text AS at, u.full_name AS by
       FROM app.tender t
       LEFT JOIN app.app_user u ON u.tenant_id = t.tenant_id AND u.id = t.tendered_by_user_id
      WHERE t.tenant_id = $1 AND t.bill_id = $2
      ORDER BY t.tendered_at, t.voids_tender_id IS NOT NULL`,
    [context.tenantId, params.billId],
  );
  const refunds = await context.client.query<{
    amount_minor: string; method: string; at: string; by: string | null; note: string | null;
  }>(
    `SELECT r.amount_minor::text, r.method, r.refunded_at::text AS at, u.full_name AS by, r.note
       FROM app.refund r
       LEFT JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.refunded_by_user_id
      WHERE r.tenant_id = $1 AND r.bill_id = $2
      ORDER BY r.refunded_at`,
    [context.tenantId, params.billId],
  );
  const revisions = await context.client.query<{
    id: string; authority: EditAuthority; reason: string; by: string | null; at: string;
    before_payable_minor: string; after_payable_minor: string; edited_no: number;
    replacement_no: number | null; supplementary_no: number | null; refund_minor: string | null;
    reopened_by: string | null; reopened_at: string | null; reopen_reason: string | null;
    granted_by: string | null; granted_at: string | null; grant_reason: string | null;
    before: unknown; after: unknown;
  }>(
    `SELECT rv.id, rv.authority, rv.reason, eu.full_name AS by, rv.edited_at::text AS at,
            rv.before_payable_minor::text, rv.after_payable_minor::text,
            eb.bill_no AS edited_no, rb.bill_no AS replacement_no, sb.bill_no AS supplementary_no,
            rf.amount_minor::text AS refund_minor,
            ru.full_name AS reopened_by, ds.reopened_at::text AS reopened_at, ds.reopen_reason,
            gu.full_name AS granted_by, pg.enabled_at::text AS granted_at, pg.reason AS grant_reason,
            rv.before, rv.after
       FROM app.bill_revision rv
       JOIN app.bill eb ON eb.tenant_id = rv.tenant_id AND eb.id = rv.bill_id
       LEFT JOIN app.bill rb ON rb.tenant_id = rv.tenant_id AND rb.id = rv.replacement_bill_id
       LEFT JOIN app.bill sb ON sb.tenant_id = rv.tenant_id AND sb.id = rv.supplementary_bill_id
       LEFT JOIN app.refund rf ON rf.tenant_id = rv.tenant_id AND rf.id = rv.refund_id
       LEFT JOIN app.day_submission ds ON ds.tenant_id = rv.tenant_id AND ds.id = rv.day_submission_id
       LEFT JOIN app.app_user eu ON eu.tenant_id = rv.tenant_id AND eu.id = rv.edited_by_user_id
       LEFT JOIN app.app_user ru ON ru.tenant_id = ds.tenant_id AND ru.id = ds.reopened_by_user_id
       LEFT JOIN app.pos_edit_grant pg ON pg.tenant_id = rv.tenant_id AND pg.id = rv.pos_edit_grant_id
       LEFT JOIN app.app_user gu ON gu.tenant_id = pg.tenant_id AND gu.id = pg.enabled_by_user_id
      WHERE rv.tenant_id = $1
        AND (rv.bill_id = $2 OR rv.replacement_bill_id = $2 OR rv.supplementary_bill_id = $2)
      ORDER BY rv.edited_at`,
    [context.tenantId, params.billId],
  );

  return {
    bill: historyBill(row, day, params.today, params.viewer),
    day,
    lines: lines.rows.map((l) => ({
      lineId: l.line_id, kind: l.kind, name: l.name,
      addOns: Array.isArray(l.modifiers)
        ? (l.modifiers as { name?: unknown }[]).flatMap((m) => (typeof m.name === 'string' ? [m.name] : [])) : [],
      menuItemId: l.menu_item_id,
      modifierOptionIds: Array.isArray(l.modifiers)
        ? (l.modifiers as { option_id?: unknown }[]).flatMap((m) => (typeof m.option_id === 'string' ? [m.option_id] : [])) : [],
      quantity: l.quantity, remainingQuantity: l.remaining,
      amountMinor: Number(l.amount_minor), taxMinor: Number(l.tax_minor), taxRateBps: l.tax_rate_bps,
    })),
    tenders: tenders.rows.map((t) => ({
      method: t.method, kind: t.kind, amountMinor: Number(t.amount_minor),
      cashReceivedMinor: t.cash_received_minor === null ? null : Number(t.cash_received_minor), at: t.at, by: t.by,
    })),
    refunds: refunds.rows.map((r) => ({
      amountMinor: Number(r.amount_minor), method: r.method, at: r.at, by: r.by, note: r.note,
    })),
    revisions: revisions.rows.map((r) => ({
      id: r.id, authority: r.authority, reason: r.reason, by: r.by, at: r.at,
      beforePayableMinor: Number(r.before_payable_minor), afterPayableMinor: Number(r.after_payable_minor),
      editedBillNo: r.edited_no, replacementBillNo: r.replacement_no, supplementaryBillNo: r.supplementary_no,
      refundMinor: r.refund_minor === null ? null : Number(r.refund_minor),
      reopened: r.authority !== 'manager' || r.reopened_at === null ? null
        : { by: r.reopened_by, at: r.reopened_at, reason: r.reopen_reason! },
      allowedBy: r.granted_at === null ? null : { by: r.granted_by, at: r.granted_at, reason: r.grant_reason! },
      before: r.before, after: r.after,
    })),
  };
}
