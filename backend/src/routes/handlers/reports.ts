import type { FastifyRequest } from 'fastify';
import type { Handler } from '../lookup.js';
import type { TenantContext } from '../../database/tenantContext.js';
import {
  salesBy, salesSummary, paymentMix, previousWindow, salesSummaryCompared,
  type SalesDimension, type SalesRow,
} from '../../modules/reports/salesReports.js';
import { exceptionReport as readExceptions } from '../../modules/reports/exceptionReport.js';
import { outwardSupplyReturn, reconcileReturnToBills } from '../../modules/reports/gstReturn.js';
import { REPORTS } from '../../modules/reports/registry.js';
import { branchPrintFailures } from '../../modules/business-types/restaurant/kitchen/printWorker.js';
import { currentBusinessDate } from '../../modules/orders/session.js';

/**
 * The reporting, privacy and print surface. Nine routes, no decisions.
 *
 * ###########################################################################
 * A REPORT READS A SNAPSHOT. THIS LAYER DOES NOT GET TO CHOOSE.
 *
 * Every figure here comes from `src/modules/reports/*`, which the snapshot-only
 * scanner (tests/reporting/snapshotOnly.test.ts) holds to an ALLOWLIST of
 * readable tables. That gate stops at the directory boundary, so the way this
 * file stays inside it is by adding no read of its own: it parses a range,
 * resolves a branch from the token, calls one domain function and returns what
 * it returned.
 *
 * The one non-reporting read is `currentBusinessDate`, and it is not a figure --
 * it is the branch's clock, used to decide whether a range is even answerable
 * yet. See requireClosedRange.
 * ###########################################################################
 *
 * ###########################################################################
 * THE RANGE COMES FROM THE QUERY STRING. THE BRANCH NEVER DOES.
 *
 * A date range is genuinely the caller's -- a manager asking about last week is
 * stating a question, not asserting a fact about themselves -- so it arrives as
 * `?from=&to=`, validated here, and it is REQUIRED rather than defaulted. A
 * report with an implied range is a report whose numbers move between two people
 * looking at the same screen.
 *
 * The branch is the opposite. It is on the verified token, the permission was
 * resolved against it, and a report that accepted `?branchId=` would be a read
 * scoped by a value the caller controls -- the same defect as a body-supplied
 * branch on a write, with the same 200 and no error. A token that names NO
 * branch is a tenant-level session and reads the whole tenant, which is wider on
 * purpose and still bounded by `tenant_id`; where a report cannot be produced
 * without a branch it refuses instead of picking one.
 * ###########################################################################
 */

/** A calendar day, and nothing looser. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * The widest range any of these will answer.
 *
 * Not a performance limit. A report is one response with no pagination, so a
 * range wider than this returns a body whose size nobody bounded -- and the
 * honest failure for "I cannot serve all of this" is a refusal naming the limit,
 * not a truncated answer that looks complete.
 */
const MAX_RANGE_DAYS = 366;

/** Which handler serves which entry in the report registry. */
const SERVES = {
  salesReport: 'sales.summary',
  salesExport: 'sales.export',
  staffReport: 'staff.activity',
  exceptionReport: 'exception.transaction',
  gstReturn: 'tax.outward_supply',
} as const;

const DIMENSIONS: readonly SalesDimension[] =
  ['item', 'category', 'station', 'hour', 'staff', 'branch'];

export class ReportRangeInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'report_range_invalid';
  constructor(detail: string) {
    super(
      `${detail}. A report states the range it covers: pass ?from=YYYY-MM-DD&to=YYYY-MM-DD. ` +
        'These are BUSINESS dates -- a restaurant day ends at 3am, and the range is ' +
        'compared against sales_order.business_date, never against a wall clock.',
    );
    this.name = 'ReportRangeInvalidError';
  }
}

export class ReportRangeUnservableError extends Error {
  readonly statusCode = 422;
  readonly code = 'report_range_unservable';
  constructor(toDate: string, openDate: string) {
    super(
      `this range ends ${toDate}, and business date ${openDate} at this branch is still ` +
        'open. A document extracted from a day that is still trading is partial, it will ' +
        'not match itself when it is run again tomorrow, and nothing on its face says so. ' +
        `Ask again for a range ending before ${openDate}.`,
    );
    this.name = 'ReportRangeUnservableError';
  }
}

