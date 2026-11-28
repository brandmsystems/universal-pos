import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../database/tenantContext.js';
import { allocateComboPrice, allocationBalances } from '../products/comboAllocation.js';
import { resolveAvailability } from '../products/availability.js';
import { assertTakesOrderChanges, SessionNotOpenError } from './session.js';

/**
 * The rate a line takes, resolved in ONE place.
 *
 * ###########################################################################
 * THIS WAS THREE COPIES OF ONE RULE, AND THEY AGREED BY LUCK.
 *
 * The single-item path, the combo-choice path and the fixed-component path each
 * carried their own CASE. They said the same thing because somebody remembered
 * to edit all three -- twice, in 0048 and again in 0051. The standing review
 * question in AGENTS.md asks exactly this: is it derived, or a second copy that
 * happens to agree today? It was a copy, and 0053 would have been the third
 * chance to leave one behind. A combo component missed here is a thali taxed at
 * the wrong rate while every single dish on the same bill is right.
 *
 * THE ARMS, IN ORDER, AND THE ORDER IS THE RULE:
 *
 *   Tax switched off, or the NONE account (0083), charges nothing. A VAT or
 *   OTHERS account charges the dish's own class rate: the GST position and the
 *   premises class below are GST's questions and are not asked of it.
 *
 *   A position that may not collect tax wins over everything. An unregistered
 *   branch and a composition dealer charge nothing, and a premises
 *   classification cannot make them start -- a composition dealer in a
 *   five-star hotel still may not collect a paisa.
 *
 *   A SPECIFIED PREMISES takes the jurisdiction's override, whatever the dish
 *   says. Above the declared-tariff threshold every restaurant supply at that
 *   premises is taxed at the higher rate with input credit, and the dish tax
 *   class is not a second opinion about it.
 *
 *   Otherwise the dish's own class, which is the ordinary case.
 *
 * COALESCE on the override, and the fallback is deliberately the DISH rate
 * rather than null: a null would make the line untaxed, which is the silent
 * failure. It cannot survive -- `order_line_premises_rate` refuses the write
 * and names the missing catalogue entry -- so the fallback exists only to make
 * the refusal loud instead of making the bill quiet.
 *
 * NO BACKTICKS IN THIS COMMENT. This is spliced into template literals, and a
 * backtick would end the string. Phase 8, 11 and 15 each lost a build to it.
 * ###########################################################################
 */
const TAX_RATE_RESOLUTION = `
            CASE
              WHEN NOT b.tax_enabled OR b.tax_account_type = 'none' THEN 0
              WHEN b.tax_account_type <> 'gst' THEN tc.rate_bps
              WHEN b.gst_registration IN ('unregistered', 'composition') THEN 0
              WHEN pc.class = 'specified' THEN COALESCE(ovr.rate_bps, tc.rate_bps)
              ELSE tc.rate_bps
            END`;

/**
 * The joins `TAX_RATE_RESOLUTION` needs. Spliced beside it, never apart.
 *
 * The financial year is derived from the BRANCH's own business date, not from
 * the server's calendar day: a branch whose service day starts at 05:00 is
 * still on yesterday at 02:00, and on 1 April that is the difference between
 * two financial years and two classifications.
 *
 * The 4 is India's statutory GST year (April-March) and is passed explicitly
 * rather than read from `platform.tenant_tax_profile.financial_year_starts_month`
 * -- that column is the year WE invoice the tenant on, and letting a tenant
 * move a statutory boundary by changing their billing preference is not a
 * setting, it is a hole.
 */
const PREMISES_JOINS = `
       LEFT JOIN app.branch_premises_class pc
         ON pc.tenant_id = b.tenant_id AND pc.branch_id = b.id
        AND pc.fy_start_year = platform.fy_start_year(
              app.business_date(b.timezone, b.business_day_starts_at), 4::smallint)
       LEFT JOIN platform.tenant pt ON pt.id = b.tenant_id
       LEFT JOIN platform.tax_rate_override ovr
         ON ovr.jurisdiction_code = pt.tax_jurisdiction
        AND ovr.position = 'specified_premises'`;


/**
 * Order entry: the priced-document write path.
 *
 * ###########################################################################
 * THE CLIENT NEVER SENDS A PRICE, AND THE SERVER NEVER READS ONE BACK.
 *
 * Two halves of one rule, and they fail in opposite directions:
 *
 *  - A price accepted from the tablet is an uncapped discount channel with no
 *    reason code and no exception report -- strictly worse than `order.discount`,
 *    which at least has a cap and an audit trail. So the request names an ITEM
 *    and a QUANTITY; the money is resolved here, from the catalogue, inside the
 *    transaction that writes the line.
 *
 *  - A bill that dereferences a catalogue row for a value stops reconciling to
 *    itself the moment a price, a modifier delta or a tax rate is edited. So
 *    every number is SNAPSHOTTED onto the line as it is written.
 *
 * The snapshot set is not "the price": it is unit_price_minor, EVERY selected
 * modifier's price_delta_minor, display_name, tax_class_key, tax_rate_bps and
 * the component split. Modifier deltas are the ones that get forgotten, because
 * they feel like configuration -- "extra cheese +30" is a line on the bill, and
 * when it becomes +40 the historical bill stops adding up.
 * ###########################################################################
 */

export class MenuItemNotOrderableError extends Error {
  readonly code = 'menu_item_not_orderable';
  constructor(
    readonly menuItemId: string,
    readonly reason: string,
    readonly availableFrom: string | null,
  ) {
    super(`menu item ${menuItemId} cannot be ordered here and now: ${reason}`);
    this.name = 'MenuItemNotOrderableError';
  }
}

