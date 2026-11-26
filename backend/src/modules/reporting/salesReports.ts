import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Sales reporting.
 *
 * ###########################################################################
 * BUSINESS DATE, NEVER CALENDAR DATE.
 *
 * A restaurant's day ends at 3am. A report that splits Friday night at midnight
 * is wrong in a way that will be reported as a bug forever, and every argument
 * about "the numbers don't match" starts here. `sales_order.business_date` was
 * stamped at open from the branch timezone and day start; nothing in this module
 * touches occurred_at or now().
 * ###########################################################################
 *
 * Every figure is read from the order line's own snapshot. No catalogue price, no
 * current tax rate, no live recipe -- asserted mechanically by the snapshot-only
 * scanner, which was written before this file existed.
 */

export type SalesDimension = 'item' | 'category' | 'station' | 'hour' | 'staff' | 'branch';

export interface SalesRow {
  readonly key: string;
  readonly label: string;
  /**
   * ######################################################################
   * TWO DIFFERENT QUESTIONS, KEPT DIFFERENT.
   *
   * `quantityMade` counts what the kitchen PRODUCED; `quantitySold` counts
   * what was CHARGED FOR.
   *
   * A COMP is quantity 0 with money < 0 -- delivered, free -- so it is made
   * and contributes nothing to sold, by construction rather than by a filter.
   * A VOID is quantity < 0 and is POST-FIRE by definition, so the dish was
   * cooked and then written off: it counts as made and reduces sold.
   *
   * That distinction was built into the sign convention in Phase 3 and this
   * is where it pays off.
   * ######################################################################
   */
  readonly quantityMade: number;
  readonly quantitySold: number;
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly compMinor: number;
  readonly voidMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
}

export interface SalesParams {
  readonly branchId?: string | null;
  readonly fromDate: string;
  readonly toDate: string;
}

/**
 * The shared projection.
 *
 * `combo_parent` rows carry no money -- they exist to display one line -- so they
 * are excluded from every money sum. `combo_component` rows carry the ALLOCATED
 * price, which is why a thali's lassi reaches the beverage category at its
 * allocated value rather than at zero or at the whole combo price.
 */
const LINE_SOURCE = `
  FROM app.order_line ol
  JOIN app.sales_order so
    ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
  LEFT JOIN app.menu_item mi
    ON mi.tenant_id = ol.tenant_id AND mi.id = ol.menu_item_id
  LEFT JOIN app.menu_category mc
    ON mc.tenant_id = mi.tenant_id AND mc.id = mi.category_id
 WHERE ol.tenant_id = $1
   AND so.status <> 'cancelled'
   AND so.business_date BETWEEN $2::date AND $3::date
   AND ($4::uuid IS NULL OR ol.branch_id = $4::uuid)
   -- An allowlist: these reports are the dishes. A combo parent carries no
   -- money, and a parcel charge (0081) is not a dish -- it is in the summary's
   -- net, not in any item, category or station row.
   AND ol.kind IN ('item', 'combo_component', 'void', 'comp', 'discount')`;

/**
 * A line's money WITHOUT tax, and its tax (0083). On an order priced with tax
 * included (`sales_order.prices_include_tax`, snapshotted when it was opened)
 * the line total holds the tax, found inside it at the line's own snapshotted
 * rate -- the rule `lineTax` applies on the bill -- so sales are ex-tax under
 * either mode and a reverse-mode restaurant's sales never include its tax.
 */
const LINE_TAX = `CASE WHEN so.prices_include_tax
    THEN round(COALESCE(ol.line_total_minor, 0)::numeric * COALESCE(ol.tax_rate_bps, 0)
               / (10000 + COALESCE(ol.tax_rate_bps, 0)))
    ELSE round(COALESCE(ol.line_total_minor, 0)::numeric * COALESCE(ol.tax_rate_bps, 0) / 10000) END`;
const LINE_NET = `(COALESCE(ol.line_total_minor, 0)
    - CASE WHEN so.prices_include_tax THEN ${LINE_TAX} ELSE 0 END)`;