export class ReportBranchRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'report_branch_required';
  constructor(readonly report: string) {
    super(
      `${report} is produced for one branch and this session names none. The branch is ` +
        'taken from the verified token and never from the request, so there is nothing ' +
        'to widen or to guess: sign in at the branch this report is for.',
    );
    this.name = 'ReportBranchRequiredError';
  }
}

export class ReportDimensionUnknownError extends Error {
  readonly statusCode = 400;
  readonly code = 'report_dimension_unknown';
  constructor(asked: string) {
    super(
      `'${asked}' is not a sales dimension. The set is ${DIMENSIONS.join(', ')}. ` +
        'An unknown dimension is refused rather than dropped: a report silently ' +
        'missing a section reads as a report with nothing in that section.',
    );
    this.name = 'ReportDimensionUnknownError';
  }
}

export class StockCountRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'stock_count_required';
  constructor() {
    super(
      'the variance report reconciles ONE count sheet against its own snapshot, so it ' +
        'needs ?countId=. There is no read that lists the counts in a period yet, which ' +
        'is why this refuses rather than choosing a count on the caller\'s behalf.',
    );
    this.name = 'StockCountRequiredError';
  }
}

/**
 * A boot refusal, not a client error.
 *
 * The registry exists so the coverage assertion can run both directions -- no
 * report without a permission key, no `report.*` key without a report. A handler
 * serving a name the registry does not declare puts a report outside that
 * assertion, so the process does not start.
 */