export class LineAlreadyFiredError extends Error {
  readonly code = 'line_already_fired';
  constructor(readonly lineId: string) {
    super(
      `order line ${lineId} has fired. Post-fire changes are adjustments ` +
        '(order.void / order.comp), not edits: the food is already cooked.',
    );
    this.name = 'LineAlreadyFiredError';
  }
}

export class ModifierNotPermittedError extends Error {
  readonly code = 'modifier_not_permitted';
  constructor(readonly optionId: string, readonly menuItemId: string) {
    super(`modifier option ${optionId} is not attached to menu item ${menuItemId}`);
    this.name = 'ModifierNotPermittedError';
  }
}

export class ModifierSelectionOutOfBoundsError extends Error {
  readonly code = 'modifier_selection_out_of_bounds';
  constructor(readonly groupId: string, readonly selected: number, readonly why: string) {
    super(`modifier group ${groupId}: ${selected} selected, ${why}`);
    this.name = 'ModifierSelectionOutOfBoundsError';
  }
}

/** What the tablet may send. Note the absence of every money field. */
export class GuestNoOutOfRangeError extends Error {
  readonly statusCode = 422;
  readonly code = 'guest_no_out_of_range';
  constructor(guestNo: number, guestCount: number | null) {
    super(
      guestCount === null
        ? `this table was opened without a guest count, so guest ${guestNo} cannot be ` +
          'checked against anything. Reopen the table with the number of covers.'
        : `guest ${guestNo} is outside the ${guestCount} covers this table was opened ` +
          'with. Change the cover count on the table first -- a line assigned to a ' +
          'guest who is not there cannot be split to anybody.',
    );
    this.name = 'GuestNoOutOfRangeError';
  }
}

export interface AddLineRequest {
  readonly orderId: string;
  readonly menuItemId: string;
  readonly quantity: number;
  readonly modifierOptionIds?: readonly string[];
  /**
   * One selection per `combo_choice_group` on the combo. A choice option must be
   * a MENU ITEM, not a modifier option, because it needs its own tax class and
   * its own station routing -- which is exactly why `modifier_group` cannot serve
   * and `combo_choice_group` exists.
   */
  readonly choices?: readonly { readonly choiceGroupId: string; readonly menuItemId: string }[];
  readonly note?: string | null;
  /**
   * Which guest this is for, 1..session.guest_count.
   *
   * ####################################################################
   * NULL MEANS SHARED, AND IT IS A REAL ANSWER RATHER THAN AN OMISSION.
   *
   * A shared starter belongs to nobody. `UnassignedGuestLinesError` refuses a
   * by_guest split while any line is unassigned precisely so that the cashier
   * decides -- attributing the papad to guest 1 because it was keyed first
   * would invent data, and the guest who pays for it would be the one who
   * happened to be sitting nearest the till.
   *
   * Nothing in the product used to set this at all, so `by_guest` refused 100%
   * of the time: the split screen existed, the guest numbers existed, the
   * refusal was correct, and there was no way to satisfy it.
   * ####################################################################
   */
  readonly guestNo?: number | null;
}

export class ComboChoiceRequiredError extends Error {
  readonly code = 'combo_choice_required';
  constructor(readonly choiceGroupId: string, readonly why: string) {
    super(`combo choice group ${choiceGroupId}: ${why}`);
    this.name = 'ComboChoiceRequiredError';
  }
}

export interface SnapshottedModifier {
  readonly optionId: string;
  readonly groupId: string;
  readonly name: string;
  readonly priceDeltaMinor: number;
}

export interface AddedLine {
  readonly lineId: string;
  readonly kind: 'item' | 'combo_parent';
  readonly displayName: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly lineTotalMinor: number | null;
  readonly displayTotalMinor: number | null;
  readonly modifiers: readonly SnapshottedModifier[];
  readonly componentLineIds: readonly string[];
}

interface OrderRow {
  branch_id: string;
  business_date: string;
  status: string;
  /** From the session. Null when the table was opened without a cover count. */
  guest_count: number | null;
}

interface ResolvedItem {
  id: string;
  name: string;
  status: string;
  price_minor: string;
  tax_class_key: string | null;
  tax_rate_bps: number | null;
  is_combo: boolean;
}

/**
 * Availability is re-resolved HERE, and by the SAME function the board read uses.
 *
 * The board's answer is advisory and can be minutes old -- a tablet holding a
 * cached menu is the normal case, which is the entire point of `menuVersion`.
 * The write is the authoritative moment, so the precedence runs again against
 * the row being written.
 *
 * It calls `resolveAvailability` rather than reproducing the ladder in a second
 * query. A hand-rolled copy here was the first thing written and it silently
 * dropped `days_of_week`, so a weekday-only item was orderable on a Sunday --
 * the copy looked right because it sat next to a correct implementation.
 *
 * The reason travels with the refusal for the same reason it travels with the
 * board: "available from 07:00" and "sold out" send the waiter to different
 * places, and a bare 409 sends them to neither.
 */
