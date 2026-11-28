import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planDocument } from '../helpers/plans.js';
import type { PlanKey } from '@universalpos/shared';
import { buildServer } from '../../src/server/app.js';
import { resetRegistry } from '../../src/middleware/routeRegistry.js';
import { hashSecret } from '../../src/modules/authentication/deviceAuth.js';
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
 * A service, end to end on the real assembly. Pro: the manager sets the
 * restaurant up and hires KOT Staff, Billing Staff and the kitchen; a dine-in
 * party grows across joined tables while the kitchen works; KOT hands the ONE
 * order to Billing, which bills and takes payment on its own terminal; a parcel
 * goes the same way. Basic: the owner bills directly, with no KOT at all.
 */

const KEY = 'service-flow-signing-key-long-enough-for-hs256';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let versionOf: ReadonlyMap<string, string>;
/** Each restaurant's plan, as its entitlement document would state it. */
const planOf = new Map<string, PlanKey>();
/**
 * Restaurants whose document says `kot: false` -- no standard plan does any
 * more (0067), but a Super Admin may publish a version that way, and the
 * owner-bills-directly flow is what such a restaurant gets.
 */
const withoutKot = new Set<string>();

interface Restaurant { tenantId: string; slug: string; token: string; branchId: string }
let r: Restaurant;
let other: Restaurant;

const tables: Record<string, string> = {};
let otherTable: string;
let biryani: string, coke: string, paneer: string, raita: string;
let deviceId: string;
const FINGERPRINT = `fp${randomUUID().replace(/-/g, '')}`;
/** The Billing terminal: a separate tablet from the KOT one. */
const BILLING_FINGERPRINT = `fb${randomUUID().replace(/-/g, '')}`;
let billingDeviceId: string;
let waiter: string, cashier: string, chef: string;

async function http(
  method: string, url: string, token: string | null, payload?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await app.inject({
    method: method as never, url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}),
      ...extra,
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  const text = response.body;
  return { status: response.statusCode, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

const at = (path: string, branchId: string) => `${path}?branchId=${branchId}`;
const ok = (res: { status: number; body: unknown }) => expect(res.status, JSON.stringify(res.body)).toBe(200);

async function restaurant(plan: PlanKey = 'pro'): Promise<Restaurant> {
  const slug = `svc-${randomUUID().slice(0, 8)}`;
  const email = `owner@${slug}.test`;
  const now = Math.floor(Date.now() / 1000);
  const made = await http('POST', '/api/platform/tenants',
    signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY), {
      slug, name: 'Service Place', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Manager',
      firstBranchName: 'Main', planVersionId: versionOf.get(plan)!, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
    });
  ok(made);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'service-owner-2026' });
  const signedIn = await http('POST', `/api/auth/${slug}/login`, null, { email, password: 'service-owner-2026' });
  const tenantId = made.body['tenantId'] as string;
  planOf.set(tenantId, plan);
  return {
    tenantId, slug, token: signedIn.body['accessToken'] as string,
    branchId: (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id,
  };
}

/**
 * Staff are added by the Sales person -- that route is salesStaffPins.test.ts.
 * Here they are a fixture with the same rows: a user, an active PIN, a membership.
 */
