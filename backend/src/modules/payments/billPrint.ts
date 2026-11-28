import type { TenantContext } from '../../database/tenantContext.js';
import { splitHeads, type StoredTaxHead } from '../tax/taxHeads.js';

/**
 * The printed bill: the paper handed to the table, and the receipt after it is
 * paid.
 *
 * ###########################################################################
 * EVERY FIGURE ON THE PAPER IS ONE THE BILL ALREADY HOLDS.
 *
 * Lines, rates, tax and total come from the bill's own snapshot rows and the
 * order lines' snapshots -- never the menu, never today's tax rate. A receipt
 * reprinted in March for a bill made in October must say what was charged in
 * October. Nothing here computes a price; the one piece of arithmetic is
 * showing a line's comp or discount as the difference between its rate x
 * quantity and the amount the bill holds for it, so the paper adds up.
 *
 * The tax heads are the bill's stored components where it has them, and
 * otherwise the same `splitHeads` that `generateBill` and the GST return use,
 * applied to the stamped treatment and each line's own tax -- so the paper, the
 * bill and the return split a rupee the same way.
 * ###########################################################################
 *
 * ###########################################################################
 * EVERY COPY IS COUNTED, AND THE SECOND ONE SAYS SO.
 *
 * Printing writes an `app.bill_print` row under a lock on the bill, so two
 * tablets printing at once get copy 1 and copy 2, never two copy 1s. A bill is
 * printed as a bill until it is settled and as a receipt after, and each kind
 * is counted on its own: the first receipt is an original whatever happened to
 * the bill before it was paid. What each is CALLED on paper is the branch's
 * (0088, `layout.headings`); the kind and the count are never the till's.
 * ###########################################################################
 */

export type PrintKind = 'bill' | 'receipt';

export interface PrintedLine {
  readonly quantity: number;
  readonly name: string;
  /** Per unit, add-ons included; null on a percentage split, where no rate is honest. */
  readonly rateMinor: number | null;
  /** rate x quantity, or the bill's amount when there is no rate. */
  readonly grossMinor: number;
  readonly addOns: readonly string[];
  /** A comp or discount on this line, as a positive amount taken off; 0 when none. */
  readonly lessMinor: number;
  readonly lessLabel: string | null;
}

export interface PrintedTax {
  readonly label: string;
  readonly amountMinor: number;
}

export interface PrintedTender {
  readonly method: string;
  /** Applied to the bill; negative for a void. */
  readonly amountMinor: number;
  readonly reference: string | null;
  /** The note handed over, when the cashier recorded it. */
  readonly cashReceivedMinor: number | null;
  readonly changeMinor: number;
  /** Paise taken over the bill to reach a whole rupee (card/UPI): round-off, not sales. */
  readonly roundingMinor: number;
}

/**
 * How the branch lays its bill out (0078), carried on every printout so the
 * till prints with what the manager set rather than with a copy of it. The
 * paper comes from the branch's bill printer; with none chosen it is the 3-inch
 * thermal roll every bill was laid out for before.
 */
export interface PrintLayout {
  readonly printerName: string | null;
  readonly connection: string | null;
  readonly printerType: 'thermal' | 'laser' | 'inkjet';
  readonly paperSize: 'thermal_58' | 'thermal_80' | 'thermal_112' | 'a5' | 'a4';
  readonly orientation: 'portrait' | 'landscape';
  readonly marginMm: number;
  readonly fontSizePx: number;
  readonly show: {
    readonly logo: boolean;
    readonly details: boolean;
    readonly customer: boolean;
    readonly tax: boolean;
    readonly payments: boolean;
    /** The copy's name at the top (CUSTOMER / KITCHEN / COUNTER), 0080. REPRINT and PARCEL print regardless. */
    readonly copyLabel: boolean;
  };
  readonly copies: { readonly customer: boolean; readonly kitchen: boolean; readonly counter: boolean };
  readonly autoPrint: boolean;
  /**
   * The heading at the top of the customer and counter copies (0088): a bill
   * with nothing paid, a bill with some paid, and a receipt. Read at print time
   * like the footer, so a reprint carries the heading saved now. Never on a KOT.
   */
  readonly headings: { readonly unpaid: string; readonly partPaid: string; readonly paid: string };
}

