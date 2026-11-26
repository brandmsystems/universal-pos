import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * The floor read: every table on a branch, and what is happening at it.
 *
 * ###########################################################################
 * THE POS HAD NO WAY TO SEE A FLOOR, AND NOBODY NOTICED UNTIL A SCREEN NEEDED ONE.
 *
 * `readBoard` reads ONE session by id, which is everything a waiter needs once
 * they are already at a table. Nothing enumerated the tables, so the first
 * screen of the product -- the one a shift starts on -- had no endpoint. Found
 * by building the client, which is the only way this class of gap is ever found.
 * ###########################################################################
 *
 * ###########################################################################
 * THE LEASE COMES BACK IN WHATEVER STATE IT IS IN, WITH THE STATE ON IT.
 *
 * Same rule as the board, and for the same reason: filtering to the live lease
 * collapses "never leased", "released", "expired" and "FORCE-RELEASED" into one
 * indistinguishable null, and those need different words in front of a waiter.
 * A manager taking a table and a lease quietly timing out are not the same
 * event, and the server is the only place that knows which happened.
 *
 * `lease: null` therefore means exactly one thing: this session has never been
 * leased. Anything else carries `lease_state`, and the client compares
 * `lease_device_id` to its own -- a live lease here is not a grant to whoever
 * is reading it.
 * ###########################################################################
 */

export interface FloorTable {
  readonly id: string;
  readonly identifier: string;
  readonly seats: number;
  readonly floor_name: string;
  /** Null when nothing is open at this table. */
  readonly session_id: string | null;
  readonly guest_count: number | null;
  /** 'ordering' while KOT owns the party, 'billing' once handed over. */
  readonly stage: 'ordering' | 'billing' | null;
  readonly opened_at: string | null;
  /**
   * The open order behind the session. Returned because the order pane needs it
   * to add a line, and a session whose order has no lines yet gives a client no
   * other way to learn it -- the board's line rows carry `order_id`, and a fresh
   * table has none. Discovering it with a second call would be a second instant.
   */
  readonly order_id: string | null;
  readonly line_count: number;
  /** Before tax, minor units, as text. Null when nothing is open. */
  readonly amount_minor: string | null;
  readonly unsent_count: number;
  readonly kitchen_cooking: number;
  readonly kitchen_ready: number;
  /** A bill has been generated: the table is waiting on payment. */
  readonly billed: boolean;
  /** Every table the party sits at; more than one means joined. */
  readonly joined_tables: readonly string[] | null;
  readonly lease_device_id: string | null;
  readonly lease_state: 'live' | 'expired' | 'released' | 'force_released' | null;
  readonly lease_seconds_remaining: number | null;
}

export interface FloorResponse {
  readonly tables: readonly FloorTable[];
  /**
   * Server time at the read, so a client countdown is anchored to the clock that
   * decides rather than to the tablet's own.
   */
  readonly serverNow: string;
  readonly businessDate: string;
}

