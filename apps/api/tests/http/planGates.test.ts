import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import pg from 'pg';
import { ENTITLEMENTS, getAdminMenu, type PlanKey } from '@katkitchen/shared';
import { applyDueChanges } from '../../src/modules/billing/scheduledChange.js';
import { ownerClient } from '../helpers/db.js';
import { buildServer } from '../../src/app.js';
import {
  PlanGateWithoutCacheError, planGates, registerTenantRoute, resetRegistry, type RouteDefinition,
} from '../../src/core/middleware/routeRegistry.js';
import { signToken, verifyToken } from '../../src/modules/auth/jwt.js';
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
import {
  RedisEntitlementCache, createRedis,
} from '../../src/modules/platform/redisEntitlementCache.js';
import {
  EntitlementUnavailableError, resolveEntitlement, type EntitlementCache,
} from '../../src/modules/platform/entitlements.js';
import { entitlementInvalidationConsumer } from '../../src/modules/notifications/outboxConsumers.js';
import { slugify } from '../../src/modules/platform/slug.js';

/**
 * Plan gates, end to end: restaurants provisioned through the Sales Person's
 * route, signed in through their own login, and served by the REAL assembly
 * against the REAL Redis cache -- starting empty, so every first read is a
 * miss filled from the document provisioning published.
 */

const KEY = 'plan-gates-signing-key-long-enough-for-hs256';
let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
let rep: string;
let versions: ReadonlyMap<string, string>;
let routes: readonly RouteDefinition[];

interface Made {
  readonly tenantId: string; readonly slug: string; readonly token: string;
  readonly branchToken: string; readonly subscriptionId: string;
}
let basic: Made;
let standard: Made;
let pro: Made;

