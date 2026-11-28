import type { TenantContext } from '../../database/tenantContext.js';
import { resolveAvailabilityForBranch } from './availability.js';

/**
 * The menu as a POS screen needs it: one row per item, availability already
 * decided, and a version stamp the tablet can compare its cache against.
 *
 * ###########################################################################
 * ONE IMPLEMENTATION, TWO CALLERS, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 *
 * `readBoard` needs this, and so does `GET /pos/menu` -- the standalone read a
 * tablet uses to refresh a cached menu without opening a session. Written twice
 * they would answer differently the first time a precedence rule changed, and
 * the tablet would show one answer while the write path enforced the other.
 * That already happened once inside the board itself: a hand-rolled copy of the
 * precedence dropped `days_of_week`, so a weekday-only item read as available on
 * a Sunday.
 * ###########################################################################
 */

export interface MenuRead {
  /** Precedence already applied, with the reason per item. */
  readonly menu: readonly Record<string, unknown>[];
  /** What tells an offline tablet its cached menu is stale. */
  readonly menuVersion: string;
}

export async function readMenuForBranch(
  context: TenantContext,
  params: { branchId: string },
): Promise<MenuRead> {
  // Listed -> in service -> sold out, most-permanent first, and the REASON
  // travels with the answer.
  //
  // Resolved by the SAME function the write path calls, one query for the whole
  // branch. This was a hand-rolled copy of the precedence and the copy dropped
  // `days_of_week`, so a weekday-only item read as available on a Sunday -- the
  // board would have offered it and the write would then have refused it, which
  // is the worst of both.
  const availability = await resolveAvailabilityForBranch(
    context, { branchId: params.branchId });

  // ###########################################################################
  // THE LIVE CATALOGUE PRICE IS CORRECT HERE. DO NOT "FIX" IT.
  //
  // This reads the CURRENT price, branch override included, and that does not
  // violate the priced-document rule -- it is what the rule exists to permit.
  // The board renders the menu a waiter is choosing FROM, so it must show what
  // the item costs right now. The snapshot happens in `addLine`, at the moment
  // of order, which is what makes catalogue price safely mutable.
  //
  // A reader who mistakes this for a snapshot violation and routes it through a
  // snapshot instead makes the tablet display stale prices, which is the actual
  // defect. The tell is direction: a number on its way to an ORDER LINE must be
  // snapshotted; a number on its way to a SCREEN must be live.
  // ###########################################################################
  const catalogue = await context.client.query<Record<string, unknown>>(
    `SELECT mi.id, mi.name, mi.barcode, mi.category_id, mi.station_code, mi.kind,
            COALESCE(bp.price_minor, mi.price_minor)::text AS price_minor,
            tc.rate_bps AS tax_rate_bps, tc.key AS tax_class_key,
            ks.id AS kitchen_station_id, ks.name AS kitchen_name
       FROM app.menu_item mi
       LEFT JOIN app.tax_class tc ON tc.tenant_id = mi.tenant_id AND tc.id = mi.tax_class_id
       LEFT JOIN app.branch_menu_price bp
         ON bp.tenant_id = mi.tenant_id AND bp.menu_item_id = mi.id AND bp.branch_id = $2
       -- The kitchen this branch sends the item to, resolved exactly as
       -- kitchen/fire.ts routes it: a branch routing exception, else the
       -- branch's active station for the item's code. A label for the KOT's
       -- kitchen filter; a combo routes per component and so has none.
       LEFT JOIN app.branch_item_routing r
         ON r.tenant_id = mi.tenant_id AND r.branch_id = $2 AND r.menu_item_id = mi.id
       LEFT JOIN app.kitchen_station code_ks
         ON code_ks.tenant_id = mi.tenant_id AND code_ks.branch_id = $2
            AND code_ks.code = mi.station_code AND code_ks.status = 'active'
       LEFT JOIN app.kitchen_station ks
         ON ks.tenant_id = mi.tenant_id AND ks.id = COALESCE(r.kitchen_station_id, code_ks.id)
      WHERE mi.tenant_id = $1 AND mi.status = 'active'
      ORDER BY mi.name`,
    [context.tenantId, params.branchId],
  );

  const menu = catalogue.rows.map((row) => {
    const verdict = availability.get(row['id'] as string);
    return {
      ...row,
      orderable: verdict?.orderable ?? true,
      unavailable_reason: verdict?.reason ?? null,
      unavailable_message: verdict?.message ?? null,
      available_from: verdict?.availableFrom ?? null,
    };
  });

  // A cheap, monotonic stamp over everything that can change a price or an
  // availability answer. The tablet compares it to what it cached.
  const version = await context.client.query<{ v: string }>(
    `SELECT md5(
              COALESCE(max(mi.updated_at)::text, '') ||
              COALESCE((SELECT max(updated_at)::text FROM app.branch_menu_price
                         WHERE tenant_id = $1 AND branch_id = $2), '') ||
              COALESCE((SELECT max(updated_at)::text FROM app.branch_menu_listing
                         WHERE tenant_id = $1 AND branch_id = $2), '')
            ) AS v
       FROM app.menu_item mi WHERE mi.tenant_id = $1`,
    [context.tenantId, params.branchId],
  );

  return { menu, menuVersion: version.rows[0]?.v ?? 'unknown' };
}