export interface PrintedBill {
  readonly kind: PrintKind;
  readonly layout: PrintLayout;
  readonly copyNo: number;
  readonly restaurant: {
    readonly name: string;
    readonly legalName: string | null;
    readonly address: string | null;
    readonly phone: string | null;
    /** The outlet's email (0083), printed when set. */
    readonly email: string | null;
    readonly gstin: string | null;
    /**
     * The registration printed under the name, labelled for the tax the bill was
     * raised under: GSTIN, TRN (VAT) or Tax No. Null when the bill names none.
     */
    readonly taxNumber: { readonly label: string; readonly value: string } | null;
    readonly footer: string;
  };
  /** Reverse mode (0083): the line amounts already include the tax shown. */
  readonly pricesIncludeTax: boolean;
  /** The tax's name for the paper -- 'GST', 'VAT' or 'Tax' -- or null when the bill charges none. */
  readonly taxLabel: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly billNo: number;
  readonly businessDate: string;
  readonly openedAt: string;
  readonly billedAt: string;
  readonly settledAt: string | null;
  readonly printedAt: string;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly tables: readonly string[];
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly covers: number | null;
  readonly waiter: string | null;
  readonly cashier: string | null;
  readonly lines: readonly PrintedLine[];
  /**
   * A parcel's packing charge (0081), printed under the items; 0 when none. As
   * charged, like the lines: tax-inclusive when `pricesIncludeTax`.
   */
  readonly parcelChargeMinor: number;
  readonly subtotalMinor: number;
  readonly taxes: readonly PrintedTax[];
  /** The bill's own tax total, for a layout that prints one tax line instead of the heads. */
  readonly taxMinor: number;
  /** Subtotal + tax: the tax document's total. */
  readonly totalMinor: number;
  /** To the nearest rupee (0082): -49..+50 paise, printed as Round off. 0 on a bill made before the rule. */
  readonly roundOffMinor: number;
  /** What the customer pays: total + round off. Paid and outstanding are measured against this. */
  readonly payableMinor: number;
  readonly tenders: readonly PrintedTender[];
  readonly paidMinor: number;
  readonly outstandingMinor: number;
}

export class BillToPrintUnknownError extends Error {
  readonly code = 'bill_unknown';
  constructor(readonly billId: string) {
    super(`bill ${billId} does not exist at this restaurant`);
    this.name = 'BillToPrintUnknownError';
  }
}

export class VoidBillNotPrintableError extends Error {
  readonly code = 'bill_void';
  constructor(readonly billId: string) {
    super('this bill was voided; it cannot be printed');
    this.name = 'VoidBillNotPrintableError';
  }
}

/** 500 -> "5%", 250 -> "2.5%", 1225 -> "12.25%". */
const pct = (bps: number): string =>
  `${bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '')}%`;