async function hire(code: string, role: string | readonly string[], pin: string, place: Restaurant = r): Promise<string> {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO app.app_user (id, tenant_id, employee_code, full_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [userId, place.tenantId, code, `Staff ${code}`]);
  await db.query(
    `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, 'pin', $4)`,
    [randomUUID(), place.tenantId, userId, await hashSecret(pin)]);
  for (const key of typeof role === 'string' ? [role] : role) {
    const held = (await db.query<{ id: string; assignable_scope: string }>(
      `SELECT id, assignable_scope FROM app.role WHERE tenant_id = $1 AND key = $2`, [place.tenantId, key])).rows[0]!;
    await db.query(
      `INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), place.tenantId, userId, held.assignable_scope === 'tenant_only' ? null : place.branchId,
       held.id, held.assignable_scope]);
  }
  return userId;
}

async function pinLogin(code: string, pin: string, fingerprint = FINGERPRINT, at: Restaurant = r) {
  return http('POST', `/api/auth/${at.slug}/pin`, null,
    { employeeCode: code, pin, deviceFingerprint: fingerprint, branchId: at.branchId });
}

/**
 * A till and someone on it. The owner's sign-in makes the computer a till and
 * opens no POS session (managers sign in on the Manager Login page); the POS is
 * worked by a staff member who takes orders and the money, signed in by PIN.
 */
async function tillSession(place: Restaurant, fingerprint: string, deviceName: string): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: `/api/auth/${place.slug}/till`,
    headers: { 'content-type': 'application/json' },
    payload: { login: `owner@${place.slug}.test`, password: 'service-owner-2026', deviceFingerprint: fingerprint, deviceName },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as { accessToken?: string }).accessToken).toBeUndefined();
  const code = `T${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  await hire(code, ['waiter', 'cashier'], '5927', place);
  const signed = await pinLogin(code, '5927', fingerprint, place);
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
  return signed.body['accessToken'] as string;
}

async function setup(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const made = await http('POST', at(path, r.branchId), r.token, payload);
  ok(made);
  return made.body;
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
     VALUES ($1, $2, 'argon2id$stub', 'Service Rep', $3)`, [rep, `service+${rep}@platform.test`, salesRole]);
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
    async get(tenantId: string) {
      const document = planDocument(tenantId, planOf.get(tenantId) ?? 'pro');
      return withoutKot.has(tenantId)
        ? { ...document, features: { ...document.features, kot: false, kds: false } } : document;
    },
    async put() { /* every document is computed */ },
  } },
    new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await restaurant();
  other = await restaurant();

  // The floor plan.
  const types = await http('GET', '/api/t/admin/floor-types', r.token);
  const ac = (types.body['rows'] as { id: string; key: string }[])[0]!;
  const floor = await setup('/api/t/admin/floors', { name: 'AC Hall', floor_type_id: ac.id, display_order: '1' });
  for (const name of ['T05', 'T06', 'T07', 'T08', 'T09', 'T10']) {
    tables[name] = (await setup('/api/t/admin/tables', { floor_id: floor['id'], identifier: name, seats: '4' }))['id'] as string;
  }
  const otherFloor = await http('POST', at('/api/t/admin/floors', other.branchId), other.token, { name: 'Other', display_order: '1' });
  ok(otherFloor);
  const otherT = await http('POST', at('/api/t/admin/tables', other.branchId), other.token,
    { floor_id: otherFloor.body['id'], identifier: 'T05', seats: '4' });
  ok(otherT);
  otherTable = otherT.body['id'] as string;

  // Kitchens: food and drinks go to different stations.
  const printer = await setup('/api/t/admin/printers', { name: 'Pass printer', connection_kind: 'usb' });
  await setup('/api/t/admin/kitchens', { name: 'Hot Kitchen', kind: 'food', printerId: printer['id'] });
  await setup('/api/t/admin/kitchens', { name: 'Bar', kind: 'beverage', printerId: printer['id'] });

  // The menu.
  const taxClassId = (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [r.tenantId])).rows[0]!.id;
  const category = await http('POST', '/api/t/admin/menu/categories', r.token, { key: 'mains', name: 'Mains', display_order: '1' });
  ok(category);
  const extras = await http('POST', '/api/t/admin/addons', r.token,
    { name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ name: 'Extra Raita', priceDeltaMinor: 3000 }] });
  ok(extras);
  raita = (extras.body['options'] as { id: string }[])[0]!.id;
  const item = async (name: string, kitchenCode: string, priceMinor: number, addOnGroupIds: string[] = []) => {
    const made = await setup('/api/t/admin/menu/items', {
      name, categoryId: category.body['id'], kind: 'single', kitchenCode, priceMinor, prepMinutes: 10, taxClassId, addOnGroupIds,
    });
    expect(made['listed']).toBe(true);
    return made['id'] as string;
  };
  biryani = await item('Chicken Biryani', 'hot_kitchen', 25000, [extras.body['id'] as string]);
  paneer = await item('Paneer Tikka', 'hot_kitchen', 20000);
  coke = await item('Coke', 'bar', 5000);

  // Staff, each choosing their own PIN.
  await hire('W1', 'waiter', '6038');
  await hire('C1', 'cashier', '4816');
  await hire('K1', 'kds', '8250');
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('1. the tablets', () => {
  it('two tills at the branch: KOT and the Billing counter', async () => {
    // Fixtures: tablet setup codes are gone. A till becomes a device when a
    // manager signs in on it (basicTill.test.ts); here two already are.
    deviceId = randomUUID();
    billingDeviceId = randomUUID();
    for (const [id, name, fingerprint] of [[deviceId, 'Front till', FINGERPRINT], [billingDeviceId, 'Billing counter', BILLING_FINGERPRINT]]) {
      await db.query(
        `INSERT INTO app.device (id, tenant_id, branch_id, name, fingerprint, registered_by_user_id)
         VALUES ($1, $2, $3, $4, $5, (SELECT id FROM app.app_user WHERE tenant_id = $2 ORDER BY created_at LIMIT 1))`,
        [id, r.tenantId, r.branchId, name, fingerprint]);
    }
  });
});

describe('2. staff sign in on the tablet with their own PIN', () => {
  it('waiter, cashier and kitchen each get a session', async () => {
    const w = await pinLogin('W1', '6038'); ok(w); waiter = w.body['accessToken'] as string;
    const c = await pinLogin('C1', '4816', BILLING_FINGERPRINT); ok(c); cashier = c.body['accessToken'] as string;
    const k = await pinLogin('K1', '8250'); ok(k); chef = k.body['accessToken'] as string;
  });

  it('every screen can say who is signed in, and only ever the caller', async () => {
    const me = async (token: string) => { const res = await http('GET', '/api/t/me', token); ok(res); return res.body; };
    expect(await me(waiter)).toMatchObject({
      kind: 'staff', fullName: 'Staff W1', employeeCode: 'W1', branchName: 'Main', deviceName: 'Front till',
      roles: [{ roleName: 'KOT Staff', branchName: 'Main' }],
    });
    expect(await me(cashier)).toMatchObject({ employeeCode: 'C1', deviceName: 'Billing counter', roles: [{ roleName: 'Billing Staff' }] });
    // The owner at the admin: password sign-in, no branch, no tablet.
    const owner = await me(r.token);
    expect(owner).toMatchObject({ kind: 'staff', email: `owner@${r.slug}.test`, branchName: null, deviceName: null });
    expect((owner['roles'] as { roleName: string }[]).map((x) => x.roleName)).toContain('Restaurant Manager');
    // Another restaurant's token describes its own owner, never this one's staff.
    const theirs = await me(other.token);
    expect(theirs['email']).toBe(`owner@${other.slug}.test`);
    expect(theirs['userId']).not.toBe(owner['userId']);
  });

  it('a tablet taken out of use is told so; a wrong PIN or code still is not told which', async () => {
    // The Billing page kept its PIN screen after its tablet was taken out of use
    // and answered every PIN "not accepted" -- the tablet could not learn it
    // needed setting up again.
    const revoked = `fx${randomUUID().replace(/-/g, '')}`;
    const by = await hire('RV1', 'waiter', '4816');
    await db.query(
      `INSERT INTO app.device (id, tenant_id, branch_id, name, fingerprint, registered_by_user_id, status, revoked_at, revoked_by_user_id)
       VALUES ($1, $2, $3, 'Old till', $4, $5, 'revoked', now(), $5)`,
      [randomUUID(), r.tenantId, r.branchId, revoked, by]);
    const unset = await pinLogin('C1', '4816', revoked);
    expect(unset.status).toBe(401);
    expect(unset.body['error']).toBe('tablet_not_set_up');
    const wrongPin = await pinLogin('C1', '0482', BILLING_FINGERPRINT);
    const wrongCode = await pinLogin('NOPE', '4816', BILLING_FINGERPRINT);
    expect(wrongPin.body).toEqual({ error: 'authentication_failed', retryable: false });
    expect(wrongCode.body).toEqual(wrongPin.body);
  });

  it('a switched-off waiter cannot sign in', async () => {
    const id = await hire('W9', 'waiter', '7149');
    // Switched off by the Sales person (salesStaffPins.test.ts); the row is what sign-in reads.
    await db.query(`UPDATE app.app_user SET status = 'disabled' WHERE id = $1`, [id]);
    const refused = await pinLogin('W9', '7149');
    expect(refused.status).not.toBe(200);
    expect(refused.body['accessToken']).toBeUndefined();
  });

  it('the kitchen cannot write to the POS', async () => {
    const pos = await http('POST', '/api/t/pos/session', chef, { diningTableIds: [tables['T08']] });
    expect(pos.status).toBe(403);
  });
});

interface KitchenTicket { kotId: string; stationName: string; sendNo: number; ticketText: string;
  lines: { name: string; quantity: number; note: string | null }[] }

/** What a kitchen gets: its printed ticket, as KOT shows it (the kitchen screen is gone). */
async function kitchen(orderId: string, stationName: string): Promise<KitchenTicket[]> {
  const res = await http('GET', `/api/t/pos/order/${orderId}/tickets`, waiter);
  ok(res);
  return (res.body as unknown as KitchenTicket[]).filter((t) => t.stationName === stationName);
}

async function sessionVersion(sessionId: string, token: string): Promise<number> {
  const board = await http('GET', `/api/t/pos/session/${sessionId}/board`, token);
  ok(board);
  return Number((board.body['session'] as Record<string, unknown>)['version']);
}

describe('3. dine-in: a party grows across joined tables', () => {
  let sessionId: string, orderId: string, lease: string;
  const leased = () => ({ 'x-lease-token': lease });

  const add = (menuItemId: string, quantity: number, extra: Record<string, unknown> = {}) =>
    http('POST', `/api/t/pos/order/${orderId}/line`, waiter, { menuItemId, quantity, ...extra }, leased());
  const fire = async () => http('POST', `/api/t/pos/order/${orderId}/fire`, waiter,
    { sessionVersion: await sessionVersion(sessionId, waiter) }, leased());

  it('seats four at T05 and sends the first order to the kitchen', async () => {
    const opened = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables['T05']], guestCount: 4 });
    ok(opened);
    sessionId = opened.body['sessionId'] as string;
    orderId = opened.body['orderId'] as string;
    const claimed = await http('POST', `/api/t/pos/session/${sessionId}/lease`, waiter, { deviceId });
    ok(claimed);
    lease = claimed.body['token'] as string;

    ok(await add(biryani, 2, { modifierOptionIds: [raita], note: 'Less spicy' }));
    ok(await add(coke, 2));
    ok(await fire());

    const [ticket] = await kitchen(orderId, 'Hot Kitchen');
    expect(ticket).toMatchObject({ sendNo: 1 });
    expect(ticket!.ticketText).toContain('Table: T05');
    expect(ticket!.lines).toEqual([{ name: 'Chicken Biryani', quantity: 2, note: 'Less spicy' }]);
    // An ordinary add-on travels under its dish, not as a line of its own.
    expect(ticket!.ticketText).toContain('      + Extra Raita');
    expect((await kitchen(orderId, 'Bar'))[0]!.lines.map((l) => l.name)).toEqual(['Coke']);
  });

  it('KOT marks the food ready', async () => {
    const [ticket] = await kitchen(orderId, 'Hot Kitchen');
    ok(await http('POST', `/api/t/pos/kot/${ticket!.kotId}/ready`, waiter, {}));
    const floor = await http('GET', '/api/t/pos/floor', waiter);
    const t05 = (floor.body['tables'] as Record<string, unknown>[]).find((t) => t['id'] === tables['T05'])!;
    expect(t05['kitchen_ready']).toBeGreaterThan(0);
  });

  it('KOT sees each kitchen ticket with its printer, and can print it again', async () => {
    interface Ticket { kotId: string; stationName: string; sendNo: number; ticketText: string;
      lines: { name: string; quantity: number }[];
      print: { jobId: string; status: string; printerName: string } | null }
    const read = async () => {
      const res = await http('GET', `/api/t/pos/order/${orderId}/tickets`, waiter);
      ok(res);
      return res.body as unknown as Ticket[];
    };
    const tickets = await read();
    expect(tickets.map((t) => t.stationName).sort()).toEqual(['Bar', 'Hot Kitchen']);
    const hot = tickets.find((t) => t.stationName === 'Hot Kitchen')!;
    expect(hot).toMatchObject({ sendNo: 1, print: { status: 'waiting', printerName: 'Pass printer' } });
    expect(hot.lines).toEqual([{ name: 'Chicken Biryani', quantity: 2, note: 'Less spicy' }]);
    // The same text the kitchen printer is sent -- one renderer, not two.
    // What the cook and the runner read: whose order, which table, when, and
    // the add-on cooked with the dish -- which the paper never carried before.
    for (const text of ['SERVICE PLACE', 'KOT #1', 'Table: T05', 'Covers: 4', 'Waiter: Staff W1',
      'Kitchen: Hot Kitchen', ' 2 x Chicken Biryani', '      + Extra Raita', '      * Less spicy', 'Items: 2']) {
      expect(hot.ticketText, text).toContain(text);
    }
    expect(hot.ticketText).toMatch(/Date: \d{2}\/\d{2}\/\d{4} +Time: \d{2}:\d{2}/);
    // The printer is sent the same paper.
    const sent = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.print_job WHERE kot_id = $1`, [hot.kotId]);
    expect(Number(sent.rows[0]!.n)).toBe(1);

    // "Print again" is a NEW job, attributed to the waiter; the original stays.
    const again = await http('POST', `/api/t/pos/kot/${hot.print!.jobId}/reprint`, waiter, {});
    ok(again);
    const job = (await db.query<{ origin: string; reprint_of_job_id: string; requested_by_user_id: string }>(
      `SELECT origin, reprint_of_job_id, requested_by_user_id FROM app.print_job WHERE id = $1`,
      [again.body['jobId']])).rows[0]!;
    expect(job).toMatchObject({ origin: 'reprint', reprint_of_job_id: hot.print!.jobId });
    expect((await read()).find((t) => t.kotId === hot.kotId)!.print!.jobId).toBe(again.body['jobId']);

    // A printed ticket's tablet copy says it is a copy, so it is not cooked twice.
    await db.query(`UPDATE app.print_job SET status = 'accepted', accepted_at = now() WHERE id = $1`, [hot.print!.jobId]);
    expect((await read()).find((t) => t.kotId === hot.kotId)!.ticketText).toMatch(/REPRINT -- NOT A NEW ORDER/);
  });

  it('another restaurant cannot read or reprint these tickets', async () => {
    const theirs = await http('GET', `/api/t/pos/order/${orderId}/tickets`, other.token);
    expect([403, 404]).toContain(theirs.status);
    const job = (await db.query<{ id: string }>(
      `SELECT j.id FROM app.print_job j JOIN app.kot k ON k.tenant_id = j.tenant_id AND k.id = j.kot_id
         JOIN app.kot_fire f ON f.tenant_id = k.tenant_id AND f.id = k.fire_id
        WHERE f.order_id = $1 LIMIT 1`, [orderId])).rows[0]!.id;
    const jobs = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.print_job WHERE tenant_id = $1`, [r.tenantId])).rows[0]!.n);
    const before = await jobs();
    const theirReprint = await http('POST', `/api/t/pos/kot/${job}/reprint`, other.token, {});
    expect(theirReprint.status).not.toBe(200);
    expect(await jobs(), 'no copy was printed for the other restaurant').toBe(before);
    // The refusal a caller at a branch actually gets for a job it cannot see.
    const missing = await http('POST', `/api/t/pos/kot/${randomUUID()}/reprint`, waiter, {});
    expect(missing.status).toBe(404);
    expect(missing.body['error']).toBe('print_job_unknown');
    const unknown = await http('GET', `/api/t/pos/order/${randomUUID()}/tickets`, waiter);
    expect(unknown.status).toBe(404);
    expect(unknown.body['error']).toBe('order_unknown');
  });

  it('joins T06, then T07, and every table shows the same party', async () => {
    ok(await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T06'] }, leased()));
    ok(await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T07'] }, leased()));
    // Joining a table already in the party is a no-op, not a second attachment.
    ok(await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T06'] }, leased()));
    ok(await http('PATCH', `/api/t/pos/session/${sessionId}/guests`, waiter, { guestCount: 9 }, leased()));

    const floor = await http('GET', '/api/t/pos/floor', waiter);
    const rows = floor.body['tables'] as Record<string, unknown>[];
    for (const name of ['T05', 'T06', 'T07']) {
      const row = rows.find((t) => t['id'] === tables[name])!;
      expect(row['session_id']).toBe(sessionId);
      expect(row['joined_tables']).toEqual(['T05', 'T06', 'T07']);
      expect(row['guest_count']).toBe(9);
    }
    const live = await db.query(
      `SELECT 1 FROM app.table_session_table WHERE session_id = $1 AND detached_at IS NULL`, [sessionId]);
    expect(live.rowCount).toBe(3);
  });

  it('unjoins T07; the items stay with the party', async () => {
    ok(await http('DELETE', `/api/t/pos/session/${sessionId}/tables/${tables['T07']}`, waiter, undefined, leased()));
    const floor = await http('GET', '/api/t/pos/floor', waiter);
    const t07 = (floor.body['tables'] as Record<string, unknown>[]).find((t) => t['id'] === tables['T07'])!;
    expect(t07['session_id']).toBeNull();
    const t05 = (floor.body['tables'] as Record<string, unknown>[]).find((t) => t['id'] === tables['T05'])!;
    expect(t05['joined_tables']).toEqual(['T05', 'T06']);
    expect(t05['line_count']).toBe(2);
  });

  it('refuses the joins that would be wrong, each for its own reason', async () => {
    const other = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables['T08']] });
    ok(other);
    const taken = await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T08'] }, leased());
    expect(taken.status).toBe(409);
    expect(taken.body['error']).toBe('table_occupied');

    const foreign = await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: otherTable }, leased());
    expect(foreign.status).toBe(422);
    expect(foreign.body['error']).toBe('table_unavailable');

    const noLease = await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T07'] });
    expect(noLease.status).not.toBe(200);

    const bad = await http('PATCH', `/api/t/pos/session/${sessionId}/guests`, waiter, { guestCount: 0 }, leased());
    expect(bad.body['error']).toBe('guest_count_invalid');

    const empty = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [] });
    expect(empty.body['error']).toBe('table_required');
  });

  it('a double-tapped add is one line, not two', async () => {
    const key = `idem-${randomUUID()}`;
    const once = await http('POST', `/api/t/pos/order/${orderId}/line`, waiter,
      { menuItemId: paneer, quantity: 1 }, { ...leased(), 'idempotency-key': key });
    const twice = await http('POST', `/api/t/pos/order/${orderId}/line`, waiter,
      { menuItemId: paneer, quantity: 1 }, { ...leased(), 'idempotency-key': key });
    ok(once); ok(twice);
    expect(twice.body).toEqual(once.body);
  });

  it('the second send carries only the new items, marked as send 2', async () => {
    ok(await add(biryani, 3));
    ok(await fire());
    const second = (await kitchen(orderId, 'Hot Kitchen')).find((k) => k.sendNo === 2)!;
    expect(second.ticketText).toContain('Table: T05 + T06');
    expect(second.lines.map((l) => `${l.name} x${l.quantity}`).sort())
      .toEqual(['Chicken Biryani x3', 'Paneer Tikka x1']);
    const fired = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.kot_line kl JOIN app.order_line ol ON ol.id = kl.order_line_id
        WHERE ol.order_id = $1 AND kl.source = 'item' AND ol.menu_item_id = $2`, [orderId, biryani]);
    expect(Number(fired.rows[0]!.n)).toBe(2);
  });

  it('a third send with one more drink', async () => {
    ok(await add(coke, 1));
    ok(await fire());
    const bar = await kitchen(orderId, 'Bar');
    expect(bar.find((k) => k.sendNo === 3)!.lines.map((l) => `${l.name} x${l.quantity}`)).toEqual(['Coke x1']);
  });

  it('will not hand over an order with an item the kitchen has not seen', async () => {
    const water = await add(coke, 1);
    ok(water);
    const early = await http('POST', `/api/t/pos/session/${sessionId}/ready-for-billing`, waiter, {}, leased());
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('items_not_sent');
    // Removed before it was sent: an edit with no fields is a removal.
    ok(await http('PATCH', `/api/t/pos/order/${orderId}/line/${water.body['lineId'] as string}`, waiter, {}, leased()));
  });

  it('a sign-in with no branch is told so, not answered with an internal error', async () => {
    // The owner at the admin signs in with a password and holds no branch. The
    // tablet screens are per branch; this was a 500 "no branch on the request".
    for (const path of ['/api/t/billing/queue', '/api/t/pos/floor', '/api/t/pos/parcels']) {
      const res = await http('GET', path, r.token);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body['error']).toBe('branch_scope_required');
    }
  });

  it('Billing Staff cannot take orders, and cannot bill an order KOT still owns', async () => {
    const add1 = await http('POST', `/api/t/pos/order/${orderId}/line`, cashier, { menuItemId: coke, quantity: 1 }, leased());
    expect(add1.status).toBe(403);
    const take = await http('POST', `/api/t/pos/session/${sessionId}/billing-lease`, cashier, { deviceId: billingDeviceId });
    expect(take.status).toBe(409);
    expect(take.body['error']).toBe('order_not_ready_for_billing');
  });

  let billingLease: string;
  it('KOT hands the order to Billing, and from then on cannot change it', async () => {
    const floorBefore = await http('GET', '/api/t/pos/floor', waiter);
    const amount = Number((floorBefore.body['tables'] as Record<string, unknown>[])
      .find((t) => t['id'] === tables['T05'])!['amount_minor']);
    // 2x(250+30) + 2x50 + 200 + 3x250 + 50
    expect(amount).toBe(2 * 28000 + 2 * 5000 + 20000 + 3 * 25000 + 5000);

    ok(await http('POST', `/api/t/pos/session/${sessionId}/ready-for-billing`, waiter, {}, leased()));

    // The KOT lease ended with the hand-over; and even a fresh claim is refused.
    const addAfter = await http('POST', `/api/t/pos/order/${orderId}/line`, waiter, { menuItemId: coke, quantity: 1 }, leased());
    expect(addAfter.status).toBe(409);
    const reclaim = await http('POST', `/api/t/pos/session/${sessionId}/lease`, waiter, { deviceId });
    expect(reclaim.status).toBe(409);
    expect(reclaim.body['error']).toBe('order_in_billing');
    // And the domain refuses on its own, whatever the lease says.
    const stage = await db.query<{ stage: string }>(`SELECT stage FROM app.table_session WHERE id = $1`, [sessionId]);
    expect(stage.rows[0]!.stage).toBe('billing');

    const queue = await http('GET', '/api/t/billing/queue', cashier);
    ok(queue);
    expect(queue.body['kot']).toBe(true);
    const row = (queue.body['rows'] as unknown as { sessionId: string; status: string; tables: string[]; amountMinor: string }[])
      .find((q) => q.sessionId === sessionId)!;
    expect(row).toMatchObject({ status: 'ready', tables: ['T05', 'T06'], amountMinor: String(amount) });

    const claimed = await http('POST', `/api/t/pos/session/${sessionId}/billing-lease`, cashier, { deviceId: billingDeviceId });
    ok(claimed);
    billingLease = claimed.body['token'] as string;
  });

  it('Billing bills the ONE order once, takes payment, and the tables go back to the floor', async () => {
    const billed = { 'x-lease-token': billingLease };
    ok(await http('POST', `/api/t/pos/session/${sessionId}/bill`, cashier, { splitKind: 'whole' }, billed));
    const second = await http('POST', `/api/t/pos/session/${sessionId}/bill`, cashier, { splitKind: 'whole' }, billed);
    expect(second.status).not.toBe(200);

    const board = await http('GET', `/api/t/pos/session/${sessionId}/board`, cashier);
    const bills = board.body['bills'] as Record<string, unknown>[];
    expect(bills).toHaveLength(1);
    type Row = { sessionId: string; status: string; payment: string };
    const row = async (): Promise<Row> => ((await http('GET', '/api/t/billing/queue', cashier)).body['rows'] as unknown as Row[])
      .find((q) => q.sessionId === sessionId)!;
    // Billed and nothing paid is not "part paid": the server says which.
    expect(await row()).toMatchObject({ status: 'in_progress', payment: 'none' });

    // A bill exists, so a manager can no longer send it back to KOT.
    const reopen = await http('POST', `/api/t/admin/sessions/${sessionId}/reopen`, r.token, { reason: 'customer added dessert' });
    expect(reopen.body['error']).toBe('bill_already_made');

    ok(await http('POST', `/api/t/pos/bill/${bills[0]!['id'] as string}/tender`, cashier,
      { method: 'card', amountMinor: Number(bills[0]!['outstanding_minor']), reference: 'CARD-0001' }, billed));
    // Paid in full and not yet closed: still open, and said to be paid.
    expect(await row()).toMatchObject({ status: 'in_progress', payment: 'full' });
    ok(await http('DELETE', `/api/t/pos/session/${sessionId}`, cashier, undefined, billed));

    const done = await http('GET', '/api/t/billing/queue', cashier);
    expect((done.body['rows'] as unknown as { sessionId: string; status: string }[]).find((q) => q.sessionId === sessionId)!.status)
      .toBe('completed');
    const orders = await db.query(`SELECT 1 FROM app.sales_order WHERE session_id = $1`, [sessionId]);
    expect(orders.rowCount).toBe(1);

    const floor = await http('GET', '/api/t/pos/floor', waiter);
    for (const name of ['T05', 'T06']) {
      expect((floor.body['tables'] as Record<string, unknown>[]).find((t) => t['id'] === tables[name])!['session_id']).toBeNull();
    }
    // Closing releases the tables for good: T05 can be seated again.
    ok(await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables['T05']] }));
  });

  it('a manager can send an unbilled order back to KOT, with a reason', async () => {
    const opened = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables['T07']] });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const lease = (await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId })).body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/line`, waiter,
      { menuItemId: coke, quantity: 1 }, { 'x-lease-token': lease }));
    ok(await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/fire`, waiter,
      { sessionVersion: await sessionVersion(sid, waiter) }, { 'x-lease-token': lease }));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, waiter, {}, { 'x-lease-token': lease }));

    const noReason = await http('POST', `/api/t/admin/sessions/${sid}/reopen`, r.token, {});
    expect(noReason.body['error']).toBe('reopen_reason_required');
    const kotCannot = await http('POST', `/api/t/admin/sessions/${sid}/reopen`, waiter, { reason: 'one more drink' });
    expect(kotCannot.status).toBe(403);
    ok(await http('POST', `/api/t/admin/sessions/${sid}/reopen`, r.token, { reason: 'one more drink' }));
    ok(await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId }));
  });
});