async function http(method: string, url: string, token: string, payload?: unknown) {
  const response = await app.inject({
    method: method as never,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function repToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
}

async function createRestaurant(name: string, plan: PlanKey): Promise<Made> {
  const slug = `${slugify(name)}-${randomUUID().slice(0, 6)}`;
  const email = `manager@${slug}.test`;
  const password = `${slug}-password`;
  const made = await app.inject({
    method: 'POST', url: '/api/platform/tenants',
    headers: {
      authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
      'idempotency-key': `idem-${randomUUID()}`,
    },
    payload: {
      slug, name, currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email,
      ownerName: `${name} Manager`, firstBranchName: 'Main',
      planVersionId: versions.get(plan), taxJurisdiction: 'IN',
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const { tenantId, inviteToken } = made.json() as { tenantId: string; inviteToken: string };
  const accepted = await app.inject({
    method: 'POST', url: '/api/auth/invite/accept',
    headers: { 'content-type': 'application/json' },
    payload: { token: inviteToken, password },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const login = await app.inject({
    method: 'POST', url: `/api/auth/${slug}/login`,
    headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const token = (login.json() as { accessToken: string }).accessToken;

  // Terminal enrolment is branch-scoped, so the device tests need a token that
  // names the branch: the same claims, re-signed with it.
  const branchId = (await db.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;
  const branchToken = signToken({ ...verifyToken(token, KEY), branch_id: branchId }, KEY);
  const subscriptionId = (await db.query<{ id: string }>(
    `SELECT id FROM platform.subscription WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;
  return { tenantId, slug, token, branchToken, subscriptionId };
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
     VALUES ($1, $2, 'argon2id$stub', 'Plan Rep', $3)`, [rep, `plans+${rep}@platform.test`, roleId]);
  versions = await ensureStandardPlans(db, rep);

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
    pool: appPool, ownerPool, jwtKey: KEY, routes,
    entitlements: new RedisEntitlementCache(redis),
  }, new Set(routes.map((r) => `${r.method} ${r.url}`)));
  await app.ready();

  basic = await createRestaurant('Basic Bistro', 'basic');
  standard = await createRestaurant('Standard Cafe', 'standard');
  pro = await createRestaurant('Pro Kitchen', 'pro');
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await redis?.quit();
  await db?.end();
});

/* ------------------------------------------------------------- declared --- */

/**
 * The permission namespaces a plan decides. Derived from the key, so a new
 * `kot.*` route is covered the day it is added. (`kds.*` left with the
 * kitchen screen, 0077: no route carries one.)
 */
const NAMESPACE_GATE: Readonly<Record<string, string>> = {
  kot: 'feature:kot',
  report: 'reports',
};

function undeclared(candidates: readonly RouteDefinition[]): string[] {
  return candidates.flatMap((route) => {
    if (route.plane !== 'tenant' || route.permission?.plane !== 'tenant') return [];
    const expected = NAMESPACE_GATE[route.permission.key.split('.')[0]!];
    if (expected === undefined) return [];
    const declared = route.plan === undefined ? [] : planGates(route.plan).map((gate) =>
      'feature' in gate ? `feature:${gate.feature}` : 'reports' in gate ? 'reports' : null);
    return declared.includes(expected) ? [] : [`${route.method} ${route.url} (${route.permission.key})`];
  });
}

describe('every route a plan decides declares its gate', () => {
  it('holds over the whole route table', () => {
    const checked = routes.filter((r) =>
      r.permission?.plane === 'tenant' && NAMESPACE_GATE[r.permission.key.split('.')[0]!] !== undefined);
    // Non-vacuous: the set this test reasons about is the one that matters.
    // 12 -> 10 with 0077: the two kitchen-screen routes went with the screen.
    expect(checked.length).toBeGreaterThanOrEqual(10);
    const urls = new Set(checked.map((r) => `${r.method} ${r.url}`));
    for (const must of [
      'POST /pos/order/:id/fire', 'POST /pos/kot/:id/reprint', 'POST /pos/kot/:id/ready',
      'GET /admin/reports/exception',
    ]) expect(urls, must).toContain(must);
    expect(undeclared(routes)).toEqual([]);
  });

  it('catches a route written without one', () => {
    const synthetic: RouteDefinition = {
      method: 'GET', url: '/pos/synthetic', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kot.fire' }, audit: 'none',
      handler: async () => ({}),
    };
    const wrongGate: RouteDefinition = { ...synthetic, url: '/pos/wrong', plan: { reports: 'advanced' } };
    expect(undeclared([synthetic, wrongGate])).toEqual([
      'GET /pos/synthetic (kot.fire)',
      'GET /pos/wrong (kot.fire)',
    ]);
  });

  it('refuses to boot a gated route with no cache to check it against', () => {
    const bare = Fastify();
    const gated: RouteDefinition = {
      method: 'GET', url: '/admin/gated', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kot.fire' }, audit: 'none',
      plan: { feature: 'kot' }, handler: async () => ({}),
    };
    expect(() => registerTenantRoute(bare, { pool: appPool }, gated))
      .toThrow(PlanGateWithoutCacheError);
    // `reports: 'basic'` is every plan and checks nothing, so it needs no cache.
    expect(() => registerTenantRoute(bare, { pool: appPool }, {
      ...gated, url: '/admin/basic-report', plan: { reports: 'basic' },
    })).not.toThrow();
  });
});

/* ------------------------------------------------------------ the menu --- */

describe('the admin menu comes from the same document', () => {
  it('reports each plan exactly as ENTITLEMENTS defines it', async () => {
    for (const [made, plan] of [[basic, 'basic'], [standard, 'standard'], [pro, 'pro']] as const) {
      const read = await http('GET', '/api/t/admin/entitlements', made.token);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body['planKey']).toBe(plan);
      expect(read.body['entitlements']).toEqual(ENTITLEMENTS[plan]);
      expect(read.body['menu']).toEqual(getAdminMenu(ENTITLEMENTS[plan]));
    }
  });

  it('says how much of each limit is in use, from the same counts the gates refuse on', async () => {
    const read = await http('GET', '/api/t/admin/entitlements', basic.token);
    const usage = read.body['usage'] as Record<string, number>;
    expect(Object.keys(usage).sort()).toEqual(['branches', 'devices', 'users']);
    expect(usage['branches']).toBe(1);
    // The owner, provisioned with two memberships, is one restaurant user.
    expect(usage['users']).toBe(1);
  });

  it('applies the menu rules', () => {
    expect(getAdminMenu(ENTITLEMENTS.basic)).toEqual({ branches: false, kot: true, kds: false, devices: true, reports: false, tables: false });
    expect(getAdminMenu(ENTITLEMENTS.standard)).toEqual({ branches: false, kot: true, kds: false, devices: true, reports: true, tables: true });
    expect(getAdminMenu(ENTITLEMENTS.pro)).toEqual({ branches: true, kot: true, kds: true, devices: true, reports: true, tables: true });
  });
});

/* ------------------------------------------------------------ features --- */

describe('a Basic restaurant', () => {
  it.each([
    ['GET', '/api/t/admin/floors', 'Floors and tables', 'Standard'],
    ['GET', '/api/t/admin/reports/staff?from=2026-01-01&to=2026-01-31', 'The advanced reports', 'Standard'],
    ['GET', '/api/t/admin/reports/exception?from=2026-01-01&to=2026-01-31', 'The advanced reports', 'Standard'],
  ])('is refused %s %s with 402 naming the cheapest plan that has it', async (method, url, what, on) => {
    const refused = await http(method, url, basic.token);
    expect(refused.status, JSON.stringify(refused.body)).toBe(402);
    expect(refused.body['error']).toBe('upgrade_required');
    expect(String(refused.body['detail'])).toContain(what);
    expect(String(refused.body['detail'])).toContain(`available on ${on}`);
  });

  it('has KOT: the ticket read is past the gate', async () => {
    const tickets = await http('GET', `/api/t/pos/order/${randomUUID()}/tickets`, basic.branchToken);
    expect(tickets.status, JSON.stringify(tickets.body)).not.toBe(402);
  });

  it('keeps the sales report the dashboard reads', async () => {
    const sales = await http('GET', '/api/t/admin/reports/sales?from=2026-01-01&to=2026-01-31', basic.token);
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  });

  it('cannot open a second branch', async () => {
    const second = await http('POST', '/api/t/admin/branches', basic.token, {
      code: 'B2', name: 'Second', timezone: 'Asia/Kolkata', business_day_starts_at: '04:00',
      gst_registration: 'unregistered',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(402);
    expect(second.body['error']).toBe('upgrade_required');
    const branches = await db.query(`SELECT 1 FROM app.branch WHERE tenant_id = $1`, [basic.tenantId]);
    expect(branches.rowCount).toBe(1);
  });

  it('has no tablet setup code to issue: a till is made at a manager\'s sign-in', async () => {
    const issued = await http('POST', '/api/t/admin/devices', basic.branchToken, {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(404);
  });
});

describe('Pro', () => {
  it('has floors and tables and every report', async () => {
    const floors = await http('GET', '/api/t/admin/floors', pro.token);
    expect(floors.status, JSON.stringify(floors.body)).not.toBe(402);
    expect((await http('GET', '/api/t/admin/reports/staff?from=2026-01-01&to=2026-01-31', pro.token)).status).toBe(200);
    const exception = await http('GET', '/api/t/admin/reports/exception?from=2026-01-01&to=2026-01-31', pro.token);
    expect(exception.status, JSON.stringify(exception.body)).toBe(200);
  });

  it('may open a second branch', async () => {
    const second = await http('POST', '/api/t/admin/branches', pro.token, {
      code: 'B2', name: 'Second', timezone: 'Asia/Kolkata', business_day_starts_at: '04:00',
      gst_registration: 'unregistered',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
  });
});

/* ------------------------------------------------------------- upgrade --- */

describe('an upgrade reaches the restaurant without a restart', () => {
  it('Basic to Pro: the new document is published and the cached one dropped', async () => {
    // Warm the cache with the Basic document.
    const floors = '/api/t/admin/floors';
    expect((await http('GET', floors, basic.token)).status).toBe(402);

    const changed = await app.inject({
      method: 'POST', url: `/api/platform/subscriptions/${basic.subscriptionId}/change`,
      headers: {
        authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: { planVersionId: versions.get('pro') },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const latest = await db.query<{ plan_key: string; version: string }>(
      `SELECT plan_key, version::text FROM platform.entitlement_document
        WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [basic.tenantId]);
    expect(latest.rows[0]!.plan_key).toBe('pro');

    // What the outbox worker does with the message the upgrade enqueued.
    const message = await db.query<{ id: string }>(
      `SELECT id FROM platform.outbox WHERE topic = 'entitlement.invalidate' AND dedupe_key = $1`,
      [`${basic.tenantId}:${latest.rows[0]!.version}`]);
    expect(message.rowCount).toBe(1);
    await entitlementInvalidationConsumer.handle(db, {
      id: message.rows[0]!.id, topic: 'entitlement.invalidate', tenantId: basic.tenantId,
      payload: {}, attempts: 0,
    } as never);

    expect((await http('GET', floors, basic.token)).status).not.toBe(402);
  });
});

/* ------------------------------------------------------- kitchen screen --- */

describe('floors and further branches are decided by the plan alone', () => {
  const newest = async (tenantId: string) => (await db.query<{ version: string; plan_key: string; features: Record<string, boolean> }>(
    `SELECT version::text, plan_key, features FROM platform.entitlement_document
      WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [tenantId])).rows[0]!;

  /** What the outbox worker does with the invalidation a publish enqueued. */
  async function deliverInvalidation(tenantId: string): Promise<void> {
    const latest = await newest(tenantId);
    const message = await db.query<{ id: string }>(
      `SELECT id FROM platform.outbox WHERE topic = 'entitlement.invalidate' AND dedupe_key = $1`,
      [`${tenantId}:${latest.version}`]);
    expect(message.rowCount).toBe(1);
    await entitlementInvalidationConsumer.handle(db, {
      id: message.rows[0]!.id, topic: 'entitlement.invalidate', tenantId, payload: {}, attempts: 0,
    } as never);
  }

  async function changePlan(made: Made, plan: PlanKey): Promise<void> {
    const changed = await app.inject({
      method: 'POST', url: `/api/platform/subscriptions/${made.subscriptionId}/change`,
      headers: {
        authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: { planVersionId: versions.get(plan) },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const result = changed.json() as { effect: string; scheduled?: { id: string } };
    if (result.effect === 'at_period_end') {
      // A contraction waits for the period boundary: run the boundary now, for
      // this change's own effective instant, as the scheduler would.
      const due = await db.query<{ effective_at: Date }>(
        `SELECT effective_at FROM platform.scheduled_subscription_change WHERE id = $1`, [result.scheduled!.id]);
      const applied = await applyDueChanges(db, { now: due.rows[0]!.effective_at });
      expect(applied.find((a) => a.changeId === result.scheduled!.id)?.outcome).toBe('applied');
    }
    expect((await newest(made.tenantId)).plan_key).toBe(plan);
    await deliverInvalidation(made.tenantId);
  }

  const tablesStatus = async (made: Made) => (await http('GET', '/api/t/admin/floors', made.token)).status;
  const branchStatus = async (made: Made) => (await http('POST', '/api/t/admin/branches', made.token, {
    code: `B${randomUUID().slice(0, 4)}`, name: `Branch ${randomUUID().slice(0, 4)}`, timezone: 'Asia/Kolkata',
    business_day_starts_at: '04:00', gst_registration: 'unregistered',
  })).status;

  it('the Sales Person states only the plan; the document says what it includes', async () => {
    // A fresh Basic: the shared one is upgraded to Pro by the suite above.
    const fresh = await createRestaurant('Fresh Basic', 'basic');
    for (const [made, plan] of [[fresh, 'basic'], [standard, 'standard'], [pro, 'pro']] as const) {
      const document = await newest(made.tenantId);
      expect(document.plan_key).toBe(plan);
      expect(document.features['kds']).toBe(ENTITLEMENTS[plan].kds);
      expect(document.features['kot']).toBe(true);
    }
  });

  it('there is no restaurant-level switch to disagree with the plan', async () => {
    const column = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'tenant' AND column_name = 'kds_enabled'`);
    expect(column.rowCount).toBe(0);

    // A `kdsEnabled` sent anyway is not a field this route knows, so it changes nothing.
    const edit = await app.inject({
      method: 'PATCH', url: `/api/platform/tenants/${standard.tenantId}`,
      headers: {
        authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: { kdsEnabled: true },
    });
    expect(edit.statusCode).toBe(400);
    expect((await newest(standard.tenantId)).features['kds']).toBe(false);
  });

  it('Standard: floors and tables, no second branch, KOT and the reports', async () => {
    expect(await tablesStatus(standard)).not.toBe(402);
    expect(await branchStatus(standard)).toBe(402);
    const tickets = await http('GET', `/api/t/pos/order/${randomUUID()}/tickets`, standard.branchToken);
    expect(tickets.status, 'KOT is past the gate').not.toBe(402);
    expect((await http('GET', '/api/t/admin/reports/staff?from=2026-01-01&to=2026-01-31', standard.token)).status).toBe(200);
  });

  it('Basic -> Standard -> Pro -> Standard -> Basic: the plan change alone moves both', async () => {
    const moving = await createRestaurant('Moving Kitchen', 'basic');
    expect(await tablesStatus(moving)).toBe(402);

    await changePlan(moving, 'standard');
    expect(await tablesStatus(moving), 'Standard has floors and tables').not.toBe(402);
    expect(await branchStatus(moving), 'but not a second branch').toBe(402);

    await changePlan(moving, 'pro');
    expect(await tablesStatus(moving)).not.toBe(402);
    expect(await branchStatus(moving), 'Pro has further branches').toBe(200);

    await changePlan(moving, 'standard');
    expect(await tablesStatus(moving)).not.toBe(402);
    expect(await branchStatus(moving), 'a downgrade takes further branches away').toBe(402);

    await changePlan(moving, 'basic');
    expect(await tablesStatus(moving), 'Basic has no floors and tables').toBe(402);
    expect(await branchStatus(moving)).toBe(402);
  });
});

/* --------------------------------------------------------- read-through --- */

describe('the cache is an optimisation of the document table, not a gate of its own', () => {
  const broken: EntitlementCache = {
    async get() { throw new Error('connection lost'); },
    async put() { throw new Error('connection lost'); },
  };

  it('reads the real document when Redis fails -- the real plan, not an unlimited one', async () => {
    const errors: unknown[] = [];
    const document = await resolveEntitlement(broken, db, pro.tenantId, (e) => errors.push(e));
    expect(document.planKey).toBe('pro');
    expect(document.limits['devices']).toBe(ENTITLEMENTS.pro.devices);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still fails closed for a restaurant that has no document at all', async () => {
    await expect(resolveEntitlement(broken, db, randomUUID()))
      .rejects.toThrow(EntitlementUnavailableError);
  });
});