const MEASURES = `
  -- What the kitchen PRODUCED. Voids are excluded, not subtracted: order.void is
  -- POST-FIRE by definition -- the pre-fire correction mutates the line and never
  -- becomes a row at all -- so a voided dish was cooked and then written off. It
  -- counts as made and not as sold, which is the whole reason the two figures are
  -- reported separately.
  SUM(ol.quantity) FILTER (WHERE ol.kind IN ('item', 'combo_component'))::text
    AS quantity_made,
  -- What was charged for. A comp contributes nothing here BY CONSTRUCTION,
  -- because its quantity is zero.
  SUM(ol.quantity)::text AS quantity_sold,
  COALESCE(SUM(${LINE_NET}) FILTER (
    WHERE ol.kind IN ('item', 'combo_component')), 0)::text AS gross_minor,
  COALESCE(SUM(${LINE_NET}) FILTER (WHERE ol.kind = 'discount'), 0)::text
    AS discount_minor,
  COALESCE(SUM(${LINE_NET}) FILTER (WHERE ol.kind = 'comp'), 0)::text AS comp_minor,
  COALESCE(SUM(${LINE_NET}) FILTER (WHERE ol.kind = 'void'), 0)::text AS void_minor,
  COALESCE(SUM(${LINE_NET}), 0)::text AS net_minor,
  -- Tax from the LINE's own snapshotted rate, never a current rate.
  COALESCE(SUM(${LINE_TAX}), 0)::text AS tax_minor`;

const DIMENSIONS: Record<SalesDimension, { key: string; label: string; join: string }> = {
  // The label comes from the ITEM, not the line. An adjustment line's
  // display_name reads "Biryani void", so grouping on it splits one item into
  // three rows that share a key -- and a caller looking up by key silently gets
  // whichever one sorted first.
  item: {
    key: 'COALESCE(ol.menu_item_id::text, ol.display_name)',
    label: 'COALESCE(mi.name, ol.display_name)',
    join: '',
  },
  category: { key: "COALESCE(mc.id::text, 'uncategorised')", label: "COALESCE(mc.name, 'Uncategorised')", join: '' },
  station: { key: "COALESCE(mi.station_code, 'unrouted')", label: "COALESCE(mi.station_code, 'Unrouted')", join: '' },
  // Business date first, then hour within it -- an hour column alone would merge
  // 8pm Friday with 8pm Saturday.
  hour: {
    key: "so.business_date::text || ' ' || lpad(extract(hour FROM ol.created_at)::text, 2, '0')",
    label: "so.business_date::text || ' ' || lpad(extract(hour FROM ol.created_at)::text, 2, '0') || ':00'",
    join: '',
  },
  staff: { key: 'ol.created_by_user_id::text', label: "COALESCE(u.full_name, 'Unknown')", join: `
  LEFT JOIN app.app_user u ON u.tenant_id = ol.tenant_id AND u.id = ol.created_by_user_id` },
  branch: { key: 'ol.branch_id::text', label: 'b.name', join: `
  LEFT JOIN app.branch b ON b.tenant_id = ol.tenant_id AND b.id = ol.branch_id` },
};

export async function salesBy(
  context: TenantContext,
  dimension: SalesDimension,
  params: SalesParams,
): Promise<readonly SalesRow[]> {
  const dim = DIMENSIONS[dimension];

  const result = await context.client.query<{
    key: string; label: string; quantity_made: string | null; quantity_sold: string | null;
    gross_minor: string; discount_minor: string; comp_minor: string; void_minor: string;
    net_minor: string; tax_minor: string;
  }>(
    `SELECT ${dim.key} AS key, ${dim.label} AS label, ${MEASURES}
     ${LINE_SOURCE.replace(' WHERE', `${dim.join}\n WHERE`)}
     GROUP BY 1, 2
     ORDER BY 2`,
    [context.tenantId, params.fromDate, params.toDate, params.branchId ?? null],
  );

  return result.rows.map((r) => ({
    key: r.key,
    label: r.label,
    quantityMade: Number(r.quantity_made ?? 0),
    quantitySold: Number(r.quantity_sold ?? 0),
    grossMinor: Number(r.gross_minor),
    discountMinor: Number(r.discount_minor),
    compMinor: Number(r.comp_minor),
    voidMinor: Number(r.void_minor),
    netMinor: Number(r.net_minor),
    taxMinor: Number(r.tax_minor),
  }));
}

