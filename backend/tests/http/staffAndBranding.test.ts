import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planCache } from '../helpers/plans.js';
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
import { slugify } from '../../src/modules/platform/slug.js';

/**
 * The new flow end to end on the real assembly: a Sales Person creates a
 * branded restaurant and its manager signs up. Staff are the Sales person's
 * (salesStaffPins.test.ts); the manager's staff list is read only.
 */

const KEY = 'staff-and-branding-signing-key-long-enough';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let otherRep: string;
let proVersion: string;

interface Made {
  readonly tenantId: string; readonly slug: string; readonly token: string; readonly branchId: string;
}
let restaurant: Made;

async function http(method: string, url: string, token: string | null, payload?: unknown) {
  const response = await app.inject({
    method: method as never,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}),
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  const isJson = String(response.headers['content-type'] ?? '').includes('json');
  return {
    status: response.statusCode,
    headers: response.headers,
    raw: response.rawPayload,
    body: (isJson ? response.json() : {}) as Record<string, unknown>,
  };
}

const platformToken = (sub: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
};

async function login(email: string, password: string): Promise<string> {
  const response = await http('POST', `/api/auth/${restaurant.slug}/login`, null, { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body['accessToken'] as string;
}

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const salesRole = (await db.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  otherRep = randomUUID();
  for (const [id, name] of [[rep, 'Brand Rep'], [otherRep, 'Other Rep']] as const) {
    await db.query(
      `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
       VALUES ($1, $2, 'argon2id$stub', $3, $4)`, [id, `brand+${id}@platform.test`, name, salesRole]);
  }
  proVersion = (await ensureStandardPlans(db, rep)).get('pro')!;

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((r) => !isUnserved(r.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: planCache('pro') },
    new Set(routes.map((r) => `${r.method} ${r.url}`)));
  await app.ready();

  const slug = `${slugify('Brand Kitchen')}-${randomUUID().slice(0, 6)}`;
  const email = `manager@${slug}.test`;
  const made = await http('POST', '/api/platform/tenants', platformToken(rep), {
    slug, name: 'Brand Kitchen', currency: 'INR', timezone: 'Asia/Kolkata',
    ownerEmail: email, ownerName: 'Brand Manager', ownerPhone: '+91 98450 11111',
    firstBranchName: 'Main', planVersionId: proVersion, taxJurisdiction: 'IN',
    address: '12 MG Road, Bengaluru', themeColor: '#1D4ED8', themeColorSecondary: '#F59E0B',
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const accepted = await http('POST', '/api/auth/invite/accept', null,
    { token: made.body['inviteToken'], password: 'brand-manager-2026' });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const tenantId = made.body['tenantId'] as string;
  restaurant = {
    tenantId, slug, token: '',
    branchId: (await db.query<{ id: string }>(
      `SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id,
  };
  restaurant = { ...restaurant, token: await login(email, 'brand-manager-2026') };
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

/* -------------------------------------------------------------- branding --- */

describe('a restaurant carries its address, colour and logo', () => {
  it('stores both colours normalised and the address, and shows the colours publicly', async () => {
    const row = await db.query<{ address: string; theme_color: string; theme_color_secondary: string }>(
      `SELECT address, theme_color, theme_color_secondary FROM platform.tenant WHERE id = $1`, [restaurant.tenantId]);
    expect(row.rows[0]).toEqual({ address: '12 MG Road, Bengaluru', theme_color: '#1d4ed8', theme_color_secondary: '#f59e0b' });
    const lookup = await http('GET', `/api/public/restaurants/${restaurant.slug}`, null);
    expect(lookup.body).toMatchObject({ themeColor: '#1d4ed8', themeColorSecondary: '#f59e0b', logoUrl: null });
  });

  it('the secondary colour is edited, cleared and refused on its own; the console list carries it', async () => {
    const set = await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColorSecondary: '#16A34A' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ themeColor: '#1d4ed8', themeColorSecondary: '#16a34a' });
    const listed = await http('GET', `/api/platform/tenants?search=${restaurant.slug}`, platformToken(rep));
    const rows = (Array.isArray(listed.body) ? listed.body : (listed.body['rows'] ?? listed.body['tenants'] ?? [])) as { slug: string; themeColorSecondary: string | null }[];
    expect(rows.find((r) => r.slug === restaurant.slug)?.themeColorSecondary).toBe('#16a34a');
    const refused = await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColorSecondary: 'green' });
    expect([refused.status, refused.body['error']]).toEqual([400, 'branding_invalid']);
    expect(String(refused.body['detail'])).toContain('themeColorSecondary');
    const cleared = await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColorSecondary: null });
    expect(cleared.body).toMatchObject({ themeColor: '#1d4ed8', themeColorSecondary: null });
    expect((await http('GET', `/api/public/restaurants/${restaurant.slug}`, null)).body['themeColorSecondary']).toBeNull();
    // The primary on its own, too: each colour is its own field.
    const primaryOnly = await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColor: '#0E7490' });
    expect(primaryOnly.status, JSON.stringify(primaryOnly.body)).toBe(200);
    expect(primaryOnly.body).toMatchObject({ themeColor: '#0e7490', themeColorSecondary: null });
    expect((await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColor: '#1d4ed8' })).status).toBe(200);
    // Back to the colour the rest of the suite expects.
    expect((await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`, platformToken(rep), { themeColorSecondary: '#f59e0b' })).status).toBe(200);
  });

  it('refuses a colour that is not a hex colour, before anything is created', async () => {
    const refused = await http('PATCH', `/api/platform/tenants/${restaurant.tenantId}`,
      platformToken(rep), { themeColor: 'red; background:url(x)' });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('branding_invalid');
  });

  it('uploads a logo and serves it publicly with its own content type', async () => {
    const set = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(rep), { contentType: 'image/png', dataBase64: PNG_1X1 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const url = set.body['logoUrl'] as string;
    expect(url).toMatch(new RegExp(`^/api/public/restaurants/${restaurant.slug}/logo\\?v=[0-9a-f]{12}$`));

    const image = await http('GET', url, null);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(image.raw).equals(Buffer.from(PNG_1X1, 'base64'))).toBe(true);

    const lookup = await http('GET', `/api/public/restaurants/${restaurant.slug}`, null);
    expect(lookup.body['logoUrl']).toBe(url);
  });

  it('refuses a file whose bytes are not the image it claims to be', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const refused = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(rep), { contentType: 'image/png', dataBase64: html });
    expect(refused.status).toBe(400);
    expect(String(refused.body['detail'])).toContain('not a PNG, JPEG or WebP');
  });

  it('refuses a logo over 256 KB', async () => {
    const big = Buffer.concat([Buffer.from(PNG_1X1, 'base64'), Buffer.alloc(300 * 1024)]).toString('base64');
    const refused = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(rep), { contentType: 'image/png', dataBase64: big });
    expect(refused.status).toBe(400);
    expect(String(refused.body['detail'])).toContain('256 KB');
  });

  it('lets only the Sales Person who sold it change the logo', async () => {
    const refused = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(otherRep), { contentType: 'image/png', dataBase64: PNG_1X1 });
    expect(refused.status).toBe(404);
  });

  it('removes the logo', async () => {
    const removed = await http('DELETE', `/api/platform/tenants/${restaurant.tenantId}/logo`, platformToken(rep));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const gone = await http('GET', `/api/public/restaurants/${restaurant.slug}/logo`, null);
    expect(gone.status).toBe(404);
  });
});