async function resolveOrderableItem(
  context: TenantContext,
  branchId: string,
  menuItemId: string,
): Promise<ResolvedItem> {
  const result = await context.client.query<ResolvedItem>(
    `SELECT mi.id, mi.name, mi.status,
            COALESCE(bp.price_minor, mi.price_minor)::text AS price_minor,
            tc.key AS tax_class_key,
            -- ###############################################################
            -- WHERE AN UNREGISTERED BRANCH STOPS CHARGING GST.
            --
            -- Here, in the line snapshot, and deliberately NOT at bill time.
            -- generateBill sums taxOn(amount, line.tax_rate_bps) over the
            -- lines, so a suppression applied to the bill total would make
            -- bill.tax_minor disagree with the sum of bill_line.tax_minor,
            -- and that reconciliation is what a GST return is built on.
            --
            -- An explicit 0, not NULL. NULL already means "this item has no
            -- tax class configured", which is a setup gap somebody has to fix;
            -- 0 means "lawfully zero-rated because this position may not
            -- collect tax". taxOn treats both as no tax, but only one of them
            -- is a bug, and a report cannot tell them apart if they share a
            -- representation.
            --
            -- TWO POSITIONS, NOT ONE. An unregistered branch holds no
            -- GSTIN; a composition branch holds one and is still FORBIDDEN to
            -- collect a paisa from a diner -- it pays 5% of turnover itself.
            -- Migration 0051 has the whole argument; the question asked here
            -- is not "is there a registration" but "may this position collect
            -- tax".
            --
            -- NO BACKTICKS IN THIS COMMENT, and that is not a style choice:
            -- this SQL is a template literal, so a backtick ends the string.
            -- It broke the build in phase 8 and again in phase 11, and it
            -- broke it here too.
            -- ###############################################################
            ${TAX_RATE_RESOLUTION} AS tax_rate_bps,
            (mi.kind = 'combo') AS is_combo
       FROM app.menu_item mi
       -- An INNER join: a line cannot be priced for a branch that does not
       -- exist, and a LEFT join here would make a bad branch id resolve to a
       -- null position, which the CASE would then read as "registered".
       JOIN app.branch b ON b.tenant_id = mi.tenant_id AND b.id = $2
       LEFT JOIN app.tax_class tc ON tc.tenant_id = mi.tenant_id AND tc.id = mi.tax_class_id
       LEFT JOIN app.branch_menu_price bp
         ON bp.tenant_id = mi.tenant_id AND bp.menu_item_id = mi.id AND bp.branch_id = $2
       ${PREMISES_JOINS}
      WHERE mi.tenant_id = $1 AND mi.id = $3`,
    [context.tenantId, branchId, menuItemId],
  );

  const item = result.rows[0];
  if (!item) throw new MenuItemNotOrderableError(menuItemId, 'unknown', null);
  if (item.status !== 'active') {
    throw new MenuItemNotOrderableError(menuItemId, 'archived', null);
  }

  const verdict = await resolveAvailability(context, { branchId, menuItemId });
  if (!verdict.orderable) {
    throw new MenuItemNotOrderableError(
      menuItemId, verdict.reason ?? 'unavailable', verdict.availableFrom ?? null);
  }
  return item;
}

/**
 * Modifier deltas are resolved and bounds-checked server-side too.
 *
 * A tablet sending an option id that is not attached to the item would otherwise
 * price a delta from a group that does not apply -- and since deltas may be
 * negative ("no cheese -30"), an unattached option is a discount channel.
 */
async function resolveModifiers(
  context: TenantContext,
  menuItemId: string,
  optionIds: readonly string[],
): Promise<readonly SnapshottedModifier[]> {
  if (optionIds.length === 0) return [];

  const rows = await context.client.query<{
    option_id: string; group_id: string; name: string; price_delta_minor: string;
    min_select: number | null; max_select: number | null;
  }>(
    `SELECT mo.id AS option_id, mo.modifier_group_id AS group_id, mo.name,
            mo.price_delta_minor::text,
            -- COALESCE, not the override alone: an absent override means the
            -- group's own bound binds. Overrides may widen or narrow, since
            -- selection counts are not money.
            COALESCE(a.min_select_override, g.min_select) AS min_select,
            COALESCE(a.max_select_override, g.max_select) AS max_select
       FROM app.modifier_option mo
       JOIN app.modifier_group g
         ON g.tenant_id = mo.tenant_id AND g.id = mo.modifier_group_id
       -- The attachment is what makes the option orderable ON THIS ITEM. Without
       -- this join any tenant option could be priced onto any item.
       JOIN app.menu_item_modifier_group a
         ON a.tenant_id = mo.tenant_id AND a.modifier_group_id = mo.modifier_group_id
        AND a.menu_item_id = $3
      WHERE mo.tenant_id = $1 AND mo.id = ANY($2::uuid[]) AND mo.status = 'active'`,
    [context.tenantId, [...optionIds], menuItemId],
  );

  const found = new Map(rows.rows.map((r) => [r.option_id, r]));
  for (const id of optionIds) {
    if (!found.has(id)) throw new ModifierNotPermittedError(id, menuItemId);
  }

  const perGroup = new Map<string, { count: number; min: number | null; max: number | null }>();
  for (const row of rows.rows) {
    const entry = perGroup.get(row.group_id) ??
      { count: 0, min: row.min_select, max: row.max_select };
    entry.count += 1;
    perGroup.set(row.group_id, entry);
  }
  for (const [groupId, g] of perGroup) {
    // NULL max means "the other bound binds", not unlimited -- the same reading
    // as a NULL discount amount cap.
    if (g.max !== null && g.count > g.max) {
      throw new ModifierSelectionOutOfBoundsError(groupId, g.count, `at most ${g.max} allowed`);
    }
    if (g.min !== null && g.count < g.min) {
      throw new ModifierSelectionOutOfBoundsError(groupId, g.count, `at least ${g.min} required`);
    }
  }

  return optionIds.map((id) => {
    const row = found.get(id)!;
    return {
      optionId: row.option_id,
      groupId: row.group_id,
      name: row.name,
      priceDeltaMinor: Number(row.price_delta_minor),
    };
  });
}

async function loadOpenOrder(context: TenantContext, orderId: string): Promise<OrderRow> {
  const order = await context.client.query<OrderRow>(
    // The session's cover count travels with the order, because every line added
    // to it is checked against that number and a second query per line would be
    // a round trip per tap during a rush.
    `SELECT so.branch_id, so.business_date::text, so.status, ts.guest_count
       FROM app.sales_order so
       JOIN app.table_session ts ON ts.tenant_id = so.tenant_id AND ts.id = so.session_id
      WHERE so.tenant_id = $1 AND so.id = $2`,
    [context.tenantId, orderId],
  );
  const row = order.rows[0];
  if (!row) throw new Error(`unknown order ${orderId}`);
  if (row.status === 'closed' || row.status === 'cancelled') {
    throw new Error(`order ${orderId} is ${row.status} and takes no more lines`);
  }
  return row;
}

