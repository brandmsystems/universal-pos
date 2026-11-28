import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../database/tenantContext.js';
import { allocateComboPrice } from '../products/comboAllocation.js';
import { resolveSupply } from '../tax/registry.js';
import { implementedTenantRegime, tenantCurrency } from '../tax/tenantRegime.js';
import {
  lineTax, refundTaxSnapshot, splitHeads,
} from '../tax/taxHeads.js';
import type { BillRounding, JurisdictionDefinition, TaxAccount } from '../tax/jurisdictions.js';
import type { StoredTaxHead } from '../tax/taxHeads.js';
import { assertInBilling } from '../orders/session.js';
import { BillEditDaySubmittedError, dayState, lockDay } from './dayEnd.js';

/**
 * Bill and payment.
 *
 * Every figure here comes from the ORDER LINE's snapshot -- price, tax rate,
 * component split. Nothing dereferences the catalogue. This is where the
 * priced-document rule arrives at its destination.
 */

export type SplitKind = 'whole' | 'by_line' | 'by_guest' | 'by_percentage';
export type TenderMethod = 'cash' | 'card' | 'upi' | 'wallet' | 'voucher' | 'other';

/**
 * A second bill over lines the first already covers.
 *
 * `assert_billing_invariants` catches this at COMMIT -- an order line allocated
 * beyond 10000bps across non-void bills -- and that backstop stays, because it
 * is what catches the percentage-split cases this check cannot see. But a
 * deferred trigger firing gives the caller a constraint name and a row id, and
 * "you have already billed this table" is a sentence a cashier can act on.
 *
 * Checked here rather than only there for that reason alone. The trigger remains
 * the authority; this is the message.
 */
/**
 * The branch a bill is being raised for does not exist.
 *
 * A 404 rather than the `?? { gstin: null, state_code: null }` this replaced:
 * that fallback stamped a null GST snapshot and let the INSERT proceed to be
 * refused by the foreign key a line later, so the one place a reader checks to
 * see whether the snapshot is trustworthy said "null is fine here" when it was
 * not.
 */
export class UnknownBillingBranchError extends Error {
  readonly statusCode = 404;
  readonly code = 'branch_unknown';
  constructor(branchId: string) {
    super(`no branch ${branchId} in this restaurant, so no bill can be raised for it`);
    this.name = 'UnknownBillingBranchError';
  }
}

export class UnknownRefundBillError extends Error {
  readonly statusCode = 404;
  readonly code = 'refund_bill_unknown';
  constructor(billId: string) {
    super(
      `no bill ${billId} in this restaurant, so there is no supply for a refund to `
      + 'reduce and no tax for it to reverse',
    );
    this.name = 'UnknownRefundBillError';
  }
}

export class LinesAlreadyBilledError extends Error {
  readonly statusCode = 409;
  readonly code = 'lines_already_billed';
  constructor(readonly lineIds: readonly string[]) {
    super(
      `${lineIds.length} of these lines are already fully billed. A further bill ` +
        'for this table has to be a split over what is left, not another whole one.',
    );
    this.name = 'LinesAlreadyBilledError';
  }
}

export class UnassignedGuestLinesError extends Error {
  readonly statusCode = 422;
  readonly code = 'unassigned_guest_lines';
  constructor(readonly lineIds: readonly string[]) {
    super(
      `${lineIds.length} line(s) belong to no guest. A shared starter belongs to nobody, ` +
        'and attributing it would invent data -- assign them explicitly before splitting.',
    );
    this.name = 'UnassignedGuestLinesError';
  }
}

export class BillTenderedError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_already_tendered';
  constructor(billId: string) {
    super(`bill ${billId} has been tendered against and can no longer be changed`);
    this.name = 'BillTenderedError';
  }
}

interface BillableLine {
  id: string;
  display_name: string;
  guest_no: number | null;
  net_amount_minor: string;
  tax_rate_bps: number | null;
  /** The order's price mode (0083): reverse means the amount already holds its tax. */
  prices_include_tax: boolean;
}

/**
 * The NET position of each order line: the line itself plus every void, comp and
 * discount against it. A fully voided line nets to zero and simply does not
 * appear on a bill.
 */
async function billableLines(
  context: TenantContext,
  sessionId: string,
): Promise<readonly BillableLine[]> {
  const result = await context.client.query<BillableLine>(
    `SELECT base.id,
            base.display_name,
            base.guest_no,
            (base.line_total_minor + COALESCE(sum(adj.line_total_minor), 0))::text AS net_amount_minor,
            base.tax_rate_bps,
            o.prices_include_tax
       FROM app.order_line base
       JOIN app.sales_order o ON o.tenant_id = base.tenant_id AND o.id = base.order_id
       LEFT JOIN app.order_line adj
         ON adj.tenant_id = base.tenant_id AND adj.adjusts_line_id = base.id
      WHERE base.tenant_id = $1 AND o.session_id = $2
        AND base.kind IN ('item', 'combo_component', 'charge')
      GROUP BY base.id, base.display_name, base.guest_no, base.line_total_minor,
               base.tax_rate_bps, o.prices_include_tax
     HAVING base.line_total_minor + COALESCE(sum(adj.line_total_minor), 0) > 0
      ORDER BY base.created_at`,
    [context.tenantId, sessionId],
  );
  return result.rows;
}