export class ReportNotDeclaredError extends Error {
  readonly code = 'report_not_declared';
  constructor(readonly names: readonly string[]) {
    super(
      `these handlers serve reports the registry does not declare: ${names.join(', ')}. ` +
        'src/modules/reports/registry.ts is what ties a report to the permission that guards ' +
        'it; a report outside it is a screen nobody granted access to.',
    );
    this.name = 'ReportNotDeclaredError';
  }
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const raw = request.query;
  return raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function stringQuery(request: FastifyRequest, name: string): string | null {
  const value = queryOf(request)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The branch, from the VERIFIED token, and null when the token carries none --
 * a password session signed in at the tenant level rather than standing at a
 * till. Same rule and same function shape as the POS and admin handlers.
 */
function branchOnToken(request: FastifyRequest): string | null {
  const value = (request.claims ?? {})['branch_id'];
  return typeof value === 'string' ? value : null;
}

function requireBranch(request: FastifyRequest, report: string): string {
  const branchId = branchOnToken(request);
  if (branchId === null) throw new ReportBranchRequiredError(report);
  return branchId;
}

export interface DateRange {
  readonly fromDate: string;
  readonly toDate: string;
}

/** Rejects a malformed, reversed, impossible or unbounded range. */
function dateRange(request: FastifyRequest): DateRange {
  const fromDate = stringQuery(request, 'from');
  const toDate = stringQuery(request, 'to');

  const missing = [
    ...(fromDate === null ? ['from'] : []),
    ...(toDate === null ? ['to'] : []),
  ];
  if (fromDate === null || toDate === null) {
    throw new ReportRangeInvalidError(`the range is incomplete: ${missing.join(' and ')} absent`);
  }

  for (const [name, value] of [['from', fromDate], ['to', toDate]] as const) {
    if (!DATE_ONLY.test(value)) {
      throw new ReportRangeInvalidError(`${name}=${value} is not a YYYY-MM-DD date`);
    }
    // 2026-02-30 matches the pattern and is not a day. Round-tripping through UTC
    // is what catches it, and it must be UTC: a local-time parse of a date-only
    // string shifts the day in half the world's timezones.
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new ReportRangeInvalidError(`${name}=${value} is not a real calendar day`);
    }
  }

  if (fromDate > toDate) {
    throw new ReportRangeInvalidError(`from=${fromDate} is after to=${toDate}`);
  }

  const span = Math.round((Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS);
  if (span >= MAX_RANGE_DAYS) {
    throw new ReportRangeInvalidError(
      `${span} days is wider than the ${MAX_RANGE_DAYS}-day limit for one response`,
    );
  }

  return { fromDate, toDate };
}

/**
 * ###########################################################################
 * A DOCUMENT MAY NOT COVER A DAY THAT IS STILL TRADING.
 *
 * `business_date` is stamped at open from the branch's timezone and day start, so
 * "today" at a branch that opens its day at 5am is not today in UTC and is not
 * today at the branch next door. The clock is therefore the BRANCH's, read
 * through the same function the POS uses to stamp a session.
 *
 * A viewing report is allowed to include the open day -- "sales so far today" is
 * a real question and the screen is live. An EXPORT and a TAX RETURN are not:
 * they are extracted, filed, mailed and reconciled against, and a figure that
 * changes after it leaves is worse than one that was refused.
 * ###########################################################################
 */
async function requireClosedRange(
  context: TenantContext,
  branchId: string,
  range: DateRange,
): Promise<string> {
  const openDate = await currentBusinessDate(context, branchId);
  if (range.toDate >= openDate) throw new ReportRangeUnservableError(range.toDate, openDate);
  return openDate;
}

export interface RangeCaveat {
  readonly kind: 'open_business_date' | 'branch_clock_unknown';
  readonly detail: string;
}

/** The same fact requireClosedRange refuses on, surfaced instead of refused. */
async function rangeCaveats(
  context: TenantContext,
  branchId: string | null,
  range: DateRange,
): Promise<readonly RangeCaveat[]> {
  if (branchId === null) {
    return [{
      kind: 'branch_clock_unknown',
      detail:
        'this session names no branch, so the report covers every branch in the tenant ' +
        'and no single business-day clock applies. Whether the last day in the range is ' +
        'still trading cannot be stated here, and it may differ between branches.',
    }];
  }
  const openDate = await currentBusinessDate(context, branchId);
  if (range.toDate < openDate) return [];
  return [{
    kind: 'open_business_date',
    detail:
      `business date ${openDate} is still open at this branch, so the figures for it ` +
      'are partial and will keep moving until the day closes. The export and the tax ' +
      'return refuse a range like this; a screen is allowed to show it.',
  }];
}

/**
 * `compare=previous` for the window immediately before this one, or an explicit
 * `compareFrom`/`compareTo` pair.
 *
 * The 'previous' case is computed by `previousWindow` in the domain rather than
 * here, because "the period before" is inclusive-date arithmetic that is off by
 * one the first time anybody writes it -- and a comparison that is quietly one
 * day short makes every delta on the dashboard wrong by a fraction nobody can
 * see.
 */
function comparisonWindow(
  request: FastifyRequest, range: { fromDate: string; toDate: string },
): { fromDate: string; toDate: string } | null {
  const mode = stringQuery(request, 'compare');
  const from = stringQuery(request, 'compareFrom');
  const to = stringQuery(request, 'compareTo');

  if (from !== null || to !== null) {
    if (from === null || to === null) {
      throw new ReportRangeInvalidError(
        'a comparison needs both compareFrom and compareTo, or neither');
    }
    for (const [name, value] of [['compareFrom', from], ['compareTo', to]] as const) {
      if (!DATE_ONLY.test(value)) {
        throw new ReportRangeInvalidError(`${name}=${value} is not a YYYY-MM-DD date`);
      }
    }
    if (from > to) {
      throw new ReportRangeInvalidError(`compareFrom=${from} is after compareTo=${to}`);
    }
    return { fromDate: from, toDate: to };
  }

  if (mode === null) return null;
  if (mode !== 'previous') {
    throw new ReportRangeInvalidError(
      `compare=${mode} is not understood. Use compare=previous, or name a window ` +
        'with compareFrom and compareTo.');
  }
  return previousWindow(range.fromDate, range.toDate);
}

function requestedDimensions(request: FastifyRequest): readonly SalesDimension[] {
  const asked = stringQuery(request, 'dimensions');
  if (asked === null) return DIMENSIONS;
  const wanted = asked.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (wanted.length === 0) throw new ReportDimensionUnknownError(asked);
  for (const one of wanted) {
    if (!DIMENSIONS.includes(one as SalesDimension)) throw new ReportDimensionUnknownError(one);
  }
  return wanted as readonly SalesDimension[];
}

async function salesByDimensions(
  context: TenantContext,
  branchId: string | null,
  range: DateRange,
  dimensions: readonly SalesDimension[],
): Promise<Record<string, readonly SalesRow[]>> {
  const out: Record<string, readonly SalesRow[]> = {};
  for (const dimension of dimensions) {
    out[dimension] = await salesBy(context, dimension, { branchId, ...range });
  }
  return out;
}

function assertDeclared(handlers: Record<string, Handler>): void {
  const declared = new Set(REPORTS.map((report) => report.name));
  const undeclared = Object.entries(SERVES)
    .filter(([handler, report]) => handler in handlers && !declared.has(report))
    .map(([handler, report]) => `${handler} -> ${report}`);
  if (undeclared.length > 0) throw new ReportNotDeclaredError(undeclared);
}

export function reportHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    /**
     * The sales report. Six dimensions off ONE projection, each read from the
     * order line's own snapshot -- see src/modules/reports/salesReports.ts for why
     * `quantityMade` and `quantitySold` are two different figures.
     */
    salesReport: async (request, _reply, context) => {
      const range = dateRange(request);
      const branchId = branchOnToken(request);
      const dimensions = requestedDimensions(request);
      // #################################################################
      // BOTH EXTRAS ARE OPT-IN, AND THE DASHBOARD MAKES ONE CALL.
      //
      // `payments` and `compare` are requested the same way `dimensions` is,
      // so the export path and every existing caller pay for neither. And they
      // are ADDITIVE to the response rather than reshaping `summary`: a caller
      // reading `summary.netMinor` today keeps reading it tomorrow.
      //
      // They live on this route rather than on two new ones because the owner
      // dashboard wants all of it for one date range, and three routes would
      // be three chances for the range to differ between tiles.
      // #################################################################
      const wantsPayments = stringQuery(request, 'payments') !== null;
      const compare = comparisonWindow(request, range);

      return {
        report: SERVES.salesReport,
        branchId,
        ...range,
        summary: await salesSummary(context, { branchId, ...range }),
        dimensions: await salesByDimensions(context, branchId, range, dimensions),
        /** Null when not asked for. NOT an empty array: absent and none differ. */
        payments: wantsPayments
          ? await paymentMix(context, { branchId, ...range })
          : null,
        comparison: compare === null ? null : await (async () => {
          const compared = await salesSummaryCompared(
            context, { branchId, ...range }, compare);
          return { window: compare, previous: compared.previous, delta: compared.delta };
        })(),
        caveats: await rangeCaveats(context, branchId, range),
      };
    },

    /**
     * The same figures, extracted -- and it REFUSES what the screen above is
     * allowed to show. An export is a file somebody keeps; a partial one that
     * reads as complete is the failure this route exists to avoid.
     */
    salesExport: async (request, _reply, context) => {
      const range = dateRange(request);
      const branchId = requireBranch(request, 'the sales export');
      const openDate = await requireClosedRange(context, branchId, range);
      const dimension = (stringQuery(request, 'dimension') ?? 'item') as SalesDimension;
      if (!DIMENSIONS.includes(dimension)) throw new ReportDimensionUnknownError(dimension);

      const rows = await salesBy(context, dimension, { branchId, ...range });
      return {
        report: SERVES.salesExport,
        branchId,
        ...range,
        dimension,
        /** The day the branch was on when this was taken; every day in the range is closed. */
        takenAgainstOpenBusinessDate: openDate,
        rowCount: rows.length,
        rows,
        summary: await salesSummary(context, { branchId, ...range }),
      };
    },

    /**
     * Per-staff activity, from the sales snapshot.
     *
     * The staff dimension attributes each line to `order_line.created_by_user_id`
     * -- the person who keyed it. The registry describes this report as
     * attributed through `authorising_membership_id`, which is the AUDIT log's
     * attribution and is not implemented by any read that exists: see the note in
     * the delivery report. What is served is what is built, and it is labelled
     * for what it is rather than presented as the other thing.
     */
    staffReport: async (request, _reply, context) => {
      const range = dateRange(request);
      const branchId = branchOnToken(request);
      return {
        report: SERVES.staffReport,
        branchId,
        ...range,
        attribution: 'order_line.created_by_user_id',
        staff: await salesBy(context, 'staff', { branchId, ...range }),
        summary: await salesSummary(context, { branchId, ...range }),
        caveats: await rangeCaveats(context, branchId, range),
      };
    },

    /**
     * Voids, comps, discounts and the rest, sectioned from `risk_subclass` and
     * ranked against each actor's OWN baseline. Privacy-class keys are in neither
     * section by construction; they are in app.pii_access_log, with a DPO
     * audience, and the two must not be joined.
     */
    exceptionReport: async (request, _reply, context) => {
      const range = dateRange(request);
      const branchId = branchOnToken(request);
      const asked = stringQuery(request, 'baselineDays');
      const baselineDays = asked === null ? 28 : Number(asked);
      if (!Number.isInteger(baselineDays) || baselineDays < 7 || baselineDays > 365) {
        throw new ReportRangeInvalidError(
          `baselineDays=${asked} must be a whole number of days between 7 and 365; ` +
            'a shorter window is noise and a longer one dilutes the spike being looked for',
        );
      }
      return {
        report: SERVES.exceptionReport,
        branchId,
        ...range,
        baselineDays,
        ...await readExceptions(context, { branchId, baselineDays, ...range }),
      };
    },

    /**
     * The tenant's own outward-supply return, GSTR-1 shaped.
     *
     * ###################################################################
     * SERVED WITH AN UNREVIEWED DEPENDENCY, AND IT SAYS SO ON ITS FACE.
     *
     * The figures are snapshots off `bill` and `bill_line` and they reconcile
     * to those bills independently -- that much is mechanical. What is NOT
     * settled is the place-of-supply treatment for a restaurant supply, which
     * nobody who files an Indian GST return has yet reviewed. The return
     * therefore carries `awaitingReview` and the caveat rather than a filing
     * flag: a screen that cannot present this as final cannot get somebody
     * into trouble with it.
     *
     * `reconciliation` is computed off bill_line directly rather than through
     * the bucketing, so it cannot agree with the return merely by sharing its
     * arithmetic. `matches: false` means the two disagree and the return must
     * not be filed at all.
     * ###################################################################
     */
    gstReturn: async (request, _reply, context) => {
      const range = dateRange(request);
      const branchId = requireBranch(request, 'the outward-supply return');
      await requireClosedRange(context, branchId, range);
      const params = { branchId, ...range };
      return {
        report: SERVES.gstReturn,
        ...await outwardSupplyReturn(context, params),
        reconciliation: await reconcileReturnToBills(context, params),
        awaitingReview: true,
        caveats: [
          {
            kind: 'place_of_supply_unreviewed',
            detail:
              'the place-of-supply treatment of a restaurant supply has not been reviewed ' +
              'by anyone who files these returns. Every figure here is read from the bill ' +
              'as it was raised; what is unconfirmed is whether the treatment recorded on ' +
              'those bills is the right one, and whether a registered recipient makes a ' +
              'restaurant supply reportable as B2B at all.',
          },
          {
            kind: 'b2b_capture_may_be_off',
            detail:
              'the B2B section is populated only for bills where a cashier recorded a ' +
              'company GSTIN, and the till only asks for one when the tax settings say ' +
              'so -- it is off by default. An empty B2B section is therefore either ' +
              'genuinely no registered customers or a setting nobody has turned on, and ' +
              'this report cannot tell you which. (Before migration 0050 it was neither: ' +
              'no write path existed at all.)',
          },
          {
            kind: 'printed_heads_may_predate_0050',
            detail:
              'reconciliation.printedHeadsMatch compares the CGST/SGST/IGST split being ' +
              'filed against the split printed on the bills. It is false for any bill ' +
              'raised before migration 0050, because until then the components carried no ' +
              'amount -- and for a jsonb null scalar, no array either. That is a fact ' +
              'about those documents rather than a disagreement about these figures.',
          },
        ],
      };
    },

    /**
     * The BRANCH's print failures. Not platform health: a jammed printer is a
     * problem for the manager standing twenty feet from it.
     */
    printFailures: async (request, _reply, context) => {
      const branchId = requireBranch(request, 'the print failure list');
      const failures = await branchPrintFailures(
        context.client, { tenantId: context.tenantId, branchId });
      return { branchId, failureCount: failures.length, failures };
    },

  };

  assertDeclared(handlers);
  return handlers;
}
