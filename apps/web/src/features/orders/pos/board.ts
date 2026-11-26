import { minorFrom, type Minor } from '../../../lib/money.js';

/**
 * The shape of `GET /pos/session/:id/board`, in one place.
 *
 * ###########################################################################
 * WHAT THE BOARD DOES NOT SEND IS TYPED AS ABSENT, NOT AS NULL.
 *
 * Two of the three fields this note used to list are SERVED now --
 * `adjusts_line_id` (with the reason's id, name and note) and `guest_no` -- so
 * an adjustment attaches to its line and says why, and the split picker can
 * show whose line it is. The remaining gap is real and stays described:
 *
 *   bill_line rows       app.bill_line carries share_bps and guest_no per bill,
 *                        and the board's `bills` query returns no lines at all.
 *                        So how much of a line is already allocated -- the thing
 *                        `lines_already_billed` and the 10000bps invariant turn
 *                        on -- is not knowable client-side. A partial void or
 *                        comp therefore cannot be subtracted on screen before
 *                        the till refuses it.
 *
 * Typed `field?: T | null`, so `undefined` is "not served" and reads
 * differently from a genuine null. Under exactOptionalPropertyTypes that is not
 * cosmetic: a screen cannot silently treat the absence as an answer, which is
 * the same rule `Remote<T>` enforces one level up.
 * ###########################################################################
 */

export type LineKind =
  | 'item' | 'combo_parent' | 'combo_component'
  | 'void' | 'comp' | 'discount' | 'charge';

export interface BoardLine {
  readonly id: string;
  readonly order_id: string;
  readonly kind: LineKind;
  readonly parent_line_id: string | null;
  readonly display_name: string;
  readonly quantity: number;
  readonly unit_price_minor: string | null;
  /** NULL for a combo parent, whose money is `display_total_minor`. */
  readonly line_total_minor: string | null;
  readonly display_total_minor: string | null;
  readonly tax_rate_bps: number | null;
  readonly fired: boolean;
  readonly note: string | null;
  /** Served now: which line this adjustment came off. */
  readonly adjusts_line_id: string | null;
  readonly adjustment_reason_id: string | null;
  /** The reason's own name, so the screen shows words rather than a uuid. */
  readonly adjustment_reason_name: string | null;
  readonly adjustment_note: string | null;
  readonly guest_no: number | null;
}

export interface BoardTable {
  readonly dining_table_id: string;
  readonly identifier: string;
  readonly seats: number;
}

export interface BoardSession {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly guest_count: number | null;
  readonly business_date: string;
  readonly opened_at: string | null;
  readonly service_type?: 'dine_in' | 'parcel';
  /** 'counter': numbered, no tables (every parcel; dine-in on a plan without tables). */
  readonly seating?: 'table' | 'counter';
  readonly parcel_no?: number | null;
  readonly pickup_name?: string | null;
  readonly picked_up_at?: string | null;
  /** 'billing' once KOT handed the order over: from then on KOT cannot change it. */
  readonly stage?: 'ordering' | 'billing';
  readonly billing_ready_at?: string | null;
}

export interface BoardMenuItem {
  readonly id: string;
  readonly name: string;
  readonly price_minor: string;
  readonly category_id: string;
  readonly orderable: boolean;
  readonly unavailable_message: string | null;
  readonly unavailable_reason: string | null;
  /** The kitchen this branch sends the item to; null for a combo, which routes per component. */
  readonly kitchen_station_id?: string | null;
  readonly kitchen_name?: string | null;
}

export interface BillTender {
  readonly id: string;
  readonly kind: 'capture' | 'void';
  readonly method: string;
  readonly amount_minor: string;
  readonly rounding_minor: string;
  /** The cash note handed over, when recorded; change is the server's, beside it. */
  readonly cash_received_minor: string | null;
  readonly change_minor: string;
  readonly reference: string | null;
  readonly voids_tender_id: string | null;
  readonly settled_offline_manually: boolean;
  readonly tendered_at: string;
}