export async function readFloor(
  context: TenantContext,
  params: { branchId: string; businessDate: string },
): Promise<FloorResponse> {
  const nowRow = await context.client.query<{ server_now: string }>(
    'SELECT now()::text AS server_now',
  );

  // One query. Six would be six instants, and a waiter watching the floor board
  // would see a table free in one row and occupied in another.
  //
  // The lease is a LATERAL rather than a join: a session is leased many times
  // over its life and only the most recent one describes the present, so the
  // join has to pick a row rather than multiply them.
  const result = await context.client.query<FloorTable>(
    `SELECT t.id,
            t.identifier,
            t.seats::int            AS seats,
            f.name                  AS floor_name,
            s.id                    AS session_id,
            s.guest_count::int      AS guest_count,
            s.stage                 AS stage,
            s.opened_at::text       AS opened_at,
            ord.id                  AS order_id,
            COALESCE(ord.n, 0)::int AS line_count,
            ord.amount_minor::text  AS amount_minor,
            COALESCE(ord.unsent, 0)::int  AS unsent_count,
            COALESCE(kit.cooking, 0)::int AS kitchen_cooking,
            COALESCE(kit.ready, 0)::int   AS kitchen_ready,
            COALESCE(ord.billed, false)   AS billed,
            joined.tables           AS joined_tables,
            l.device_id             AS lease_device_id,
            l.state                 AS lease_state,
            l.seconds_remaining     AS lease_seconds_remaining
       FROM app.dining_table t
       JOIN app.floor f
         ON f.tenant_id = t.tenant_id AND f.id = t.floor_id

       -- The open session at this table, if any. detached_at IS NULL matters: a
       -- party that moved from T5 to T22 keeps ONE session, and the old table
       -- must read as free rather than showing the same order twice.
       LEFT JOIN app.table_session_table tst
         ON tst.tenant_id = t.tenant_id
        AND tst.dining_table_id = t.id
        AND tst.detached_at IS NULL
       LEFT JOIN app.table_session s
         ON s.tenant_id = tst.tenant_id
        AND s.id = tst.session_id
        AND s.status = 'open'

       LEFT JOIN LATERAL (
         SELECT tsl.device_id,
                GREATEST(0, floor(EXTRACT(EPOCH FROM (tsl.expires_at - now()))))::int
                  AS seconds_remaining,
                CASE
                  WHEN tsl.force_released_at IS NOT NULL THEN 'force_released'
                  WHEN tsl.released_at IS NOT NULL       THEN 'released'
                  WHEN tsl.expires_at <= now()           THEN 'expired'
                  ELSE 'live'
                END AS state
           FROM app.table_session_lease tsl
          WHERE tsl.tenant_id = s.tenant_id AND tsl.session_id = s.id
          ORDER BY tsl.claimed_at DESC
          LIMIT 1
       ) l ON true

       -- The order and its line count together: they come from the same row set,
       -- and splitting them would let a client see a count without an id to act
       -- on it with.
       LEFT JOIN LATERAL (
         SELECT so.id,
                (SELECT count(*)
                   FROM app.order_line ol
                  WHERE ol.tenant_id = so.tenant_id
                    AND ol.order_id = so.id
                    AND ol.parent_line_id IS NULL) AS n,
                -- Before tax, from the snapshotted line totals: combo parents
                -- carry no money (their components do) and adjustments are
                -- signed rows, so the plain sum is already net.
                (SELECT COALESCE(sum(ol.line_total_minor), 0)
                   FROM app.order_line ol
                  WHERE ol.tenant_id = so.tenant_id AND ol.order_id = so.id
                    AND ol.kind <> 'combo_parent') AS amount_minor,
                (SELECT count(*)
                   FROM app.order_line ol
                  WHERE ol.tenant_id = so.tenant_id AND ol.order_id = so.id
                    AND ol.kind IN ('item', 'combo_parent') AND ol.fired_at IS NULL) AS unsent,
                EXISTS (SELECT 1 FROM app.bill b
                         WHERE b.tenant_id = so.tenant_id AND b.session_id = s.id
                           AND b.status <> 'void') AS billed
           FROM app.sales_order so
          WHERE so.tenant_id = s.tenant_id
            AND so.session_id = s.id
            -- The same predicate the write path uses: 'closed' and 'cancelled'
            -- take no more lines, and 'confirmed' still does. Filtering to
            -- 'open' would strip the order id off every table that had fired,
            -- which is most of them mid-service.
            AND so.status NOT IN ('closed', 'cancelled')
          ORDER BY so.created_at
          LIMIT 1
       ) ord ON true

       -- Every table the party sits at, so a joined group reads "T05 + T06" on
       -- each of its tables from the attachment rows, not a stored string.
       LEFT JOIN LATERAL (
         SELECT array_agg(jt.identifier ORDER BY jt.identifier) AS tables
           FROM app.table_session_table j
           JOIN app.dining_table jt ON jt.tenant_id = j.tenant_id AND jt.id = j.dining_table_id
          WHERE j.tenant_id = s.tenant_id AND j.session_id = s.id AND j.detached_at IS NULL
       ) joined ON s.id IS NOT NULL

       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE kl.state IN ('queued', 'preparing')) AS cooking,
                count(*) FILTER (WHERE kl.state = 'ready') AS ready
           FROM app.kot_line kl
           JOIN app.kot k ON k.tenant_id = kl.tenant_id AND k.id = kl.kot_id
           JOIN app.kot_fire kf ON kf.tenant_id = k.tenant_id AND kf.id = k.fire_id
          WHERE kf.tenant_id = s.tenant_id AND kf.order_id = ord.id AND kl.source = 'item'
       ) kit ON ord.id IS NOT NULL

      WHERE t.tenant_id = $1
        AND t.branch_id = $2
        AND t.status = 'active'
      ORDER BY f.display_order, t.identifier`,
    [context.tenantId, params.branchId],
  );

  return {
    tables: result.rows,
    serverNow: nowRow.rows[0]!.server_now,
    businessDate: params.businessDate,
  };
}
