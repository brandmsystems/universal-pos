import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Availability is three separate concerns and they do not share a table. One
 * boolean across all three is what makes a POS wrong at 11:01am -- because
 * whoever cleared the sold-out flag at closing also cleared the breakfast
 * restriction.
 */

export type UnavailableReason = 'not_listed' | 'out_of_service_hours' | 'sold_out';

export interface AvailabilityVerdict {
  readonly orderable: boolean;
  readonly reason?: UnavailableReason;
  /** What the waiter is told. The reason drives what they do next. */
  readonly message?: string;
  readonly availableFrom?: string;
}

/**
 * Precedence is MOST PERMANENT FIRST.
 *
 * All three deny, so the order does not change whether the item can be sold. It
 * changes what the staff member is told, and that is the point: an item that is
 * both out of hours and 86'd should say "available from 07:00", because "sold
 * out" implies come back later today and that is wrong.
 */
export const PRECEDENCE: readonly UnavailableReason[] = [
  'not_listed',
  'out_of_service_hours',
  'sold_out',
];

const DAY_BITS = [64, 1, 2, 4, 8, 16, 32]; // JS getDay(): Sunday = 0 -> bit 64

export function dayBit(date: Date): number {
  return DAY_BITS[date.getDay()]!;
}

/** starts_at > ends_at means the period wraps midnight -- ordinary for late-night. */
export function withinPeriod(
  minutesNow: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  return startMinutes <= endMinutes
    ? minutesNow >= startMinutes && minutesNow < endMinutes
    : minutesNow >= startMinutes || minutesNow < endMinutes;
}

export interface AvailabilityQuery {
  readonly branchId: string;
  readonly menuItemId: string;
  /** Defaults to now(); injectable so the 11:01am case is testable. */
  readonly at?: Date;
}

interface ResolutionRow {
  listed: boolean | null;
  has_periods: boolean;
  in_period: boolean | null;
  sold_out: boolean | null;
  next_start: string | null;
}

/**
 * One query, evaluated entirely in branch-local time. The POS reads all three
 * concerns on every order attempt -- none of them is cached, because all three
 * change during service.
 */
export async function resolveAvailability(
  context: TenantContext,
  query: AvailabilityQuery,
): Promise<AvailabilityVerdict> {
  const at = query.at ?? new Date();

  const result = await context.client.query<ResolutionRow>(
    `WITH branch AS (
       SELECT b.id, b.timezone, b.business_day_starts_at
         FROM app.branch b
        WHERE b.tenant_id = $1 AND b.id = $2
     ),
     local AS (
       SELECT ($4::timestamptz AT TIME ZONE (SELECT timezone FROM branch)) AS local_ts,
              app.business_date((SELECT timezone FROM branch),
                                (SELECT business_day_starts_at FROM branch),
                                $4::timestamptz) AS business_date
     ),
     listing AS (
       SELECT listed FROM app.branch_menu_listing
        WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_id = $3
     ),
     periods AS (
       SELECT sp.starts_at, sp.ends_at, sp.days_of_week
         FROM app.menu_item_service_period misp
         JOIN app.service_period sp
           ON sp.tenant_id = misp.tenant_id AND sp.id = misp.service_period_id
        WHERE misp.tenant_id = $1 AND misp.menu_item_id = $3
          AND sp.status = 'active'
          AND (sp.branch_id IS NULL OR sp.branch_id = $2)
     ),
     sold AS (
       SELECT state FROM app.branch_item_availability
        WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_id = $3
          AND business_date = (SELECT business_date FROM local)
     )
     SELECT
       (SELECT listed FROM listing)                          AS listed,
       EXISTS (SELECT 1 FROM periods)                        AS has_periods,
       EXISTS (
         SELECT 1 FROM periods p, local l
          WHERE (p.days_of_week & $5::int) <> 0
            AND CASE WHEN p.starts_at <= p.ends_at
                     THEN l.local_ts::time >= p.starts_at AND l.local_ts::time < p.ends_at
                     ELSE l.local_ts::time >= p.starts_at OR  l.local_ts::time < p.ends_at
                END
       )                                                     AS in_period,
       (SELECT state = 'sold_out' FROM sold)                 AS sold_out,
       (SELECT to_char(min(p.starts_at), 'HH24:MI') FROM periods p) AS next_start`,
    [context.tenantId, query.branchId, query.menuItemId, at.toISOString(), dayBit(at)],
  );

  const row = result.rows[0];
  if (!row) return { orderable: false, reason: 'not_listed', message: 'unknown branch or item' };

  // The same ladder the set-based resolver reads. Shared, not reproduced.
  return verdictFrom(row);
}