describe('3c. leftovers from an earlier day, and cancelling an order', () => {
  type QueueRow = { sessionId: string; status: string; businessDate: string; leftover: boolean; payment: string };
  const queue = async () => {
    const res = await http('GET', '/api/t/billing/queue', cashier);
    ok(res);
    return res.body['rows'] as unknown as QueueRow[];
  };
  /** Seated, one drink sent to the bar, and handed to Billing. */
  const handedOver = async (table: string) => {
    const opened = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables[table]] });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const lease = { 'x-lease-token': (await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId })).body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, waiter, { menuItemId: coke, quantity: 1 }, lease));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, waiter, { sessionVersion: await sessionVersion(sid, waiter) }, lease));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, waiter, {}, lease));
    return sid;
  };
  /** Moves a session to the day before, as if it had been started yesterday. */
  const backdate = async (sid: string) => (await db.query<{ business_date: string }>(
    `UPDATE app.table_session SET business_date = business_date - 1 WHERE id = $1 RETURNING business_date::text`,
    [sid])).rows[0]!.business_date;
  const billIt = async (sid: string) => {
    const claimed = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, cashier, { deviceId: billingDeviceId });
    ok(claimed);
    const lease = { 'x-lease-token': claimed.body['token'] as string };
    ok(await http('POST', `/api/t/pos/session/${sid}/bill`, cashier, { splitKind: 'whole' }, lease));
    return lease;
  };

  let t09: string;
  it('an order left open from yesterday still reaches Billing and the manager, marked as a leftover', async () => {
    t09 = await handedOver('T09');
    const yesterday = await backdate(t09);
    expect((await queue()).find((q) => q.sessionId === t09))
      .toMatchObject({ status: 'ready', businessDate: yesterday, leftover: true });

    const parcel = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Late' });
    ok(parcel);
    const pid = parcel.body['sessionId'] as string;
    await backdate(pid);
    const parcels = await http('GET', '/api/t/pos/parcels', waiter);
    expect((parcels.body as unknown as { sessionId: string; leftover: boolean }[]).find((p) => p.sessionId === pid))
      .toMatchObject({ leftover: true });

    const open = await http('GET', '/api/t/admin/sessions/open', r.token);
    ok(open);
    const ids = (open.body['rows'] as { sessionId: string }[]).map((o) => o.sessionId);
    expect(ids).toEqual(expect.arrayContaining([t09, pid]));
    // Oldest first: yesterday's lead, in the order they were opened.
    expect(ids.indexOf(t09)).toBe(0);
    expect(ids.indexOf(pid)).toBe(1);

    // A parcel nobody ordered anything on can be cancelled outright.
    ok(await http('POST', `/api/t/admin/sessions/${pid}/cancel`, r.token, { reason: 'opened by mistake' }));
    const after = await http('GET', '/api/t/pos/parcels', waiter);
    expect((after.body as unknown as { sessionId: string }[]).some((p) => p.sessionId === pid)).toBe(false);
  });

  it("cancelling needs a reason, and is not the till's or the waiter's to do", async () => {
    const noReason = await http('POST', `/api/t/admin/sessions/${t09}/cancel`, r.token, { reason: ' no ' });
    expect(noReason.status).toBe(400);
    expect(noReason.body['error']).toBe('cancel_reason_required');
    for (const token of [cashier, waiter]) {
      const refused = await http('POST', `/api/t/admin/sessions/${t09}/cancel`, token, { reason: 'customer walked out' });
      expect(refused.status).toBe(403);
    }
    const still = await db.query<{ status: string }>(`SELECT status FROM app.table_session WHERE id = $1`, [t09]);
    expect(still.rows[0]!.status).toBe('open');
  });

  it('cancelling an unpaid order voids its bill, stops the kitchen and frees the table', async () => {
    await billIt(t09);
    const res = await http('POST', `/api/t/admin/sessions/${t09}/cancel`, r.token, { reason: 'customer walked out' });
    ok(res);
    expect(res.body['voidedBills']).toBe(1);

    const bill = await db.query<{ status: string }>(`SELECT status FROM app.bill WHERE session_id = $1`, [t09]);
    expect(bill.rows.map((b) => b.status)).toEqual(['void']);
    const order = await db.query<{ status: string; cancel_reason: string; cancelled_by_user_id: string | null }>(
      `SELECT status, cancel_reason, cancelled_by_user_id FROM app.sales_order WHERE session_id = $1`, [t09]);
    expect(order.rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'customer walked out' });
    expect(order.rows[0]!.cancelled_by_user_id).not.toBeNull();
    const kitchen = await db.query<{ state: string }>(
      `SELECT kl.state FROM app.kot_line kl JOIN app.order_line ol ON ol.id = kl.order_line_id
         JOIN app.sales_order so ON so.id = ol.order_id WHERE so.session_id = $1`, [t09]);
    expect(kitchen.rows.map((k) => k.state)).toEqual(['cancelled']);

    // Closed and from yesterday: it leaves the queue rather than sitting in Completed.
    expect((await queue()).some((q) => q.sessionId === t09)).toBe(false);
    const open = await http('GET', '/api/t/admin/sessions/open', r.token);
    expect((open.body['rows'] as { sessionId: string }[]).some((o) => o.sessionId === t09)).toBe(false);
    // The table can be seated again.
    ok(await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [tables['T09']] }));

    const twice = await http('POST', `/api/t/admin/sessions/${t09}/cancel`, r.token, { reason: 'customer walked out' });
    expect(twice.body['error']).toBe('session_not_open');
  });

  it('a cancelled order from today is shown as cancelled, not as paid', async () => {
    const sid = await handedOver('T10');
    ok(await http('POST', `/api/t/admin/sessions/${sid}/cancel`, r.token, { reason: 'test order on the new tablet' }));
    expect((await queue()).find((q) => q.sessionId === sid)).toMatchObject({ status: 'cancelled', leftover: false });
  });

  it('refuses to cancel once money has been taken -- that is a refund', async () => {
    const sid = await handedOver('T10');
    const lease = await billIt(sid);
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, cashier);
    const bill = (board.body['bills'] as Record<string, unknown>[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, cashier,
      { method: 'card', amountMinor: 1000, reference: 'CARD-PART' }, lease));

    const refused = await http('POST', `/api/t/admin/sessions/${sid}/cancel`, r.token, { reason: 'customer walked out' });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('order_has_payment');
    const untouched = await db.query<{ status: string }>(`SELECT status FROM app.bill WHERE session_id = $1`, [sid]);
    expect(untouched.rows.map((b) => b.status)).toEqual(['open']);
  });

  it('a part payment is "part"; a leftover paid and closed today is in Completed for today', async () => {
    const parcel = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Yesterday' });
    ok(parcel);
    const sid = parcel.body['sessionId'] as string;
    const oid = parcel.body['orderId'] as string;
    const kot = { 'x-lease-token': (await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId })).body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, waiter, { menuItemId: coke, quantity: 1 }, kot));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, waiter, { sessionVersion: await sessionVersion(sid, waiter) }, kot));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, waiter, {}, kot));
    await backdate(sid);
    const lease = await billIt(sid);
    const bill = ((await http('GET', `/api/t/pos/session/${sid}/board`, cashier)).body['bills'] as Record<string, unknown>[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, cashier,
      { method: 'card', amountMinor: 500, reference: 'CARD-HALF' }, lease));
    expect((await queue()).find((q) => q.sessionId === sid)).toMatchObject({ status: 'in_progress', payment: 'part', leftover: true });
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, cashier,
      { method: 'card', amountMinor: Number(bill['outstanding_minor']) - 500, reference: 'CARD-REST' }, lease));
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, cashier, undefined, lease));
    // Closed today, though it started yesterday: Completed, not gone.
    expect((await queue()).find((q) => q.sessionId === sid)).toMatchObject({ status: 'completed', payment: 'full' });
  });

  it("another restaurant's manager cannot cancel this one's order", async () => {
    const open = await http('GET', '/api/t/admin/sessions/open', r.token);
    const sid = (open.body['rows'] as { sessionId: string }[])[0]!.sessionId;
    const res = await http('POST', `/api/t/admin/sessions/${sid}/cancel`, other.token, { reason: 'not mine at all' });
    expect(res.body['error']).toBe('session_not_open');
    const still = await db.query<{ status: string }>(`SELECT status FROM app.table_session WHERE id = $1`, [sid]);
    expect(still.rows[0]!.status).toBe('open');
  });
});