/**
 * Checked, not trusted. A guest number outside the covers is refused rather
 * than stored: the CHECK on the column only requires `> 0`, so guest 9 at a
 * table of four would be accepted by the database and then be unsplittable to
 * anybody -- a refusal at bill time, in front of the customer, instead of at
 * the tap.
 */
function resolveGuestNo(guestNo: number | null, guestCount: number | null): number | null {
  if (guestNo === null) return null;
  if (!Number.isInteger(guestNo) || guestNo < 1) {
    throw new GuestNoOutOfRangeError(guestNo, guestCount);
  }
  if (guestCount === null || guestNo > guestCount) {
    throw new GuestNoOutOfRangeError(guestNo, guestCount);
  }
  return guestNo;
}

export async function addLine(
  context: TenantContext,
  request: AddLineRequest,
  actorUserId: string,
): Promise<AddedLine> {
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }

  await assertTakesOrderChanges(context, { orderId: request.orderId });
  const order = await loadOpenOrder(context, request.orderId);
  const guestNo = resolveGuestNo(request.guestNo ?? null, order.guest_count);
  const item = await resolveOrderableItem(context, order.branch_id, request.menuItemId);
  const modifiers = await resolveModifiers(
    context, request.menuItemId, request.modifierOptionIds ?? []);

  const lineId = randomUUID();
  const note = request.note ?? null;

  if (item.is_combo) {
    return addComboLine(context, {
      // The COMPONENTS carry the money, so they carry the guest as well: a
      // by_guest split sums component rows, and a guest number on the parent
      // alone would split a thali to nobody.
      lineId, order, item, request, modifiers, actorUserId, note, guestNo,
    });
  }

  const { unitPrice, lineTotal } = priceSingle(item, modifiers, request.quantity);

  await context.client.query(
    `INSERT INTO app.order_line
       (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
        unit_price_minor, quantity, line_total_minor, tax_class_key, tax_rate_bps,
        modifiers, note, created_by_user_id, guest_no)
     VALUES ($1, $2, $3, $4, 'item', $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
             $13, $14, $15)`,
    [
      lineId, context.tenantId, order.branch_id, request.orderId,
      request.menuItemId,
      // Snapshotted, not referenced: items are archived rather than renamed, but
      // a legitimate display-name change must not make a reprint disagree with
      // the paper the customer is holding.
      item.name,
      unitPrice, request.quantity, lineTotal,
      item.tax_class_key, item.tax_rate_bps,
      JSON.stringify(modifiers.map((m) => ({
        option_id: m.optionId, group_id: m.groupId,
        name: m.name, price_delta_minor: m.priceDeltaMinor,
      }))),
      note, actorUserId, guestNo,
    ],
  );

  return {
    lineId, kind: 'item', displayName: item.name, quantity: request.quantity,
    unitPriceMinor: unitPrice, lineTotalMinor: lineTotal, displayTotalMinor: null,
    modifiers, componentLineIds: [],
  };
}

function priceSingle(
  item: ResolvedItem,
  modifiers: readonly SnapshottedModifier[],
  quantity: number,
): { unitPrice: number; lineTotal: number } {
  const deltaSum = modifiers.reduce((a, m) => a + m.priceDeltaMinor, 0);
  const unitPrice = Number(item.price_minor) + deltaSum;
  // The line total cannot go below zero: negative deltas are legitimate
  // ("no cheese -30"), a negative BILL LINE is not -- that would be a refund
  // with no reason code and no reference.
  if (unitPrice < 0) {
    throw new Error(
      `modifier deltas take ${item.name} below zero; that is a discount, not a modifier`);
  }
  return { unitPrice, lineTotal: unitPrice * quantity };
}

/** One taxed amount a line would put on a bill: the item itself, or each combo component. */
export interface PricedAmount {
  readonly amountMinor: number;
  readonly taxRateBps: number | null;
}

export type PriceLineRequest = Pick<AddLineRequest, 'menuItemId' | 'quantity' | 'modifierOptionIds' | 'choices'>;

/**
 * What a line WOULD be charged, through the same resolution `addLine` writes
 * with -- availability, branch price, modifiers, combo allocation, the tax rate.
 * The order screen's estimate reads this, so it cannot price a dish
 * differently from the line the order will hold.
 */
export async function priceRequestedLine(
  context: TenantContext,
  branchId: string,
  request: PriceLineRequest,
): Promise<readonly PricedAmount[]> {
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }
  const item = await resolveOrderableItem(context, branchId, request.menuItemId);
  const modifiers = await resolveModifiers(context, request.menuItemId, request.modifierOptionIds ?? []);
  if (!item.is_combo) {
    return [{ amountMinor: priceSingle(item, modifiers, request.quantity).lineTotal, taxRateBps: item.tax_rate_bps }];
  }
  const combo = await priceCombo(context, branchId, item, request, modifiers);
  return combo.components.map((c) => ({ amountMinor: c.allocated, taxRateBps: c.tax_rate_bps }));
}

export class ParcelChargeNotParcelError extends Error {
  readonly statusCode = 409;
  readonly code = 'parcel_charge_not_parcel';
  constructor(readonly orderId: string) {
    super('A parcel charge goes on a parcel order only. This order is dine-in.');
    this.name = 'ParcelChargeNotParcelError';
  }
}

