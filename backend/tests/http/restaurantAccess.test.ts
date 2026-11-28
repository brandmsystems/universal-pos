import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { buildServer } from '../../src/server/app.js';
import { resetRegistry } from '../../src/middleware/routeRegistry.js';
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
import { slugify, slugProblem } from '../../src/modules/platform/slug.js';
import { planCache } from '../helpers/plans.js';

/**
 * A restaurant's own address, `/{slug}`, and the wall between restaurants --
 * driven through the REAL server assembly, not a hand-built fixture of it.
 *
 * The slug only chooses which restaurant's sign-in page to show. Which
 * restaurant a session belongs to comes from the verified login, and every
 * tenant route takes the tenant from the token alone. These tests attack that
 * from every side the brief named: another restaurant's slug in the URL,
 * another restaurant's row id in the request, and one restaurant's password at
 * another restaurant's door.
 */

const KEY = 'restaurant-access-signing-key-long-enough';
let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let basicVersion: string;

interface Made { readonly tenantId: string; readonly slug: string; readonly email: string; readonly token: string }
let restaurantA: Made;
let restaurantB: Made;

const PASSWORD_A = 'restaurant-a-password';
const PASSWORD_B = 'restaurant-b-password';

async function http(method: string, url: string, options: { token?: string; payload?: unknown } = {}) {
  const response = await app.inject({
    method: method as never,
    url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.payload !== undefined ? { payload: options.payload as never } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function repToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
}

/** Created through the Sales Person's route, and its password set through its own setup link. */
async function createRestaurant(name: string, password: string): Promise<Made> {
  const slug = `${slugify(name)}-${randomUUID().slice(0, 6)}`;
  const email = `manager@${slug}.test`;
  const made = await app.inject({
    method: 'POST', url: '/api/platform/tenants',
    headers: {
      authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
      'idempotency-key': `idem-${randomUUID()}`,
    },
    payload: {
      slug, name, currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: `${name} Manager`,
      firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN',
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const body = made.json() as { tenantId: string; inviteToken: string };
  const accepted = await http('POST', '/api/auth/invite/accept', {
    payload: { token: body.inviteToken, password },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const login = await http('POST', `/api/auth/${slug}/login`, { payload: { email, password } });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { tenantId: body.tenantId, slug, email, token: login.body['accessToken'] as string };
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
     VALUES ($1, $2, 'argon2id$stub', 'Access Rep', $3)`, [rep, `access+${rep}@platform.test`, roleId]);
  basicVersion = (await ensureStandardPlans(db, rep)).get('basic')!;

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((r) => !isUnserved(r.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: planCache() },
    new Set(routes.map((r) => `${r.method} ${r.url}`)));
  await app.ready();

  restaurantA = await createRestaurant('ABC Restaurant', PASSWORD_A);
  restaurantB = await createRestaurant('Fresh & Tasty', PASSWORD_B);
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('each restaurant gets its own unique slug', () => {
  it('turns a name into a URL-friendly slug', () => {
    expect(slugify('ABC Restaurant')).toBe('abc-restaurant');
    expect(slugify('Fresh & Tasty')).toBe('fresh-tasty');
    expect(slugify('Spice House Dubai')).toBe('spice-house-dubai');
    expect(slugify('  Café  Délice!! ')).toBe('cafe-delice');
  });

  it('gave restaurant A and B different slugs', () => {
    expect(restaurantA.slug).toMatch(/^abc-restaurant-/);
    expect(restaurantB.slug).toMatch(/^fresh-tasty-/);
    expect(restaurantA.slug).not.toBe(restaurantB.slug);
  });

  it('refuses a duplicate slug with the message the form shows', async () => {
    const again = await app.inject({
      method: 'POST', url: '/api/platform/tenants',
      headers: {
        authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: {
        slug: restaurantA.slug, name: 'Copycat', currency: 'INR', timezone: 'Asia/Kolkata',
        ownerEmail: 'copy@cat.test', ownerName: 'Copy', firstBranchName: 'Main',
        planVersionId: basicVersion, taxJurisdiction: 'IN',
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: 'slug_taken',
      detail: 'This restaurant slug is already in use. Please choose another slug.',
    });
  });

  it('normalises separators: repeated or edge hyphens never come out of a name', () => {
    expect(slugify('ABC -- Family  Restaurant -')).toBe('abc-family-restaurant');
    expect(slugify('--Spice__Hub--')).toBe('spice-hub');
    // ...and a hand-typed slug with them is refused, by the rule the form and server share.
    for (const bad of ['abc--cafe', 'abc-', 'a', '-abc']) expect(slugProblem(bad), bad).not.toBeNull();
    expect(slugProblem('abc-family-restaurant')).toBeNull();
  });

  it('the database refuses a dirty slug on any new or changed row, not just the form', async () => {
    await expect(db.query(`UPDATE platform.tenant SET slug = $2 WHERE id = $1`,
      [restaurantA.tenantId, `${restaurantA.slug}--x`])).rejects.toThrow(/tenant_slug_clean/);
    await expect(db.query(`UPDATE platform.tenant SET slug = $2 WHERE id = $1`,
      [restaurantA.tenantId, `${restaurantA.slug}-`])).rejects.toThrow(/tenant_slug_clean|tenant_slug_format/);
  });

  it('two restaurants created at once with one slug: one gets it, the other is told it is taken', async () => {
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const create = (n: number) => app.inject({
      method: 'POST', url: '/api/platform/tenants',
      headers: {
        authorization: `Bearer ${repToken()}`, 'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: {
        slug, name: `Race ${n}`, currency: 'INR', timezone: 'Asia/Kolkata',
        ownerEmail: `race${n}@${slug}.test`, ownerName: 'Racer', firstBranchName: 'Main',
        planVersionId: basicVersion, taxJurisdiction: 'IN',
      },
    });
    const results = await Promise.all([create(1), create(2)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({ error: 'slug_taken' });
    const rows = await db.query(`SELECT 1 FROM platform.tenant WHERE slug = $1`, [slug]);
    expect(rows.rowCount).toBe(1);
  });

  it('refuses a reserved or malformed slug, and says so before anything is created', async () => {
    expect(slugProblem('admin')).toMatch(/reserved/);
    expect(slugProblem('ABC Restaurant')).toMatch(/lowercase/);
    const check = await http('GET', '/api/platform/tenants/slug-available?slug=api', { token: repToken() });
    expect(check.body).toMatchObject({ available: false });
    // The Super Admin console's address: a restaurant there would shadow it.
    expect(slugProblem('superadmin')).toMatch(/reserved/);
    const superadmin = await http('GET', '/api/platform/tenants/slug-available?slug=superadmin', { token: repToken() });
    expect(superadmin.body).toMatchObject({ available: false });
    const taken = await http('GET', `/api/platform/tenants/slug-available?slug=${restaurantA.slug}`, { token: repToken() });
    expect(taken.body).toMatchObject({
      available: false, problem: 'This restaurant slug is already in use. Please choose another slug.' });
    const free = await http('GET', `/api/platform/tenants/slug-available?slug=nobody-${randomUUID().slice(0, 8)}`, { token: repToken() });
    expect(free.body).toMatchObject({ available: true, problem: null });
  });
});

describe('/{slug} shows that restaurant and no other', () => {
  it('answers restaurant A\'s address with restaurant A', async () => {
    const page = await http('GET', `/api/public/restaurants/${restaurantA.slug}`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      slug: restaurantA.slug, name: 'ABC Restaurant', signInAvailable: true, themeColor: null, themeColorSecondary: null, businessType: 'restaurant', logoUrl: null, formerSlugs: [],
      currency: 'INR', locale: 'en-IN', billRounding: 'nearest_rupee',
    });
  });

  it('answers restaurant B\'s address with restaurant B', async () => {
    const page = await http('GET', `/api/public/restaurants/${restaurantB.slug}`);
    expect(page.body).toMatchObject({ slug: restaurantB.slug, name: 'Fresh & Tasty' });
  });

  it('answers an unknown slug with a 404, not an empty page', async () => {
    const page = await http('GET', '/api/public/restaurants/no-such-restaurant-anywhere');
    expect(page.status).toBe(404);
    expect(page.body['error']).toBe('restaurant_not_found');
  });
});

describe('a restaurant signs in with its own credentials, and only reaches its own data', () => {
  it('rejects a wrong password, and restaurant A\'s password at restaurant B\'s door', async () => {
    const wrong = await http('POST', `/api/auth/${restaurantA.slug}/login`,
      { payload: { email: restaurantA.email, password: 'not-the-password' } });
    expect(wrong.status).toBe(401);
    const crossed = await http('POST', `/api/auth/${restaurantB.slug}/login`,
      { payload: { email: restaurantA.email, password: PASSWORD_A } });
    expect(crossed.status).toBe(401);
  });

  it('puts restaurant A\'s id in A\'s token and no other', () => {
    const claims = JSON.parse(Buffer.from(restaurantA.token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims['tenant_id']).toBe(restaurantA.tenantId);
  });

  it('lists only restaurant A\'s rows for restaurant A', async () => {
    const mine = await http('GET', '/api/t/admin/branches', { token: restaurantA.token });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const rows = (mine.body['rows'] ?? mine.body) as { id: string; tenant_id?: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const branchOfB = await db.query<{ id: string }>(
      `SELECT id FROM app.branch WHERE tenant_id = $1`, [restaurantB.tenantId]);
    expect(rows.map((r) => r.id)).not.toContain(branchOfB.rows[0]!.id);
  });

  it('cannot change restaurant B\'s data by naming B\'s row id', async () => {
    const branchOfB = (await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM app.branch WHERE tenant_id = $1`, [restaurantB.tenantId])).rows[0]!;
    const attempt = await http('PATCH', `/api/t/admin/branches/${branchOfB.id}`,
      { token: restaurantA.token, payload: { name: 'Taken over by A' } });
    const after = await db.query<{ name: string }>(`SELECT name FROM app.branch WHERE id = $1`, [branchOfB.id]);
    // RLS stops the write; the route must SAY so, not answer 200.
    expect(attempt.status, 'restaurant A must not reach restaurant B\'s row').toBe(404);
    expect(attempt.body['error']).toBe('row_not_found');
    expect(after.rows[0]!.name).toBe(branchOfB.name);
  });

  it('ignores a restaurant id smuggled in a header or query string', async () => {
    const smuggled = await app.inject({
      method: 'GET', url: `/api/t/admin/branches?tenantId=${restaurantB.tenantId}`,
      headers: { authorization: `Bearer ${restaurantA.token}`, 'x-tenant-id': restaurantB.tenantId },
    });
    const rows = ((smuggled.json() as Record<string, unknown>)['rows'] ?? smuggled.json()) as { id: string }[];
    const branchOfB = await db.query<{ id: string }>(
      `SELECT id FROM app.branch WHERE tenant_id = $1`, [restaurantB.tenantId]);
    expect(rows.map((r) => r.id)).not.toContain(branchOfB.rows[0]!.id);
  });
});

describe('a Super Admin can give a restaurant a new address, and the old one keeps working', () => {
  let superAdmin: string;
  let renamed: Made;
  let oldSlug: string;
  const adminToken = () => {
    const now = Math.floor(Date.now() / 1000);
    return signToken({ sub: superAdmin, platform_role: 'super_admin', iat: now, exp: now + 600 }, KEY);
  };
  const rename = (tenantId: string, slug: string, token = adminToken()) =>
    http('POST', `/api/platform/tenants/${tenantId}/slug`, { token, payload: { slug } });

  beforeAll(async () => {
    const roleId = (await db.query<{ id: string }>(
      `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)).rows[0]!.id;
    superAdmin = randomUUID();
    await db.query(
      `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
       VALUES ($1, $2, 'argon2id$stub', 'Rename Admin', $3)`, [superAdmin, `rename+${superAdmin}@platform.test`, roleId]);
    renamed = await createRestaurant('Rename Me', 'rename-me-password');
    oldSlug = renamed.slug;
  });

  it('is the Super Admin\'s alone: a Sales Person is refused', async () => {
    const res = await rename(renamed.tenantId, `sales-${randomUUID().slice(0, 6)}`, repToken());
    expect([res.status, res.body['error']]).toEqual([403, 'forbidden']);
  });

  it('renames, audits it, and the old address answers with the new one', async () => {
    const next = `renamed-${randomUUID().slice(0, 6)}`;
    const res = await rename(renamed.tenantId, next);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ slug: next, previousSlug: oldSlug });

    const viaOld = await http('GET', `/api/public/restaurants/${oldSlug}`);
    expect([viaOld.status, viaOld.body['slug']]).toEqual([200, next]);
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM platform.platform_audit_log WHERE target_id = $1 AND action = 'tenant.slug.changed'`,
      [renamed.tenantId]);
    expect(audit.rowCount).toBe(1);
    renamed = { ...renamed, slug: next };
  });

  it('sign-in and the till still work under the old address', async () => {
    const viaOld = await http('POST', `/api/auth/${oldSlug}/login`,
      { payload: { email: renamed.email, password: 'rename-me-password' } });
    expect(viaOld.status, JSON.stringify(viaOld.body)).toBe(200);
    // A till bookmarked at /<old-slug>/pos signs in and lists its staff as before.
    const fingerprint = `fp${randomUUID().replace(/-/g, '')}`;
    const till = await http('POST', `/api/auth/${oldSlug}/till`, {
      payload: { login: renamed.email, password: 'rename-me-password', deviceFingerprint: fingerprint, deviceName: 'Old link' },
    });
    expect(till.status, JSON.stringify(till.body)).toBe(200);
  });

  it('no other restaurant can take the old address, by rename or by create', async () => {
    const steal = await rename(restaurantB.tenantId, oldSlug);
    expect([steal.status, steal.body['error']]).toEqual([409, 'slug_taken']);
    const check = await http('GET', `/api/platform/tenants/slug-available?slug=${oldSlug}`, { token: repToken() });
    expect(check.body).toMatchObject({ available: false });
    const create = await app.inject({
      method: 'POST', url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${repToken()}`, 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}` },
      payload: {
        slug: oldSlug, name: 'Squatter', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: 'sq@uatter.test',
        ownerName: 'Squatter', firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN',
      },
    });
    expect([create.statusCode, (create.json() as { error: string }).error]).toEqual([409, 'slug_taken']);
  });

  it('the database refuses it too, whichever table is written', async () => {
    await expect(db.query(`UPDATE platform.tenant SET slug = $2 WHERE id = $1`, [restaurantB.tenantId, oldSlug]))
      .rejects.toThrow(/former address of another restaurant/);
    await expect(db.query(
      `INSERT INTO platform.tenant_slug_history (slug, tenant_id, retired_by_platform_user_id) VALUES ($1, $2, $3)`,
      [restaurantB.slug, renamed.tenantId, superAdmin])).rejects.toThrow(/address of another restaurant/);
  });

  it('the restaurant itself may take its old address back', async () => {
    const between = renamed.slug;
    const back = await rename(renamed.tenantId, oldSlug);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const history = await db.query<{ slug: string }>(
      `SELECT slug::text AS slug FROM platform.tenant_slug_history WHERE tenant_id = $1`, [renamed.tenantId]);
    expect(history.rows.map((h) => h.slug)).toEqual([between]);
    expect((await http('GET', `/api/public/restaurants/${between}`)).body['slug']).toBe(oldSlug);
    renamed = { ...renamed, slug: oldSlug };
  });

  it('refuses a dirty, reserved or unchanged slug, each for its own reason', async () => {
    for (const bad of ['abc--x', 'admin', 'Upper Case']) {
      const res = await rename(renamed.tenantId, bad);
      expect([res.status, res.body['error']], bad).toEqual([400, 'slug_invalid']);
    }
    const same = await rename(renamed.tenantId, renamed.slug);
    expect([same.status, same.body['error']]).toEqual([409, 'slug_unchanged']);
  });

  it('two restaurants renamed to one slug at once: one gets it', async () => {
    const target = `race-rename-${randomUUID().slice(0, 6)}`;
    const results = await Promise.all([rename(renamed.tenantId, target), rename(restaurantB.tenantId, target)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.query(`SELECT 1 FROM platform.tenant WHERE slug = $1`, [target])).rowCount).toBe(1);
  });
});