/**
 * The regime and supply position of a restaurant sale at a branch in
 * `stateCode`: the place of supply is the branch's own state (see the snapshot
 * note in `generateBill`). One copy, so the order screen's estimate splits tax
 * under the same heads the bill will.
 */
export async function restaurantSupply(
  context: TenantContext,
  stateCode: string | null,
  taxChargedMinor: number,
  taxAccount: TaxAccount = 'gst',
): Promise<{ regime: JurisdictionDefinition; position: ReturnType<typeof resolveSupply> }> {
  const regime = await implementedTenantRegime(context.client, context.tenantId);
  const position = resolveSupply(regime.code, {
    supplierStateCode: stateCode,
    placeOfSupplyStateCode: stateCode,
    taxChargedMinor,
    taxAccount,
  });
  return { regime, position };
}

/**
 * How a branch charges tax now (0083): the account it charges under -- NONE
 * when tax is switched off -- and whether its prices include tax.
 */
export async function branchTaxTerms(
  context: TenantContext,
  branchId: string,
): Promise<{ stateCode: string | null; taxAccount: TaxAccount; pricesIncludeTax: boolean }> {
  const branch = await context.client.query<{
    state_code: string | null; tax_enabled: boolean; tax_account_type: TaxAccount; tax_calculation_mode: string;
  }>(
    `SELECT state_code, tax_enabled, tax_account_type, tax_calculation_mode
       FROM app.branch WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, branchId],
  );
  const row = branch.rows[0];
  if (!row) throw new UnknownBillingBranchError(branchId);
  return {
    stateCode: row.state_code,
    taxAccount: row.tax_enabled ? row.tax_account_type : 'none',
    pricesIncludeTax: row.tax_calculation_mode === 'reverse',
  };
}

async function allocateBillNo(
  context: TenantContext,
  branchId: string,
  businessDate: string,
): Promise<number> {
  await context.client.query(
    `INSERT INTO app.bill_sequence (tenant_id, branch_id, business_date, next_no)
     VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [context.tenantId, branchId, businessDate],
  );
  const result = await context.client.query<{ next_no: number }>(
    `UPDATE app.bill_sequence SET next_no = next_no + 1
      WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3
      RETURNING next_no`,
    [context.tenantId, branchId, businessDate],
  );
  return result.rows[0]!.next_no;
}

export interface GenerateBillRequest {
  readonly branchId: string;
  readonly sessionId: string;
  readonly businessDate: string;
  readonly generatedByUserId: string;
  readonly splitKind: SplitKind;
  /** by_line: which lines. by_guest: which guest numbers. by_percentage: shares in bps. */
  readonly lineIds?: readonly string[];
  readonly guestNos?: readonly number[];
  readonly shareBps?: number;
}

export interface GeneratedBill {
  readonly billId: string;
  readonly billNo: number;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  /** Subtotal + tax: the tax document's figure. */
  readonly totalMinor: number;
  /** To the nearest rupee: -49..+50 paise. Not a supply; no tax. */
  readonly roundOffMinor: number;
  /** What is collected: total + round off, a whole rupee. */
  readonly payableMinor: number;
  readonly lineCount: number;
}

/**
 * A bill is paid to the nearest whole rupee: under 50 paise rounds DOWN, 50 or
 * more UP (190.05 -> 190, 264.50 -> 265). The paise between are the bill's
 * round-off, its own line, carrying no tax. The ONE copy of the rule here, used
 * by `generateBill` and the order screen's estimate; the database's
 * `bill_round_off_matches_rule` holds every bill to the same formula.
 */
export function nearestRupeeRoundOff(totalMinor: number): number {
  const paise = totalMinor % 100;
  return paise >= 50 ? 100 - paise : -paise;
}

/**
 * The round-off a bill carries under its country's rule (0084): India pays to
 * the nearest rupee, the UAE to the fils with no round-off at all. The rule is
 * the jurisdiction's and is stamped on the bill, where the database derives the
 * same figure from it.
 */
export function roundOffFor(rule: BillRounding, totalMinor: number): number {
  return rule === 'nearest_rupee' ? nearestRupeeRoundOff(totalMinor) : 0;
}