describe('3d. the printed bill and receipt', () => {
  type Printed = {
    kind: string; copyNo: number; billNo: number; serviceType: string; parcelNo: number | null;
    pickupName: string | null; waiter: string | null; cashier: string | null;
    restaurant: { name: string; address: string | null; phone: string | null; footer: string };
    lines: { quantity: number; name: string; rateMinor: number | null; grossMinor: number; addOns: string[]; lessMinor: number }[];
    subtotalMinor: number; taxes: { label: string; amountMinor: number }[]; totalMinor: number;
    tenders: { method: string; amountMinor: number; reference: string | null }[];
  };
  let billId: string;
  let lease: Record<string, string>;
  const print = async (token: string = cashier) => http('POST', `/api/t/pos/bill/${billId}/print`, token, {});

  it('the outlet states its phone and footer, and a malformed phone is refused', async () => {
    const bad = await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token, { phone: 'call us' });
    expect(bad.status).toBe(409);
    expect(bad.body['error']).toBe('invariant_refused');
    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token,
      { phone: '+91 98450 12345', bill_address: '12 MG Road, Pune', bill_footer: 'Thank you! Come again' }));
  });

  it('prints a BILL from the bill itself, then counts the second copy as a reprint', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Asha' });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = { 'x-lease-token': (await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId })).body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, waiter, { menuItemId: biryani, quantity: 2, modifierOptionIds: [raita] }, kot));
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, waiter, { menuItemId: coke, quantity: 1 }, kot));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, waiter, { sessionVersion: await sessionVersion(sid, waiter) }, kot));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, waiter, {}, kot));
    const claimed = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, cashier, { deviceId: billingDeviceId });
    ok(claimed);
    lease = { 'x-lease-token': claimed.body['token'] as string };
    const made = await http('POST', `/api/t/pos/session/${sid}/bill`, cashier, { splitKind: 'whole' }, lease);
    ok(made);
    billId = made.body['billId'] as string;
    const stored = (await db.query<{ subtotal_minor: string; tax_minor: string; total_minor: string; bill_no: number }>(
      `SELECT subtotal_minor, tax_minor, total_minor, bill_no FROM app.bill WHERE id = $1`, [billId])).rows[0]!;

    const first = await print();
    ok(first);
    const doc = first.body as unknown as Printed;
    expect(doc).toMatchObject({
      kind: 'bill', copyNo: 1, billNo: stored.bill_no, serviceType: 'parcel', pickupName: 'Asha',
      waiter: 'Staff W1', cashier: 'Staff C1',
      restaurant: { name: 'Service Place', address: '12 MG Road, Pune', phone: '+91 98450 12345', footer: 'Thank you! Come again' },
    });
    expect(doc.lines).toEqual([
      { quantity: 2, name: 'Chicken Biryani', rateMinor: 28000, grossMinor: 56000, addOns: ['Extra Raita'], lessMinor: 0, lessLabel: null },
      { quantity: 1, name: 'Coke', rateMinor: 5000, grossMinor: 5000, addOns: [], lessMinor: 0, lessLabel: null },
    ]);
    // The paper adds up to the bill, figure for figure.
    expect(doc.subtotalMinor).toBe(Number(stored.subtotal_minor));
    expect(doc.lines.reduce((sum, l) => sum + l.grossMinor - l.lessMinor, 0)).toBe(doc.subtotalMinor);
    expect(doc.taxes.reduce((sum, t) => sum + t.amountMinor, 0)).toBe(Number(stored.tax_minor));
    expect(doc.taxes.every((t) => t.label.length > 0)).toBe(true);
    expect(doc.totalMinor).toBe(Number(stored.total_minor));

    const second = await print();
    expect(second.body).toMatchObject({ kind: 'bill', copyNo: 2 });
  });

  // 0088: the heading is the branch's wording; which heading, and the count, stay the server's.
  const headingsOf = (res: { body: Record<string, unknown> }) =>
    (res.body['layout'] as { headings: Record<string, string> }).headings;
  const branchRow = async (): Promise<Record<string, unknown>> =>
    ((await http('GET', '/api/t/admin/branches', r.token)).body['rows'] as Record<string, unknown>[])
      .find((b) => b['id'] === r.branchId)!;
  const headingColumns = (row: Record<string, unknown>) =>
    ({ unpaid: row['bill_heading_unpaid'], part: row['bill_heading_part_paid'], paid: row['bill_heading_paid'] });

  it('a branch that never set its headings prints the defaults (0088)', async () => {
    expect(headingColumns(await branchRow())).toEqual({ unpaid: 'BILL', part: 'PART PAID', paid: 'INVOICE' });
    const third = await print();
    ok(third);
    expect(third.body).toMatchObject({ kind: 'bill', copyNo: 3 });
    expect(headingsOf(third)).toEqual({ unpaid: 'BILL', partPaid: 'PART PAID', paid: 'INVOICE' });
  });

  it('a heading is 1 to 20 printable ASCII characters with no space at either end, or the save is refused', async () => {
    for (const bad of ['', ' BILL', 'BILL ', 'X'.repeat(21), 'ரசீது', 'TAX\nINVOICE', 'FACTURE\u00e9']) {
      for (const column of ['bill_heading_unpaid', 'bill_heading_part_paid', 'bill_heading_paid']) {
        const refused = await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token, { [column]: bad });
        expect(refused.status, `${column} = ${JSON.stringify(bad)}`).toBe(409);
        expect(refused.body['error']).toBe('invariant_refused');
      }
    }
    // A heading may not be cleared to nothing, either: the column is NOT NULL.
    const cleared = await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token, { bill_heading_paid: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body['error']).toBe('field_required');
    expect(headingColumns(await branchRow())).toEqual({ unpaid: 'BILL', part: 'PART PAID', paid: 'INVOICE' });
  });

  it('another restaurant cannot set our headings', async () => {
    const theirs = await http('PATCH', `/api/t/admin/branches/${r.branchId}`, other.token, { bill_heading_paid: 'HACKED' });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(404);
    expect(headingColumns(await branchRow())).toEqual({ unpaid: 'BILL', part: 'PART PAID', paid: 'INVOICE' });
  });

  it('custom headings are saved, read back, and carried on the next print -- bill data untouched', async () => {
    const before = (await db.query<{ bill_no: number; total_minor: string; status: string }>(
      `SELECT bill_no, total_minor, status FROM app.bill WHERE id = $1`, [billId])).rows[0]!;
    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token, {
      bill_heading_unpaid: 'RESTAURANT BILL', bill_heading_part_paid: 'PAYMENT DUE', bill_heading_paid: 'TAX INVOICE',
    }));
    expect(headingColumns(await branchRow())).toEqual({ unpaid: 'RESTAURANT BILL', part: 'PAYMENT DUE', paid: 'TAX INVOICE' });

    const fourth = await print();
    ok(fourth);
    expect(fourth.body).toMatchObject({ kind: 'bill', copyNo: 4, billNo: before.bill_no, totalMinor: Number(before.total_minor) });
    expect(headingsOf(fourth)).toEqual({ unpaid: 'RESTAURANT BILL', partPaid: 'PAYMENT DUE', paid: 'TAX INVOICE' });
    const after = (await db.query<{ bill_no: number; total_minor: string; status: string }>(
      `SELECT bill_no, total_minor, status FROM app.bill WHERE id = $1`, [billId])).rows[0]!;
    expect(after).toEqual(before);
  });

  it('after payment it prints a RECEIPT with how it was paid, counted from 1 again', async () => {
    const board = await http('GET', `/api/t/pos/session/${(await db.query<{ session_id: string }>(
      `SELECT session_id FROM app.bill WHERE id = $1`, [billId])).rows[0]!.session_id}/board`, cashier);
    const bill = (board.body['bills'] as Record<string, unknown>[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${billId}/tender`, cashier,
      { method: 'upi', amountMinor: Number(bill['outstanding_minor']), reference: 'UPI-77' }, lease));

    const receipt = await print();
    ok(receipt);
    expect(receipt.body).toMatchObject({ kind: 'receipt', copyNo: 1 });
    // Which heading prints is the receipt's (`paid`), chosen on the till from `kind`; the words are the branch's.
    expect(headingsOf(receipt).paid).toBe('TAX INVOICE');
    expect((receipt.body as unknown as Printed).tenders)
      .toEqual([{ method: 'upi', amountMinor: Number(bill['outstanding_minor']), reference: 'UPI-77',
        cashReceivedMinor: null, changeMinor: 0, roundingMinor: 0 }]);

    const copies = await db.query<{ kind: string; copy_no: number }>(
      `SELECT kind, copy_no FROM app.bill_print WHERE bill_id = $1 ORDER BY kind, copy_no`, [billId]);
    expect(copies.rows).toEqual([
      { kind: 'bill', copy_no: 1 }, { kind: 'bill', copy_no: 2 }, { kind: 'bill', copy_no: 3 }, { kind: 'bill', copy_no: 4 },
      { kind: 'receipt', copy_no: 1 },
    ]);
  });

  it('a reprint carries the heading saved NOW, and Reset to default restores what every branch prints', async () => {
    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token, { bill_heading_paid: 'CASH RECEIPT' }));
    const reprint = await print();
    ok(reprint);
    expect(reprint.body).toMatchObject({ kind: 'receipt', copyNo: 2 });
    expect(headingsOf(reprint).paid).toBe('CASH RECEIPT');

    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token,
      { bill_heading_unpaid: 'BILL', bill_heading_part_paid: 'PART PAID', bill_heading_paid: 'INVOICE' }));
    const again = await print();
    expect(again.body).toMatchObject({ kind: 'receipt', copyNo: 3 });
    expect(headingsOf(again)).toEqual({ unpaid: 'BILL', partPaid: 'PART PAID', paid: 'INVOICE' });
  });

  it('is not the kitchen\'s to print, and another restaurant cannot print it at all', async () => {
    expect((await print(chef)).status).toBe(403);
    const elsewhere = await print(other.token);
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(404);
    expect(elsewhere.body['error']).toBe('bill_unknown');
  });
});

describe('3e. taking payment: parts, mixed methods, the cash note and its change', () => {
  /** A parcel handed to Billing and billed; returns the bill and Billing's lease. */
  const billed = async (quantity: number) => {
    const opened = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Pay' });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = { 'x-lease-token': (await http('POST', `/api/t/pos/session/${sid}/lease`, waiter, { deviceId })).body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, waiter, { menuItemId: coke, quantity }, kot));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, waiter, { sessionVersion: await sessionVersion(sid, waiter) }, kot));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, waiter, {}, kot));
    const claimed = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, cashier, { deviceId: billingDeviceId });
    ok(claimed);
    const lease = { 'x-lease-token': claimed.body['token'] as string };
    const made = await http('POST', `/api/t/pos/session/${sid}/bill`, cashier, { splitKind: 'whole' }, lease);
    ok(made);
    // What is owed: the payable (total + round off, 0082).
    return { sid, billId: made.body['billId'] as string, total: made.body['payableMinor'] as number, lease };
  };
  const pay = (billId: string, parts: unknown, lease: Record<string, string>, token = cashier) =>
    http('POST', `/api/t/pos/bill/${billId}/payment`, token, { parts }, lease);

  it('card plus a cash note: the server applies the note to what is left and names the change', async () => {
    const { sid, billId, total, lease } = await billed(4);
    const card = total - 1000;
    const res = await pay(billId, [{ method: 'card', amountMinor: card, reference: 'C-1' },
      { method: 'cash', cashReceivedMinor: 5000 }], lease);
    ok(res);
    expect(res.body).toMatchObject({ paidMinor: total, outstandingMinor: 0, changeMinor: 4000, settled: true });

    // The board and the printed receipt say the same thing the payment did.
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, cashier);
    const bill = (board.body['bills'] as { paid_minor: string; settled: boolean; tenders: Record<string, unknown>[] }[])[0]!;
    expect(bill).toMatchObject({ paid_minor: String(total), settled: true });
    expect(bill.tenders.find((t) => t['method'] === 'cash'))
      .toMatchObject({ amount_minor: '1000', cash_received_minor: '5000', change_minor: '4000' });
    const receipt = await http('POST', `/api/t/pos/bill/${billId}/print`, cashier, {});
    ok(receipt);
    expect(receipt.body).toMatchObject({ kind: 'receipt', paidMinor: total, outstandingMinor: 0 });
    expect(receipt.body['tenders']).toEqual([
      { method: 'card', amountMinor: card, reference: 'C-1', cashReceivedMinor: null, changeMinor: 0, roundingMinor: 0 },
      { method: 'cash', amountMinor: 1000, reference: null, cashReceivedMinor: 5000, changeMinor: 4000, roundingMinor: 0 },
    ]);
  });

  it('a part payment stays open in the queue, prints a balance, and the rest settles it later', async () => {
    const { sid, billId, total, lease } = await billed(3);
    ok(await pay(billId, [{ method: 'upi', amountMinor: 2000 }], lease));
    const bill = await http('POST', `/api/t/pos/bill/${billId}/print`, cashier, {});
    expect(bill.body).toMatchObject({ kind: 'bill', paidMinor: 2000, outstandingMinor: total - 2000 });
    const queue = await http('GET', '/api/t/billing/queue', cashier);
    expect((queue.body['rows'] as { sessionId: string; status: string; paidMinor: string }[])
      .find((q) => q.sessionId === sid)).toMatchObject({ status: 'in_progress', paidMinor: '2000' });

    const rest = await pay(billId, [{ method: 'cash', cashReceivedMinor: total }], lease);
    ok(rest);
    expect(rest.body).toMatchObject({ settled: true, changeMinor: 2000, outstandingMinor: 0 });
  });

  it('refusals reach the till as their own codes, and nothing is half-recorded', async () => {
    const { billId, total, lease } = await billed(2);
    const over = await pay(billId, [{ method: 'card', amountMinor: total + 1 }], lease);
    expect([over.status, over.body['error']]).toEqual([409, 'payment_exceeds_balance']);
    const bad = await pay(billId, [{ method: 'card', amountMinor: -5 }], lease);
    expect([bad.status, bad.body['error']]).toEqual([422, 'payment_invalid']);
    const rows = await db.query(`SELECT 1 FROM app.tender WHERE bill_id = $1`, [billId]);
    expect(rows.rowCount).toBe(0);

    ok(await pay(billId, [{ method: 'card', amountMinor: total }], lease));
    const again = await pay(billId, [{ method: 'cash', cashReceivedMinor: 100 }], lease);
    expect([again.status, again.body['error']]).toEqual([409, 'bill_not_payable']);
  });

  it('a retried request with the same key is taken once', async () => {
    const { billId, total, lease } = await billed(2);
    const key = { ...lease, 'idempotency-key': `idem-${randomUUID()}` };
    const parts = [{ method: 'cash', cashReceivedMinor: total + 500 }];
    const first = await pay(billId, parts, key);
    const second = await pay(billId, parts, key);
    ok(first);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await db.query(`SELECT 1 FROM app.tender WHERE bill_id = $1`, [billId]);
    expect(rows.rowCount).toBe(1);
  });

  it('needs the till key and Billing\'s lease', async () => {
    const { billId, total, lease } = await billed(1);
    const kitchen = await pay(billId, [{ method: 'card', amountMinor: total }], lease, chef);
    expect(kitchen.status).toBe(403);
    const unleased = await http('POST', `/api/t/pos/bill/${billId}/payment`, cashier,
      { parts: [{ method: 'card', amountMinor: total }] });
    expect([unleased.status, unleased.body['error']]).toEqual([400, 'lease_token_required']);
    const elsewhere = await pay(billId, [{ method: 'card', amountMinor: total }], lease, other.token);
    // Refused for lacking the till key, before isolation is reached; isolation
    // itself is pinned in service.test (F2) by paying from another restaurant.
    expect([elsewhere.status, elsewhere.body['error']]).toEqual([403, 'forbidden']);
    expect((await db.query(`SELECT 1 FROM app.tender WHERE bill_id = $1`, [billId])).rowCount).toBe(0);
  });
});

describe('4. parcel: counter to kitchen to customer', () => {
  let sessionId: string, orderId: string, lease: string, parcelNo: number;
  const leased = () => ({ 'x-lease-token': lease });
  const status = async () => {
    const list = await http('GET', '/api/t/pos/parcels', waiter);
    ok(list);
    return (list.body as unknown as { sessionId: string; status: string; parcelNo: number; pickupName: string | null }[])
      .find((p) => p.sessionId === sessionId)!;
  };

  it('opens a parcel with no table, numbered for the day', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Rahul' });
    ok(opened);
    sessionId = opened.body['sessionId'] as string;
    orderId = opened.body['orderId'] as string;
    parcelNo = opened.body['parcelNo'] as number;
    const next = await http('POST', '/api/t/pos/parcel', waiter, {});
    ok(next);
    expect(next.body['parcelNo']).toBe(parcelNo + 1);
    const attached = await db.query(`SELECT 1 FROM app.table_session_table WHERE session_id = $1`, [sessionId]);
    expect(attached.rowCount).toBe(0);
    expect(await status()).toMatchObject({ status: 'new', pickupName: 'Rahul', parcelNo });
  });

  it('goes to the kitchen marked PARCEL, and cannot be handed over until ready', async () => {
    const claimed = await http('POST', `/api/t/pos/session/${sessionId}/lease`, waiter, { deviceId });
    ok(claimed);
    lease = claimed.body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${orderId}/line`, waiter, { menuItemId: biryani, quantity: 2 }, leased()));

    const early = await http('POST', `/api/t/pos/session/${sessionId}/pickup`, waiter, {}, leased());
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('parcel_not_ready');

    ok(await http('POST', `/api/t/pos/order/${orderId}/fire`, waiter,
      { sessionVersion: await sessionVersion(sessionId, waiter) }, leased()));
    const [ticket] = await kitchen(orderId, 'Hot Kitchen');
    expect(ticket!.ticketText).toContain(`PARCEL P-${parcelNo} Rahul`);
    expect((await status()).status).toBe('preparing');

    const joined = await http('POST', `/api/t/pos/session/${sessionId}/tables`, waiter, { diningTableId: tables['T07'] }, leased());
    expect(joined.body['error']).toBe('service_type_mismatch');

    ok(await http('POST', `/api/t/pos/kot/${ticket!.kotId}/ready`, waiter, {}));
    expect((await status()).status).toBe('ready');
  });

  it('is picked up once, paid, and completed', async () => {
    ok(await http('POST', `/api/t/pos/session/${sessionId}/pickup`, waiter, {}, leased()));
    expect((await status()).status).toBe('picked_up');
    const again = await http('POST', `/api/t/pos/session/${sessionId}/pickup`, waiter, {}, leased());
    expect(again.body['error']).toBe('parcel_already_picked_up');

    ok(await http('POST', `/api/t/pos/session/${sessionId}/ready-for-billing`, waiter, {}, leased()));
    const taken = await http('POST', `/api/t/pos/session/${sessionId}/billing-lease`, cashier, { deviceId: billingDeviceId });
    ok(taken);
    const billed = { 'x-lease-token': taken.body['token'] as string };
    ok(await http('POST', `/api/t/pos/session/${sessionId}/bill`, cashier, { splitKind: 'whole' }, billed));
    const board = await http('GET', `/api/t/pos/session/${sessionId}/board`, cashier);
    const bill = (board.body['bills'] as Record<string, unknown>[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, cashier,
      { method: 'card', amountMinor: Number(bill['outstanding_minor']), reference: 'CARD-0002' }, billed));
    ok(await http('DELETE', `/api/t/pos/session/${sessionId}`, cashier, undefined, billed));
    expect((await status()).status).toBe('completed');
  });
});

