import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Day end: the till submits a business day's bills, after which no till may
 * change them; only a manager reopens a submitted day, with a reason (0086).
 * A manager may instead let the till edit TODAY's submitted bills again, Allow
 * POS Bill Editing, and switch that off again (0087).
 *
 * ###########################################################################
 * ONE LOCK PER BRANCH PER BUSINESS DAY, TAKEN BY EVERYTHING THAT READS THE STATE
 * TO DECIDE A WRITE.
 *
 * Submitting, reopening, switching POS editing, editing a bill and voiding a
 * tender each take the same transaction-scoped advisory lock before reading
 * whether the day is submitted, so an edit cannot read "open" while a
 * submission (or a grant switched off) commits beside it. The
 * partial unique index `day_submission_one_live` is the backstop for the
 * submission itself; this lock is what keeps the CHECK and the WRITE together.
 * ###########################################################################
 */

export type DayState = 'open' | 'submitted' | 'reopened';

export interface DayMethod {
  readonly method: string;
  readonly payments: number;
  readonly amountMinor: number;
}

/** A business day's bills as they stand: non-void bills, voided ones counted apart. */
export interface DayFigures {
  readonly billCount: number;
  readonly voidBillCount: number;
  readonly salesMinor: number;
  readonly taxMinor: number;
  readonly payableMinor: number;
  readonly collectedMinor: number;
  readonly refundedMinor: number;
  readonly outstandingMinor: number;
  readonly methods: readonly DayMethod[];
}

export interface DaySubmissionView {
  readonly id: string;
  readonly status: 'submitted' | 'reopened';
  readonly submittedAt: string;
  readonly submittedBy: string | null;
  readonly billCount: number;
  readonly payableMinor: number;
  readonly collectedMinor: number;
  readonly reopenedAt: string | null;
  readonly reopenedBy: string | null;
  readonly reopenReason: string | null;
}

/** A manager's Allow POS Bill Editing on the day's current submission (0087). */
export interface PosEditingView {
  readonly on: boolean;
  readonly grantId: string;
  readonly enabledBy: string | null;
  readonly enabledAt: string;
  readonly reason: string;
  readonly disabledBy: string | null;
  readonly disabledAt: string | null;
}

export interface DayStatus {
  readonly businessDate: string;
  readonly state: DayState;
  /** The latest submission that is not superseded; null when the day was never submitted. */
  readonly submission: DaySubmissionView | null;
  /** Bills made on this business day after it was submitted (orders taken before the day ended). */
  readonly billsSinceSubmission: number;
  /**
   * The latest Allow POS Bill Editing decision on the CURRENT submission; null
   * when none was made since it (a new submission starts with it off).
   */
  readonly posEditing: PosEditingView | null;
}

/** A day nobody has submitted. */
export function openDay(businessDate: string): DayStatus {
  return { businessDate, state: 'open', submission: null, billsSinceSubmission: 0, posEditing: null };
}

export class DayHasOpenOrdersError extends Error {
  readonly statusCode = 409;
  readonly code = 'day_has_open_orders';
  constructor(readonly openOrders: number) {
    super(`${openOrders} order(s) of this day are still open: take their payment or cancel them, then submit the day`);
    this.name = 'DayHasOpenOrdersError';
  }
}

export class DayHasNoBillsError extends Error {
  readonly statusCode = 409;
  readonly code = 'day_has_no_bills';
  constructor(readonly businessDate: string) {
    super(`there are no bills on ${businessDate}, so there is nothing to submit`);
    this.name = 'DayHasNoBillsError';
  }
}

/**
 * The figures the person confirmed are not the figures now: a bill was made,
 * paid or edited between the confirmation opening and the tap. The day is not
 * submitted on figures nobody looked at.
 */
export class DayChangedError extends Error {
  readonly statusCode = 409;
  readonly code = 'day_changed';
  constructor(readonly figures: DayFigures) {
    super('the day\'s bills changed after the confirmation was shown; review the new count and totals and submit again');
    this.name = 'DayChangedError';
  }
}

export class DayNotSubmittedError extends Error {
  readonly statusCode = 409;
  readonly code = 'day_not_submitted';
  constructor(readonly businessDate: string) {
    super(`${businessDate} is not submitted, so there is nothing to reopen`);
    this.name = 'DayNotSubmittedError';
  }
}