export async function printBill(
  context: TenantContext,
  params: { billId: string; branchId: string | null; actorUserId: string },
): Promise<PrintedBill> {
  const found = await context.client.query<{
    id: string; status: string; bill_no: number; business_date: string; session_id: string;
    subtotal_minor: string; tax_minor: string; total_minor: string; round_off_minor: string; payable_minor: string;
    generated_at: string; settled_at: string | null; generated_by: string | null;
    supplier_gstin: string | null; tax_treatment: string; tax_jurisdiction: string;
    tax_account_type: string; prices_include_tax: boolean; supplier_tax_registration_no: string | null; currency: string;
    branch_name: string; phone: string | null; bill_address: string | null; bill_footer: string;
    email: string | null; bill_name: string | null;
    timezone: string;
    printer_name: string | null; connection_kind: string | null; printer_type: PrintLayout['printerType'] | null;
    paper_size: PrintLayout['paperSize'] | null; orientation: PrintLayout['orientation'] | null;
    margin_mm: number | null; font_size_px: number | null;
    bill_show_logo: boolean; bill_show_details: boolean; bill_show_customer: boolean; bill_show_tax: boolean;
    bill_show_payments: boolean; bill_copy_customer: boolean; bill_copy_kitchen: boolean; bill_copy_counter: boolean;
    bill_auto_print: boolean; bill_show_copy_label: boolean;
    bill_heading_unpaid: string; bill_heading_part_paid: string; bill_heading_paid: string;
  }>(
    // A branch-scoped tablet prints only its own branch's bills; the owner's
    // branch-less session prints any of the restaurant's.
    `SELECT b.id, b.status, b.bill_no, b.business_date::text AS business_date, b.session_id,
            b.subtotal_minor::text, b.tax_minor::text, b.total_minor::text,
            b.round_off_minor::text, b.payable_minor::text,
            b.generated_at::text AS generated_at, b.settled_at::text AS settled_at,
            u.full_name AS generated_by, b.supplier_gstin, b.tax_treatment, b.tax_jurisdiction,
            b.tax_account_type, b.prices_include_tax, b.supplier_tax_registration_no, b.currency,
            br.name AS branch_name, br.phone, br.bill_address, br.bill_footer, br.timezone,
            br.email, br.bill_name,
            p.name AS printer_name, p.connection_kind, p.printer_type, p.paper_size, p.orientation,
            p.margin_mm, p.font_size_px,
            br.bill_show_logo, br.bill_show_details, br.bill_show_customer, br.bill_show_tax,
            br.bill_show_payments, br.bill_copy_customer, br.bill_copy_kitchen, br.bill_copy_counter,
            br.bill_auto_print, br.bill_show_copy_label,
            br.bill_heading_unpaid, br.bill_heading_part_paid, br.bill_heading_paid
       FROM app.bill b
       JOIN app.branch br ON br.tenant_id = b.tenant_id AND br.id = b.branch_id
       LEFT JOIN app.printer p ON p.tenant_id = br.tenant_id AND p.id = br.bill_printer_id
       LEFT JOIN app.app_user u ON u.tenant_id = b.tenant_id AND u.id = b.generated_by_user_id
      WHERE b.tenant_id = $1 AND b.id = $2 AND ($3::uuid IS NULL OR b.branch_id = $3)
        FOR UPDATE OF b`,
    [context.tenantId, params.billId, params.branchId]);
  const bill = found.rows[0];
  if (!bill) throw new BillToPrintUnknownError(params.billId);
  if (bill.status === 'void') throw new VoidBillNotPrintableError(params.billId);

  // The restaurant's own name and address, from the tenant root -- the one row
  // every app table already points at. Read, never written, as `generateBill`
  // reads the regime.
  const tenant = (await context.client.query<{
    name: string; legal_name: string | null; address: string | null;
  }>(
    `SELECT name, legal_name, address FROM platform.tenant WHERE id = $1`,
    [context.tenantId])).rows[0]!;

  const session = (await context.client.query<{
    service_type: 'dine_in' | 'parcel'; parcel_no: number | null; pickup_name: string | null;
    guest_count: number | null; opened_at: string; waiter: string | null; tables: string[];
  }>(
    `SELECT s.service_type, s.parcel_no, s.pickup_name, s.guest_count,
            s.opened_at::text AS opened_at, u.full_name AS waiter,
            COALESCE((SELECT array_agg(t.identifier ORDER BY t.identifier)
                        FROM app.table_session_table tst
                        JOIN app.dining_table t ON t.tenant_id = tst.tenant_id AND t.id = tst.dining_table_id
                       WHERE tst.tenant_id = s.tenant_id AND tst.session_id = s.id
                         AND (tst.detached_at IS NULL OR tst.detached_at >= COALESCE(s.closed_at, 'infinity'))),
                     '{}') AS tables
       FROM app.table_session s
       LEFT JOIN app.app_user u ON u.tenant_id = s.tenant_id AND u.id = s.opened_by_user_id
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [context.tenantId, bill.session_id])).rows[0]!;

  const lines = await context.client.query<{
    share_bps: number; display_name: string; amount_minor: string; tax_minor: string;
    tax_rate_bps: number | null; tax_components: unknown;
    kind: string; quantity: number; unit_price_minor: string | null; modifiers: unknown;
    parent_line_id: string | null; parent_name: string | null; parent_quantity: number | null;
    voided_quantity: string; less_kinds: string[] | null;
  }>(
    `SELECT bl.share_bps, bl.display_name, bl.amount_minor::text, bl.tax_minor::text,
            bl.tax_rate_bps, bl.tax_components,
            ol.kind, ol.quantity, ol.unit_price_minor::text, ol.modifiers,
            ol.parent_line_id, p.display_name AS parent_name, p.quantity AS parent_quantity,
            COALESCE((SELECT sum(a.quantity) FROM app.order_line a
                       WHERE a.tenant_id = ol.tenant_id AND a.adjusts_line_id = ol.id
                         AND a.kind = 'void'), 0)::text AS voided_quantity,
            (SELECT array_agg(DISTINCT a.kind) FROM app.order_line a
              WHERE a.tenant_id = ol.tenant_id AND a.adjusts_line_id = ol.id
                AND a.kind IN ('comp', 'discount')) AS less_kinds
       FROM app.bill_line bl
       JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
       LEFT JOIN app.order_line p ON p.tenant_id = ol.tenant_id AND p.id = ol.parent_line_id
      WHERE bl.tenant_id = $1 AND bl.bill_id = $2
      ORDER BY ol.created_at, bl.id`,
    [context.tenantId, params.billId]);

  const printed: PrintedLine[] = [];
  let parcelChargeMinor = 0;
  const comboIndex = new Map<string, number>();
  const heads = new Map<string, PrintedTax & { order: number }>();
  for (const row of lines.rows) {
    // What the line was charged at, as the diner saw it: in reverse mode the
    // bill line holds the taxable value, and its tax is inside the price.
    const amount = Number(row.amount_minor) + (bill.prices_include_tax ? Number(row.tax_minor) : 0);

    // A combo prints as the one dish the guest ordered, its components folded
    // under it -- the bill holds them apart because they carry different tax.
    if (row.kind === 'charge') {
      parcelChargeMinor += amount;
    } else if (row.kind === 'combo_component' && row.parent_line_id !== null) {
      const at = comboIndex.get(row.parent_line_id);
      if (at === undefined) {
        comboIndex.set(row.parent_line_id, printed.length);
        printed.push({
          quantity: row.parent_quantity ?? 1, name: row.parent_name ?? row.display_name,
          rateMinor: null, grossMinor: amount, addOns: [row.display_name], lessMinor: 0, lessLabel: null,
        });
      } else {
        const combo = printed[at]!;
        printed[at] = { ...combo, grossMinor: combo.grossMinor + amount, addOns: [...combo.addOns, row.display_name] };
      }
    } else {
      const quantity = row.quantity + Number(row.voided_quantity);
      const addOns = Array.isArray(row.modifiers)
        ? (row.modifiers as { name?: unknown }[]).flatMap((m) => (typeof m.name === 'string' ? [m.name] : []))
        : [];
      const rate = row.share_bps === 10000 && row.unit_price_minor !== null ? Number(row.unit_price_minor) : null;
      const gross = rate === null ? amount : rate * quantity;
      const less = gross - amount;
      const kinds = row.less_kinds ?? [];
      printed.push({
        quantity, name: row.display_name, rateMinor: rate, grossMinor: gross, addOns,
        lessMinor: less,
        lessLabel: less === 0 ? null
          : kinds.includes('comp') && !kinds.includes('discount') ? 'Complimentary'
            : 'Discount',
      });
    }

    const stored = Array.isArray(row.tax_components) && row.tax_components.length > 0
      ? (row.tax_components as StoredTaxHead[]).filter((h) => typeof h.amount_minor === 'number')
      : [];
    const lineHeads = stored.length > 0
      ? stored
      : splitHeads(bill.tax_jurisdiction, bill.tax_treatment, Number(row.tax_minor), row.tax_rate_bps);
    if (lineHeads.length > 0) {
      for (const head of lineHeads) addHead(heads, `${head.name} ${pct(head.rate_bps)}`, head.amount_minor);
    } else if (Number(row.tax_minor) !== 0) {
      // Tax with no knowable head -- a branch that never stated its GST
      // position. Printed under the rate alone rather than an invented head.
      addHead(heads, `Tax ${pct(row.tax_rate_bps ?? 0)}`, Number(row.tax_minor));
    }
  }

  const tenders = await context.client.query<{
    method: string; amount_minor: string; rounding_minor: string; reference: string | null;
    cash_received_minor: string | null;
  }>(
    `SELECT t.method, t.amount_minor::text, t.rounding_minor::text,
            COALESCE(t.reference, t.operator_reference) AS reference, t.cash_received_minor::text
       FROM app.tender t
      WHERE t.tenant_id = $1 AND t.bill_id = $2
      ORDER BY t.tendered_at, t.id`,
    [context.tenantId, params.billId]);

  // Net of voids and rounding: the same sum `tender_invariants` checks.
  const paid = tenders.rows.reduce((sum, t) => sum + Number(t.amount_minor) - Number(t.rounding_minor), 0);

  const kind: PrintKind = bill.status === 'settled' ? 'receipt' : 'bill';
  const copy = await context.client.query<{ copy_no: number; printed_at: string }>(
    `INSERT INTO app.bill_print (id, tenant_id, bill_id, kind, copy_no, printed_by_user_id)
     SELECT gen_random_uuid(), $1, $2, $3,
            COALESCE((SELECT max(copy_no) FROM app.bill_print
                       WHERE tenant_id = $1 AND bill_id = $2 AND kind = $3), 0) + 1,
            $4
     RETURNING copy_no, printed_at::text AS printed_at`,
    [context.tenantId, params.billId, kind, params.actorUserId]);

  return {
    kind,
    layout: {
      printerName: bill.printer_name,
      connection: bill.connection_kind,
      printerType: bill.printer_type ?? 'thermal',
      paperSize: bill.paper_size ?? 'thermal_80',
      orientation: bill.orientation ?? 'portrait',
      marginMm: bill.margin_mm ?? 3,
      fontSizePx: bill.font_size_px ?? 12,
      show: {
        logo: bill.bill_show_logo, details: bill.bill_show_details, customer: bill.bill_show_customer,
        tax: bill.bill_show_tax, payments: bill.bill_show_payments, copyLabel: bill.bill_show_copy_label,
      },
      copies: { customer: bill.bill_copy_customer, kitchen: bill.bill_copy_kitchen, counter: bill.bill_copy_counter },
      autoPrint: bill.bill_auto_print,
      headings: { unpaid: bill.bill_heading_unpaid, partPaid: bill.bill_heading_part_paid, paid: bill.bill_heading_paid },
    },
    copyNo: copy.rows[0]!.copy_no,
    restaurant: {
      // The branch's name for its bills (0083) over the restaurant's, as the
      // address is: a two-outlet restaurant may trade under two names.
      name: bill.bill_name ?? tenant.name,
      legalName: tenant.legal_name,
      address: bill.bill_address ?? tenant.address,
      phone: bill.phone,
      email: bill.email,
      gstin: bill.supplier_gstin,
      taxNumber: bill.supplier_gstin !== null ? { label: 'GSTIN', value: bill.supplier_gstin }
        : bill.supplier_tax_registration_no !== null
          ? { label: bill.tax_account_type === 'vat' ? 'TRN' : 'Tax No.', value: bill.supplier_tax_registration_no }
          : null,
      footer: bill.bill_footer,
    },
    pricesIncludeTax: bill.prices_include_tax,
    taxLabel: TAX_LABEL[bill.tax_account_type] ?? null,
    currency: bill.currency,
    timezone: bill.timezone,
    billNo: bill.bill_no,
    businessDate: bill.business_date,
    openedAt: session.opened_at,
    billedAt: bill.generated_at,
    settledAt: bill.settled_at,
    printedAt: copy.rows[0]!.printed_at,
    serviceType: session.service_type,
    tables: session.tables,
    parcelNo: session.parcel_no,
    pickupName: session.pickup_name,
    covers: session.guest_count,
    waiter: session.waiter,
    cashier: bill.generated_by,
    lines: printed,
    parcelChargeMinor,
    subtotalMinor: Number(bill.subtotal_minor),
    taxes: [...heads.values()].sort((a, b) => a.order - b.order)
      .map(({ label, amountMinor }) => ({ label, amountMinor })),
    taxMinor: Number(bill.tax_minor),
    totalMinor: Number(bill.total_minor),
    roundOffMinor: Number(bill.round_off_minor),
    payableMinor: Number(bill.payable_minor),
    tenders: tenders.rows.map((t) => ({
      method: t.method, amountMinor: Number(t.amount_minor), reference: t.reference,
      cashReceivedMinor: t.cash_received_minor === null ? null : Number(t.cash_received_minor),
      changeMinor: t.cash_received_minor === null
        ? 0 : Number(t.cash_received_minor) - Number(t.amount_minor),
      roundingMinor: Number(t.rounding_minor),
    })),
    paidMinor: paid,
    outstandingMinor: Number(bill.payable_minor) - paid,
  };
}

/** The tax's name for the paper, by the account the bill was raised under. NONE prints none. */
const TAX_LABEL: Readonly<Record<string, string>> = { gst: 'GST', vat: 'VAT', others: 'Tax' };

function addHead(heads: Map<string, PrintedTax & { order: number }>, label: string, amount: number): void {
  const current = heads.get(label);
  heads.set(label, { label, amountMinor: (current?.amountMinor ?? 0) + amount, order: current?.order ?? heads.size });
}