describe('4b. KOT says when food is ready', () => {
  let sessionId: string, orderId: string, lease: string, kotId: string;
  const leased = () => ({ 'x-lease-token': lease });
  interface Ticket { kotId: string; stationName: string; ready: boolean; kotMarksReady: boolean }
  const tickets = async (): Promise<Ticket[]> => {
    const res = await http('GET', `/api/t/pos/order/${orderId}/tickets`, waiter);
    ok(res);
    return res.body as unknown as Ticket[];
  };
  const parcel = async () => ((await http('GET', '/api/t/pos/parcels', waiter)).body as unknown as
    { sessionId: string; status: string }[]).find((p) => p.sessionId === sessionId)!;

  beforeAll(() => { planOf.set(r.tenantId, 'standard'); });
  afterAll(() => { planOf.delete(r.tenantId); });

  it('a sent parcel waits on KOT, not on a screen nobody has', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', waiter, { pickupName: 'Asha' });
    ok(opened);
    sessionId = opened.body['sessionId'] as string;
    orderId = opened.body['orderId'] as string;
    const claimed = await http('POST', `/api/t/pos/session/${sessionId}/lease`, waiter, { deviceId });
    ok(claimed);
    lease = claimed.body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${orderId}/line`, waiter, { menuItemId: paneer, quantity: 1 }, leased()));
    ok(await http('POST', `/api/t/pos/order/${orderId}/fire`, waiter,
      { sessionVersion: await sessionVersion(sessionId, waiter) }, leased()));

    const [ticket] = await tickets();
    expect(ticket).toMatchObject({ stationName: 'Hot Kitchen', ready: false, kotMarksReady: true });
    kotId = ticket!.kotId;
    expect((await parcel()).status).toBe('preparing');
    const early = await http('POST', `/api/t/pos/session/${sessionId}/pickup`, waiter, {}, leased());
    expect(early.body['error']).toBe('parcel_not_ready');
  });

  it('only someone holding kot.ready may say it is ready', async () => {
    const refused = await http('POST', `/api/t/pos/kot/${kotId}/ready`, cashier, {});
    expect(refused.status).toBe(403);
  });

  it('KOT marks it ready; the parcel is ready and can be handed over', async () => {
    const marked = await http('POST', `/api/t/pos/kot/${kotId}/ready`, waiter, {});
    ok(marked);
    expect(marked.body).toMatchObject({ kotId, marked: 1 });
    expect((await tickets())[0]).toMatchObject({ ready: true, kotMarksReady: true });
    expect((await parcel()).status).toBe('ready');
    ok(await http('POST', `/api/t/pos/session/${sessionId}/pickup`, waiter, {}, leased()));

    // The audit row names the action and who did it.
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM app.tenant_audit_log WHERE tenant_id = $1 AND target_id = $2`, [r.tenantId, kotId]);
    expect(audit.rows.map((a) => a.action)).toContain('kot.marked_ready');
  });

  it('a ticket from another restaurant is not this tablet\'s to mark', async () => {
    const theirs = await http('POST', `/api/t/pos/kot/${randomUUID()}/ready`, waiter, {});
    expect(theirs.status).toBe(409);
    expect(theirs.body['error']).toBe('kds_version_conflict');
  });

  it('on a retired plan version that still names a kitchen screen, KOT still marks food ready', async () => {
    // The screen is gone: refusing here would leave nobody able to release food.
    planOf.set(r.tenantId, 'pro');
    expect((await tickets())[0]).toMatchObject({ kotMarksReady: true });
    ok(await http('POST', `/api/t/pos/kot/${kotId}/ready`, waiter, {}));
    planOf.set(r.tenantId, 'standard');
  });
});