export interface SalesSummary {
  readonly fromDate: string;
  readonly toDate: string;
  readonly orders: number;
  readonly coversServed: number;
  readonly netMinor: number;
  readonly averageTicketMinor: number;
}

export async function salesSummary(
  context: TenantContext,
  params: SalesParams,
): Promise<SalesSummary> {
  const result = await context.client.query<{
    orders: string; covers: string; net_minor: string;
  }>(
    `SELECT count(DISTINCT so.id)::text AS orders,
            COALESCE(sum(DISTINCT ts.guest_count), 0)::text AS covers,
            COALESCE(sum(${LINE_NET}) FILTER (WHERE ol.id IS NOT NULL), 0)::text AS net_minor
       FROM app.sales_order so
       JOIN app.table_session ts ON ts.tenant_id = so.tenant_id AND ts.id = so.session_id
       LEFT JOIN app.order_line ol
         ON ol.tenant_id = so.tenant_id AND ol.order_id = so.id AND ol.kind <> 'combo_parent'
      WHERE so.tenant_id = $1
        AND so.status <> 'cancelled'
        AND so.business_date BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR so.branch_id = $4::uuid)`,
    [context.tenantId, params.fromDate, params.toDate, params.branchId ?? null],
  );

  const row = result.rows[0]!;
  const orders = Number(row.orders);
  const net = Number(row.net_minor);
  return {
    fromDate: params.fromDate,
    toDate: params.toDate,
    orders,
    coversServed: Number(row.covers),
    netMinor: net,
    averageTicketMinor: orders > 0 ? Math.round(net / orders) : 0,
  };
}

/**
 * Payment mix: what the money arrived as.
 *
 * ###########################################################################
 * NOT A `SalesDimension`, AND THAT IS THE DECISION, NOT AN OVERSIGHT.
 *
 * Everything above projects `app.order_line`: quantity made, quantity sold,
 * gross, discount, comp, void, tax-from-the-line's-own-rate. A tender has none
 * of those. Adding 'payment' to `SalesDimension` would have returned `SalesRow`
 * with six of its eight fields sitting at zero -- a shape that reads as "no
 * discounts on cash sales" rather than "this question has no discounts in it".
 *
 * The two also disagree about WHAT they measure, which is the deeper reason:
 * order lines are what was ORDERED, tenders are what was COLLECTED, and on any
 * given day they differ by the unsettled bills. A caller who could ask for
 * `salesBy('payment')` would reasonably expect the totals to match
 * `salesBy('item')`, and they never will.
 * ###########################################################################
 *
 * ###########################################################################
 * A VOID IS A NEGATIVE ROW, SO `collectedMinor` NEEDS NO FILTER.
 *
 * `tender_shape_exact` requires `amount_minor > 0` for a capture and, for a
 * void, a negative amount naming the tender it reverses. So the sum over both
 * kinds IS the money in the drawer -- the same property that made the bill's
 * `paid_minor` safe, and the reason a filtered version of this query would be a
 * new way to get it wrong.
 *
 * The voided figure is reported SEPARATELY rather than only netted, because a
 * method with heavy void traffic is a leakage signal and netting hides it: two
 * ₹5,000 cash captures with one ₹5,000 void looks identical to one ₹5,000
 * capture until you count the reversals.
 * ###########################################################################
 */
export interface PaymentMixRow {
  readonly method: string;
  /** Captures plus voids. The money actually taken. */
  readonly collectedMinor: number;
  readonly capturedMinor: number;
  readonly voidedMinor: number;
  readonly captureCount: number;
  readonly voidCount: number;
  /** Taken outside the system and keyed in afterwards. Needs an authoriser. */
  readonly manualCount: number;
}

