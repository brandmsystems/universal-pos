import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planDocument } from '../helpers/plans.js';
import type { PlanKey } from '@universalpos/shared';
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
import { withTenantTransaction } from '../../src/database/unitOfWork.js';
import { discountLine, voidLine, compLine, LineNotFiredError } from '../../src/modules/orders/adjustments.js';

/**
 * A shop sells over a counter: scan or pick a product, take the money, hand over
 * a bill. There is no kitchen, so nothing is fired -- and the catalogue says so
 * with a third item kind, `product` (0090), rather than by letting a dish go
 * without a station. These tests run the sale over HTTP on a general-retail
 * tenant, then hold the rules around it: a product is adjusted without a fire, a
 * dish still is not, a product has no kitchen, and a dish still needs one.
 */

const KEY = 'retail-checkout-signing-key-long-enough-for-hs256';
const BARCODE = '8901234567890';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let versionOf: ReadonlyMap<string, string>;
const planOf = new Map<string, PlanKey>();

let tenantId: string;
let slug: string;
let branchId: string;
let ownerToken: string;
let till: { deviceId: string; token: string };
let staffId: string;
let taxClassId: string;
let categoryId: string;
let pen: string;
const FINGERPRINT = `till${randomUUID().replace(/-/g, '')}`;

async function http(method: string, url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {}) {
  const response = await app.inject({
    method: method as never, url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  return { status: response.statusCode, body: (response.body ? JSON.parse(response.body) : {}) as Record<string, unknown> };
}
const keyed = (extra: Record<string, string> = {}) => ({ 'idempotency-key': `idem-${randomUUID()}`, ...extra });
const ok = (res: { status: number; body: unknown }) => expect(res.status, JSON.stringify(res.body)).toBe(200);
const at = (path: string) => `${path}?branchId=${branchId}`;

let kitchenMade = false;
/** A kitchen at the branch and a dish for it: the restaurant half of the catalogue, to prove it is still strict. */
async function makeDish(): Promise<string> {
  if (!kitchenMade) {
    const printer = await http('POST', at('/api/t/admin/printers'), ownerToken, { name: 'Kitchen printer', connection_kind: 'usb' });
    ok(printer);
    ok(await http('POST', at('/api/t/admin/kitchens'), ownerToken, { name: 'Kitchen', kind: 'food', printerId: printer.body['id'] }));
    kitchenMade = true;
  }
  const made = await http('POST', at('/api/t/admin/menu/items'), ownerToken, {
    name: `Dal ${randomUUID().slice(0, 4)}`, categoryId, kind: 'single', kitchenCode: 'kitchen', priceMinor: 20000,
    prepMinutes: 10, taxClassId, addOnGroupIds: [],
  });
  ok(made);
  return made.body['id'] as string;
}

function salesToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
}

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const salesRole = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Retail Rep', $3)`, [rep, `retail+${rep}@platform.test`, salesRole]);
  versionOf = await ensureStandardPlans(db, rep);

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((x) => !isUnserved(x.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: {
    async get(id: string) { return planDocument(id, planOf.get(id) ?? 'basic'); },
    async put() { /* every document is computed */ },
  } }, new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  // A general-retail tenant on the Basic plan, created the way the Super Admin's form does.
  slug = `shop-${randomUUID().slice(0, 8)}`;
  const email = `owner@${slug}.test`;
  const made = await http('POST', '/api/platform/tenants', salesToken(), {
    slug, name: 'Corner Shop', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Owner',
    firstBranchName: 'Main', planVersionId: versionOf.get('basic')!, taxJurisdiction: 'IN',
    address: '1 Test Road, Pune', businessType: 'general_retail',
  }, keyed());
  ok(made);
  tenantId = made.body['tenantId'] as string;
  planOf.set(tenantId, 'basic');
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'shop-owner-2026' });
  const signedIn = await http('POST', `/api/auth/${slug}/login`, null, { email, password: 'shop-owner-2026' });
  ownerToken = signedIn.body['accessToken'] as string;
  branchId = (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;

  taxClassId = (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [tenantId])).rows[0]!.id;
  const category = await http('POST', '/api/t/admin/menu/categories', ownerToken, { key: 'stationery', name: 'Stationery', display_order: '1' });
  ok(category);
  categoryId = category.body['id'] as string;

  // The till: the manager's sign-in makes this computer a till; a staff PIN signs in on it.
  const tillRes = await http('POST', `/api/auth/${slug}/till`, null,
    { login: email, password: 'shop-owner-2026', deviceFingerprint: FINGERPRINT, deviceName: 'Counter' });
  ok(tillRes);
  ok(await http('POST', `/api/platform/tenants/${tenantId}/staff`, salesToken(),
    { fullName: 'Till Staff', username: 'TILLSTAFF', access: 'pos', pin: '5927' }, keyed()));
  staffId = (await db.query<{ id: string }>(
    `SELECT id FROM app.app_user WHERE tenant_id = $1 AND full_name = 'Till Staff'`, [tenantId])).rows[0]!.id;
  const pin = await http('POST', `/api/auth/${slug}/pin`, null,
    { userId: staffId, pin: '5927', deviceFingerprint: FINGERPRINT, branchId });
  ok(pin);
  till = { deviceId: tillRes.body['deviceId'] as string, token: pin.body['accessToken'] as string };
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('the catalogue: a product has no kitchen, a dish still needs one', () => {
  it('creates a product with a barcode and no kitchen, and the branch menu offers it with its kind and barcode', async () => {
    const made = await http('POST', at('/api/t/admin/menu/items'), ownerToken, {
      name: 'Blue Pen', categoryId, kind: 'product', barcode: BARCODE, priceMinor: 1500, taxClassId, addOnGroupIds: [],
    });
    ok(made);
    pen = made.body['id'] as string;
    expect(made.body).toMatchObject({ kind: 'product', kitchenCode: null, barcode: BARCODE });
    const menu = await http('GET', '/api/t/pos/menu', till.token);
    ok(menu);
    const row = (menu.body['menu'] as Record<string, unknown>[]).find((m) => m['id'] === pen);
    expect(row).toMatchObject({ kind: 'product', barcode: BARCODE, station_code: null, orderable: true, price_minor: '1500' });
  });

  it('refuses a product that names a kitchen, and still refuses a single dish that names none', async () => {
    const withKitchen = await http('POST', at('/api/t/admin/menu/items'), ownerToken, {
      name: 'Bad Pen', categoryId, kind: 'product', kitchenCode: 'kitchen', priceMinor: 100, taxClassId, addOnGroupIds: [],
    });
    expect(withKitchen.status).toBe(400);
    const dishWithout = await http('POST', at('/api/t/admin/menu/items'), ownerToken, {
      name: 'Bad Dish', categoryId, kind: 'single', priceMinor: 100, taxClassId, addOnGroupIds: [],
    });
    expect(dishWithout.status).toBe(400);
  });

  it('keeps the schema guarantee: the database itself refuses a dish with no station and a product with one', async () => {
    await makeDish(); // creates the branch's kitchen, so the station code 'kitchen' exists
    await db.query('BEGIN');
    try {
      await db.query('SAVEPOINT a');
      await expect(db.query(`UPDATE app.menu_item SET kind = 'single' WHERE id = $1`, [pen]))
        .rejects.toMatchObject({ code: '23514', constraint: 'menu_item_routing_matches_kind' });
      await db.query('ROLLBACK TO SAVEPOINT a');
      await db.query('SAVEPOINT b');
      await expect(db.query(`UPDATE app.menu_item SET station_code = 'kitchen' WHERE id = $1`, [pen]))
        .rejects.toMatchObject({ code: '23514', constraint: 'menu_item_routing_matches_kind' });
      await db.query('ROLLBACK TO SAVEPOINT b');
      await db.query('SAVEPOINT c');
      await expect(db.query(`UPDATE app.menu_item SET kind = 'bakery' WHERE id = $1`, [pen]))
        .rejects.toMatchObject({ code: '23514', constraint: 'menu_item_kind_known' });
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('refuses the same barcode on a second active product', async () => {
    const twin = await http('POST', at('/api/t/admin/menu/items'), ownerToken, {
      name: 'Twin Pen', categoryId, kind: 'product', barcode: BARCODE, priceMinor: 100, taxClassId, addOnGroupIds: [],
    });
    expect(twin.status).toBe(409);
  });
});

describe('a sale with no kitchen: scan, bill, take the money', () => {
  it('opens, adds a product twice over, bills and settles in cash, and nothing is fired or printed', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const lease = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    ok(lease);
    const orderLease = { 'x-lease-token': lease.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: pen, quantity: 2 }, keyed(orderLease)));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(orderLease)));

    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    ok(billing);
    const billLease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(billLease));
    ok(bill);
    // 2 x 15.00 = 30.00, GST 5% forward is included in the shown tax; the bill states a total.
    const total = bill.body['totalMinor'] as number;
    expect(total).toBeGreaterThanOrEqual(3000);
    const paid = await http('POST', `/api/t/pos/bill/${bill.body['billId'] as string}/payment`, till.token,
      { parts: [{ method: 'cash', cashReceivedMinor: total + 500 }] }, keyed(billLease));
    ok(paid);
    expect(paid.body).toMatchObject({ settled: true, outstandingMinor: 0 });

    // The positive postconditions: a priced line, a paid bill -- and no kitchen anywhere.
    const line = await db.query<{ quantity: number; unit_price_minor: string; fired_at: string | null }>(
      `SELECT quantity, unit_price_minor::text, fired_at::text FROM app.order_line
        WHERE tenant_id = $1 AND order_id = $2 AND kind = 'item'`, [tenantId, oid]);
    expect(line.rows).toEqual([{ quantity: 2, unit_price_minor: '1500', fired_at: null }]);
    const kitchen = await db.query(`SELECT 1 FROM app.kot_fire WHERE tenant_id = $1 AND order_id = $2`, [tenantId, oid]);
    expect(kitchen.rowCount).toBe(0);
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, till.token, undefined, keyed(billLease)));
  });

  it('refuses to fire an order that holds only products, by name, rather than inventing a kitchen ticket', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const lease = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const orderLease = { 'x-lease-token': lease.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: pen, quantity: 1 }, keyed(orderLease)));
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, till.token);
    const version = Number((board.body['session'] as Record<string, unknown>)['version']);
    const fired = await http('POST', `/api/t/pos/order/${oid}/fire`, till.token, { sessionVersion: version }, keyed(orderLease));
    expect(fired.status).not.toBe(200);
    expect(fired.body['error']).toBeDefined();
    const tickets = await db.query(`SELECT 1 FROM app.kot_fire WHERE tenant_id = $1 AND order_id = $2`, [tenantId, oid]);
    expect(tickets.rowCount).toBe(0);
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, till.token, undefined, keyed(orderLease)));
  });
});

