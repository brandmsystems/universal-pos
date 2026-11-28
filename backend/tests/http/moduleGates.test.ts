import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUSINESS_MODULE_KEYS, BUSINESS_TYPES, defaultModulesFor } from '@universalpos/shared';
import { assertCheckedSet, ownerClient } from '../helpers/db.js';
import { buildServer } from '../../src/server/app.js';
import { resetRegistry, type RouteDefinition } from '../../src/middleware/routeRegistry.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { allRoutes } from '../../src/routes/index.js';
import { isUnserved, mergeHandlers } from '../../src/routes/lookup.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { syncHandlers } from '../../src/routes/handlers/sync.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { staffHandlers } from '../../src/routes/handlers/staff.js';
import { reportHandlers } from '../../src/routes/handlers/reports.js';
import { crmHandlers } from '../../src/routes/handlers/crm.js';
import { planHandlers } from '../../src/routes/handlers/plan.js';
import { setupHandlers } from '../../src/routes/handlers/setup.js';
import { accessHandlers } from '../../src/routes/handlers/access.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { authHandlers } from '../../src/routes/handlers/auth.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { ensureStandardPlans } from '../../src/modules/platform/planCatalogue.js';
import { RedisEntitlementCache, createRedis } from '../../src/modules/platform/redisEntitlementCache.js';
import { entitlementInvalidationConsumer } from '../../src/modules/notifications/outboxConsumers.js';
import { slugify } from '../../src/modules/platform/slug.js';

/**
 * Tenant modules, end to end (Phase 1): a tenant is provisioned with the modules its
 * business type starts with (or the ones the wizard chose), the control plane
 * publishes them in the entitlement document, and a route that belongs to a module
 * is refused with 402 `module_disabled` when it is off. A restaurant that existed
 * before modules keeps every route it had.
 */

const KEY = 'module-gates-signing-key-long-enough-for-hs256';
let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
let rep: string;
let proVersion: string;
let routes: readonly RouteDefinition[];

function repToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
}

const platformHeaders = () => ({
  authorization: `Bearer ${repToken()}`, 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}`,
});

interface Made { tenantId: string; slug: string; token: string }

async function createTenant(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; made?: Made }> {
  const slug = `${slugify('Module Probe')}-${randomUUID().slice(0, 6)}`;
  const email = `manager@${slug}.test`;
  const password = `${slug}-password`;
  const response = await app.inject({
    method: 'POST', url: '/api/platform/tenants', headers: platformHeaders(),
    payload: {
      slug, name: 'Module Probe', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email,
      ownerName: 'Probe Manager', firstBranchName: 'Main', planVersionId: proVersion, taxJurisdiction: 'IN',
      ...payload,
    },
  });
  const body = response.json() as Record<string, unknown>;
  if (response.statusCode !== 200) return { status: response.statusCode, body };
  const tenantId = body['tenantId'] as string;
  const accepted = await app.inject({
    method: 'POST', url: '/api/auth/invite/accept', headers: { 'content-type': 'application/json' },
    payload: { token: body['inviteToken'], password },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const login = await app.inject({
    method: 'POST', url: `/api/auth/${slug}/login`, headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { status: 200, body, made: { tenantId, slug, token: (login.json() as { accessToken: string }).accessToken } };
}

const ticketsStatus = async (made: Made): Promise<{ status: number; body: string }> => {
  const response = await app.inject({
    method: 'GET', url: `/api/t/pos/order/${randomUUID()}/tickets`,
    headers: { authorization: `Bearer ${made.token}` },
  });
  return { status: response.statusCode, body: response.body };
};

const newestModules = async (tenantId: string): Promise<string[]> => {
  const row = (await db.query<{ modules: Record<string, boolean> }>(
    `SELECT modules FROM platform.entitlement_document WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
    [tenantId])).rows[0]!;
  return Object.keys(row.modules).sort();
};