export interface BillRow {
  readonly id: string;
  readonly bill_no: number;
  readonly split_kind: string;
  readonly status: string;
  readonly subtotal_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
  /** To the nearest rupee (0082): -49..+50 paise; '0' on a bill made before the rule. Absent from an older API. */
  readonly round_off_minor?: string;
  /** What is collected: total + round off. Outstanding and settled are measured against this. */
  readonly payable_minor?: string;
  /** The subtotal as the bill holds it: dishes, and the parcel charge line (0081). Absent from an older API. */
  readonly items_minor?: string;
  readonly parcel_charge_minor?: string;
  /** How the bill was taxed (0083). Absent from an older API: GST, forward. */
  readonly tax_account_type?: 'none' | 'gst' | 'vat' | 'others';
  readonly prices_include_tax?: boolean;
  /** Computed server-side, in the same transaction that read the tenders. */
  readonly paid_minor: string;
  readonly outstanding_minor: string;
  readonly settled: boolean;
  readonly settled_at: string | null;
  /**
   * WHETHER a diner is named on this bill, never who or their number. The till
   * needs the boolean -- attach or change, and whether points can be spent --
   * and the phone leaves the server through one logged route only.
   */
  readonly customer_id: string | null;
  /**
   * The COMPANY on the bill, when a cashier recorded one. Unlike the customer,
   * this is returned whole rather than as a boolean: a GSTIN is a business's
   * public tax identifier, printed on the invoice it belongs to, and a cashier
   * reading it back to a customer is the point of showing it.
   */
  readonly recipient_gstin: string | null;
  readonly recipient_legal_name: string | null;
  /**
   * The GST position the bill was raised under, snapshotted. The till needs it
   * to TITLE the document: a composition taxable person hands over a bill of
   * supply, not a tax invoice, and the paper has to say so.
   */
  readonly supplier_gst_registration: string | null;
  readonly tenders: readonly BillTender[];
}

export interface BoardLease {
  readonly state: string;
  readonly seconds_remaining: number;
  readonly device_id: string;
}

export interface Board {
  readonly session: BoardSession | null;
  readonly tables: readonly BoardTable[];
  readonly bills: readonly BillRow[];
  readonly lines: readonly BoardLine[];
  readonly lease: BoardLease | null;
  readonly menu: readonly BoardMenuItem[];
  readonly menuVersion: string;
  readonly serverNow: string;
  /** On the board, not fetched separately -- see BoardResponse in src/modules/orders/board.ts. */
  readonly taxOptions: { readonly b2bCaptureEnabled: boolean };
}

const ADJUSTMENT_KINDS: readonly LineKind[] = ['void', 'comp', 'discount'];

/**
 * ###########################################################################
 * AN ADJUSTMENT ROW IS A LINE ON THE ORDER, AND IT MUST NOT BE DRAWN AS ONE.
 *
 * `order_line_shape_exact` (migration 0027) requires `parent_line_id IS NULL` on
 * every void, comp and discount row -- they are top-level rows that carry a
 * NEGATIVE `line_total_minor` and the display_name of the line they adjust. The
 * board returns them mixed in with the order's items.
 *
 * So `parent_line_id === null` is NOT the test for "a line the customer
 * ordered": before this existed, one void of one dish rendered as two lines with
 * the same name, one positive and one negative, and a waiter reading the pane
 * saw a dish they had voided still sitting on the order. The kind is the
 * discriminator, because the kind is what the constraint keys on.
 * ###########################################################################
 */
export function isAdjustment(line: BoardLine): boolean {
  return ADJUSTMENT_KINDS.includes(line.kind);
}

/** What the customer ordered: top-level, not an adjustment, not a component. */
export function orderedLines(lines: readonly BoardLine[]): readonly BoardLine[] {
  return lines.filter((line) => !isAdjustment(line) && line.parent_line_id === null);
}

export function adjustmentLines(lines: readonly BoardLine[]): readonly BoardLine[] {
  return lines.filter(isAdjustment);
}