export class DayReopenReasonRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'day_reopen_reason_required';
  constructor() {
    super('say why the day is being reopened (5 to 500 characters); it is kept with the submission');
    this.name = 'DayReopenReasonRequiredError';
  }
}

export class BusinessDateInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'business_date_invalid';
  constructor(readonly value: unknown) {
    super('a business date is YYYY-MM-DD and not after today');
    this.name = 'BusinessDateInvalidError';
  }
}

export class DayBranchRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'day_branch_required';
  constructor() {
    super('this restaurant has more than one branch: name the branch (branchId) whose day this is');
    this.name = 'DayBranchRequiredError';
  }
}

export class BillEditPreviousDayError extends Error {
  readonly statusCode = 403;
  readonly code = 'bill_edit_previous_day';
  constructor(readonly businessDate: string) {
    super(`this bill is from ${businessDate}; the till edits only today's bills, so ask a manager`);
    this.name = 'BillEditPreviousDayError';
  }
}

export class BillEditDaySubmittedError extends Error {
  readonly statusCode = 403;
  readonly code = 'bill_edit_day_submitted';
  constructor(readonly businessDate: string) {
    super(`the bills of ${businessDate} have been submitted, so the till can no longer change them; `
      + 'a manager can, or can allow POS bill editing for today');
    this.name = 'BillEditDaySubmittedError';
  }
}

/** Allow POS Bill Editing is for the branch's business day today, never another. */
export class PosEditingTodayOnlyError extends Error {
  readonly statusCode = 409;
  readonly code = 'pos_editing_today_only';
  constructor(readonly businessDate: string) {
    super(`POS bill editing can be allowed only for today; the till never edits the bills of ${businessDate}`);
    this.name = 'PosEditingTodayOnlyError';
  }
}

export class PosEditingDayOpenError extends Error {
  readonly statusCode = 409;
  readonly code = 'pos_editing_day_open';
  constructor(readonly businessDate: string) {
    super(`${businessDate} is not submitted yet, so the till can already edit its bills`);
    this.name = 'PosEditingDayOpenError';
  }
}

export class PosEditingReasonRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'pos_editing_reason_required';
  constructor() {
    super('say why the till may edit the submitted bills again (5 to 500 characters); it is kept with the permission');
    this.name = 'PosEditingReasonRequiredError';
  }
}

export class BillEditReopenFirstError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_edit_reopen_first';
  constructor(readonly businessDate: string) {
    super(`the bills of ${businessDate} have been submitted; reopen the day, with a reason, to edit them`);
    this.name = 'BillEditReopenFirstError';
  }
}

export type EditAuthority = 'pos' | 'manager';

/**
 * Whether a bill of `businessDate` may be edited in this capacity, decided under
 * the day lock (which this takes). Returns the submission the edit runs under,
 * if any, and for a till edit of a submitted day the grant that allowed it.
 *
 *   pos      today only. While the day is not submitted, always; once it is
 *            (or reopened -- reopening authorises a MANAGER), only while a
 *            manager's Allow POS Bill Editing is on for the CURRENT submission.
 *            Read here on every edit, never cached: switching it off refuses
 *            the next save, whatever the till's screen still shows.
 *   manager  any day; a submitted day only after it is reopened.
 */
export async function assertMayEditDay(
  context: TenantContext,
  params: { branchId: string; businessDate: string; today: string; authority: EditAuthority },
): Promise<{ submissionId: string | null; grantId: string | null }> {
  await lockDay(context, params.branchId, params.businessDate);
  const { state, submissionId } = await dayState(context, params.branchId, params.businessDate);
  if (params.authority === 'pos') {
    if (params.businessDate !== params.today) throw new BillEditPreviousDayError(params.businessDate);
    if (state === 'open') return { submissionId: null, grantId: null };
    const grantId = await liveGrant(context, submissionId!);
    if (grantId === null) throw new BillEditDaySubmittedError(params.businessDate);
    return { submissionId, grantId };
  }
  if (state === 'submitted') throw new BillEditReopenFirstError(params.businessDate);
  return { submissionId: state === 'reopened' ? submissionId : null, grantId: null };
}