async function deliverLatestInvalidation(tenantId: string): Promise<void> {
  const latest = (await db.query<{ version: string }>(
    `SELECT version::text FROM platform.entitlement_document WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
    [tenantId])).rows[0]!;
  const message = await db.query<{ id: string }>(
    `SELECT id FROM platform.outbox WHERE topic = 'entitlement.invalidate' AND dedupe_key = $1`,
    [`${tenantId}:${latest.version}`]);
  expect(message.rowCount).toBe(1);
  await entitlementInvalidationConsumer.handle(db, {
    id: message.rows[0]!.id, topic: 'entitlement.invalidate', tenantId, payload: {}, attempts: 0,
  } as never);
}

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const roleId = (await db.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Module Rep', $3)`, [rep, `modules+${rep}@platform.test`, roleId]);
  proVersion = (await ensureStandardPlans(db, rep)).get('pro')!;

  redis = createRedis(process.env['REDIS_URL'] ?? 'redis://localhost:6380');
  await redis.connect();
  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  routes = allRoutes(handlers).filter((r) => !isUnserved(r.handler));
  app = buildServer({
    pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: new RedisEntitlementCache(redis),
  }, new Set(routes.map((r) => `${r.method} ${r.url}`)));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await redis?.quit();
  await db?.end();
});

describe('the module catalogue is derived from the registry', () => {
  it('names every module any type uses, once, and every type starts with the till', () => {
    assertCheckedSet({
      label: 'business modules', checked: [...BUSINESS_MODULE_KEYS], minimum: 20,
      mustInclude: ['pos', 'kitchen', 'kot', 'tables', 'prescriptions', 'appointments', 'barcode_checkout'],
    });
    expect(new Set(BUSINESS_MODULE_KEYS).size).toBe(BUSINESS_MODULE_KEYS.length);
    for (const type of Object.values(BUSINESS_TYPES)) {
      expect(defaultModulesFor(type.key)).toContain('pos');
    }
  });
});

describe('provisioning configures the modules', () => {
  it('a restaurant, with no modules named, gets the restaurant defaults', async () => {
    const { made } = await createTenant({});
    expect(await newestModules(made!.tenantId)).toEqual([...defaultModulesFor('restaurant')].sort());
  });

  it('a general-retail business gets the retail defaults, and no kitchen', async () => {
    const { made } = await createTenant({ businessType: 'general_retail' });
    const modules = await newestModules(made!.tenantId);
    expect(modules).toEqual([...defaultModulesFor('general_retail')].sort());
    expect(modules).not.toContain('kitchen');
    expect(modules).not.toContain('kot');
  });

  it('the wizard may choose the modules; the table and the document agree', async () => {
    const { made } = await createTenant({ businessType: 'general_retail', modules: ['pos', 'products'] });
    expect(await newestModules(made!.tenantId)).toEqual(['pos', 'products']);
    const rows = await db.query<{ module_key: string }>(
      `SELECT module_key FROM platform.tenant_module WHERE tenant_id = $1 AND enabled ORDER BY module_key`,
      [made!.tenantId]);
    expect(rows.rows.map((r) => r.module_key)).toEqual(['pos', 'products']);
  });

  it('refuses a request without the till, and an unknown module, creating nothing', async () => {
    const before = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform.tenant`)).rows[0]!.n;
    const noTill = await createTenant({ modules: ['kitchen'] });
    expect(noTill.status).toBe(400);
    expect(noTill.body['error']).toBe('tenant_modules_invalid');
    const unknown = await createTenant({ modules: ['pos', 'time_machine'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body['error']).toBe('tenant_modules_invalid');
    const after = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform.tenant`)).rows[0]!.n;
    expect(after, 'a refused wizard leaves no half-made tenant').toBe(before);
  });
});