/** A combo's components, for the pane that shows what is inside one. */
export function componentsOf(
  lines: readonly BoardLine[],
  parentId: string,
): readonly BoardLine[] {
  return lines.filter((line) => line.parent_line_id === parentId);
}

/**
 * ###########################################################################
 * A COMBO PARENT IS NOT A PRICED LINE, AND THREE SERVER RULES SAY SO.
 *
 * `item` and `combo_component` are the only kinds that carry money, and every
 * server path that deals in money or in food filters on exactly those two:
 *
 *   billableLines   (src/modules/payments/billing.ts)   kind IN ('item','combo_component')
 *   fireOrder       (src/modules/kitchen/fire.ts)      kind IN ('item','combo_component')
 *   lockTarget      (src/modules/orders/adjustments.ts) refuses anything else outright --
 *                   "a combo is adjusted through its components"
 *
 * So a client list built from "top-level lines" is the wrong set for all three,
 * in opposite directions: it INCLUDES the combo parent and EXCLUDES the
 * components. Two consequences, both live before this existed:
 *
 *  - A combo parent's `fired_at` is never set, because fire only updates those
 *    two kinds. Counting unfired top-level lines therefore counted the parent
 *    forever: the Fire button read "Fire 1 to the kitchen" for the rest of the
 *    service and firing it was refused with `nothing_to_fire`.
 *  - A by_line split composed of top-level ids sends the parent's id, which
 *    `billableLines` never returns, so it is silently dropped -- a bill with
 *    fewer lines than the cashier ticked, or none at all.
 * ###########################################################################
 */
export function pricedLines(lines: readonly BoardLine[]): readonly BoardLine[] {
  return lines.filter((line) => line.kind === 'item' || line.kind === 'combo_component');
}

/**
 * Has the kitchen got this line?
 *
 * ###########################################################################
 * A COMBO PARENT'S `fired` FLAG IS ALWAYS FALSE, AND THE SERVER'S OWN GUARD
 * READS IT. SO THE CLIENT DERIVES THE ANSWER FROM THE PARTS INSTEAD.
 *
 * `fireOrder` sets `fired_at` on `item` and `combo_component` rows only, so a
 * `combo_parent` row's `fired_at` stays NULL for the life of the order however
 * many times the combo is cooked. `editLine` and `removeLine` both guard with
 * `if (row.fired_at !== null) throw LineAlreadyFiredError` against THAT row --
 * a condition a combo parent can never satisfy.
 *
 * The consequences are asymmetric and one of them is silent:
 *
 *  - removeLine deletes `id = $2 OR parent_line_id = $2`, which includes fired
 *    components, and `kot_line_order_line_fk` is ON DELETE RESTRICT -- so it
 *    fails at the database with a constraint name rather than with "the kitchen
 *    already has this".
 *  - editLine's quantity change calls `reallocateCombo`, which locks the
 *    components and rewrites their quantity, line_total and unit price WITHOUT
 *    looking at their `fired_at` at all. It succeeds. The kitchen is cooking the
 *    quantity on its ticket and the bill charges the new one.
 *
 * A client cannot fix either, but it can decline to ask: any part in the kitchen
 * means the combo is in the kitchen. `some`, not `every`, because fire moves
 * every unfired part at once and the conservative reading is the safe one.
 * ###########################################################################
 */
export function effectivelyFired(
  line: BoardLine,
  all: readonly BoardLine[],
): boolean {
  if (line.kind !== 'combo_parent') return line.fired;
  const parts = componentsOf(all, line.id);
  return parts.some((part) => part.fired);
}

/**
 * The server's figure for a line, or null when the server sent none.
 *
 * A combo parent carries `display_total_minor` and a NULL `line_total_minor`; an
 * item is the other way round. Null out means "no figure", and the caller draws
 * that as unknown -- never as zero, which on a bill is a free dish.
 */
export function lineMoney(line: BoardLine): Minor | null {
  const text = line.display_total_minor ?? line.line_total_minor;
  return text === null || text === undefined ? null : minorFrom(text);
}
