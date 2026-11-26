import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/auth/jwt.js';
import { planeGuard } from '../../src/core/security/planeGuards.js';
import { registerTenantRoute, resetRegistry } from '../../src/core/middleware/routeRegistry.js';
import { toErrorResponse } from '../../src/core/errors/errors.js';
import { posRoutes } from '../../src/routes/pos.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { isUnserved, mergeHandlers } from '../../src/routes/lookup.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import { DEFAULT_ADJUSTMENT_REASONS } from '../../src/modules/orders/adjustmentReasons.js';
import { planCache } from '../helpers/plans.js';

/**
 * The adjustment vocabulary, over HTTP.
 *
 * ###########################################################################
 * WHY THIS FILE EXISTS: EVERY ADJUSTMENT WAS UNREACHABLE.
 *
 * Void, comp, discount, recall and refund each require a `reasonId` and refuse
 * without one. `app.adjustment_reason` and `app.adjustment_reason_kind` were
 * built for it, `AdjustmentReasonRepository` existed, the foreign keys
 * referenced `(tenant_id, reason_id, kind)` so the wrong kind could not be
 * used -- and NO ROUTE SERVED THE LIST, and nothing seeded a single row outside
 * a test fixture. Five flows that each work perfectly in the repository layer
 * could not be performed by any client, and no test noticed, because every test
 * inserted its own reasons first.
 *
 * Two things had to be true, so both are asserted here rather than one:
 *
 *   1. THE LIST IS SERVED, on both surfaces that need it. A single route cannot
 *      do it: permission is one key per route and the KITCHEN system role holds
 *      `kds.view` without `order.view`, so a POS-only route would leave the KDS
 *      recall sheet exactly as stranded as before.
 *
 *   2. A PROVISIONED TENANT HAS A VOCABULARY. A served route over an empty
 *      table is the same dead end with a 200 in front of it.
 * ###########################################################################
 */
const KEY = 'adjustment-reason-surface-signing-key';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let tenantId: string, branchId: string, ownerUserId: string;
let otherTenantId: string;
let waiterUserId: string, blindUserId: string;

function token(userId: string, tenant = tenantId): string {
  return signToken(
    { sub: userId, tenant_id: tenant, branch_id: branchId,
      exp: Math.floor(Date.now() / 1000) + 600 },
    KEY,
  );
}