describe('5. isolation', () => {
  it('another restaurant cannot see this one\'s parcels or seat its tables', async () => {
    const theirs = await http('GET', '/api/t/pos/parcels', other.token);
    // The owner's password session has no branch, so it is not a POS session at all.
    expect(theirs.status).not.toBe(200);
    const seat = await http('POST', '/api/t/pos/session', waiter, { diningTableIds: [otherTable] });
    expect(seat.status).toBe(422);
    expect(seat.body['error']).toBe('table_unavailable');
  });
});

describe('6. a plan version without KOT: the owner bills directly', () => {
  let shop: Restaurant;
  let owner: string;
  let tea: string;
  const SHOP_FINGERPRINT = `fs${randomUUID().replace(/-/g, '')}`;

  it('the owner signs in at the counter as its till: no setup code, no PIN', async () => {
    shop = await restaurant('basic');
    withoutKot.add(shop.tenantId);
    const printer = await http('POST', at('/api/t/admin/printers', shop.branchId), shop.token, { name: 'Counter', connection_kind: 'usb' });
    ok(printer);
    ok(await http('POST', at('/api/t/admin/kitchens', shop.branchId), shop.token,
      { name: 'Counter Kitchen', kind: 'food', printerId: printer.body['id'] }));
    const taxClassId = (await db.query<{ id: string }>(
      `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [shop.tenantId])).rows[0]!.id;
    const item = await http('POST', at('/api/t/admin/menu/items', shop.branchId), shop.token, {
      name: 'Masala Tea', kind: 'single', kitchenCode: 'counter_kitchen', priceMinor: 2000, taxClassId,
    });
    ok(item);
    expect(item.body['listed']).toBe(true);
    tea = item.body['id'] as string;

    owner = await tillSession(shop, SHOP_FINGERPRINT, 'Counter');
  });

  it('without KOT on the plan nothing goes to a kitchen', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', owner, {});
    ok(opened);
    const deviceRow = await db.query<{ id: string }>(`SELECT id FROM app.device WHERE fingerprint = $1`, [SHOP_FINGERPRINT]);
    const lease = (await http('POST', `/api/t/pos/session/${opened.body['sessionId'] as string}/lease`, owner,
      { deviceId: deviceRow.rows[0]!.id })).body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/line`, owner,
      { menuItemId: tea, quantity: 1 }, { 'x-lease-token': lease }));
    const fire = await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/fire`, owner,
      { sessionVersion: 1 }, { 'x-lease-token': lease });
    expect(fire.status).toBe(402);
    expect(fire.body['error']).toBe('upgrade_required');
  });

  it('order, bill and pay at the counter, with nothing sent to a kitchen', async () => {
    const deviceId2 = (await db.query<{ id: string }>(`SELECT id FROM app.device WHERE fingerprint = $1`, [SHOP_FINGERPRINT])).rows[0]!.id;
    const opened = await http('POST', '/api/t/pos/parcel', owner, { pickupName: 'Walk-in' });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const lease = (await http('POST', `/api/t/pos/session/${sid}/lease`, owner, { deviceId: deviceId2 })).body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/line`, owner,
      { menuItemId: tea, quantity: 3 }, { 'x-lease-token': lease }));
    // Unsent is normal without KOT, so the hand-over does not ask for a kitchen.
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, owner, {}, { 'x-lease-token': lease }));
    const taken = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, owner, { deviceId: deviceId2 });
    ok(taken);
    const billed = { 'x-lease-token': taken.body['token'] as string };
    ok(await http('POST', `/api/t/pos/session/${sid}/bill`, owner, { splitKind: 'whole' }, billed));
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, owner);
    const bill = (board.body['bills'] as Record<string, unknown>[])[0]!;
    expect(Number(bill['subtotal_minor'])).toBe(6000);
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, owner,
      { method: 'upi', amountMinor: Number(bill['outstanding_minor']), reference: 'UPI-1' }, billed));
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, owner, undefined, billed));
    const queue = await http('GET', '/api/t/billing/queue', owner);
    expect(queue.body['kot'], 'without KOT, Billing takes its own orders').toBe(false);
    expect((queue.body['rows'] as unknown as { sessionId: string; status: string }[]).find((q) => q.sessionId === sid)!.status)
      .toBe('completed');
    const kitchenLines = await db.query(
      `SELECT 1 FROM app.kot_line kl JOIN app.order_line ol ON ol.id = kl.order_line_id WHERE ol.order_id = $1`,
      [opened.body['orderId']]);
    expect(kitchenLines.rowCount).toBe(0);
  });

  it('a Billing & Orders account takes the order itself; Billing Staff cannot', async () => {
    // A `cashier` is refused 403 at New order: without KOT nobody else takes
    // the order, which is what `counter` is for.
    const deviceId2 = (await db.query<{ id: string }>(`SELECT id FROM app.device WHERE fingerprint = $1`, [SHOP_FINGERPRINT])).rows[0]!.id;
    const signIn = async (code: string, role: string, pin: string) => {
      await hire(code, role, pin, shop);
      const session = await pinLogin(code, pin, SHOP_FINGERPRINT, shop);
      ok(session);
      return session.body['accessToken'] as string;
    };
    const billingOnly = await signIn('BS1', 'cashier', '5927');
    const refused = await http('POST', '/api/t/pos/parcel', billingOnly, { pickupName: 'Walk-in' });
    expect(refused.status).toBe(403);

    const counter = await signIn('BO1', 'counter', '7392');
    const opened = await http('POST', '/api/t/pos/parcel', counter, { pickupName: 'Walk-in' });
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const lease = (await http('POST', `/api/t/pos/session/${sid}/lease`, counter, { deviceId: deviceId2 })).body['token'] as string;
    ok(await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/line`, counter,
      { menuItemId: tea, quantity: 2 }, { 'x-lease-token': lease }));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, counter, {}, { 'x-lease-token': lease }));
    const taken = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, counter, { deviceId: deviceId2 });
    ok(taken);
    const billed = { 'x-lease-token': taken.body['token'] as string };
    ok(await http('POST', `/api/t/pos/session/${sid}/bill`, counter, { splitKind: 'whole' }, billed));
    const bill = ((await http('GET', `/api/t/pos/session/${sid}/board`, counter)).body['bills'] as Record<string, unknown>[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, counter,
      { method: 'cash', amountMinor: Number(bill['outstanding_minor']) }, billed));
    // It still cannot send anything to a kitchen: that is KOT's.
    const fire = await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/fire`, counter, { sessionVersion: 1 },
      { 'x-lease-token': lease });
    expect(fire.status, JSON.stringify(fire.body)).toBe(403);
  });
});

