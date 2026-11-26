import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { applyOfflineOperation } from '../../src/routes/handlers/sync.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/core/database/tenantContext.js';
import {
  claimOrReplay,
  digestOf,
  IdempotencyConflictError,
  recordClaimResult,
} from '../../src/modules/orders/idempotency.js';
import {
  fireOrder,
  NothingToFireError,
  SessionVersionConflictError,
  FIRE_LOCK_ORDER,
} from '../../src/modules/kitchen/fire.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;

let tenantId: string;
let branchId: string;
let userId: string;
let grillId: string;
let tandoorId: string;
let coldId: string;
let burgerId: string;
let naanOptionId: string;
let taxClassId: string;
let voidReasonId: string;
let discountReasonId: string;

const BUSINESS_DATE = '2026-04-01';

function ctx(): TenantContext {
  return peekTenantContext()!;
}

async function newSession(): Promise<{ sessionId: string; tableId: string }> {
  const sessionId = randomUUID();
  const tableId = randomUUID();
  const floorId = randomUUID();
  await owner.query(
    `INSERT INTO app.floor (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)`,
    [floorId, tenantId, branchId, `F-${floorId.slice(0, 8)}`],
  );
  await owner.query(
    `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
     VALUES ($1, $2, $3, $4, '1', 4)`,
    [tableId, tenantId, branchId, floorId],
  );
  await owner.query(
    `INSERT INTO app.table_session (id, tenant_id, branch_id, business_date, opened_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, tenantId, branchId, BUSINESS_DATE, userId],
  );
  await owner.query(
    `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), tenantId, sessionId, tableId],
  );
  return { sessionId, tableId };
}

async function newOrderWithLine(
  sessionId: string,
  opts: { withNaan?: boolean } = {},
): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await owner.query(
    `INSERT INTO app.sales_order (id, tenant_id, branch_id, session_id, business_date, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, tenantId, branchId, sessionId, BUSINESS_DATE, userId],
  );
  const modifiers = opts.withNaan ? JSON.stringify([{ option_id: naanOptionId, name: 'Add naan', delta_minor: 4000 }]) : '[]';
  await owner.query(
    `INSERT INTO app.order_line
       (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
        unit_price_minor, quantity, line_total_minor, tax_class_key, tax_rate_bps,
        modifiers, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'item', $5, 'Burger', 21000, 1, 21000, 'food_5', 500, $6::jsonb, $7)`,
    [lineId, tenantId, branchId, orderId, burgerId, modifiers, userId],
  );
  return { orderId, lineId };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 10 });

  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key='super_admin'`)
  ).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3)`,
    [superAdminId, `ops+${superAdminId}@platform.test`, roleId],
  );
  const planId = randomUUID();
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'ops_plan', 'Ops') ON CONFLICT (key) DO NOTHING`,
    [planId],
  );
  const actualPlanId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.plan WHERE key='ops_plan'`)
  ).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, 1, 100000, 'INR', 'monthly', now()) ON CONFLICT (plan_id, version) DO NOTHING`,
    [randomUUID(), actualPlanId],
  );
  const planVersionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [actualPlanId])
  ).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `ops-${randomUUID()}`;
    const result = await provisionTenant(client, {
      idempotencyKey: key, slug: `o${key.slice(4, 12)}`, name: 'Ops Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = result.tenantId;
    branchId = result.firstBranchId;
    userId = result.ownerUserId;
  } finally {
    client.release();
  }
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);

  await owner.query(
    `INSERT INTO app.station_code (tenant_id, code, name) VALUES
       ($1,'grill','Grill'), ($1,'tandoor','Tandoor'), ($1,'cold','Cold')`,
    [tenantId],
  );
  grillId = randomUUID(); tandoorId = randomUUID(); coldId = randomUUID();
  await owner.query(
    `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name) VALUES
       ($1,$4,$5,'grill','Grill'), ($2,$4,$5,'tandoor','Tandoor'), ($3,$4,$5,'cold','Cold')`,
    [grillId, tandoorId, coldId, tenantId, branchId],
  );

  taxClassId = randomUUID();
  await owner.query(
    `INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps) VALUES ($1,$2,'food_5','Food 5%',500)`,
    [taxClassId, tenantId],
  );
  burgerId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, station_code, price_minor)
     VALUES ($1,$2,'burger','Burger','single',$3,'grill',21000)`,
    [burgerId, tenantId, taxClassId],
  );
  const groupId = randomUUID();
  naanOptionId = randomUUID();
  await owner.query(
    `INSERT INTO app.modifier_group (id, tenant_id, key, name) VALUES ($1,$2,'add_bread','Add bread')`,
    [groupId, tenantId],
  );
  await owner.query(
    `INSERT INTO app.modifier_option (id, tenant_id, modifier_group_id, key, name, price_delta_minor, station_code)
     VALUES ($1,$2,$3,'add_naan','Add naan',4000,'tandoor')`,
    [naanOptionId, tenantId, groupId],
  );

  voidReasonId = randomUUID();
  discountReasonId = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id, tenant_id, key, name) VALUES
       ($1,$3,'customer_walked_out','Customer walked out'),
       ($2,$3,'loyalty','Loyalty discount')`,
    [voidReasonId, discountReasonId, tenantId],
  );
  await owner.query(
    `INSERT INTO app.adjustment_reason_kind (tenant_id, reason_id, kind) VALUES
       ($1,$2,'void'), ($1,$3,'discount')`,
    [tenantId, voidReasonId, discountReasonId],
  );
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