export class ParcelChargeAboveMaxError extends Error {
  readonly statusCode = 422;
  readonly code = 'parcel_charge_above_max';
  constructor(readonly amountMinor: number, readonly maxMinor: number) {
    super(
      maxMinor === 0
        ? 'This branch takes no parcel charge. A manager sets one under Printed bill.'
        : 'This parcel charge is more than the most this branch allows.',
    );
    this.name = 'ParcelChargeAboveMaxError';
  }
}

export class ParcelChargeInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'parcel_charge_invalid';
  constructor() {
    super('A parcel charge is a whole number of paise, zero or more.');
    this.name = 'ParcelChargeInvalidError';
  }
}

interface ParcelChargeTerms {
  default_minor: string;
  max_minor: string;
  tax_class_key: string | null;
  tax_rate_bps: number | null;
}

/**
 * The branch's parcel-charge cap and the tax the charge takes, resolved through
 * `TAX_RATE_RESOLUTION` like every dish -- so an unregistered branch charges no
 * tax on packing either, and a specified premises takes its override.
 */
async function parcelChargeTerms(context: TenantContext, branchId: string): Promise<ParcelChargeTerms> {
  const result = await context.client.query<ParcelChargeTerms>(
    `SELECT b.parcel_charge_default_minor::text AS default_minor,
            b.parcel_charge_max_minor::text AS max_minor,
            tc.key AS tax_class_key,
            ${TAX_RATE_RESOLUTION} AS tax_rate_bps
       FROM app.branch b
       LEFT JOIN app.tax_class tc ON tc.tenant_id = b.tenant_id AND tc.id = b.parcel_charge_tax_class_id
       ${PREMISES_JOINS}
      WHERE b.tenant_id = $1 AND b.id = $2`,
    [context.tenantId, branchId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`unknown branch ${branchId}`);
  return row;
}

/** Refused unless 0 <= amount <= the branch's cap. */
function checkParcelCharge(amountMinor: number, terms: ParcelChargeTerms): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new ParcelChargeInvalidError();
  if (amountMinor > Number(terms.max_minor)) {
    throw new ParcelChargeAboveMaxError(amountMinor, Number(terms.max_minor));
  }
}

/**
 * The charge as the estimate prices it: the same cap, the same rate the line
 * will snapshot. No amount means the branch's default -- what the till fills in.
 */
export async function priceParcelCharge(
  context: TenantContext,
  branchId: string,
  amountMinor: number | null,
): Promise<{ charge: PricedAmount | null; defaultMinor: number; maxMinor: number }> {
  const terms = await parcelChargeTerms(context, branchId);
  const amount = amountMinor ?? Number(terms.default_minor);
  checkParcelCharge(amount, terms);
  return {
    charge: amount === 0 ? null : { amountMinor: amount, taxRateBps: terms.tax_rate_bps },
    defaultMinor: Number(terms.default_minor),
    maxMinor: Number(terms.max_minor),
  };
}

export class ParcelChargeAfterPaymentError extends Error {
  readonly statusCode = 409;
  readonly code = 'parcel_charge_after_payment';
  constructor(readonly sessionId: string) {
    super('Money has been taken on this bill, so its parcel charge can no longer change.');
    this.name = 'ParcelChargeAfterPaymentError';
  }
}

/**
 * Set or clear (0) a parcel order's charge, until money is taken.
 *
 * One `charge` line per order, UPDATED in place rather than replaced: once a
 * bill has been made, its voided `bill_line` still references the line, and
 * that reference is a record (ON DELETE RESTRICT). Clearing therefore sets 0,
 * which no bill ever carries.
 *
 * With Billing already, an UNPAID bill is a snapshot of the old charge, so it
 * is voided -- the same step `cancelOrder` takes -- and the till makes the bill
 * again. Once any money is in, the charge is part of what was paid against and
 * is refused; the refund path is where that is undone.
 */