export async function generateBill(
  context: TenantContext,
  request: GenerateBillRequest,
): Promise<GeneratedBill> {
  await assertInBilling(context, request.sessionId);
  const all = await billableLines(context, request.sessionId);

  let selected: readonly BillableLine[];
  let shareBps = 10000;

  switch (request.splitKind) {
    case 'whole':
      selected = all;
      break;
    case 'by_line': {
      const wanted = new Set(request.lineIds ?? []);
      selected = all.filter((l) => wanted.has(l.id));
      break;
    }
    case 'by_guest': {
      // A by-guest split cannot cover null-guest lines: forcing an attribution
      // would invent data. Prompt, do not guess.
      const unassigned = all.filter((l) => l.guest_no === null).map((l) => l.id);
      if (unassigned.length > 0) throw new UnassignedGuestLinesError(unassigned);
      const wanted = new Set(request.guestNos ?? []);
      selected = all.filter((l) => l.guest_no !== null && wanted.has(l.guest_no));
      break;
    }
    case 'by_percentage':
      selected = all;
      shareBps = request.shareBps ?? 10000;
      break;
  }

  // Largest-remainder, the same allocator combos use. "Split three ways" over
  // 1000 is 333/333/334, and the naive version loses a rupee a table.
  const shares =
    request.splitKind === 'by_percentage'
      ? allocateComboPrice(
          Math.round(
            (selected.reduce((sum, l) => sum + Number(l.net_amount_minor), 0) * shareBps) / 10000,
          ),
          selected.map((l) => ({
            componentId: l.id,
            listPriceMinor: Number(l.net_amount_minor),
            quantity: 1,
          })),
        )
      : selected.map((l) => ({ componentId: l.id, allocatedMinor: Number(l.net_amount_minor) }));

  // Refuse before writing, with words. The share each line has ALREADY been
  // allocated across non-void bills, plus what this bill would add, may not
  // exceed the whole of it -- the same rule the deferred trigger enforces, asked
  // early so the answer is a sentence instead of a constraint name.
  if (selected.length > 0) {
    const allocated = await context.client.query<{ order_line_id: string }>(
      `SELECT l.order_line_id
         FROM app.bill_line l
         JOIN app.bill b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
        WHERE l.tenant_id = $1
          AND b.status <> 'void'
          AND l.order_line_id = ANY($2::uuid[])
        GROUP BY l.order_line_id
       HAVING sum(l.share_bps) + $3::int > 10000`,
      [context.tenantId, selected.map((l) => l.id), shareBps],
    );
    if (allocated.rows.length > 0) {
      throw new LinesAlreadyBilledError(allocated.rows.map((r) => r.order_line_id));
    }
  }

  const byId = new Map(shares.map((s) => [s.componentId, s.allocatedMinor]));

  // Forward or reverse, per the ORDER's own mode (0083), through the one rule
  // the estimate and the paper use. One session is one order, so one mode.
  const pricesIncludeTax = selected.some((l) => l.prices_include_tax);
  if (selected.some((l) => l.prices_include_tax !== pricesIncludeTax)) {
    throw new Error(`session ${request.sessionId} holds lines priced both with and without tax`);
  }
  const split = new Map(selected.map((l) => [l.id, lineTax(byId.get(l.id)!, l.tax_rate_bps, l.prices_include_tax)]));
  let subtotal = 0;
  let tax = 0;
  for (const line of selected) {
    const { taxableMinor, taxMinor } = split.get(line.id)!;
    subtotal += taxableMinor;
    tax += taxMinor;
  }

  // #########################################################################
  // THE GST SNAPSHOT, TAKEN HERE AND NEVER JOINED AT PRINT TIME.
  //
  // Migration 0037 added `supplier_gstin`, `place_of_supply_state_code`,
  // `recipient_gstin` and `recipient_legal_name` to this table, and no write
  // path filled any of them. Every bill therefore carried a null supplier GSTIN
  // and no place of supply -- which is not a cosmetic omission: it is what makes
  // the document a tax invoice rather than a piece of paper, and the credit-note
  // path reads these columns, so every credit note reported zero tax.
  //
  // Stamped, not joined, for the priced-document reason that governs this whole
  // module: a bill reprinted after the branch's registration changed must show
  // what was true when it was issued. A join would silently rewrite history.
  //
  // PLACE OF SUPPLY IS THE RESTAURANT'S STATE, NOT THE GUEST'S. Restaurant
  // service is performed where the restaurant is (IGST Act s.12(4)), so a diner
  // from another state is still an intra-state supply. Reading it from the guest
  // would produce IGST on a walk-in, which is wrong in a way no diner would
  // report and every audit would find.
  //
  // A NULL GSTIN IS NO LONGER THE ANSWER TO "WAS THIS TAXABLE".
  //
  // It used to be read that way, and the reading was wrong: null meant
  // unregistered AND "registered, number not arrived yet" AND "nobody filled
  // the field in", three positions with two lawful tax behaviours. Migration
  // 0048 made the position a stated column, and it is stamped here beside the
  // GSTIN so a printed bill showing no tax can prove which of those it was.
  // `bill_registered_iff_supplier_gstin` keeps the pair honest and
  // `bill_unregistered_carries_no_tax` refuses the document outright if the
  // line rates and the stated position ever disagree -- which is the backstop
  // for the suppression in `resolveOrderableItem`, not a duplicate of it.
  //
  // The RECIPIENT half stays null HERE. A B2B bill's recipient is written by
  // `POST /pos/bill/:id/recipient` after the bill exists and before the first
  // tender, because a diner hands over a company GSTIN when they ask for the
  // bill rather than when the kitchen starts cooking. `attachRecipient` is the
  // only writer.
  //
  // THE HEAD -- CGST+SGST OR IGST -- IS DERIVED HERE AND NOWHERE ELSE.
  //
  // It used to be configuration: `app.tax_component` held a free-text name per
  // tax class and the outward-supply return matched that text to bucket a
  // statutory figure. `src/modules/tax/taxHeads.ts` says what that cost. The head is
  // now a function of the supply, stamped on the document, and asserted by
  // `bill_line_heads_match_treatment` at COMMIT.
  // #########################################################################
  //
  // THE REGIME IS STAMPED TOO, alongside the GSTIN and for the same reason: the
  // heads on this document mean nothing without the law they were struck under,
  // so a bill reprinted after a tenant's jurisdiction changed must show the one
  // it was issued in. `implementedTenantRegime` says why it is read across the
  // plane boundary rather than copied onto the branch.
  //
  // THE PREMISES CLASS IS READ FOR THE BILL'S OWN BUSINESS DATE.
  //
  // Not for today. A bill raised on 1 April for a session opened on 31 March
  // belongs to the year its business date names, and that is the year whose
  // classification the document was issued under. Reading `now()` here would
  // stamp the new year's answer onto a document priced under the old one.
  //
  // `unstated` where the branch has never answered -- absence is not
  // `standard`, for the reason migration 0053 sets out.
  const supply = await context.client.query<{
    gstin: string | null; state_code: string | null; gst_registration: string;
    premises_class: string | null; tax_account: TaxAccount; tax_registration_no: string | null;
  }>(
    `SELECT b.gstin, b.state_code, b.gst_registration, pc.class AS premises_class,
            CASE WHEN b.tax_enabled THEN b.tax_account_type ELSE 'none' END AS tax_account,
            b.tax_registration_no
       FROM app.branch b
       LEFT JOIN app.branch_premises_class pc
         ON pc.tenant_id = b.tenant_id AND pc.branch_id = b.id
        AND pc.fy_start_year = platform.fy_start_year($3::date, 4::smallint)
      WHERE b.tenant_id = $1 AND b.id = $2`,
    [context.tenantId, request.branchId, request.businessDate],
  );
  const branchRow = supply.rows[0];
  // No fallback object. A bill for a branch that does not exist was previously
  // stamped with a null pair and issued; the FK would have refused it a moment
  // later, but the `?? {}` said the opposite in the one place a reader looks to
  // find out whether the snapshot can be trusted.
  if (!branchRow) throw new UnknownBillingBranchError(request.branchId);
  const place = branchRow;

  // PLACE OF SUPPLY IS THE BRANCH'S STATE, passed rather than read inside the
  // derivation. Restaurant service is performed where the restaurant is, so an
  // out-of-state diner is still an intra-state supply and this is the whole of
  // today's answer. When a delivery or catering channel exists it supplies the
  // ADDRESS's state to this same parameter and the head follows it -- which is
  // why `resolveSupplyPosition` takes it instead of looking it up.
  //
  // REFUSED BEFORE A BILL NUMBER IS TAKEN, deliberately. A tenant in a declared
  // but unbuilt jurisdiction cannot raise a bill at all, and doing that check
  // here rather than after `allocateBillNo` means the refusal leaves no gap in
  // the branch's day-numbered series -- which an auditor reads as a deleted
  // bill. `implementedJurisdiction` raises by name; it never falls back on
  // another country's rules, for the reason src/modules/tax/registry.ts sets out.
  const { regime, position } = await restaurantSupply(context, place.state_code, tax, place.tax_account);
  // Outside GST a bill carries no GST identity (`bill_treatment_fits_tax_account`):
  // the number it prints is the VAT or other-tax registration.
  const gst = place.tax_account === 'gst';
  const currency = await tenantCurrency(context.client, context.tenantId);
  const roundOff = roundOffFor(regime.billRounding, subtotal + tax);

  const billId = randomUUID();
  const billNo = await allocateBillNo(context, request.branchId, request.businessDate);

  await context.client.query(
    `INSERT INTO app.bill
       (id, tenant_id, branch_id, session_id, business_date, bill_no, split_kind,
        subtotal_minor, tax_minor, total_minor, generated_by_user_id,
        supplier_gstin, place_of_supply_state_code, supplier_gst_registration,
        supplier_state_code, tax_treatment, tax_jurisdiction, premises_class,
        rounding_rule, round_off_minor, tax_account_type, prices_include_tax, supplier_tax_registration_no,
        currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$23,$19,$20,$21,$22,$24)`,
    [
      billId, context.tenantId, request.branchId, request.sessionId, request.businessDate,
      billNo, request.splitKind, subtotal, tax, subtotal + tax, request.generatedByUserId,
      gst ? place.gstin : null, position.placeOfSupplyStateCode, gst ? place.gst_registration : null,
      position.supplierStateCode, position.treatment, regime.code,
      place.premises_class ?? 'unstated',
      roundOff,
      place.tax_account, pricesIncludeTax,
      place.tax_account === 'vat' || place.tax_account === 'others' ? place.tax_registration_no : null,
      regime.billRounding, currency,
    ],
  );

  for (const line of selected) {
    const { taxableMinor, taxMinor } = split.get(line.id)!;
    await context.client.query(
      `INSERT INTO app.bill_line
         (id, tenant_id, bill_id, order_line_id, share_bps, display_name, guest_no,
          amount_minor, tax_minor, tax_rate_bps, tax_components)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        randomUUID(), context.tenantId, billId, line.id, shareBps, line.display_name,
        line.guest_no, taxableMinor, taxMinor, line.tax_rate_bps,
        // An ARRAY, always -- never `JSON.stringify(null)`, which stores a jsonb
        // `null` SCALAR that COALESCE does not convert and
        // `jsonb_array_elements` refuses outright. 975 live rows were written
        // that way, and they are why the outward-supply return raised
        // "cannot extract elements from a scalar" instead of producing a return.
        JSON.stringify(splitHeads(regime.code, position.treatment, taxMinor, line.tax_rate_bps)),
      ],
    );
  }

  return {
    billId, billNo, subtotalMinor: subtotal, taxMinor: tax,
    totalMinor: subtotal + tax, roundOffMinor: roundOff, payableMinor: subtotal + tax + roundOff,
    lineCount: selected.length,
  };
}

export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'card', 'upi', 'wallet', 'voucher', 'other'];

/**
 * One method's share of a payment.
 *
 * `amountMinor` is what is APPLIED to the bill -- the only figure sales and the
 * invariants read. For cash, `cashReceivedMinor` is the note handed over; give
 * it alone and the server applies what is due and returns the rest as change.
 * `amountMinor` on cash without `cashReceivedMinor` is the exact-cash form every
 * tablet sent before 0070, and still means exactly that. Never both: the server
 * decides what a note pays.
 */
export interface PaymentPart {
  readonly method: TenderMethod;
  readonly amountMinor?: number;
  readonly cashReceivedMinor?: number;
  /** Cash rounds to the nearest unit; card takes the exact figure. */
  readonly roundingMinor?: number;
  readonly reference?: string;
}

export interface PaymentRequest {
  readonly billId: string;
  readonly parts: readonly PaymentPart[];
  readonly tenderedByUserId: string;
}

export interface RecordedTender {
  readonly tenderId: string;
  readonly method: TenderMethod;
  readonly amountMinor: number;
  readonly cashReceivedMinor: number | null;
  readonly changeMinor: number;
}

export interface PaymentResult {
  readonly tenders: readonly RecordedTender[];
  /** What the bill is settled against: its PAYABLE (total + round off). */
  readonly totalMinor: number;
  /** What THIS payment applied to the bill, every method together. */
  readonly appliedMinor: number;
  /** Everything applied to the bill so far, this payment included. */
  readonly paidMinor: number;
  readonly outstandingMinor: number;
  readonly changeMinor: number;
  readonly settled: boolean;
}

export interface TenderRequest extends PaymentPart {
  readonly billId: string;
  readonly tenderedByUserId: string;
}

export interface TenderResult extends PaymentResult {
  readonly tenderId: string;
}

export class PaymentInvalidError extends Error {
  readonly statusCode = 422;
  readonly code = 'payment_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'PaymentInvalidError';
  }
}

export class PaymentExceedsBalanceError extends Error {
  readonly statusCode = 409;
  readonly code = 'payment_exceeds_balance';
  constructor(readonly outstandingMinor: number, attemptedMinor: number) {
    super(
      `${attemptedMinor} is more than the ${outstandingMinor} still due. Only cash can be ` +
        'more than the balance, and the difference goes back as change.',
    );
    this.name = 'PaymentExceedsBalanceError';
  }
}

export class BillNotPayableError extends Error {
  readonly statusCode = 409;
  readonly code = 'bill_not_payable';
  constructor(billId: string, readonly status: string) {
    super(`bill ${billId} is ${status}; there is nothing to pay on it`);
    this.name = 'BillNotPayableError';
  }
}

export class PaymentBillUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'payment_bill_unknown';
  constructor(billId: string) {
    super(`no bill ${billId} at this restaurant`);
    this.name = 'PaymentBillUnknownError';
  }
}

function positiveMinor(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentInvalidError(`${field} must be a whole number of paise above zero`);
  }
  return value;
}

/**
 * Takes one or more methods against a bill, all or none.
 *
 * The balance is the server's: the bill row is locked, what is due is read
 * under that lock, and a client's idea of the balance is never asked for.
 * Non-cash parts go first, in the order given, and none may exceed what is
 * left -- a card cannot be charged change. Cash goes last because it is the
 * only method that can be MORE than the balance: it is applied up to what is
 * due and the rest is change, recorded as the note beside the tender rather
 * than as money taken. At most one cash part, so "which cash was the change
 * from" never needs an answer.
 *
 * `tender_invariants` remains the authority at COMMIT; these checks exist so
 * the cashier gets a sentence instead of a constraint name.
 */
export async function takePayment(
  context: TenantContext,
  request: PaymentRequest,
): Promise<PaymentResult> {
  if (!Array.isArray(request.parts) || request.parts.length === 0 || request.parts.length > 8) {
    throw new PaymentInvalidError('a payment has between one and eight parts');
  }
  for (const part of request.parts) {
    if (!TENDER_METHODS.includes(part.method)) {
      throw new PaymentInvalidError(`unknown payment method ${String(part.method)}`);
    }
    if (part.method !== 'cash' && part.cashReceivedMinor !== undefined) {
      throw new PaymentInvalidError('only cash has an amount received');
    }
    if (part.reference !== undefined && (typeof part.reference !== 'string' || part.reference.length > 120)) {
      throw new PaymentInvalidError('a reference is text of at most 120 characters');
    }
  }
  if (request.parts.filter((p) => p.method === 'cash').length > 1) {
    throw new PaymentInvalidError('at most one cash part per payment');
  }

  // The payable, not the total: a bill is paid to the nearest rupee (0082).
  const bill = await context.client.query<{ status: string; total_minor: string }>(
    `SELECT status, payable_minor::text AS total_minor FROM app.bill
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, request.billId],
  );
  const row = bill.rows[0];
  if (!row) throw new PaymentBillUnknownError(request.billId);
  if (row.status !== 'open') throw new BillNotPayableError(request.billId, row.status);

  const totalMinor = Number(row.total_minor);
  let outstanding = await outstandingOn(context, request.billId, totalMinor);
  if (outstanding <= 0) throw new BillNotPayableError(request.billId, 'already paid');

  const ordered = [
    ...request.parts.filter((p) => p.method !== 'cash'),
    ...request.parts.filter((p) => p.method === 'cash'),
  ];
  const tenders: RecordedTender[] = [];
  for (const part of ordered) {
    const rounding = part.roundingMinor ?? 0;
    if (!Number.isSafeInteger(rounding) || rounding < 0) {
      throw new PaymentInvalidError('rounding is a whole number of paise, zero or more');
    }
    let amount: number;
    let received: number | null = null;
    if (part.method === 'cash' && part.cashReceivedMinor !== undefined) {
      received = positiveMinor(part.cashReceivedMinor, 'cashReceivedMinor');
      if (rounding !== 0) throw new PaymentInvalidError('rounding is not taken with cash received');
      if (outstanding <= 0) throw new BillNotPayableError(request.billId, 'already paid by the other methods');
      if (part.amountMinor !== undefined) throw new PaymentInvalidError('give cash received or an amount, not both');
      amount = Math.min(received, outstanding);
    } else {
      amount = positiveMinor(part.amountMinor, 'amountMinor');
    }
    // A round-off is only ever the paise taken to reach the next whole rupee
    // AND clearing the bill exactly: under a rupee, on a whole-rupee amount,
    // leaving nothing owed. Anything wider would let a client book over-payment
    // as "rounding" -- money taken that is neither sales nor change.
    if (rounding !== 0 && (rounding >= 100 || amount % 100 !== 0 || amount - rounding !== outstanding)) {
      throw new PaymentInvalidError('a round-off is under one rupee, on a whole-rupee amount, and clears the bill exactly');
    }
    if (amount - rounding > outstanding) throw new PaymentExceedsBalanceError(outstanding, amount - rounding);

    // clock_timestamp, not now(): parts written in one transaction would share
    // now() and come back from every reader in no particular order.
    const tenderId = randomUUID();
    await context.client.query(
      `INSERT INTO app.tender
         (id, tenant_id, bill_id, kind, method, amount_minor, rounding_minor, reference,
          tendered_by_user_id, cash_received_minor, tendered_at)
       VALUES ($1,$2,$3,'capture',$4,$5,$6,$7,$8,$9, clock_timestamp())`,
      [
        tenderId, context.tenantId, request.billId, part.method, amount, rounding,
        part.reference ?? null, request.tenderedByUserId, received,
      ],
    );
    outstanding -= amount - rounding;
    tenders.push({
      tenderId, method: part.method, amountMinor: amount,
      cashReceivedMinor: received, changeMinor: received === null ? 0 : received - amount,
    });
  }

  const settled = outstanding === 0;
  if (settled) {
    await context.client.query(
      `UPDATE app.bill SET status = 'settled', settled_at = now(), version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, request.billId],
    );
  }
  return {
    tenders, totalMinor, paidMinor: totalMinor - outstanding, outstandingMinor: outstanding,
    appliedMinor: tenders.reduce((sum, t) => sum + t.amountMinor, 0),
    changeMinor: tenders.reduce((sum, t) => sum + t.changeMinor, 0), settled,
  };
}

/** What is still due: the same sum `tender_invariants` checks, voids included. */
async function outstandingOn(context: TenantContext, billId: string, payableMinor: number): Promise<number> {
  const taken = await context.client.query<{ net: string }>(
    `SELECT COALESCE(sum(amount_minor - rounding_minor), 0)::text AS net
       FROM app.tender WHERE tenant_id = $1 AND bill_id = $2`,
    [context.tenantId, billId],
  );
  return payableMinor - Number(taken.rows[0]!.net);
}

/** One method. A partial tender leaves the session open; only a settled bill closes it. */
export async function recordTender(
  context: TenantContext,
  request: TenderRequest,
): Promise<TenderResult> {
  const { billId, tenderedByUserId, ...part } = request;
  const result = await takePayment(context, { billId, tenderedByUserId, parts: [part] });
  return { ...result, tenderId: result.tenders[0]!.tenderId };
}

/** Same-session, pre-close: a negative row, never an update. */
export async function voidTender(
  context: TenantContext,
  params: { tenderId: string; reasonId: string; voidedByUserId: string },
): Promise<{ voidTenderId: string }> {
  const original = await context.client.query<{
    bill_id: string; method: TenderMethod; amount_minor: string; rounding_minor: string;
  }>(
    `SELECT bill_id, method, amount_minor::text, rounding_minor::text
       FROM app.tender WHERE tenant_id = $1 AND id = $2 AND kind = 'capture'`,
    [context.tenantId, params.tenderId],
  );
  const row = original.rows[0];
  if (!row) throw new Error(`unknown tender ${params.tenderId}`);

  // A submitted day's money is what was handed over: the till cannot move it
  // afterwards, reopened or not (day end, 0086).
  const day = await context.client.query<{ branch_id: string; business_date: string }>(
    `SELECT branch_id, business_date::text FROM app.bill WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, row.bill_id],
  );
  const { branch_id: branchId, business_date: businessDate } = day.rows[0]!;
  await lockDay(context, branchId, businessDate);
  if ((await dayState(context, branchId, businessDate)).state !== 'open') {
    throw new BillEditDaySubmittedError(businessDate);
  }

  const voidTenderId = randomUUID();
  await context.client.query(
    `INSERT INTO app.tender
       (id, tenant_id, bill_id, kind, method, amount_minor, rounding_minor,
        voids_tender_id, reason_id, tendered_by_user_id)
     VALUES ($1,$2,$3,'void',$4,$5,$6,$7,$8,$9)`,
    [
      voidTenderId, context.tenantId, row.bill_id, row.method,
      -Number(row.amount_minor), -Number(row.rounding_minor),
      params.tenderId, params.reasonId, params.voidedByUserId,
    ],
  );

  await context.client.query(
    `UPDATE app.bill SET status = 'open', settled_at = NULL, version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND status = 'settled'`,
    [context.tenantId, row.bill_id],
  );

  return { voidTenderId };
}