/* ------------------------------------------------- the installable POS app --- */

/** A PNG the logo upload accepts: signature, IHDR (the size the manifest reads), IEND. */
function pngOf(width: number, height: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

describe('the installable POS app: one manifest per restaurant, opening its own POS', () => {
  const manifestOf = (slug: string) => http('GET', `/api/public/restaurants/${slug}/manifest`, null);
  const UNIVERSALPOS_ICONS = ['/app-icons/pos-icon-192.png', '/app-icons/pos-icon-512.png', '/app-icons/pos-icon-maskable-512.png'];

  it('is a web app manifest whose start_url, scope and id are /{slug}/pos, re-checked on every launch', async () => {
    const got = await manifestOf(restaurant.slug);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(got.headers['cache-control']).toBe('no-cache');
    expect(got.body).toMatchObject({
      id: `/${restaurant.slug}/pos`, start_url: `/${restaurant.slug}/pos`, scope: `/${restaurant.slug}/pos`,
      name: 'Brand Kitchen POS', short_name: 'Brand Kitchen', display: 'standalone', theme_color: '#1d4ed8',
    });
    expect((got.body['icons'] as { src: string }[]).map((i) => i.src)).toEqual(UNIVERSALPOS_ICONS);
  });

  it('says nothing the public lookup does not: names, colour and icons only', async () => {
    expect(Object.keys((await manifestOf(restaurant.slug)).body).sort()).toEqual([
      'background_color', 'description', 'display', 'icons', 'id', 'lang', 'name', 'orientation',
      'prefer_related_applications', 'scope', 'short_name', 'start_url', 'theme_color',
    ]);
  });

  it('another restaurant gets its own app, never this one', async () => {
    const slug = `${slugify('Second Kitchen')}-${randomUUID().slice(0, 6)}`;
    const made = await http('POST', '/api/platform/tenants', platformToken(rep), {
      slug, name: 'Second Kitchen', currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `manager@${slug}.test`, ownerName: 'Second Manager', ownerPhone: '+91 98450 22222',
      firstBranchName: 'Main', planVersionId: proVersion, taxJurisdiction: 'IN', address: '4 Church Street, Bengaluru',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const [ours, theirs] = [await manifestOf(restaurant.slug), await manifestOf(slug)];
    expect(theirs.body).toMatchObject({ id: `/${slug}/pos`, start_url: `/${slug}/pos`, name: 'Second Kitchen POS', theme_color: '#FA5C00' });
    expect(JSON.stringify(theirs.body)).not.toContain(restaurant.slug);
    expect(JSON.stringify(ours.body)).not.toContain(slug);
  });

  it('an unknown restaurant has no app', async () => {
    const missing = await manifestOf(`no-such-${randomUUID().slice(0, 6)}`);
    expect([missing.status, missing.body['error']]).toEqual([404, 'restaurant_not_found']);
  });

  it('a square logo of 192 px or more is the app icon; any other logo keeps the UniversalPOS icon', async () => {
    const square = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(rep), { contentType: 'image/png', dataBase64: pngOf(512, 512) });
    expect(square.status, JSON.stringify(square.body)).toBe(200);
    expect((await manifestOf(restaurant.slug)).body['icons']).toEqual([
      { src: square.body['logoUrl'], sizes: '512x512', type: 'image/png', purpose: 'any' },
    ]);
    // The icon is the logo route, which serves it to anyone.
    expect((await http('GET', square.body['logoUrl'] as string, null)).status).toBe(200);

    const wide = await http('POST', `/api/platform/tenants/${restaurant.tenantId}/logo`,
      platformToken(rep), { contentType: 'image/png', dataBase64: pngOf(400, 200) });
    expect(wide.status, JSON.stringify(wide.body)).toBe(200);
    expect(((await manifestOf(restaurant.slug)).body['icons'] as { src: string }[]).map((i) => i.src)).toEqual(UNIVERSALPOS_ICONS);

    expect((await http('DELETE', `/api/platform/tenants/${restaurant.tenantId}/logo`, platformToken(rep))).status).toBe(200);
    expect(((await manifestOf(restaurant.slug)).body['icons'] as { src: string }[]).map((i) => i.src)).toEqual(UNIVERSALPOS_ICONS);
  });
});

/* ------------------------------------------------------------ staff setup --- */

describe('the manager sees staff and adds none (Basic only, 0077)', () => {
  // Staff are the Sales person's to add, set a PIN for and switch off: that is
  // salesStaffPins.test.ts. The manager's list is read only.
  it('lists the people with their roles', async () => {
    const listed = await http('GET', '/api/t/admin/staff', restaurant.token);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const people = listed.body['people'] as { fullName: string; roles: { roleName: string }[] }[];
    expect(people.length).toBeGreaterThan(0);
    expect(people.flatMap((x) => x.roles.map((role) => role.roleName))).toContain('Restaurant Manager');
  });

  it('has no route to add, invite or redeem a setup code', async () => {
    const add = await http('POST', `/api/t/admin/staff?branchId=${restaurant.branchId}`, restaurant.token, { fullName: 'Nope' });
    expect(add.status).toBe(404);
    const redeem = await http('POST', '/api/auth/staff-invite/accept', null, { token: 'x.y', pin: '6038' });
    expect(redeem.status).toBe(404);
  });
});

describe('admin forms learn which fields are required from the table', () => {
  it('marks the branch NOT NULL columns and not the optional ones', async () => {
    const listed = await http('GET', '/api/t/admin/branches', restaurant.token);
    const required = listed.body['required'] as string[];
    expect(required).toEqual(expect.arrayContaining(['code', 'name', 'timezone']));
    expect(required).not.toContain('gstin');
  });
});