async function liveGrant(context: TenantContext, submissionId: string): Promise<string | null> {
  const found = await context.client.query<{ id: string }>(
    `SELECT id FROM app.pos_edit_grant WHERE tenant_id = $1 AND day_submission_id = $2 AND status = 'on'`,
    [context.tenantId, submissionId],
  );
  return found.rows[0]?.id ?? null;
}

/**
 * Allow POS Bill Editing, switched on or off by a manager
 * (`payment.settlement.reopen`) for TODAY's submitted day. On needs a reason and
 * is one grant per submission (switching on twice returns it); off stamps it.
 * Either way the decision is a row: who, when and why stay.
 */
export async function setPosEditing(
  context: TenantContext,
  params: { branchId: string; businessDate: string; today: string; on: boolean; reason?: unknown; userId: string },
): Promise<DayStatus> {
  const { branchId, businessDate } = params;
  if (businessDate !== params.today) throw new PosEditingTodayOnlyError(businessDate);
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (params.on && (reason.length < 5 || reason.length > 500)) throw new PosEditingReasonRequiredError();
  await lockDay(context, branchId, businessDate);
  const { state, submissionId } = await dayState(context, branchId, businessDate);
  if (state === 'open') throw new PosEditingDayOpenError(businessDate);

  if (params.on) {
    if (await liveGrant(context, submissionId!) === null) {
      await context.client.query(
        `INSERT INTO app.pos_edit_grant
           (id, tenant_id, branch_id, business_date, day_submission_id, enabled_by_user_id, enabled_at, reason)
         VALUES ($1, $2, $3, $4::date, $5, $6, clock_timestamp(), $7)`,
        [randomUUID(), context.tenantId, branchId, businessDate, submissionId, params.userId, reason],
      );
    }
  } else {
    await context.client.query(
      `UPDATE app.pos_edit_grant SET status = 'off', disabled_at = clock_timestamp(), disabled_by_user_id = $3
        WHERE tenant_id = $1 AND day_submission_id = $2 AND status = 'on'`,
      [context.tenantId, submissionId, params.userId],
    );
  }
  return dayStatus(context, branchId, businessDate);
}

/** A real YYYY-MM-DD no later than `today`; 2026-02-30 is not a date. */
export function businessDateParam(value: unknown, today: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BusinessDateInvalidError(value);
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value || value > today) {
    throw new BusinessDateInvalidError(value);
  }
  return value;
}

/**
 * The branch a day belongs to: the session's own, or -- for a restaurant-wide
 * (owner) session that names none -- the restaurant's only active branch. Never
 * a guess between several.
 */
