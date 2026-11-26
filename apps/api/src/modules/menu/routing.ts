import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Station routing.
 *
 * The menu is tenant-level; kitchen_station is branch-scoped. So an item names a
 * station CODE from the tenant vocabulary, and each branch resolves it to its own
 * station. branch_item_routing is the exception ("at the airport, rolls come off
 * the grill rather than the tandoor").
 *
 * There is NO default-station fallback, deliberately. A default means food
 * silently appears at the wrong counter: the cook does not know it is wrong, the
 * waiter does not know it is coming, and it surfaces as a customer complaint an
 * hour later. Unroutable is refused at LISTING time, where someone is looking at
 * a setup screen and can fix it.
 */

export interface RoutingGap {
  readonly menuItemId: string;
  readonly menuItemName: string;
  readonly stationCode: string;
}

/**
 * Refuse to list an item at a branch with no station for its code -- including
 * the codes its modifier options route to, since "add a lassi" is prepared
 * somewhere the burger is not.
 */
export async function listingRoutingGaps(
  context: TenantContext,
  branchId: string,
  menuItemId: string,
): Promise<readonly RoutingGap[]> {
  const result = await context.client.query<RoutingGap>(
    `WITH required AS (
       -- The item's own code, unless a branch routing exception overrides it.
       SELECT mi.id AS "menuItemId", mi.name AS "menuItemName", mi.station_code AS "stationCode"
         FROM app.menu_item mi
        WHERE mi.tenant_id = $1 AND mi.id = $3 AND mi.station_code IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app.branch_item_routing r
             WHERE r.tenant_id = $1 AND r.branch_id = $2 AND r.menu_item_id = mi.id)
       UNION
       -- Codes reachable through the item's modifier options.
       SELECT mi.id, mi.name, mo.station_code
         FROM app.menu_item mi
         JOIN app.menu_item_modifier_group mimg
           ON mimg.tenant_id = mi.tenant_id AND mimg.menu_item_id = mi.id
         JOIN app.modifier_option mo
           ON mo.tenant_id = mimg.tenant_id AND mo.modifier_group_id = mimg.modifier_group_id
        WHERE mi.tenant_id = $1 AND mi.id = $3
          AND mo.station_code IS NOT NULL AND mo.status = 'active'
       UNION
       -- And through a combo's fixed components.
       SELECT ci.id, ci.name, ci.station_code
         FROM app.combo_component cc
         JOIN app.menu_item ci
           ON ci.tenant_id = cc.tenant_id AND ci.id = cc.component_item_id
        WHERE cc.tenant_id = $1 AND cc.combo_item_id = $3 AND ci.station_code IS NOT NULL
     )
     SELECT * FROM required r
      WHERE NOT EXISTS (
        SELECT 1 FROM app.kitchen_station ks
         WHERE ks.tenant_id = $1 AND ks.branch_id = $2
           AND ks.code = r."stationCode" AND ks.status = 'active')`,
    [context.tenantId, branchId, menuItemId],
  );
  return result.rows;
}

export class UnroutableAtBranchError extends Error {
  readonly statusCode = 422;
  readonly code = 'unroutable_at_branch';
  constructor(readonly gaps: readonly RoutingGap[], branchId: string) {
    super(
      gaps
        .map(
          (g) =>
            `${g.menuItemName} routes to "${g.stationCode}", which branch ${branchId} does not have`,
        )
        .join('; ') + ' -- create the station, or add a routing exception',
    );
    this.name = 'UnroutableAtBranchError';
  }
}

export async function assertListable(
  context: TenantContext,
  branchId: string,
  menuItemId: string,
): Promise<void> {
  const gaps = await listingRoutingGaps(context, branchId, menuItemId);
  if (gaps.length > 0) throw new UnroutableAtBranchError(gaps, branchId);
}

export interface StrandedItem {
  readonly menuItemId: string;
  readonly menuItemName: string;
}

/**
 * The reverse, which is the half that gets forgotten: archiving a station at a
 * branch that still has listed items routing to that code strands them, and the
 * failure would only appear when someone orders one.
 */
export async function itemsStrandedByArchiving(
  context: TenantContext,
  kitchenStationId: string,
): Promise<readonly StrandedItem[]> {
  const result = await context.client.query<StrandedItem>(
    `WITH station AS (
       SELECT branch_id, code FROM app.kitchen_station
        WHERE tenant_id = $1 AND id = $2
     ),
     siblings AS (
       SELECT 1 FROM app.kitchen_station ks, station s
        WHERE ks.tenant_id = $1 AND ks.branch_id = s.branch_id AND ks.code = s.code
          AND ks.id <> $2 AND ks.status = 'active'
     )
     SELECT mi.id AS "menuItemId", mi.name AS "menuItemName"
       FROM app.menu_item mi, station s
      WHERE mi.tenant_id = $1
        AND mi.station_code = s.code
        AND mi.status = 'active'
        -- Listed here: absence of a listing row means listed.
        AND NOT EXISTS (
          SELECT 1 FROM app.branch_menu_listing l
           WHERE l.tenant_id = $1 AND l.branch_id = s.branch_id
             AND l.menu_item_id = mi.id AND l.listed = false)
        -- A routing exception at this branch means the item does not need the code.
        AND NOT EXISTS (
          SELECT 1 FROM app.branch_item_routing r
           WHERE r.tenant_id = $1 AND r.branch_id = s.branch_id AND r.menu_item_id = mi.id)
        -- Another active station still realises the code.
        AND NOT EXISTS (SELECT 1 FROM siblings)`,
    [context.tenantId, kitchenStationId],
  );
  return result.rows;
}

export class StationStillRoutedError extends Error {
  readonly statusCode = 409;
  readonly code = 'station_still_routed';
  constructor(readonly items: readonly StrandedItem[]) {
    super(
      `cannot archive: ${items.length} listed item(s) still route to this station -- ` +
        items.map((i) => i.menuItemName).join(', '),
    );
    this.name = 'StationStillRoutedError';
  }
}

export async function assertStationArchivable(
  context: TenantContext,
  kitchenStationId: string,
): Promise<void> {
  const stranded = await itemsStrandedByArchiving(context, kitchenStationId);
  if (stranded.length > 0) throw new StationStillRoutedError(stranded);
}