describe('6b. Basic and Standard: KOT, printed tickets and Billing', () => {
  for (const plan of ['basic', 'standard'] as const) {
    it(`${plan}: KOT sends to the kitchen, KOT marks it ready, and the order is billed`, async () => {
      const place = await restaurant(plan);
      const printer = await http('POST', at('/api/t/admin/printers', place.branchId), place.token,
        { name: 'Pass', connection_kind: 'usb' });
      ok(printer);
      const kitchen = await http('POST', at('/api/t/admin/kitchens', place.branchId), place.token,
        { name: 'Main Kitchen', kind: 'food', printerId: printer.body['id'] });
      ok(kitchen);
      const taxClassId = (await db.query<{ id: string }>(
        `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [place.tenantId])).rows[0]!.id;
      const item = await http('POST', at('/api/t/admin/menu/items', place.branchId), place.token,
        { name: 'Veg Thali', kind: 'single', kitchenCode: 'main_kitchen', priceMinor: 15000, taxClassId });
      ok(item);

      const fingerprint = `fp${randomUUID().replace(/-/g, '')}`;
      const manager = await tillSession(place, fingerprint, 'KOT');
      const device = (await db.query<{ id: string }>(
        `SELECT id FROM app.device WHERE fingerprint = $1`, [fingerprint])).rows[0]!.id;

      const opened = await http('POST', '/api/t/pos/parcel', manager, { pickupName: 'Ravi' });
      ok(opened);
      const sid = opened.body['sessionId'] as string;
      const orderId = opened.body['orderId'] as string;
      const lease = { 'x-lease-token': (await http('POST', `/api/t/pos/session/${sid}/lease`, manager,
        { deviceId: device })).body['token'] as string };
      ok(await http('POST', `/api/t/pos/order/${orderId}/line`, manager,
        { menuItemId: item.body['id'], quantity: 2 }, lease));
      ok(await http('POST', `/api/t/pos/order/${orderId}/fire`, manager,
        { sessionVersion: await sessionVersion(sid, manager) }, lease));

      const tickets = await http('GET', `/api/t/pos/order/${orderId}/tickets`, manager);
      ok(tickets);
      const [ticket] = tickets.body as unknown as { kotId: string; kotMarksReady: boolean }[];
      expect(ticket!.kotMarksReady, 'no screen, so KOT says when food is ready').toBe(true);
      const printed = await db.query(`SELECT 1 FROM app.print_job WHERE tenant_id = $1 AND kot_id = $2`,
        [place.tenantId, ticket!.kotId]);
      expect(printed.rowCount, 'the kitchen gets a printed ticket').toBeGreaterThan(0);
      ok(await http('POST', `/api/t/pos/kot/${ticket!.kotId}/ready`, manager, {}));

      ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, manager, {}, lease));
      const taken = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, manager, { deviceId: device });
      ok(taken);
      const billed = { 'x-lease-token': taken.body['token'] as string };
      ok(await http('POST', `/api/t/pos/session/${sid}/bill`, manager, { splitKind: 'whole' }, billed));
      const bill = ((await http('GET', `/api/t/pos/session/${sid}/board`, manager)).body['bills'] as
        Record<string, unknown>[])[0]!;
      ok(await http('POST', `/api/t/pos/bill/${bill['id'] as string}/tender`, manager,
        { method: 'cash', amountMinor: Number(bill['outstanding_minor']) }, billed));
    });
  }
});

describe('7. setup from one Excel file', () => {
  type Problem = { sheet: string; row: number | null; message: string };
  type Result = { applied: boolean; errors: Problem[]; counts: Record<string, { created: number; updated: number }> };
  const send = async (path: string, sheets: Record<string, unknown[]>, token = r.token) =>
    http('POST', at(`/api/t/admin/setup/import${path}`, r.branchId), token, { sheets });
  const good = (price: string, seats: string) => ({
    restaurant: [{ row: 2, dayStartsAt: '03:00' }],
    floors: [{ row: 2, name: 'Garden', type: 'Rooftop', order: '5' }],
    tables: [{ row: 2, name: 'G1', floor: 'Garden', seats }, { row: 3, name: 'G2', floor: 'Garden', seats: '2' }],
    printers: [{ row: 2, name: 'Tandoor printer', connection: 'network', address: '192.168.0.9:9100' }],
    kitchens: [{ row: 2, name: 'Tandoor', type: 'food', printer: 'Tandoor printer' }],
    categories: [{ row: 2, name: 'Breads', kitchen: 'Tandoor', order: '3' }],
    items: [
      { row: 2, name: 'Butter Naan', category: 'Breads', price, tax: 'GST 5%', available: 'Yes' },
      { row: 3, name: 'Garlic Naan', category: 'Breads', price: '70', tax: 'GST 5%', kitchen: 'Tandoor', available: 'No' },
    ],
  });
  const totals = async () => (await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM app.floor WHERE tenant_id = $1 AND name = 'Garden') AS floors,
            (SELECT count(*) FROM app.dining_table WHERE tenant_id = $1 AND identifier IN ('G1','G2')) AS tables,
            (SELECT count(*) FROM app.printer WHERE tenant_id = $1 AND name = 'Tandoor printer') AS printers,
            (SELECT count(*) FROM app.kitchen_station WHERE tenant_id = $1 AND code = 'tandoor') AS kitchens,
            (SELECT count(*) FROM app.menu_category WHERE tenant_id = $1 AND key = 'breads') AS categories,
            (SELECT count(*) FROM app.menu_item WHERE tenant_id = $1 AND name IN ('Butter Naan','Garlic Naan')) AS items`,
    [r.tenantId])).rows[0]!;

  it('reports every bad row, by sheet and row, and saves nothing', async () => {
    const res = await send('/preview', {
      floors: [{ row: 2, name: 'Garden', type: 'Rooftop' }],
      tables: [
        { row: 2, name: 'G1', floor: 'Garden', seats: '4' },
        { row: 3, name: 'g1', floor: 'Garden', seats: '2' },
        { row: 4, name: 'G9', floor: 'Roof', seats: '2' },
        { row: 5, name: '', floor: 'Garden', seats: '2' },
      ],
      kitchens: [{ row: 2, name: 'Tandoor', type: 'food', printer: 'Nope' }],
      items: [
        { row: 2, name: 'Butter Naan', price: '4O', tax: 'GST 5%', kitchen: 'Hot Kitchen' },
        { row: 3, name: 'Plain Naan', category: 'Missing', price: '40', tax: 'GST 5%', kitchen: 'Hot Kitchen' },
      ],
    });
    ok(res);
    const result = res.body as unknown as Result;
    expect(result.applied).toBe(false);
    const at2 = (sheet: string, row: number) => result.errors.find((e) => e.sheet === sheet && e.row === row)?.message ?? '';
    expect(at2('Tables', 3)).toMatch(/also on row 2/);
    expect(at2('Tables', 4)).toMatch(/Floor "Roof" not found/);
    expect(at2('Tables', 5)).toMatch(/Table is required/);
    expect(at2('Printer Mapping', 2)).toMatch(/Printer "Nope" not found/);
    expect(at2('Menu Items', 2)).toMatch(/not a price/);
    expect(at2('Menu Items', 3)).toMatch(/Category "Missing" not found/);
    expect(await totals()).toMatchObject({ floors: '0', tables: '0' });
  });

  it('previews a good file without saving it, then imports it all', async () => {
    const preview = (await send('/preview', good('60', '4'))).body as unknown as Result;
    expect(preview).toMatchObject({ applied: false, errors: [] });
    expect(preview.counts['tables']).toEqual({ created: 2, updated: 0 });
    expect(await totals()).toMatchObject({ floors: '0', items: '0' });

    const done = await send('', good('60', '4'));
    ok(done);
    const result = done.body as unknown as Result;
    expect(result).toMatchObject({ applied: true, errors: [] });
    expect(result.counts).toMatchObject({
      floors: { created: 1 }, tables: { created: 2 }, printers: { created: 1 }, kitchens: { created: 1 },
      categories: { created: 1 }, items: { created: 2 }, restaurant: { updated: 1 },
    });
    expect(await totals()).toEqual({ floors: '1', tables: '2', printers: '1', kitchens: '1', categories: '1', items: '2' });
    // Blank Kitchen used the category's default; Available: No took it off sale.
    const items = await db.query<{ name: string; station_code: string; price_minor: string; listed: boolean }>(
      `SELECT i.name, i.station_code, i.price_minor::text, l.listed FROM app.menu_item i
         JOIN app.branch_menu_listing l ON l.tenant_id = i.tenant_id AND l.menu_item_id = i.id AND l.branch_id = $2
        WHERE i.tenant_id = $1 AND i.name IN ('Butter Naan','Garlic Naan') ORDER BY i.name`, [r.tenantId, r.branchId]);
    expect(items.rows).toEqual([
      { name: 'Butter Naan', station_code: 'tandoor', price_minor: '6000', listed: true },
      { name: 'Garlic Naan', station_code: 'tandoor', price_minor: '7000', listed: false },
    ]);
  });

  it('uploading the corrected file again updates in place and duplicates nothing', async () => {
    const again = (await send('', good('65.50', '6'))).body as unknown as Result;
    expect(again).toMatchObject({ applied: true, errors: [] });
    expect(Object.values(again.counts).every((c) => c.created === 0)).toBe(true);
    expect(await totals()).toEqual({ floors: '1', tables: '2', printers: '1', kitchens: '1', categories: '1', items: '2' });
    const naan = await db.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM app.menu_item WHERE tenant_id = $1 AND name = 'Butter Naan'`, [r.tenantId]);
    expect(naan.rows[0]!.price_minor).toBe('6550');
    const seats = await db.query<{ seats: number }>(
      `SELECT seats FROM app.dining_table WHERE tenant_id = $1 AND identifier = 'G1'`, [r.tenantId]);
    expect(seats.rows[0]!.seats).toBe(6);
  });

  it('is refused to anyone who cannot do the setup by hand', async () => {
    const refused = await send('', good('60', '4'), waiter);
    expect(refused.status).toBe(403);
  });
});