export async function dayBranch(context: TenantContext, branchId: string | null): Promise<string> {
  if (branchId !== null) return branchId;
  const found = await context.client.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at LIMIT 2`,
    [context.tenantId],
  );
  if (found.rows.length !== 1) throw new DayBranchRequiredError();
  return found.rows[0]!.id;
}

export async function lockDay(context: TenantContext, branchId: string, businessDate: string): Promise<void> {
  await context.client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`day-end:${context.tenantId}:${branchId}:${businessDate}`],
  );
}

/** Where the day stands: the latest submission that has not been superseded decides. */
export async function dayState(
  context: TenantContext,
  branchId: string,
  businessDate: string,
): Promise<{ state: DayState; submissionId: string | null }> {
  const found = await context.client.query<{ id: string; status: 'submitted' | 'reopened' }>(
    `SELECT id, status FROM app.day_submission
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date AND status <> 'superseded'
      ORDER BY submitted_at DESC LIMIT 1`,
    [context.tenantId, branchId, businessDate],
  );
  const row = found.rows[0];
  return row === undefined ? { state: 'open', submissionId: null } : { state: row.status, submissionId: row.id };
}

const NO_FIGURES: DayFigures = {
  billCount: 0, voidBillCount: 0, salesMinor: 0, taxMinor: 0, payableMinor: 0,
  collectedMinor: 0, refundedMinor: 0, outstandingMinor: 0, methods: [],
};

export async function dayFigures(
  context: TenantContext,
  branchId: string,
  businessDate: string,
): Promise<DayFigures> {
  return (await rangeFigures(context, branchId, businessDate, businessDate)).get(businessDate) ?? NO_FIGURES;
}

/** Each business day's figures in a range, three reads whatever its length. */
export async function rangeFigures(
  context: TenantContext,
  branchId: string,
  fromDate: string,
  toDate: string,
): Promise<ReadonlyMap<string, DayFigures>> {
  const args = [context.tenantId, branchId, fromDate, toDate];
  const bills = await context.client.query<{
    day: string; bills: string; void_bills: string; sales: string; tax: string; payable: string;
  }>(
    `SELECT business_date::text AS day,
            count(*) FILTER (WHERE status <> 'void')::text AS bills,
            count(*) FILTER (WHERE status = 'void')::text AS void_bills,
            COALESCE(sum(total_minor) FILTER (WHERE status <> 'void'), 0)::text AS sales,
            COALESCE(sum(tax_minor) FILTER (WHERE status <> 'void'), 0)::text AS tax,
            COALESCE(sum(payable_minor) FILTER (WHERE status <> 'void'), 0)::text AS payable
       FROM app.bill
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date BETWEEN $3::date AND $4::date
      GROUP BY business_date`,
    args,
  );
  // Net of voided tenders: a void is a negative row (rule 9), so the plain sum is the money in.
  const methods = await context.client.query<{ day: string; method: string; payments: string; amount: string }>(
    `SELECT b.business_date::text AS day, t.method,
            count(*) FILTER (WHERE t.kind = 'capture')::text AS payments,
            sum(t.amount_minor - t.rounding_minor)::text AS amount
       FROM app.tender t
       JOIN app.bill b ON b.tenant_id = t.tenant_id AND b.id = t.bill_id
      WHERE t.tenant_id = $1 AND b.branch_id = $2 AND b.business_date BETWEEN $3::date AND $4::date
        AND b.status <> 'void'
      GROUP BY b.business_date, t.method ORDER BY t.method`,
    args,
  );
  const refunds = await context.client.query<{ day: string; refunded: string }>(
    `SELECT b.business_date::text AS day, sum(r.amount_minor)::text AS refunded
       FROM app.refund r
       JOIN app.bill b ON b.tenant_id = r.tenant_id AND b.id = r.bill_id
      WHERE r.tenant_id = $1 AND b.branch_id = $2 AND b.business_date BETWEEN $3::date AND $4::date
        AND b.status <> 'void'
      GROUP BY b.business_date`,
    args,
  );
  const refundedOn = new Map(refunds.rows.map((r) => [r.day, Number(r.refunded)]));
  const out = new Map<string, DayFigures>();
  for (const row of bills.rows) {
    const methodRows = methods.rows.filter((m) => m.day === row.day).map((m) => ({
      method: m.method, payments: Number(m.payments), amountMinor: Number(m.amount),
    }));
    const collected = methodRows.reduce((n, m) => n + m.amountMinor, 0);
    out.set(row.day, {
      billCount: Number(row.bills),
      voidBillCount: Number(row.void_bills),
      salesMinor: Number(row.sales),
      taxMinor: Number(row.tax),
      payableMinor: Number(row.payable),
      collectedMinor: collected,
      refundedMinor: refundedOn.get(row.day) ?? 0,
      outstandingMinor: Number(row.payable) - collected,
      methods: methodRows,
    });
  }
  return out;
}

interface SubmissionRow {
  id: string; status: 'submitted' | 'reopened'; submitted_at: string; submitted_by: string | null;
  bill_count: number; payable_minor: string; collected_minor: string;
  reopened_at: string | null; reopened_by: string | null; reopen_reason: string | null; since: number;
  grant_id: string | null; grant_status: 'on' | 'off' | null; grant_enabled_by: string | null;
  grant_enabled_at: string | null; grant_reason: string | null;
  grant_disabled_by: string | null; grant_disabled_at: string | null;
}

function grantView(row: SubmissionRow): PosEditingView | null {
  if (row.grant_id === null) return null;
  return {
    on: row.grant_status === 'on', grantId: row.grant_id, enabledBy: row.grant_enabled_by,
    enabledAt: row.grant_enabled_at!, reason: row.grant_reason!,
    disabledBy: row.grant_disabled_by, disabledAt: row.grant_disabled_at,
  };
}

function view(row: SubmissionRow): DaySubmissionView {
  return {
    id: row.id, status: row.status, submittedAt: row.submitted_at, submittedBy: row.submitted_by,
    billCount: row.bill_count, payableMinor: Number(row.payable_minor), collectedMinor: Number(row.collected_minor),
    reopenedAt: row.reopened_at, reopenedBy: row.reopened_by, reopenReason: row.reopen_reason,
  };
}

/** Each listed day's standing, in one read: business date -> status. */
export async function dayStatuses(
  context: TenantContext,
  branchId: string,
  fromDate: string,
  toDate: string,
): Promise<ReadonlyMap<string, DayStatus>> {
  const rows = await context.client.query<SubmissionRow & { business_date: string }>(
    `SELECT DISTINCT ON (s.business_date) s.business_date::text AS business_date,
            s.id, s.status, s.submitted_at::text AS submitted_at, su.full_name AS submitted_by,
            s.bill_count, s.payable_minor::text AS payable_minor, s.collected_minor::text AS collected_minor,
            s.reopened_at::text AS reopened_at, ru.full_name AS reopened_by, s.reopen_reason,
            (SELECT count(*) FROM app.bill b
              WHERE b.tenant_id = s.tenant_id AND b.branch_id = s.branch_id
                AND b.business_date = s.business_date AND b.generated_at > s.submitted_at)::int AS since,
            g.id AS grant_id, g.status AS grant_status, g.enabled_by AS grant_enabled_by,
            g.enabled_at AS grant_enabled_at, g.reason AS grant_reason,
            g.disabled_by AS grant_disabled_by, g.disabled_at AS grant_disabled_at
       FROM app.day_submission s
       LEFT JOIN app.app_user su ON su.tenant_id = s.tenant_id AND su.id = s.submitted_by_user_id
       LEFT JOIN app.app_user ru ON ru.tenant_id = s.tenant_id AND ru.id = s.reopened_by_user_id
       LEFT JOIN LATERAL (
         SELECT pg.id, pg.status, eu.full_name AS enabled_by, pg.enabled_at::text AS enabled_at, pg.reason,
                du.full_name AS disabled_by, pg.disabled_at::text AS disabled_at
           FROM app.pos_edit_grant pg
           LEFT JOIN app.app_user eu ON eu.tenant_id = pg.tenant_id AND eu.id = pg.enabled_by_user_id
           LEFT JOIN app.app_user du ON du.tenant_id = pg.tenant_id AND du.id = pg.disabled_by_user_id
          WHERE pg.tenant_id = s.tenant_id AND pg.day_submission_id = s.id
          ORDER BY pg.enabled_at DESC LIMIT 1
       ) g ON true
      WHERE s.tenant_id = $1 AND s.branch_id = $2 AND s.status <> 'superseded'
        AND s.business_date BETWEEN $3::date AND $4::date
      ORDER BY s.business_date, s.submitted_at DESC`,
    [context.tenantId, branchId, fromDate, toDate],
  );
  return new Map(rows.rows.map((r) => [r.business_date, {
    businessDate: r.business_date, state: r.status, submission: view(r),
    billsSinceSubmission: r.status === 'submitted' ? r.since : 0,
    posEditing: grantView(r),
  }]));
}

export async function dayStatus(context: TenantContext, branchId: string, businessDate: string): Promise<DayStatus> {
  return (await dayStatuses(context, branchId, businessDate, businessDate)).get(businessDate) ?? openDay(businessDate);
}

/** Today's day, as the Submit Day Bills confirmation shows it. */
export async function dayReview(
  context: TenantContext,
  branchId: string,
  businessDate: string,
): Promise<DayStatus & { figures: DayFigures; openOrders: number }> {
  return {
    ...(await dayStatus(context, branchId, businessDate)),
    figures: await dayFigures(context, branchId, businessDate),
    openOrders: await openOrdersOn(context, branchId, businessDate),
  };
}

async function openOrdersOn(context: TenantContext, branchId: string, businessDate: string): Promise<number> {
  const open = await context.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.table_session
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date AND status = 'open'`,
    [context.tenantId, branchId, businessDate],
  );
  return open.rows[0]!.n;
}