export async function paymentMix(
  context: TenantContext,
  params: SalesParams,
): Promise<readonly PaymentMixRow[]> {
  const result = await context.client.query<{
    method: string; collected_minor: string; captured_minor: string;
    voided_minor: string; capture_count: string; void_count: string; manual_count: string;
  }>(
    // Business date from the BILL, not from `tendered_at`: a bill settled at 2am
    // belongs to the night that made it, and the whole module's first rule is
    // that nothing here reads a wall clock.
    `SELECT t.method,
            COALESCE(SUM(t.amount_minor), 0)::text AS collected_minor,
            COALESCE(SUM(t.amount_minor) FILTER (WHERE t.kind = 'capture'), 0)::text
              AS captured_minor,
            COALESCE(SUM(t.amount_minor) FILTER (WHERE t.kind = 'void'), 0)::text
              AS voided_minor,
            COUNT(*) FILTER (WHERE t.kind = 'capture')::text AS capture_count,
            COUNT(*) FILTER (WHERE t.kind = 'void')::text AS void_count,
            COUNT(*) FILTER (WHERE t.settled_offline_manually)::text AS manual_count
       FROM app.tender t
       JOIN app.bill b ON b.tenant_id = t.tenant_id AND b.id = t.bill_id
      WHERE t.tenant_id = $1
        AND b.status <> 'void'
        AND b.business_date BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR b.branch_id = $4::uuid)
      GROUP BY t.method
      -- Ordered by the SUM, not by the aliased column. ORDER BY 2 DESC sorted
      -- the ::text cast LEXICOGRAPHICALLY, so 399 came before 2562 and the
      -- payment list on the dashboard was in no order at all. Visible only by
      -- looking at the rendered screen: every test asserted per-method figures,
      -- which were right, and none asserted the sequence.
      ORDER BY SUM(t.amount_minor) DESC`,
    [context.tenantId, params.fromDate, params.toDate, params.branchId ?? null],
  );

  return result.rows.map((r) => ({
    method: r.method,
    collectedMinor: Number(r.collected_minor),
    capturedMinor: Number(r.captured_minor),
    voidedMinor: Number(r.voided_minor),
    captureCount: Number(r.capture_count),
    voidCount: Number(r.void_count),
    manualCount: Number(r.manual_count),
  }));
}

/**
 * The same summary for the period before, so a tile can say "up 12%".
 *
 * ###########################################################################
 * A DELTA WITH NO BASELINE IS NULL, NOT ZERO, AND NOT INFINITY.
 *
 * Percentage change against a previous period of zero has no value. The two
 * wrong answers are both worse than absence: 0% reads as "flat" on the first
 * day a branch ever trades, and Infinity reaches the screen as "∞%" or, after a
 * `toFixed`, as the string "Infinity%".
 *
 * So each field is `number | null` and null means NO BASELINE. The dashboard
 * renders that as "no comparison" -- the same discipline as `Remote`: absence is
 * never a discriminator, and it is never rounded into a number.
 *
 * The window is computed HERE rather than by the caller. "The previous period"
 * means one of the same length ending the day before this one starts, and the
 * inclusive-date arithmetic is off by one the first time everybody writes it.
 * ###########################################################################
 */
export interface SalesDelta {
  readonly ordersPct: number | null;
  readonly netPct: number | null;
  readonly averageTicketPct: number | null;
  readonly coversPct: number | null;
}

export interface SalesComparison {
  readonly current: SalesSummary;
  /** Null when no comparison window was asked for. */
  readonly previous: SalesSummary | null;
  readonly delta: SalesDelta | null;
}

/** Same length, ending the day before `fromDate`. Inclusive at both ends. */
export function previousWindow(
  fromDate: string, toDate: string,
): { fromDate: string; toDate: string } {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return {
    fromDate: prevFrom.toISOString().slice(0, 10),
    toDate: prevTo.toISOString().slice(0, 10),
  };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function salesSummaryCompared(
  context: TenantContext,
  params: SalesParams,
  compare: { fromDate: string; toDate: string } | null,
): Promise<SalesComparison> {
  const current = await salesSummary(context, params);
  if (!compare) return { current, previous: null, delta: null };

  const previous = await salesSummary(context, { ...params, ...compare });
  return {
    current,
    previous,
    delta: {
      ordersPct: pctChange(current.orders, previous.orders),
      netPct: pctChange(current.netMinor, previous.netMinor),
      averageTicketPct: pctChange(current.averageTicketMinor, previous.averageTicketMinor),
      coversPct: pctChange(current.coversServed, previous.coversServed),
    },
  };
}
