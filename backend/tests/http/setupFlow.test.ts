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

/**
 * The manager's setup flow on the real assembly: floor types, floors, tables,
 * printers, kitchens, categories, add-ons and food items, signed in as the
 * restaurant's own manager (a password session with no branch, which names
 * the branch with ?branchId=).
 */

const KEY = 'setup-flow-signing-key-long-enough-for-hs256';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let proVersion: string;

interface Restaurant { tenantId: string; slug: string; token: string; branchA: string }
let r: Restaurant;
let other: Restaurant;
let branchB: string;

async function http(method: string, url: string, token: string | null, payload?: unknown) {
  const response = await app.inject({
    method: method as never, url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}),
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function restaurant(name: string): Promise<Restaurant> {
  const slug = `setup-${randomUUID().slice(0, 8)}`;
  const email = `manager@${slug}.test`;
  const now = Math.floor(Date.now() / 1000);
  const made = await http('POST', '/api/platform/tenants',
    signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY), {
      slug, name, currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Setup Manager',
      firstBranchName: 'Main', planVersionId: proVersion, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
    });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'setup-manager-2026' });
  const login = await http('POST', `/api/auth/${slug}/login`, null, { email, password: 'setup-manager-2026' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const tenantId = made.body['tenantId'] as string;
  const branchA = (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;
  return { tenantId, slug, token: login.body['accessToken'] as string, branchA };
}

const at = (url: string, branchId: string): string => `${url}${url.includes('?') ? '&' : '?'}branchId=${branchId}`;
let taxClassId: string;

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const salesRole = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Setup Rep', $3)`, [rep, `setup+${rep}@platform.test`, salesRole]);
  proVersion = (await ensureStandardPlans(db, rep)).get('pro')!;

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((x) => !isUnserved(x.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: planCache('pro') },
    new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await restaurant('Setup Kitchen');
  other = await restaurant('Other Place');
  const second = await http('POST', '/api/t/admin/branches', r.token, {
    code: 'B2', name: 'Second', timezone: 'Asia/Kolkata', business_day_starts_at: '04:00', gst_registration: 'unregistered',
  });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  branchB = second.body['id'] as string;
  taxClassId = (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [r.tenantId])).rows[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

let floorA: string;
let printerA: string;
let printerB: string;
let extrasId: string;
let limeId: string;

describe('1-3. floor types, floors and tables', () => {
  it('starts every restaurant with AC, Non AC, VIP and Rooftop', async () => {
    const types = await http('GET', '/api/t/admin/floor-types', r.token);
    expect((types.body['rows'] as { name: string }[]).map((t) => t.name).sort())
      .toEqual(['AC', 'Non AC', 'Rooftop', 'VIP']);
  });

  it('adds a floor of a type at the branch the owner names', async () => {
    const types = await http('GET', '/api/t/admin/floor-types', r.token);
    const vip = (types.body['rows'] as { id: string; key: string }[]).find((t) => t.key === 'vip')!;
    const noBranch = await http('POST', '/api/t/admin/floors', r.token, { name: 'Terrace' });
    expect(noBranch.status).toBe(400);
    const floor = await http('POST', at('/api/t/admin/floors', r.branchA), r.token,
      { name: 'Ground floor', floor_type_id: vip.id, display_order: '1' });
    expect(floor.status, JSON.stringify(floor.body)).toBe(200);
    expect(floor.body).toMatchObject({ branch_id: r.branchA, floor_type_id: vip.id });
    floorA = floor.body['id'] as string;
  });

  it('adds tables with seats, and refuses zero seats and a floor from another branch', async () => {
    const table = await http('POST', at('/api/t/admin/tables', r.branchA), r.token,
      { floor_id: floorA, identifier: 'T1', seats: '4' });
    expect(table.status, JSON.stringify(table.body)).toBe(200);
    const zero = await http('POST', at('/api/t/admin/tables', r.branchA), r.token,
      { floor_id: floorA, identifier: 'T2', seats: '0' });
    expect(zero.status).toBe(409);
    expect(zero.body['error']).toBe('invariant_refused');
    const elsewhere = await http('POST', at('/api/t/admin/tables', branchB), r.token,
      { floor_id: floorA, identifier: 'X1', seats: '2' });
    expect(elsewhere.status).toBe(422);
    expect(elsewhere.body['error']).toBe('reference_invalid');
  });

  it('marks the required fields of a table from the table itself', async () => {
    const listed = await http('GET', at('/api/t/admin/tables', r.branchA), r.token);
    expect(listed.body['required']).toEqual(expect.arrayContaining(['floor_id', 'identifier', 'seats']));
  });
});

describe('4-5. printers and kitchens', () => {
  it('adds printers at each branch', async () => {
    const a = await http('POST', at('/api/t/admin/printers', r.branchA), r.token,
      { name: 'Kitchen printer', connection_kind: 'network', address: '192.168.0.10:9100' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    printerA = a.body['id'] as string;
    const b = await http('POST', at('/api/t/admin/printers', branchB), r.token,
      { name: 'Bar printer', connection_kind: 'usb' });
    printerB = b.body['id'] as string;
  });

  it('a Wi-Fi or Ethernet printer is saved only at a LAN address and a printing port, on create and on edit', async () => {
    const url = at('/api/t/admin/printers', r.branchA);
    for (const address of ['8.8.8.8:9100', '127.0.0.1:9100', '10.0.0.5:6379', 'printer.local:9100']) {
      const refused = await http('POST', url, r.token, { name: `Refused ${address}`, connection_kind: 'network', address });
      expect(refused.status, address).toBe(400);
      expect(refused.body['error'], address).toBe('printer_address_invalid');
    }
    const noAddress = await http('POST', url, r.token, { name: 'No address', connection_kind: 'network' });
    expect(noAddress.body['error']).toBe('printer_address_invalid');

    const moved = await http('PATCH', `/api/t/admin/printers/${printerA}`, r.token, { address: '169.254.169.254:9100' });
    expect(moved.status).toBe(400);
    expect(moved.body['error']).toBe('printer_address_invalid');
    const ok = await http('PATCH', `/api/t/admin/printers/${printerA}`, r.token, { address: '172.16.4.20:9101' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body['address']).toBe('172.16.4.20:9101');
  });

  it('a kitchen is created with its type and printer, and needs both', async () => {
    const noPrinter = await http('POST', at('/api/t/admin/kitchens', r.branchA), r.token, { name: 'Juice', kind: 'beverage' });
    expect(noPrinter.status).toBe(400);
    expect(noPrinter.body['error']).toBe('setup_invalid');
    const wrongBranch = await http('POST', at('/api/t/admin/kitchens', r.branchA), r.token,
      { name: 'Juice', kind: 'beverage', printerId: printerB });
    expect(wrongBranch.status).toBe(400);

    const juice = await http('POST', at('/api/t/admin/kitchens', r.branchA), r.token,
      { name: 'Juice', kind: 'beverage', printerId: printerA });
    expect(juice.status, JSON.stringify(juice.body)).toBe(200);
    expect(juice.body).toMatchObject({ code: 'juice', kind: 'beverage', printerName: 'Kitchen printer' });

    const kitchen1 = await http('POST', at('/api/t/admin/kitchens', r.branchA), r.token,
      { name: 'Kitchen1', kind: 'food', printerId: printerA });
    expect(kitchen1.body['code']).toBe('kitchen1');
    const chatAtB = await http('POST', at('/api/t/admin/kitchens', branchB), r.token,
      { name: 'Chat Kitchen', kind: 'food', printerId: printerB });
    expect(chatAtB.status, JSON.stringify(chatAtB.body)).toBe(200);

    const clash = await http('POST', at('/api/t/admin/kitchens', branchB), r.token,
      { name: 'Juice', kind: 'food', printerId: printerB });
    expect(clash.status).toBe(409);
    expect(String(clash.body['detail'])).toContain('one type everywhere');
  });
});

describe('6-7. categories, add-ons and food items', () => {
  let categoryId: string;

  it('adds a category', async () => {
    const made = await http('POST', '/api/t/admin/menu/categories', r.token, { key: 'beverages', name: 'Beverages', display_order: '1' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    categoryId = made.body['id'] as string;
  });

  it('adds an add-on group with options, and edits them without deleting history', async () => {
    const made = await http('POST', '/api/t/admin/addons', r.token, {
      name: 'Extras', minSelect: 0, maxSelect: 2,
      options: [{ name: 'Mint', priceDeltaMinor: 1000 }, { name: 'Ice', priceDeltaMinor: 0 }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    extrasId = made.body['id'] as string;
    const options = made.body['options'] as { id: string; name: string }[];
    const mint = options.find((o) => o.name === 'Mint')!;
    const edited = await http('PATCH', `/api/t/admin/addons/${extrasId}`, r.token, {
      options: [{ id: mint.id, name: 'Fresh mint', priceDeltaMinor: 1500 }, { name: 'Lemon', priceDeltaMinor: 500 }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body['options'] as { name: string }[]).map((o) => o.name)).toEqual(['Fresh mint', 'Lemon']);
    const ice = await db.query<{ status: string }>(
      `SELECT status FROM app.modifier_option WHERE tenant_id = $1 AND modifier_group_id = $2 AND name = 'Ice'`, [r.tenantId, extrasId]);
    expect(ice.rows[0]!.status).toBe('archived');
  });

  it('creates a food item with every field, deriving its key from the name', async () => {
    const made = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, {
      name: 'Fresh Lime Soda', description: 'Sweet or salted', barcode: 'LIME-0001', categoryId,
      kind: 'single', kitchenCode: 'juice', priceMinor: 9900, prepMinutes: 5, taxClassId, addOnGroupIds: [extrasId],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({
      key: 'fresh_lime_soda', kind: 'single', kitchenCode: 'juice', kitchenKind: 'beverage',
      priceMinor: 9900, prepMinutes: 5, barcode: 'LIME-0001', addOnGroupIds: [extrasId],
    });
    // On sale at once: the kitchen exists here, which is all listing asks.
    expect(made.body['listed']).toBe(true);
    limeId = made.body['id'] as string;

    const off = await http('POST', at(`/api/t/admin/menu/items/${limeId}/listing`, r.branchA), r.token, { listed: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body['listed']).toBe(false);
    const on = await http('POST', at(`/api/t/admin/menu/items/${limeId}/listing`, r.branchA), r.token, { listed: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  });

  it('a second item with the same name gets its own key; a used barcode is refused', async () => {
    const again = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, {
      name: 'Fresh Lime Soda', kind: 'single', kitchenCode: 'juice', priceMinor: 8900, taxClassId,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body['key']).toBe('fresh_lime_soda_2');
    const dupe = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, {
      name: 'Other', barcode: 'LIME-0001', kind: 'single', kitchenCode: 'juice', priceMinor: 100, taxClassId,
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body['error']).toBe('setup_conflict');
  });

  it('refuses the required fields by name', async () => {
    const missing = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, { kind: 'single' });
    expect(missing.status).toBe(400);
    expect(String(missing.body['detail'])).toContain('name is required');
    const noKitchen = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token,
      { name: 'Samosa', kind: 'single', priceMinor: 2000, taxClassId });
    expect(String(noKitchen.body['detail'])).toContain('kitchen is required');
  });

  it('refuses a kitchen this branch does not have, naming it', async () => {
    const refused = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, {
      name: 'Pani Puri', kind: 'single', kitchenCode: 'chat_kitchen', priceMinor: 6000, taxClassId,
    });
    expect(refused.status).toBe(422);
    expect(refused.body['error']).toBe('unroutable_at_branch');
    const none = await db.query(`SELECT 1 FROM app.menu_item WHERE tenant_id = $1 AND name = 'Pani Puri'`, [r.tenantId]);
    expect(none.rowCount).toBe(0);
  });

  it('builds a combo from single dishes', async () => {
    const combo = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token, {
      name: 'Soda Pair', kind: 'combo', priceMinor: 17900, taxClassId, components: [{ itemId: limeId, quantity: 2 }],
    });
    expect(combo.status, JSON.stringify(combo.body)).toBe(200);
    expect(combo.body).toMatchObject({ kind: 'combo', kitchenCode: null });
    expect(combo.body['components']).toEqual([{ itemId: limeId, name: 'Fresh Lime Soda', quantity: 2 }]);
    const empty = await http('POST', at('/api/t/admin/menu/items', r.branchA), r.token,
      { name: 'Empty Combo', kind: 'combo', priceMinor: 100, taxClassId, components: [] });
    expect(empty.status).toBe(400);
  });

  it('reports progress through the seven steps', async () => {
    const progress = await http('GET', at('/api/t/admin/setup', r.branchA), r.token);
    expect(progress.body).toMatchObject({ floorTypes: 4, floors: 1, tables: 1, kitchens: 2, printers: 1, categories: 1, items: 3, addOns: 1 });
  });
});

describe('one restaurant cannot touch another\'s setup', () => {
  it('answers another restaurant\'s kitchen and add-on ids as unknown', async () => {
    const kitchens = await http('GET', at('/api/t/admin/kitchens', r.branchA), r.token);
    const juiceId = (kitchens.body as unknown as { id: string; code: string }[]).find((k) => k.code === 'juice')!.id;
    const kitchen = await http('PATCH', `/api/t/admin/kitchens/${juiceId}`, other.token, { name: 'Stolen' });
    expect(kitchen.status).toBe(404);
    const addon = await http('DELETE', `/api/t/admin/addons/${extrasId}`, other.token);
    expect(addon.status).toBe(404);
    const item = await http('GET', `/api/t/admin/menu/items/${limeId}`, other.token);
    expect(item.status).toBe(404);
    const floor = await http('PATCH', `/api/t/admin/floors/${floorA}`, other.token, { name: 'Stolen' });
    expect(floor.status).toBe(404);
  });
});