function sameFigures(a: DayFigures, row: {
  bill_count: number; void_bill_count: number; sales_minor: string; tax_minor: string;
  payable_minor: string; collected_minor: string; refunded_minor: string;
}): boolean {
  return a.billCount === row.bill_count && a.voidBillCount === row.void_bill_count
    && a.salesMinor === Number(row.sales_minor) && a.taxMinor === Number(row.tax_minor)
    && a.payableMinor === Number(row.payable_minor) && a.collectedMinor === Number(row.collected_minor)
    && a.refundedMinor === Number(row.refunded_minor);
}

/**
 * Submit Day Bills. Refused while an order of the day is still open (its money
 * is not in yet), and refused when the figures the person confirmed are not the
 * figures now. A second submission of a day whose figures have not moved
 * returns the first one (`alreadySubmitted`): a double tap submits once. A day
 * whose bills moved since -- a bill made after the submission, before the
 * business day ended -- is submitted again, and the earlier row is superseded.
 */
export async function submitDay(
  context: TenantContext,
  params: {
    branchId: string;
    businessDate: string;
    submittedByUserId: string;
    expected?: { billCount?: unknown; payableMinor?: unknown } | null;
  },
): Promise<DayStatus & { figures: DayFigures; alreadySubmitted: boolean }> {
  const { branchId, businessDate } = params;
  await lockDay(context, branchId, businessDate);

  const open = await openOrdersOn(context, branchId, businessDate);
  if (open > 0) throw new DayHasOpenOrdersError(open);

  const figures = await dayFigures(context, branchId, businessDate);
  const expected = params.expected ?? null;
  if (expected !== null && (expected.billCount !== figures.billCount || expected.payableMinor !== figures.payableMinor)) {
    throw new DayChangedError(figures);
  }
  if (figures.billCount === 0 && figures.voidBillCount === 0) throw new DayHasNoBillsError(businessDate);

  const live = await context.client.query<{
    id: string; bill_count: number; void_bill_count: number; sales_minor: string; tax_minor: string;
    payable_minor: string; collected_minor: string; refunded_minor: string;
  }>(
    `SELECT id, bill_count, void_bill_count, sales_minor::text, tax_minor::text, payable_minor::text,
            collected_minor::text, refunded_minor::text
       FROM app.day_submission
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date AND status = 'submitted'
        FOR UPDATE`,
    [context.tenantId, branchId, businessDate],
  );
  const current = live.rows[0];
  if (current !== undefined && sameFigures(figures, current)) {
    return { ...(await dayStatus(context, branchId, businessDate)), figures, alreadySubmitted: true };
  }
  if (current !== undefined) {
    await context.client.query(
      `UPDATE app.day_submission SET status = 'superseded', superseded_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, current.id],
    );
  }

  await context.client.query(
    // clock_timestamp: a submission superseded in this same transaction must sort before this one.
    `INSERT INTO app.day_submission
       (id, tenant_id, branch_id, business_date, submitted_by_user_id, submitted_at,
        bill_count, void_bill_count, sales_minor, tax_minor, payable_minor, collected_minor,
        refunded_minor, methods)
     VALUES ($1, $2, $3, $4::date, $5, clock_timestamp(), $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      randomUUID(), context.tenantId, branchId, businessDate, params.submittedByUserId,
      figures.billCount, figures.voidBillCount, figures.salesMinor, figures.taxMinor,
      figures.payableMinor, figures.collectedMinor, figures.refundedMinor,
      JSON.stringify(figures.methods.map((m) => ({ method: m.method, payments: m.payments, amount_minor: m.amountMinor }))),
    ],
  );
  return { ...(await dayStatus(context, branchId, businessDate)), figures, alreadySubmitted: false };
}

/**
 * A manager reopens a submitted day so its bills can be edited -- by a manager
 * (`bill.edit.any`); reopening opens nothing to the till (that is Allow POS Bill
 * Editing, `setPosEditing`). The submission row is stamped, never removed: what
 * was handed over stays a record.
 */
export async function reopenDay(
  context: TenantContext,
  params: { branchId: string; businessDate: string; reason: unknown; reopenedByUserId: string },
): Promise<DayStatus> {
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw new DayReopenReasonRequiredError();
  await lockDay(context, params.branchId, params.businessDate);
  const updated = await context.client.query(
    `UPDATE app.day_submission
        SET status = 'reopened', reopened_at = now(), reopened_by_user_id = $4, reopen_reason = $5
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date AND status = 'submitted'`,
    [context.tenantId, params.branchId, params.businessDate, params.reopenedByUserId, reason],
  );
  if ((updated.rowCount ?? 0) === 0) throw new DayNotSubmittedError(params.businessDate);
  return dayStatus(context, params.branchId, params.businessDate);
}