export async function setParcelCharge(
  context: TenantContext,
  params: { orderId: string; amountMinor: number },
  actorUserId: string,
): Promise<{ orderId: string; amountMinor: number; lineId: string | null; billsVoided: number }> {
  // The session first, the head of the documented lock order.
  const found = await context.client.query<{ id: string; stage: string; status: string; service_type: string }>(
    `SELECT s.id, s.stage, s.status, s.service_type
       FROM app.table_session s
       JOIN app.sales_order so ON so.tenant_id = s.tenant_id AND so.session_id = s.id
      WHERE s.tenant_id = $1 AND so.id = $2
        FOR UPDATE OF s`,
    [context.tenantId, params.orderId],
  );
  const session = found.rows[0];
  if (session?.status !== 'open') throw new SessionNotOpenError(session?.id ?? params.orderId);
  if (session.service_type !== 'parcel') throw new ParcelChargeNotParcelError(params.orderId);
  const order = await loadOpenOrder(context, params.orderId);

  const terms = await parcelChargeTerms(context, order.branch_id);
  checkParcelCharge(params.amountMinor, terms);

  let billsVoided = 0;
  if (session.stage === 'billing') {
    // Net, because a void tender is a negative row: captured-then-voided is no money in.
    const money = await context.client.query<{ settled: boolean | null; paid: string }>(
      `SELECT bool_or(b.status = 'settled') AS settled,
              COALESCE((SELECT sum(t.amount_minor)
                          FROM app.tender t
                          JOIN app.bill tb ON tb.tenant_id = t.tenant_id AND tb.id = t.bill_id
                         WHERE t.tenant_id = $1 AND tb.session_id = $2 AND tb.status <> 'void'), 0)::text AS paid
         FROM app.bill b
        WHERE b.tenant_id = $1 AND b.session_id = $2 AND b.status <> 'void'`,
      [context.tenantId, session.id],
    );
    if (money.rows[0]?.settled === true || Number(money.rows[0]?.paid ?? 0) !== 0) {
      throw new ParcelChargeAfterPaymentError(session.id);
    }
    const voided = await context.client.query(
      `UPDATE app.bill SET status = 'void', version = version + 1
        WHERE tenant_id = $1 AND session_id = $2 AND status = 'open'`,
      [context.tenantId, session.id],
    );
    billsVoided = voided.rowCount ?? 0;
  }

  const existing = await context.client.query<{ id: string }>(
    `SELECT id FROM app.order_line
      WHERE tenant_id = $1 AND order_id = $2 AND kind = 'charge' FOR UPDATE`,
    [context.tenantId, params.orderId],
  );
  const current = existing.rows[0]?.id ?? null;
  if (current !== null) {
    await context.client.query(
      `UPDATE app.order_line
          SET unit_price_minor = $3, line_total_minor = $3, tax_class_key = $4, tax_rate_bps = $5
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, current, params.amountMinor, terms.tax_class_key, terms.tax_rate_bps],
    );
    return { orderId: params.orderId, amountMinor: params.amountMinor, lineId: current, billsVoided };
  }
  if (params.amountMinor === 0) return { orderId: params.orderId, amountMinor: 0, lineId: null, billsVoided };

  const lineId = randomUUID();
  await context.client.query(
    `INSERT INTO app.order_line
       (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
        line_total_minor, tax_class_key, tax_rate_bps, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'charge', 'Parcel charge', $5, 1, $5, $6, $7, $8)`,
    [lineId, context.tenantId, order.branch_id, params.orderId, params.amountMinor,
     terms.tax_class_key, terms.tax_rate_bps, actorUserId],
  );
  return { orderId: params.orderId, amountMinor: params.amountMinor, lineId, billsVoided };
}

/**
 * A combo's choice groups, resolved against what the customer actually picked.
 *
 * The bounds are enforced here rather than trusted: an unselected required group
 * would produce a combo missing a component, and the deferred allocation trigger
 * would then abort the whole order at COMMIT with a message about a sum, which
 * tells the waiter nothing about the missing drink.
 */
async function resolveComboChoices(
  context: TenantContext,
  branchId: string,
  comboItemId: string,
  choices: readonly { choiceGroupId: string; menuItemId: string }[],
): Promise<readonly {
  component_id: string; menu_item_id: string; name: string; quantity: number;
  list_price_minor: string; tax_class_key: string | null; tax_rate_bps: number | null;
  display_order: number;
}[]> {
  const groups = await context.client.query<{
    component_id: string; choice_group_id: string; quantity: number;
    min_select: number; max_select: number | null; display_order: number;
  }>(
    `SELECT cc.id AS component_id, cc.choice_group_id, cc.quantity,
            g.min_select, g.max_select, cc.display_order
       FROM app.combo_component cc
       JOIN app.combo_choice_group g
         ON g.tenant_id = cc.tenant_id AND g.id = cc.choice_group_id
      WHERE cc.tenant_id = $1 AND cc.combo_item_id = $2 AND cc.kind = 'choice'
      ORDER BY cc.display_order, cc.id`,
    [context.tenantId, comboItemId],
  );
  if (groups.rows.length === 0) return [];

  const out: {
    component_id: string; menu_item_id: string; name: string; quantity: number;
    list_price_minor: string; tax_class_key: string | null; tax_rate_bps: number | null;
    display_order: number;
  }[] = [];

  for (const group of groups.rows) {
    const picked = choices.filter((c) => c.choiceGroupId === group.choice_group_id);
    if (picked.length < group.min_select) {
      throw new ComboChoiceRequiredError(
        group.choice_group_id, `${picked.length} chosen, at least ${group.min_select} required`);
    }
    if (group.max_select !== null && picked.length > group.max_select) {
      throw new ComboChoiceRequiredError(
        group.choice_group_id, `${picked.length} chosen, at most ${group.max_select} allowed`);
    }

    for (const choice of picked) {
      const option = await context.client.query<{
        name: string; list_price_minor: string;
        tax_class_key: string | null; tax_rate_bps: number | null;
      }>(
        // The option row is what makes this item choosable IN THIS GROUP. Its
        // price_delta_minor rides on top of the item's list price and is part of
        // the allocation basis, not a discount.
        `SELECT mi.name,
                (COALESCE(bp.price_minor, mi.price_minor) + o.price_delta_minor)::text
                  AS list_price_minor,
                tc.key AS tax_class_key,
                -- The same suppression as the single-item path. A combo's
                -- COMPONENTS carry the money and therefore the tax, so a
                -- suppression that reached only resolveOrderableItem would
                -- leave every thali at an unregistered branch fully taxed.
                ${TAX_RATE_RESOLUTION} AS tax_rate_bps
           FROM app.combo_choice_option o
           JOIN app.menu_item mi
             ON mi.tenant_id = o.tenant_id AND mi.id = o.component_item_id
           JOIN app.branch b ON b.tenant_id = o.tenant_id AND b.id = $4
           LEFT JOIN app.tax_class tc ON tc.tenant_id = mi.tenant_id AND tc.id = mi.tax_class_id
           LEFT JOIN app.branch_menu_price bp
             ON bp.tenant_id = mi.tenant_id AND bp.menu_item_id = mi.id AND bp.branch_id = $4
           ${PREMISES_JOINS}
          WHERE o.tenant_id = $1 AND o.choice_group_id = $2 AND o.component_item_id = $3
            AND mi.status = 'active'`,
        [context.tenantId, group.choice_group_id, choice.menuItemId, branchId],
      );
      const row = option.rows[0];
      if (!row) {
        throw new ComboChoiceRequiredError(
          group.choice_group_id, `${choice.menuItemId} is not an option in this group`);
      }
      out.push({
        // Distinct per selection: two picks from one group are two components,
        // and the allocator keys on this id.
        component_id: `${group.component_id}:${choice.menuItemId}`,
        menu_item_id: choice.menuItemId,
        name: row.name,
        quantity: group.quantity,
        list_price_minor: row.list_price_minor,
        tax_class_key: row.tax_class_key,
        tax_rate_bps: row.tax_rate_bps,
        display_order: group.display_order,
      });
    }
  }
  return out;
}

/**
 * A combo writes a money-less parent over priced components.
 *
 * The bill DISPLAYS one line; the GST return READS the components. One priced
 * line with non-priced children is not an option: the allocation would have to
 * be recomputed at return time from live catalogue prices, which violates the
 * priced-document rule and produces a return that disagrees with the bill it
 * came from.
 */
async function addComboLine(
  context: TenantContext,
  args: {
    lineId: string; order: OrderRow; item: ResolvedItem; request: AddLineRequest;
    modifiers: readonly SnapshottedModifier[]; actorUserId: string; note: string | null;
    guestNo: number | null;
  },
): Promise<AddedLine> {
  const { lineId, order, item, request, modifiers, actorUserId, note, guestNo } = args;
  const { displayTotal, components } = await priceCombo(context, order.branch_id, item, request, modifiers);

  await context.client.query(
    `INSERT INTO app.order_line
       (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
        quantity, display_total_minor, modifiers, note, created_by_user_id, guest_no)
     VALUES ($1, $2, $3, $4, 'combo_parent', $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
    [
      lineId, context.tenantId, order.branch_id, request.orderId, request.menuItemId,
      item.name, request.quantity, displayTotal,
      JSON.stringify(modifiers.map((m) => ({
        option_id: m.optionId, group_id: m.groupId,
        name: m.name, price_delta_minor: m.priceDeltaMinor,
      }))),
      note, actorUserId, guestNo,
    ],
  );

  const componentLineIds: string[] = [];
  for (const component of components) {
    const componentLineId = randomUUID();
    const { allocated, quantity } = component;
    componentLineIds.push(componentLineId);
    await context.client.query(
      `INSERT INTO app.order_line
         (id, tenant_id, branch_id, order_id, kind, parent_line_id, menu_item_id,
          display_name, unit_price_minor, quantity, line_total_minor,
          tax_class_key, tax_rate_bps, created_by_user_id, guest_no)
       VALUES ($1, $2, $3, $4, 'combo_component', $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14)`,
      [
        componentLineId, context.tenantId, order.branch_id, request.orderId,
        lineId, component.menu_item_id, component.name,
        // Per-unit is the allocation divided back out; the ALLOCATED TOTAL is
        // the authority and the unit price is derived from it, never the reverse.
        // Deriving the total from a rounded unit price is how the components
        // stop summing to the parent.
        Math.trunc(allocated / quantity), quantity, allocated,
        component.tax_class_key, component.tax_rate_bps, actorUserId, guestNo,
      ],
    );
  }

  return {
    lineId, kind: 'combo_parent', displayName: item.name, quantity: request.quantity,
    unitPriceMinor: null, lineTotalMinor: null, displayTotalMinor: displayTotal,
    modifiers, componentLineIds,
  };
}

/** A combo's components and their allocated share of its price, written by `addComboLine` and estimated by `priceRequestedLine`. */
async function priceCombo(
  context: TenantContext,
  branchId: string,
  item: ResolvedItem,
  request: PriceLineRequest,
  modifiers: readonly SnapshottedModifier[],
): Promise<{
  displayTotal: number;
  components: readonly {
    menu_item_id: string; name: string; tax_class_key: string | null; tax_rate_bps: number | null;
    quantity: number; allocated: number;
  }[];
}> {
  const fixed = await context.client.query<{
    component_id: string; menu_item_id: string; name: string; quantity: number;
    list_price_minor: string; tax_class_key: string | null; tax_rate_bps: number | null;
    display_order: number;
  }>(
    `SELECT cc.id AS component_id, cc.component_item_id AS menu_item_id, mi.name,
            cc.quantity, COALESCE(bp.price_minor, mi.price_minor)::text AS list_price_minor,
            tc.key AS tax_class_key,
            ${TAX_RATE_RESOLUTION} AS tax_rate_bps, cc.display_order
       FROM app.combo_component cc
       JOIN app.menu_item mi ON mi.tenant_id = cc.tenant_id AND mi.id = cc.component_item_id
       JOIN app.branch b ON b.tenant_id = cc.tenant_id AND b.id = $2
       LEFT JOIN app.tax_class tc ON tc.tenant_id = mi.tenant_id AND tc.id = mi.tax_class_id
       LEFT JOIN app.branch_menu_price bp
         ON bp.tenant_id = mi.tenant_id AND bp.menu_item_id = mi.id AND bp.branch_id = $2
       ${PREMISES_JOINS}
      WHERE cc.tenant_id = $1 AND cc.combo_item_id = $3 AND cc.kind = 'fixed'
      ORDER BY cc.display_order, cc.id`,
    [context.tenantId, branchId, request.menuItemId],
  );

  const chosen = await resolveComboChoices(
    context, branchId, request.menuItemId, request.choices ?? []);

  const components = { rows: [...fixed.rows, ...chosen] };

  const deltaSum = modifiers.reduce((a, m) => a + m.priceDeltaMinor, 0);
  const comboUnitPrice = Number(item.price_minor) + deltaSum;
  const displayTotal = comboUnitPrice * request.quantity;

  // Ties broken by display_order, so the allocation is deterministic and a
  // reprint distributes the remainder the same way it did the first time.
  const allocation = allocateComboPrice(
    displayTotal,
    components.rows.map((c) => ({
      componentId: c.component_id,
      listPriceMinor: Number(c.list_price_minor),
      quantity: c.quantity * request.quantity,
    })),
  );
  if (!allocationBalances(displayTotal, allocation)) {
    throw new Error('combo allocation does not balance');
  }

  const byId = new Map(allocation.map((a) => [a.componentId, a.allocatedMinor]));
  return {
    displayTotal,
    components: components.rows.map((c) => ({
      menu_item_id: c.menu_item_id, name: c.name,
      tax_class_key: c.tax_class_key, tax_rate_bps: c.tax_rate_bps,
      quantity: c.quantity * request.quantity,
      allocated: byId.get(c.component_id)!,
    })),
  };
}

/**
 * Pre-fire correction MUTATES the line. Post-fire does not.
 *
 * The justification is not that a pre-fire change is cheap. It is that the
 * exception report's value is inversely proportional to the noise in it: force
 * typo corrections into void rows and every waiter generates a dozen "voids" a
 * shift, nobody reads the report within a week, and the actual fraud sits in it
 * unnoticed.
 *
 * `fired_at IS NULL` is the gate. A BEFORE UPDATE trigger enforces it in the
 * database -- this check exists so the caller gets a named error instead of a
 * raw trigger message, not because the trigger is optional.
 */
export async function editLine(
  context: TenantContext,
  params: { lineId: string; quantity?: number; note?: string | null },
): Promise<void> {
  await assertTakesOrderChanges(context, { lineId: params.lineId });
  const existing = await context.client.query<{ fired_at: string | null; unit_price_minor: string | null; kind: string }>(
    `SELECT fired_at::text, unit_price_minor::text, kind
       FROM app.order_line WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, params.lineId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`unknown order line ${params.lineId}`);
  if (row.fired_at !== null) throw new LineAlreadyFiredError(params.lineId);

  if (params.quantity !== undefined) {
    if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
      throw new Error('quantity must be a positive integer; removing a line is removeLine');
    }
    if (row.kind === 'combo_parent') {
      await reallocateCombo(context, params.lineId, params.quantity);
    } else {
      // The unit price is NOT re-resolved. It was snapshotted when the line was
      // written, and a catalogue change between then and now must not move the
      // price of a line the waiter is merely correcting the count on.
      await context.client.query(
        `UPDATE app.order_line
            SET quantity = $3::int, line_total_minor = unit_price_minor * $3::int
          WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, params.lineId, params.quantity],
      );
    }
  }
  if (params.note !== undefined) {
    await context.client.query(
      `UPDATE app.order_line SET note = $3 WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, params.lineId, params.note],
    );
  }
}

/**
 * Changing a combo's quantity RE-ALLOCATES its components.
 *
 * Scaling the parent's display total without re-allocating breaks the deferred
 * allocation trigger at COMMIT -- correctly, because integer division on the old
 * total loses the remainder the largest-remainder allocator exists to place. The
 * failure would be a transaction that aborts on every combo quantity edit, which
 * reads as a bug in the trigger rather than in the caller.
 *
 * The parent's per-unit price divides exactly (it was built as unit * quantity),
 * so re-deriving it here is not a rounding step; the allocation over components
 * is where the rounding lives, and it is redone in full.
 */
async function reallocateCombo(
  context: TenantContext,
  parentLineId: string,
  newQuantity: number,
): Promise<void> {
  const parent = await context.client.query<{ display_total_minor: string; quantity: number }>(
    `SELECT display_total_minor::text, quantity FROM app.order_line
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, parentLineId],
  );
  const parentRow = parent.rows[0]!;
  const unit = Number(parentRow.display_total_minor) / parentRow.quantity;
  const displayTotal = unit * newQuantity;

  const components = await context.client.query<{
    id: string; unit_price_minor: string; quantity: number;
  }>(
    `SELECT id, unit_price_minor::text, quantity FROM app.order_line
      WHERE tenant_id = $1 AND parent_line_id = $2
      ORDER BY created_at, id FOR UPDATE`,
    [context.tenantId, parentLineId],
  );

  const perCombo = components.rows.map((c) => ({
    id: c.id,
    // Per-unit-of-combo quantity, recovered from the previous scaling.
    quantity: (c.quantity / parentRow.quantity) * newQuantity,
    listPriceMinor: Number(c.unit_price_minor),
  }));

  const allocation = allocateComboPrice(
    displayTotal,
    perCombo.map((c) => ({
      componentId: c.id, listPriceMinor: c.listPriceMinor, quantity: c.quantity,
    })),
  );
  if (!allocationBalances(displayTotal, allocation)) {
    throw new Error('combo re-allocation does not balance');
  }

  await context.client.query(
    `UPDATE app.order_line SET quantity = $3, display_total_minor = $4
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, parentLineId, newQuantity, displayTotal],
  );

  const byId = new Map(allocation.map((a) => [a.componentId, a.allocatedMinor]));
  for (const component of perCombo) {
    const allocated = byId.get(component.id)!;
    await context.client.query(
      `UPDATE app.order_line
          SET quantity = $3, line_total_minor = $4, unit_price_minor = $5
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, component.id, component.quantity, allocated,
       Math.trunc(allocated / component.quantity)],
    );
  }
}

export async function removeLine(context: TenantContext, lineId: string): Promise<void> {
  await assertTakesOrderChanges(context, { lineId });
  const existing = await context.client.query<{ fired_at: string | null; kind: string }>(
    `SELECT fired_at::text, kind FROM app.order_line
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, lineId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`unknown order line ${lineId}`);
  if (row.fired_at !== null) throw new LineAlreadyFiredError(lineId);

  // A combo parent takes its components with it. Deleting the parent alone would
  // leave orphaned components that still sum to a total nothing displays.
  await context.client.query(
    `DELETE FROM app.order_line
      WHERE tenant_id = $1 AND (id = $2 OR parent_line_id = $2)`,
    [context.tenantId, lineId],
  );
}