describe('a dish and a product on one order (a restaurant that also sells packaged goods)', () => {
  it('fires: only the dish reaches the kitchen, the product is stamped sent with it, and billing is not blocked', async () => {
    const dish = await makeDish();
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const lease = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const orderLease = { 'x-lease-token': lease.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: dish, quantity: 1 }, keyed(orderLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: pen, quantity: 3 }, keyed(orderLease)));
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, till.token);
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token,
      { sessionVersion: Number((board.body['session'] as Record<string, unknown>)['version']) }, keyed(orderLease)));
    const sent = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.kot_line kl JOIN app.kot k ON k.id = kl.kot_id
         JOIN app.kot_fire f ON f.id = k.fire_id WHERE f.order_id = $1`, [oid]);
    expect(sent.rows[0]!.n, 'one kitchen line: the dish').toBe('1');
    const stamped = await db.query<{ fired: boolean }>(
      `SELECT ol.fired_at IS NOT NULL AS fired FROM app.order_line ol
         JOIN app.menu_item mi ON mi.id = ol.menu_item_id WHERE ol.order_id = $1 AND mi.kind = 'product'`, [oid]);
    expect(stamped.rows).toEqual([{ fired: true }]);
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(orderLease)));
    // Leave nothing open on the floor: billing takes its own lease, and discarding the order needs it.
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    ok(billing);
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, till.token, undefined, keyed({ 'x-lease-token': billing.body['token'] as string })));
  });
});

describe('adjusting an unfired line: allowed for a product, still refused for a dish', () => {
  // Nothing is left open on the floor for another test file to meet.
  const toClose: { sessionId: string; lease: Record<string, string> }[] = [];
  afterEach(async () => {
    for (const o of toClose.splice(0)) ok(await http('DELETE', `/api/t/pos/session/${o.sessionId}`, till.token, undefined, keyed(o.lease)));
  });
  async function unfiredLine(itemId: string): Promise<{ lineId: string; sessionId: string; orderId: string; lease: Record<string, string> }> {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    ok(opened);
    const sessionId = opened.body['sessionId'] as string;
    const orderId = opened.body['orderId'] as string;
    const lease = await http('POST', `/api/t/pos/session/${sessionId}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const headers = { 'x-lease-token': lease.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${orderId}/line`, till.token, { menuItemId: itemId, quantity: 2 }, keyed(headers)));
    const lineId = (await db.query<{ id: string }>(
      `SELECT id FROM app.order_line WHERE tenant_id = $1 AND order_id = $2 AND kind = 'item'`, [tenantId, orderId])).rows[0]!.id;
    toClose.push({ sessionId, lease: headers });
    return { lineId, sessionId, orderId, lease: headers };
  }
  /** A reason is valid for particular kinds of adjustment; this one is valid for the kind asked. */
  const reason = async (kind: 'discount' | 'comp' | 'void' = 'discount'): Promise<string> => (await db.query<{ id: string }>(
    `SELECT r.id FROM app.adjustment_reason r
       JOIN app.adjustment_reason_kind k ON k.tenant_id = r.tenant_id AND k.reason_id = r.id
      WHERE r.tenant_id = $1 AND r.status = 'active' AND k.kind = $2 ORDER BY r.key LIMIT 1`,
    [tenantId, kind])).rows[0]!.id;
  const authority = { discountPercentCap: 20, discountAmountCap: null } as const;

  it('discounts, comps and voids a product line that was never fired, each as one new row and the original untouched', async () => {
    const run: Record<'discount' | 'comp' | 'void', (c: Parameters<Parameters<typeof withTenantTransaction>[2]>[0], lineId: string, reasonId: string) => Promise<string>> = {
      discount: (c, lineId, reasonId) => discountLine(c, { lineId, reasonId, percent: 10 }, authority, staffId),
      comp: (c, lineId, reasonId) => compLine(c, { lineId, reasonId, quantity: 1 }, staffId),
      void: (c, lineId, reasonId) => voidLine(c, { lineId, reasonId, quantity: 1 }, staffId),
    };
    // 2 x 15.00: 10% off is 3.00; a comp or a void of one unit is 15.00 (the void also takes a unit off the quantity).
    const expected = { discount: { total: -300, quantity: 0 }, comp: { total: -1500, quantity: 0 }, void: { total: -1500, quantity: -1 } } as const;
    for (const kind of ['discount', 'comp', 'void'] as const) {
      const { lineId } = await unfiredLine(pen);
      const id = await withTenantTransaction(appPool, tenantId, async (c) => run[kind](c, lineId, await reason(kind)));
      expect(typeof id).toBe('string');
      const rows = await db.query<{ kind: string; quantity: number; line_total_minor: string }>(
        `SELECT kind, quantity, line_total_minor::text FROM app.order_line
          WHERE tenant_id = $1 AND adjusts_line_id = $2`, [tenantId, lineId]);
      expect(rows.rows, kind).toEqual([{ kind, quantity: expected[kind].quantity, line_total_minor: String(expected[kind].total) }]);
      const original = await db.query<{ fired_at: string | null; quantity: number }>(
        `SELECT fired_at::text, quantity FROM app.order_line WHERE id = $1`, [lineId]);
      expect(original.rows[0], `${kind}: the line itself is untouched`).toEqual({ fired_at: null, quantity: 2 });
    }
  });

  it('refuses to adjust a product beyond what was charged, as for any line', async () => {
    const { lineId } = await unfiredLine(pen);
    await withTenantTransaction(appPool, tenantId, async (c) =>
      compLine(c, { lineId, reasonId: await reason('comp'), quantity: 2 }, staffId));
    await expect(withTenantTransaction(appPool, tenantId, async (c) =>
      discountLine(c, { lineId, reasonId: await reason('discount'), percent: 10 }, authority, staffId)))
      .rejects.toMatchObject({ name: 'AdjustmentExceedsOriginalError' });
  });

  it('still refuses all three on an unfired DISH, naming the line: the gate was widened for products only', async () => {
    const dish = await makeDish();
    const { lineId } = await unfiredLine(dish);
    await expect(withTenantTransaction(appPool, tenantId, async (c) =>
      discountLine(c, { lineId, reasonId: await reason('discount'), percent: 10 }, authority, staffId))).rejects.toBeInstanceOf(LineNotFiredError);
    await expect(withTenantTransaction(appPool, tenantId, async (c) =>
      compLine(c, { lineId, reasonId: await reason('comp'), quantity: 1 }, staffId))).rejects.toBeInstanceOf(LineNotFiredError);
    await expect(withTenantTransaction(appPool, tenantId, async (c) =>
      voidLine(c, { lineId, reasonId: await reason('void'), quantity: 1 }, staffId))).rejects.toBeInstanceOf(LineNotFiredError);
    const none = await db.query(`SELECT 1 FROM app.order_line WHERE tenant_id = $1 AND adjusts_line_id = $2`, [tenantId, lineId]);
    expect(none.rowCount).toBe(0);
  });

  it('a discount on a product still obeys the role\'s cap', async () => {
    const { lineId } = await unfiredLine(pen);
    await expect(withTenantTransaction(appPool, tenantId, async (c) =>
      discountLine(c, { lineId, reasonId: await reason('discount'), percent: 50 }, authority, staffId)))
      .rejects.toMatchObject({ name: 'DiscountExceedsAuthorityError' });
  });
});

describe('a business of this type is an ordinary tenant to the isolation rules', () => {
  it('another tenant cannot see this shop\'s product', async () => {
    const found = await db.query(`SELECT 1 FROM app.menu_item WHERE tenant_id <> $1 AND id = $2`, [tenantId, pen]);
    expect(found.rowCount).toBe(0);
    const stored = await db.query<{ business_type: string }>(`SELECT business_type FROM platform.tenant WHERE id = $1`, [tenantId]);
    expect(stored.rows[0]!.business_type).toBe('general_retail');
  });
});