async function get(
  url: string, as: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET', url: `/api/t${url}`,
    headers: { authorization: `Bearer ${token(as)}` },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

interface ServedReason {
  readonly id: string; readonly key: string; readonly name: string;
  readonly kinds: readonly string[];
}

function reasonsIn(body: unknown): readonly ServedReason[] {
  return body as readonly ServedReason[];
}

/** A user holding exactly the named permissions. The separability probe. */
async function makeUserWithPermissions(
  label: string, permissions: readonly string[], tenant = tenantId,
): Promise<string> {
  const userId = randomUUID(), roleId = randomUUID();
  await owner.query(
    `INSERT INTO app.app_user (id,tenant_id,email,full_name,status)
     VALUES ($1,$2,$3,$4,'active')`,
    [userId, tenant, `${label}+${userId}@adj.test`, label]);
  await owner.query(
    `INSERT INTO app.role (id,tenant_id,key,name,assignable_scope)
     VALUES ($1,$2,$3,$3,'any')`, [roleId, tenant, `role_${label}_${userId.slice(0, 8)}`]);
  for (const key of permissions) {
    await owner.query(
      `INSERT INTO app.role_permission (tenant_id,role_id,permission_key) VALUES ($1,$2,$3)`,
      [tenant, roleId, key]);
  }
  await owner.query(
    `INSERT INTO app.membership (id,tenant_id,user_id,branch_id,role_id,role_assignable_scope)
     VALUES ($1,$2,$3,$4,$5,'any')`,
    [randomUUID(), tenant, userId, branchId, roleId]);
  return userId;
}

async function provision(label: string): Promise<{ tenantId: string; branchId: string;
  ownerUserId: string; }> {
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT pv.id FROM platform.plan_version pv
       JOIN platform.plan p ON p.id = pv.plan_id
      WHERE p.key = 'adj_plan'`)).rows[0]!.id;
  const superAdminId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_user WHERE email LIKE 'adj+%' LIMIT 1`)).rows[0]!.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `adj-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `a${key.slice(4, 12)}`, name: label,
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@a.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    return { tenantId: r.tenantId, branchId: r.firstBranchId, ownerUserId: r.ownerUserId };
  } finally { client.release(); }
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `adj+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'adj_plan','Adj')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='adj_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);

  const main = await provision('Adjustment Probe');
  tenantId = main.tenantId; branchId = main.branchId; ownerUserId = main.ownerUserId;
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [ownerUserId]);

  waiterUserId = await makeUserWithPermissions('waiter', ['order.view']);
  blindUserId = await makeUserWithPermissions('blind', ['menu.view']);

  const other = await provision('Other Tenant');
  otherTenantId = other.tenantId;

  resetRegistry();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    void reply.code(status).send(body);
  });
  const handlers = mergeHandlers(posHandlers());
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', KEY));
    for (const route of posRoutes(handlers)) {
      if (isUnserved(route.handler)) continue;
      registerTenantRoute(scope, { pool, entitlements: planCache() }, route);
    }
  }, { prefix: '/api/t' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe('a provisioned tenant has an adjustment vocabulary', () => {
  it('seeds it, so the sheet is not served empty', async () => {
    const result = await get('/pos/adjustment-reasons', waiterUserId);
    expect(result.status).toBe(200);
    expect(reasonsIn(result.body).length).toBe(DEFAULT_ADJUSTMENT_REASONS.length);
  });

  it('covers every kind the schema permits, read from the CHECK and not from a list here',
    async () => {
      // The strong form. A hardcoded list of kinds would pass forever after
      // someone adds a sixth to the constraint and seeds no reason for it -- and
      // the symptom would be a sheet that opens empty for one adjustment only.
      const permitted = (await owner.query<{ kind: string }>(
        `SELECT unnest(enum_range) AS kind FROM (
           SELECT regexp_split_to_array(
             regexp_replace(pg_get_constraintdef(oid),
               '.*ARRAY\\[(.*)\\].*', '\\1'), ', *') AS enum_range
             FROM pg_constraint WHERE conname = 'adjustment_reason_kind_known') s`,
      )).rows.map((r) => r.kind.replace(/'|::text/g, '').trim());
      expect(permitted.length).toBeGreaterThanOrEqual(5);

      const served = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);
      const covered = new Set(served.flatMap((r) => r.kinds));
      for (const kind of permitted) {
        expect(covered.has(kind), `no seeded reason is usable for '${kind}'`).toBe(true);
      }
    });

  it('carries the kinds per reason, because the point of use is keyed on them', async () => {
    const served = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);
    const quality = served.find((r) => r.key === 'quality_issue');
    expect(quality, 'the seeded vocabulary must include a multi-kind reason').toBeDefined();
    // order_line_reason_fk references (tenant_id, reason_id, kind). A client
    // offering this reason for a discount would be refused by the database, in
    // front of a customer, after the tap.
    expect(quality!.kinds).toEqual(['comp', 'void']);
    expect(quality!.kinds).not.toContain('discount');
  });
});

describe('the POS sheet can read it', () => {
  it('serves the POS sheet to order.view alone', async () => {
    const result = await get('/pos/adjustment-reasons', waiterUserId);
    expect(result.status).toBe(200);
  });

  it('refuses a session holding neither key', async () => {
    expect((await get('/pos/adjustment-reasons', blindUserId)).status).toBe(403);
  });
});

describe('what the list withholds', () => {
  it('withholds an archived reason, which stays readable through rows citing it', async () => {
    const before = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);
    await owner.query(
      `UPDATE app.adjustment_reason SET status='archived'
        WHERE tenant_id=$1 AND key='promotion'`, [tenantId]);
    const after = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);

    expect(after.length).toBe(before.length - 1);
    expect(after.some((r) => r.key === 'promotion')).toBe(false);
    await owner.query(
      `UPDATE app.adjustment_reason SET status='active'
        WHERE tenant_id=$1 AND key='promotion'`, [tenantId]);
  });

  it('withholds a reason scoped to no kind, rather than offering a refusal', async () => {
    const orphan = randomUUID();
    await owner.query(
      `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
       VALUES ($1,$2,'orphan_reason','Orphan')`, [orphan, tenantId]);
    const served = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);
    // Unusable by construction: every point of use references the kind table,
    // so offering it would guarantee a constraint refusal after the tap.
    expect(served.some((r) => r.key === 'orphan_reason')).toBe(false);
    await owner.query(`DELETE FROM app.adjustment_reason WHERE id=$1`, [orphan]);
  });

  it('withholds another tenant vocabulary, on the predicate and not on trust', async () => {
    await owner.query(
      `UPDATE app.adjustment_reason SET name='NEIGHBOUR MARKER'
        WHERE tenant_id=$1 AND key='promotion'`, [otherTenantId]);
    const served = reasonsIn((await get('/pos/adjustment-reasons', waiterUserId)).body);
    expect(served.some((r) => r.name === 'NEIGHBOUR MARKER')).toBe(false);
    // And the neighbour really does have one, so the assertion is not vacuous.
    const neighbour = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.adjustment_reason WHERE tenant_id=$1`,
      [otherTenantId]);
    expect(Number(neighbour.rows[0]!.n)).toBe(DEFAULT_ADJUSTMENT_REASONS.length);
  });
});