describe('a route of a module is enforced on the backend', () => {
  it('the KOT routes are declared against the kot module, and the tables routes against tables', () => {
    const gated = routes.filter((r) => r.plan !== undefined && JSON.stringify(r.plan).includes('"module"'));
    assertCheckedSet({
      label: 'module-gated routes', checked: gated.map((r) => `${r.method} ${r.url}`), minimum: 7,
      mustInclude: ['POST /pos/order/:id/fire', 'GET /pos/order/:id/tickets', 'POST /pos/session'],
    });
  });

  it('a restaurant passes the gate; a retail business without the module gets 402 module_disabled', async () => {
    const restaurant = (await createTenant({})).made!;
    const passed = await ticketsStatus(restaurant);
    expect(passed.status, passed.body).not.toBe(402);

    const retail = (await createTenant({ businessType: 'general_retail' })).made!;
    const refused = await ticketsStatus(retail);
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body).error).toBe('module_disabled');
  });

  it('switching the module on republishes the document and opens the route; off closes it again', async () => {
    const retail = (await createTenant({ businessType: 'general_retail' })).made!;
    expect((await ticketsStatus(retail)).status).toBe(402);

    const patch = (modules: string[]) => app.inject({
      method: 'PATCH', url: `/api/platform/tenants/${retail.tenantId}`, headers: platformHeaders(), payload: { modules },
    });
    const on = await patch([...defaultModulesFor('general_retail'), 'kot']);
    expect(on.statusCode, on.body).toBe(200);
    await deliverLatestInvalidation(retail.tenantId);
    expect(await newestModules(retail.tenantId)).toContain('kot');
    const opened = await ticketsStatus(retail);
    expect(opened.status, opened.body).not.toBe(402);

    const off = await patch([...defaultModulesFor('general_retail')]);
    expect(off.statusCode, off.body).toBe(200);
    await deliverLatestInvalidation(retail.tenantId);
    expect((await ticketsStatus(retail)).status).toBe(402);
    // Switched off is a row kept as history, not a deleted one.
    const kept = await db.query<{ enabled: boolean }>(
      `SELECT enabled FROM platform.tenant_module WHERE tenant_id = $1 AND module_key = 'kot'`, [retail.tenantId]);
    expect(kept.rows[0]!.enabled).toBe(false);
  });

  it('the till cannot be switched off, and a tenant request cannot name modules at all', async () => {
    const retail = (await createTenant({ businessType: 'general_retail' })).made!;
    const noTill = await app.inject({
      method: 'PATCH', url: `/api/platform/tenants/${retail.tenantId}`, headers: platformHeaders(),
      payload: { modules: ['products'] },
    });
    expect(noTill.statusCode).toBe(400);
    // A tenant (manager) token on the control-plane route is refused by the plane guard.
    const tenantTry = await app.inject({
      method: 'PATCH', url: `/api/platform/tenants/${retail.tenantId}`,
      headers: { authorization: `Bearer ${retail.token}`, 'content-type': 'application/json' },
      payload: { modules: ['pos', 'kot'] },
    });
    expect([401, 403]).toContain(tenantTry.statusCode);
    expect(await newestModules(retail.tenantId)).not.toContain('kot');
  });
});

describe('restaurants that existed before modules keep everything', () => {
  it("the migration's own backfill gives a restaurant the six restaurant modules, and its document too", async () => {
    // Runs the statements of 0091 itself against a restaurant stripped of its rows, inside a
    // transaction that is rolled back; ON CONFLICT lets it skip tenants that already have theirs.
    const { made } = await createTenant({});
    const sql = readFileSync(resolve(__dirname, '../../../database/migrations/0091_tenant_modules.up.sql'), 'utf8');
    const statements = sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim());
    const backfill = statements.find((s) => s.startsWith('INSERT INTO platform.tenant_module'));
    const documents = statements.find((s) => s.startsWith('UPDATE platform.entitlement_document'));
    expect(backfill, 'the migration still has its backfill').toBeTruthy();
    expect(documents, 'the migration still backfills published documents').toBeTruthy();
    await db.query('BEGIN');
    try {
      await db.query(`DELETE FROM platform.tenant_module WHERE tenant_id = $1`, [made!.tenantId]);
      await db.query(`UPDATE platform.entitlement_document SET modules = '{}'::jsonb WHERE tenant_id = $1`, [made!.tenantId]);
      await db.query(`${backfill!} ON CONFLICT DO NOTHING`);
      await db.query(documents!);
      expect(await newestModules(made!.tenantId)).toEqual([...defaultModulesFor('restaurant')].sort());
      const rows = await db.query(`SELECT 1 FROM platform.tenant_module WHERE tenant_id = $1 AND enabled`, [made!.tenantId]);
      expect(rows.rowCount).toBe(6);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