/**
 * Post-close, manager, reason code, original bill reference.
 *
 * A refund NEVER reverses a stock deduction: cooked food that left the kitchen
 * cannot re-enter inventory. A returned dish is `inventory.waste` in Phase 4 --
 * ingredients consumed AND no revenue, which is a figure a kitchen manager
 * watches. A reversal would make it vanish from both sides and the kitchen would
 * never learn it happened.
 */
export async function recordRefund(
  context: TenantContext,
  params: {
    billId: string;
    branchId: string;
    amountMinor: number;
    method: TenderMethod;
    reasonId: string;
    originalTenderId?: string;
    note?: string;
    refundedByUserId: string;
  },
): Promise<{ refundId: string }> {
  // #########################################################################
  // THE TAX A CREDIT NOTE REVERSES, SNAPSHOTTED.
  //
  // 0039 added `taxable_minor`, `tax_minor`, `tax_rate_bps` and
  // `tax_components` here with the reason written above, and NO WRITE PATH
  // FILLED ANY OF THEM. 101 refunds exist in the dev install and 47 carry a
  // snapshot -- all 47 written directly by test fixtures. So every credit note
  // in the outward-supply return reported zero tax reversed, which leaves the
  // output tax standing on a supply the restaurant refunded.
  //
  // Same defect family as the bill's own GST snapshot in phase 9, and as the
  // heads this phase replaced: a column the schema requires, a comment
  // explaining why it matters, and a fixture supplying what production never
  // did.
  //
  // A refund amount is TAX-INCLUSIVE -- it is money handed back -- which is
  // what `refund_tax_snapshot_complete` says by requiring
  // taxable + tax = amount.
  // #########################################################################
  const billRow = await context.client.query<{
    tax_treatment: string; tax_jurisdiction: string; subtotal_minor: string;
    tax_minor: string; total_minor: string; rates: number[] | null;
  }>(
    // The bill's OWN jurisdiction and treatment, not the tenant's current ones.
    // A credit note reverses the document it names, under the regime that
    // document was issued in -- the priced-document rule applied to tax.
    `SELECT b.tax_treatment, b.tax_jurisdiction,
            b.subtotal_minor::text, b.tax_minor::text, b.total_minor::text,
            (SELECT array_agg(DISTINCT bl.tax_rate_bps)
               FROM app.bill_line bl
              WHERE bl.tenant_id = b.tenant_id AND bl.bill_id = b.id
                AND bl.tax_rate_bps IS NOT NULL AND bl.tax_rate_bps > 0) AS rates
       FROM app.bill b
      WHERE b.tenant_id = $1 AND b.id = $2`,
    [context.tenantId, params.billId],
  );
  const bill = billRow.rows[0];
  // No fallback. A refund against a bill that does not exist has no tax to
  // reverse and no business being written -- the FK would refuse it a moment
  // later, and a null snapshot would say the opposite.
  if (!bill) throw new UnknownRefundBillError(params.billId);

  const snapshot = refundTaxSnapshot({
    billSubtotalMinor: Number(bill.subtotal_minor),
    billTaxMinor: Number(bill.tax_minor),
    billTotalMinor: Number(bill.total_minor),
    rates: bill.rates ?? [],
    amountMinor: params.amountMinor,
  });

  // A full refund reverses the bill's OWN heads rather than recomputing them:
  // for a mixed-rate bill there is no single rate to recompute from, and the
  // figures that must be reversed are the ones on the paper.
  const heads = snapshot.reverseBillHeads
    ? await billHeads(context, params.billId)
    : splitHeads(
      bill.tax_jurisdiction, bill.tax_treatment, snapshot.taxMinor, snapshot.rateBps,
    );

  const refundId = randomUUID();
  await context.client.query(
    `INSERT INTO app.refund
       (id, tenant_id, branch_id, bill_id, original_tender_id, amount_minor, method,
        reason_id, note, refunded_by_user_id,
        taxable_minor, tax_minor, tax_rate_bps, tax_components)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      refundId, context.tenantId, params.branchId, params.billId,
      params.originalTenderId ?? null, params.amountMinor, params.method,
      params.reasonId, params.note ?? null, params.refundedByUserId,
      snapshot.taxableMinor, snapshot.taxMinor, snapshot.rateBps,
      JSON.stringify(heads),
    ],
  );
  return { refundId };
}

/**
 * The bill's own heads, aggregated per name. Read from `bill_line`, which is the
 * document, rather than recomputed.
 */
async function billHeads(
  context: TenantContext,
  billId: string,
): Promise<readonly StoredTaxHead[]> {
  const result = await context.client.query<{
    // `string`, not a union of Indian heads -- what a head is called is the
    // jurisdiction's business, and this reads back what the document stored.
    name: string; rate_bps: number; amount_minor: string;
  }>(
    // `jsonb_typeof` and not COALESCE: 975 live rows hold a jsonb `null` SCALAR,
    // which COALESCE does not convert and `jsonb_array_elements` refuses -- the
    // exact shape that made the outward-supply return raise instead of
    // returning. Normalised at every reader until those rows age out.
    `SELECT c.value ->> 'name' AS name,
            max((c.value ->> 'rate_bps')::integer) AS rate_bps,
            sum((c.value ->> 'amount_minor')::bigint)::text AS amount_minor
       FROM app.bill_line bl
       CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(bl.tax_components) = 'array'
                   THEN bl.tax_components ELSE '[]'::jsonb END) c
      WHERE bl.tenant_id = $1 AND bl.bill_id = $2
      GROUP BY c.value ->> 'name'
      ORDER BY 1`,
    [context.tenantId, billId],
  );
  return result.rows.map((r) => ({
    name: r.name, rate_bps: r.rate_bps, amount_minor: Number(r.amount_minor),
  }));
}