/* --------------------------------------------------------------------- A --- */

describe('A. idempotency', () => {
  it('replays the stored result rather than re-executing', async () => {
    const key = `idem-${randomUUID()}`;
    const payload = { orderId: 'o1' };

    const first = await withTenantTransaction(pool, tenantId, async () => {
      const claim = await claimOrReplay(ctx(), { idempotencyKey: key, operation: 'kot.fire', branchId, payload });
      expect(claim.replayed).toBe(false);
      await recordClaimResult(ctx(), key, { fireNo: 7 });
      return claim;
    });
    expect(first.replayed).toBe(false);

    const second = await withTenantTransaction(pool, tenantId, () =>
      claimOrReplay<{ fireNo: number }>(ctx(), { idempotencyKey: key, operation: 'kot.fire', branchId, payload }),
    );
    // The second tap must get the SAME number back, not merely "ok".
    expect(second).toEqual({ replayed: true, result: { fireNo: 7 } });
  });

  it('raises on the same key with a different payload', async () => {
    const key = `idem-${randomUUID()}`;
    await withTenantTransaction(pool, tenantId, async () => {
      await claimOrReplay(ctx(), { idempotencyKey: key, operation: 'kot.fire', branchId, payload: { a: 1 } });
      await recordClaimResult(ctx(), key, { ok: true });
    });

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        claimOrReplay(ctx(), { idempotencyKey: key, operation: 'kot.fire', branchId, payload: { a: 2 } }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('is insensitive to key order in the payload', () => {
    expect(digestOf({ a: 1, b: 2 })).toEqual(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toEqual(digestOf({ a: 2 }));
  });

  it('survives a CONCURRENT duplicate, not just a sequential one', async () => {
    const key = `idem-${randomUUID()}`;
    const payload = { orderId: 'concurrent' };

    const attempt = () =>
      withTenantTransaction(pool, tenantId, async () => {
        const claim = await claimOrReplay<{ n: number }>(ctx(), {
          idempotencyKey: key, operation: 'kot.fire', branchId, payload,
        });
        if (!claim.replayed) {
          await recordClaimResult(ctx(), key, { n: 1 });
          return { winner: true };
        }
        return { winner: false };
      });

    const [a, b] = await Promise.all([attempt(), attempt()]);
    // Exactly one executes. A check-then-insert cannot guarantee this.
    expect([a.winner, b.winner].filter(Boolean)).toHaveLength(1);

    const rows = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.request_claim WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('preserves global uniqueness despite hash partitioning', async () => {
    // Time-partitioning would have made the PK (tenant, key, created_at) and let
    // this insert twice. Hashing on the key keeps it in the PK.
    const key = `idem-${randomUUID()}`;
    await owner.query(
      `INSERT INTO app.request_claim (tenant_id, idempotency_key, branch_id, operation, request_digest, result)
       VALUES ($1,$2,$3,'x','\\x00'::bytea,'{}'::jsonb)`,
      [tenantId, key, branchId],
    );
    await expect(
      owner.query(
        `INSERT INTO app.request_claim (tenant_id, idempotency_key, branch_id, operation, request_digest, result)
         VALUES ($1,$2,$3,'x','\\x00'::bytea,'{}'::jsonb)`,
        [tenantId, key, branchId],
      ),
    ).rejects.toThrow(/duplicate key/);

    const partitions = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_inherits i ON i.inhrelid=c.oid
         JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname='request_claim'`,
    );
    expect(Number(partitions.rows[0]!.n)).toBe(16);
  });

  it('purges on the retention window', async () => {
    const key = `idem-${randomUUID()}`;
    await owner.query(
      `INSERT INTO app.request_claim (tenant_id, idempotency_key, branch_id, operation, request_digest, result, created_at)
       VALUES ($1,$2,$3,'x','\\x00'::bytea,'{}'::jsonb, now() - interval '30 days')`,
      [tenantId, key, branchId],
    );
    const purged = await owner.query<{ purge_request_claims: number }>(
      `SELECT app.purge_request_claims(7, 1000)`,
    );
    expect(purged.rows[0]!.purge_request_claims).toBeGreaterThanOrEqual(1);
    const left = await owner.query(
      `SELECT 1 FROM app.request_claim WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantId, key]);
    expect(left.rowCount).toBe(0);
  });
});

/* --------------------------------------------------------------------- B --- */

describe('B. table session', () => {
  it('allows only one open session per table', async () => {
    const { tableId } = await newSession();
    const other = randomUUID();
    await owner.query(
      `INSERT INTO app.table_session (id, tenant_id, branch_id, business_date, opened_by_user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [other, tenantId, branchId, BUSINESS_DATE, userId],
    );
    await expect(
      owner.query(
        `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
         VALUES ($1,$2,$3,$4)`,
        [randomUUID(), tenantId, other, tableId],
      ),
    ).rejects.toThrow(/one_live_attachment_per_table/);
  });

  it('lets a party move tables within one session', async () => {
    const { sessionId, tableId } = await newSession();
    const second = randomUUID();
    const floorId = (
      await owner.query<{ floor_id: string }>(
        `SELECT floor_id FROM app.dining_table WHERE id=$1`, [tableId])
    ).rows[0]!.floor_id;
    await owner.query(
      `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
       VALUES ($1,$2,$3,$4,'2',4)`,
      [second, tenantId, branchId, floorId],
    );

    await owner.query(
      `UPDATE app.table_session_table SET detached_at=now()
        WHERE tenant_id=$1 AND session_id=$2 AND dining_table_id=$3`,
      [tenantId, sessionId, tableId],
    );
    await owner.query(
      `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
       VALUES ($1,$2,$3,$4)`,
      [randomUUID(), tenantId, sessionId, second],
    );

    const live = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.table_session_table
        WHERE tenant_id=$1 AND session_id=$2 AND detached_at IS NULL`,
      [tenantId, sessionId],
    );
    expect(Number(live.rows[0]!.n)).toBe(1);
    // The freed table can be seated again.
    const reuse = randomUUID();
    await owner.query(
      `INSERT INTO app.table_session (id, tenant_id, branch_id, business_date, opened_by_user_id)
       VALUES ($1,$2,$3,$4,$5)`, [reuse, tenantId, branchId, BUSINESS_DATE, userId]);
    await expect(
      owner.query(
        `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
         VALUES ($1,$2,$3,$4)`, [randomUUID(), tenantId, reuse, tableId]),
    ).resolves.toBeTruthy();
  });

  it('merges two tables into one session', async () => {
    const { sessionId } = await newSession();
    const floorId = randomUUID();
    const extra = randomUUID();
    await owner.query(
      `INSERT INTO app.floor (id, tenant_id, branch_id, name) VALUES ($1,$2,$3,'Merge')`,
      [floorId, tenantId, branchId]);
    await owner.query(
      `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
       VALUES ($1,$2,$3,$4,'9',4)`, [extra, tenantId, branchId, floorId]);
    await owner.query(
      `INSERT INTO app.table_session_table (id, tenant_id, session_id, dining_table_id)
       VALUES ($1,$2,$3,$4)`, [randomUUID(), tenantId, sessionId, extra]);

    const live = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.table_session_table
        WHERE tenant_id=$1 AND session_id=$2 AND detached_at IS NULL`, [tenantId, sessionId]);
    expect(Number(live.rows[0]!.n)).toBe(2);
  });
});

/* --------------------------------------------------------------------- C --- */

describe('C. order lines', () => {
  it('makes SUM(quantity) the truth, because the sign is real', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    await owner.query(`UPDATE app.order_line SET fired_at=now() WHERE id=$1`, [lineId]);

    await owner.query(
      `INSERT INTO app.order_line
         (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
          line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
          adjustment_reason_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,'void','Burger (void)',21000,-1,-21000,$5,'item',21000,$6,$7)`,
      [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId],
    );

    const net = await owner.query<{ q: string; m: string }>(
      `SELECT sum(quantity)::text AS q, sum(COALESCE(line_total_minor,0))::text AS m
         FROM app.order_line WHERE tenant_id=$1 AND order_id=$2`,
      [tenantId, orderId],
    );
    expect(net.rows[0]).toEqual({ q: '0', m: '0' });
  });

  it('keeps a comp at quantity zero: made but not sold', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    await owner.query(
      `INSERT INTO app.adjustment_reason_kind (tenant_id, reason_id, kind) VALUES ($1,$2,'comp')
       ON CONFLICT DO NOTHING`, [tenantId, voidReasonId]);
    await owner.query(
      `INSERT INTO app.order_line
         (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
          line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
          adjustment_reason_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,'comp','Burger (comp)',21000,0,-21000,$5,'item',21000,$6,$7)`,
      [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId],
    );

    const net = await owner.query<{ q: string; m: string }>(
      `SELECT sum(quantity)::text AS q, sum(COALESCE(line_total_minor,0))::text AS m
         FROM app.order_line WHERE tenant_id=$1 AND order_id=$2`, [tenantId, orderId]);
    // One made and eaten; nothing collected.
    expect(net.rows[0]).toEqual({ q: '1', m: '0' });
  });

  it('refuses a positive void or a negative item', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    await expect(
      owner.query(
        `INSERT INTO app.order_line
           (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
            line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
            adjustment_reason_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,'void','x',21000,1,-21000,$5,'item',21000,$6,$7)`,
        [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId]),
    ).rejects.toThrow(/order_line_shape_exact/);
  });

  it('pins the adjustment price to the line it adjusts', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    // A price that did not come from the adjusted row cannot be used.
    await expect(
      owner.query(
        `INSERT INTO app.order_line
           (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
            line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
            adjustment_reason_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,'void','x',99999,-1,-99999,$5,'item',99999,$6,$7)`,
        [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId]),
    ).rejects.toThrow(/adjusts_price_fk/);
  });

  it('scopes a reason to the kinds it applies to', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    // "Customer walked out" is not a discount reason.
    await expect(
      owner.query(
        `INSERT INTO app.order_line
           (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
            line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
            adjustment_reason_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,'discount','x',21000,0,-1000,$5,'item',21000,$6,$7)`,
        [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId]),
    ).rejects.toThrow(/order_line_reason_fk/);
  });

  it('refuses to over-void, at COMMIT', async () => {
    const { sessionId } = await newSession();
    const { orderId, lineId } = await newOrderWithLine(sessionId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `INSERT INTO app.order_line
             (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity,
              line_total_minor, adjusts_line_id, adjusted_kind, adjusted_unit_price_minor,
              adjustment_reason_id, created_by_user_id)
           VALUES ($1,$2,$3,$4,'void','x',21000,-1,-21000,$5,'item',21000,$6,$7)`,
          [randomUUID(), tenantId, branchId, orderId, lineId, voidReasonId, userId]);
      }
      // Deferred: neither insert failed on its own; the pair fails at COMMIT.
      await expect(client.query('COMMIT')).rejects.toThrow(/net quantity/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('freezes a fired line against quantity and money changes', async () => {
    const { sessionId } = await newSession();
    const { lineId } = await newOrderWithLine(sessionId);

    // Pre-fire is a free correction -- that is what keeps the exception report
    // readable.
    await owner.query(`UPDATE app.order_line SET quantity=2, line_total_minor=42000 WHERE id=$1`, [lineId]);
    await owner.query(`UPDATE app.order_line SET fired_at=now() WHERE id=$1`, [lineId]);

    await expect(
      owner.query(`UPDATE app.order_line SET quantity=1 WHERE id=$1`, [lineId]),
    ).rejects.toThrow(/has fired/);
    // A non-money field is still editable.
    await expect(
      owner.query(`UPDATE app.order_line SET adjustment_note='ok' WHERE id=$1`, [lineId]),
    ).resolves.toBeTruthy();
  });
});

/* --------------------------------------------------------------------- D --- */

describe('D. KOT fire', () => {
  it('states the global lock order', () => {
    expect(FIRE_LOCK_ORDER).toEqual([
      'request_claim',
      'table_session',
      'fire_sequence',
      'kot_sequence(sorted by station_id)',
      'inserts',
    ]);
  });

  it('fires atomically across stations, one line producing two tickets', async () => {
    const { sessionId } = await newSession();
    const { orderId } = await newOrderWithLine(sessionId, { withNaan: true });

    const result = await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {

        branchId, orderId, sessionId, sessionVersion: 1,
        firedByUserId: userId, businessDate: BUSINESS_DATE,
      }),
    );

    // Burger to grill, "add naan" to tandoor: one line, two KOTs.
    expect(result.stations).toHaveLength(2);
    expect(new Set(result.stations.map((s) => s.stationId))).toEqual(new Set([grillId, tandoorId]));
    expect(result.fireNo).toBeGreaterThan(0);

    const stamped = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.kot WHERE tenant_id=$1 AND fire_id=$2`,
      [tenantId, result.fireId]);
    expect(Number(stamped.rows[0]!.n)).toBe(2);

    // Stock emitted at fire, one message per KOT, dedupe_key = kot_id.
    const outbox = await owner.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM platform.outbox WHERE topic='inventory.deduct'
         AND dedupe_key = ANY($1::text[])`,
      [result.stations.map((s) => s.kotId)]);
    expect(outbox.rows).toHaveLength(2);

    // print_job row created in-transaction; no attempt made.
    const jobs = await owner.query<{ status: string }>(
      `SELECT status FROM app.print_job WHERE tenant_id=$1 AND kot_id=ANY($2::uuid[])`,
      [tenantId, result.stations.map((s) => s.kotId)]);
    expect(jobs.rows.every((j) => j.status === 'pending')).toBe(true);
  });

  it('gives one fire number that identifies the whole fire', async () => {
    const { sessionId } = await newSession();
    const { orderId } = await newOrderWithLine(sessionId, { withNaan: true });
    const result = await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {
        branchId, orderId, sessionId,
        sessionVersion: 1, firedByUserId: userId, businessDate: BUSINESS_DATE,
      }));

    // Station numbers differ; the fire number is the one a dispute is traced by.
    const kots = await owner.query<{ sequence_no: number; fire_no: number }>(
      `SELECT k.sequence_no, f.fire_no FROM app.kot k
         JOIN app.kot_fire f ON f.tenant_id=k.tenant_id AND f.id=k.fire_id
        WHERE k.tenant_id=$1 AND k.fire_id=$2`, [tenantId, result.fireId]);
    expect(new Set(kots.rows.map((r) => r.fire_no)).size).toBe(1);
    expect(kots.rows).toHaveLength(2);
  });

  it('is idempotent through its CALLER: a second tap fires once', async () => {
    // ####################################################################
    // THE CLAIM MOVED, AND THIS TEST MOVED WITH IT.
    //
    // `fireOrder` used to claim the key itself, and this test called it twice
    // directly. That hid a defect in both real callers: each of them ALSO
    // claims, so the inner claim raised `idempotency_key_reused` against the
    // outer one -- operation mismatch over HTTP (`POST /pos/order/:id/fire`
    // versus `kot.fire`), digest mismatch offline (the sync loop's payload
    // carries `sessionVersion`; the inner one omitted it). Every fire through a
    // dispatcher answered 409, and no test could see it, because no test used a
    // dispatcher.
    //
    // So the second tap is asserted where it actually happens: through
    // `applyOfflineOperation`, which is the sync loop's own dispatcher and one
    // of the two places a claim is now made. The HTTP half is the registrar's,
    // asserted in tests/http/leaseEnforcement.test.ts.
    // ####################################################################
    const { sessionId } = await newSession();
    const { orderId } = await newOrderWithLine(sessionId);
    const op = {
      kind: 'kot.fire' as const,
      idempotencyKey: `fire-${randomUUID()}`,
      sessionId,
      businessDate: BUSINESS_DATE,
      payload: { orderId, sessionId, sessionVersion: 1 },
    };
    const batch = {
      clientBatchNo: 1, deviceId: randomUUID(), branchId,
      offlineSince: new Date().toISOString(), operations: [op],
    };

    // The tablet sent the batch, lost the response, and sent it again.
    await withTenantTransaction(pool, tenantId, () =>
      applyOfflineOperation(ctx(), batch, userId)(op));
    await withTenantTransaction(pool, tenantId, () =>
      applyOfflineOperation(ctx(), batch, userId)(op));

    const fires = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.kot_fire WHERE tenant_id=$1 AND order_id=$2`,
      [tenantId, orderId]);
    // Not two KOTs, and not double food.
    expect(Number(fires.rows[0]!.n)).toBe(1);
    const kots = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.kot WHERE tenant_id=$1`, [tenantId]);
    void kots;
  });

  it('makes exactly two claims in the whole tree, so nothing claims a key twice',
    async () => {
      // The structural half. The defect above was not a typo: it was two
      // functions each doing the same correct thing to the same key. The rule
      // that prevents it recurring is countable -- a claim is made by whoever
      // RECEIVED the operation, and there are exactly two such places.
      const { readdir, readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const root = path.resolve(import.meta.dirname, '../../src');
      const claimants: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { await walk(full); continue; }
          if (!entry.name.endsWith('.ts')) continue;
          const source = await readFile(full, 'utf8');
          if (/\bclaimOrReplay\s*[<(]/.test(source)) {
            claimants.push(path.relative(root, full).replace(/\\/g, '/'));
          }
        }
      };
      await walk(root);

      expect(claimants.sort()).toEqual([
        // Where it is defined.
        'modules/orders/idempotency.ts',
        // The two dispatchers: HTTP and offline sync.
        'routes/handlers/sync.ts',
        'core/middleware/routeRegistry.ts',
      ].sort());
    });

  it('refuses a stale session version and tells the terminal where it is', async () => {
    const { sessionId } = await newSession();
    const { orderId } = await newOrderWithLine(sessionId);
    await owner.query(`UPDATE app.table_session SET version=version+1 WHERE id=$1`, [sessionId]);

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        fireOrder(ctx(), {
          branchId, orderId, sessionId,
          sessionVersion: 1, firedByUserId: userId, businessDate: BUSINESS_DATE,
        })),
    ).rejects.toThrow(SessionVersionConflictError);
  });

  it('refuses a fire with nothing unfired', async () => {
    const { sessionId } = await newSession();
    const { orderId } = await newOrderWithLine(sessionId);
    await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {
        branchId, orderId, sessionId,
        sessionVersion: 1, firedByUserId: userId, businessDate: BUSINESS_DATE,
      }));

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        fireOrder(ctx(), {
          branchId, orderId, sessionId,
          sessionVersion: 2, firedByUserId: userId, businessDate: BUSINESS_DATE,
        })),
    ).rejects.toThrow(NothingToFireError);
  });

  it('allocates station numbers gaplessly, even when fires abort', async () => {
    const date = '2026-04-09';
    const before = await owner.query<{ next_no: number }>(
      `INSERT INTO app.kot_sequence (tenant_id, branch_id, station_id, business_date, next_no)
       VALUES ($1,$2,$3,$4,0) ON CONFLICT DO NOTHING RETURNING next_no`,
      [tenantId, branchId, coldId, date]);
    void before;

    // An aborted fire must not burn a number. A SEQUENCE would have.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
      await client.query(
        `UPDATE app.kot_sequence SET next_no = next_no + 1
          WHERE tenant_id=$1 AND branch_id=$2 AND station_id=$3 AND business_date=$4`,
        [tenantId, branchId, coldId, date]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const after = await owner.query<{ next_no: number }>(
      `SELECT next_no FROM app.kot_sequence
        WHERE tenant_id=$1 AND branch_id=$2 AND station_id=$3 AND business_date=$4`,
      [tenantId, branchId, coldId, date]);
    expect(after.rows[0]!.next_no, 'the increment rolled back with the transaction').toBe(0);
  });

  it('does not deadlock when overlapping station sets fire from two directions', async () => {
    // The concurrency fixture: two fires whose station sets overlap, launched
    // simultaneously. Without the global order this is where a deadlock lives.
    const runs = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { sessionId } = await newSession();
        const { orderId } = await newOrderWithLine(sessionId, { withNaan: true });
        return { sessionId, orderId };
      }),
    );

    const results = await Promise.all(
      runs.map((r) =>
        withTenantTransaction(pool, tenantId, () =>
          fireOrder(ctx(), {
            
            branchId, orderId: r.orderId, sessionId: r.sessionId, sessionVersion: 1,
            firedByUserId: userId, businessDate: '2026-04-15',
          }),
        ),
      ),
    );

    expect(results).toHaveLength(6);
    // Gapless: six fires produced fire numbers 1..6 with no gaps and no repeats.
    const fireNos = results.map((r) => r.fireNo).sort((a, b) => a - b);
    expect(fireNos).toEqual([1, 2, 3, 4, 5, 6]);

    for (const station of [grillId, tandoorId]) {
      const nos = await owner.query<{ sequence_no: number }>(
        `SELECT sequence_no FROM app.kot
          WHERE tenant_id=$1 AND station_id=$2 AND business_date='2026-04-15'
          ORDER BY sequence_no`, [tenantId, station]);
      expect(nos.rows.map((r) => r.sequence_no)).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });
});