/**
 * The same three concerns, the same precedence, for every item at a branch in
 * ONE query.
 *
 * ###########################################################################
 * THIS EXISTS SO THE BOARD READ IS NOT A SECOND COPY OF THE RULE.
 *
 * `readBoard` needs a verdict per item and cannot issue N queries for a 200-item
 * menu, so it hand-rolled the precedence in its own SQL -- and that copy silently
 * omitted `days_of_week` and branch-scoped periods, which means a weekday-only
 * item read as available on a Sunday. The copy looked right because it sat next
 * to a correct implementation and reproduced the shape of it.
 *
 * So the set-based form lives HERE, beside the single-item form, sharing the
 * predicates. A test asserts the two agree item by item -- if they can disagree,
 * one of them is the bug and nobody knows which.
 * ###########################################################################
 */
export interface BranchAvailability {
  readonly menuItemId: string;
  readonly verdict: AvailabilityVerdict;
}

export async function resolveAvailabilityForBranch(
  context: TenantContext,
  query: { branchId: string; at?: Date },
): Promise<ReadonlyMap<string, AvailabilityVerdict>> {
  const at = query.at ?? new Date();

  const result = await context.client.query<ResolutionRow & { menu_item_id: string }>(
    `WITH branch AS (
       SELECT b.id, b.timezone, b.business_day_starts_at
         FROM app.branch b
        WHERE b.tenant_id = $1 AND b.id = $2
     ),
     local AS (
       SELECT ($3::timestamptz AT TIME ZONE (SELECT timezone FROM branch)) AS local_ts,
              app.business_date((SELECT timezone FROM branch),
                                (SELECT business_day_starts_at FROM branch),
                                $3::timestamptz) AS business_date
     )
     SELECT mi.id AS menu_item_id,
            bl.listed                                        AS listed,
            EXISTS (SELECT 1 FROM app.menu_item_service_period misp
                      JOIN app.service_period sp
                        ON sp.tenant_id = misp.tenant_id AND sp.id = misp.service_period_id
                     WHERE misp.tenant_id = mi.tenant_id AND misp.menu_item_id = mi.id
                       AND sp.status = 'active'
                       AND (sp.branch_id IS NULL OR sp.branch_id = $2)) AS has_periods,
            EXISTS (SELECT 1 FROM app.menu_item_service_period misp
                      JOIN app.service_period sp
                        ON sp.tenant_id = misp.tenant_id AND sp.id = misp.service_period_id,
                           local l
                     WHERE misp.tenant_id = mi.tenant_id AND misp.menu_item_id = mi.id
                       AND sp.status = 'active'
                       AND (sp.branch_id IS NULL OR sp.branch_id = $2)
                       AND (sp.days_of_week & $4::int) <> 0
                       AND CASE WHEN sp.starts_at <= sp.ends_at
                                THEN l.local_ts::time >= sp.starts_at
                                 AND l.local_ts::time <  sp.ends_at
                                ELSE l.local_ts::time >= sp.starts_at
                                  OR l.local_ts::time <  sp.ends_at
                           END)                              AS in_period,
            (av.state = 'sold_out')                          AS sold_out,
            (SELECT to_char(min(sp.starts_at), 'HH24:MI')
               FROM app.menu_item_service_period misp
               JOIN app.service_period sp
                 ON sp.tenant_id = misp.tenant_id AND sp.id = misp.service_period_id
              WHERE misp.tenant_id = mi.tenant_id AND misp.menu_item_id = mi.id
                AND sp.status = 'active'
                AND (sp.branch_id IS NULL OR sp.branch_id = $2)) AS next_start
       FROM app.menu_item mi
       LEFT JOIN app.branch_menu_listing bl
         ON bl.tenant_id = mi.tenant_id AND bl.menu_item_id = mi.id AND bl.branch_id = $2
       LEFT JOIN app.branch_item_availability av
         ON av.tenant_id = mi.tenant_id AND av.menu_item_id = mi.id AND av.branch_id = $2
        AND av.business_date = (SELECT business_date FROM local)
      WHERE mi.tenant_id = $1 AND mi.status = 'active'`,
    [context.tenantId, query.branchId, at.toISOString(), dayBit(at)],
  );

  return new Map(result.rows.map((row) => [row.menu_item_id, verdictFrom(row)]));
}

/**
 * The precedence ladder itself, factored out so the single-item and set-based
 * resolvers cannot drift in how they READ their rows -- only in how they fetch
 * them.
 */
function verdictFrom(row: ResolutionRow): AvailabilityVerdict {
  if (row.listed === false) {
    return { orderable: false, reason: 'not_listed', message: 'not on the menu at this branch' };
  }
  if (row.has_periods && row.in_period !== true) {
    return {
      orderable: false,
      reason: 'out_of_service_hours',
      message: row.next_start ? `available from ${row.next_start}` : 'outside service hours',
      ...(row.next_start ? { availableFrom: row.next_start } : {}),
    };
  }
  if (row.sold_out === true) {
    return { orderable: false, reason: 'sold_out', message: 'sold out today' };
  }
  return { orderable: true };
}
