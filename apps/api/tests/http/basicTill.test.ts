import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planDocument } from '../helpers/plans.js';
import type { PlanKey } from '@katkitchen/shared';
import { buildServer } from '../../src/app.js';
import { resetRegistry } from '../../src/core/middleware/routeRegistry.js';
import { signToken, verifyToken } from '../../src/modules/auth/jwt.js';
import { hashSecret } from '../../src/modules/auth/deviceAuth.js';
import { issueSession } from '../../src/modules/auth/session.js';
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
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { salesBy } from '../../src/modules/reporting/salesReports.js';
import { outwardSupplyReturn } from '../../src/modules/reporting/gstReturn.js';

/**
 * Basic: one login page for the manager and the staff. The manager signs in and
 * this computer becomes a till -- no setup code, no PIN -- and on that ONE
 * sign-in takes a dine-in order (numbered at the counter: Basic has no tables)
 * and a parcel, sends them to the kitchen, bills them and takes the money.
 *
 * Staff are added by the Sales person with a 4-digit PIN (0077) and sign in on
 * that till by tapping their name: /me says they are not a manager. Then the
 * limits: two tills, which only a manager makes, and four users (the owner
 * included), counted on the server.
 */

const KEY = 'basic-till-signing-key-long-enough-for-hs256';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let versionOf: ReadonlyMap<string, string>;
const planOf = new Map<string, PlanKey>();

interface Restaurant { tenantId: string; slug: string; token: string; branchId: string }
let r: Restaurant;
let other: Restaurant;
let dal: string;
let till: { deviceId: string; token: string };
const FINGERPRINT = `till${randomUUID().replace(/-/g, '')}`;

async function http(
  method: string, url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {},
) {
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
/** POS writes carry an idempotency key, as the tablet's queue sends them. */
const keyed = (extra: Record<string, string> = {}) => ({ 'idempotency-key': `idem-${randomUUID()}`, ...extra });
const ok = (res: { status: number; body: unknown }) => expect(res.status, JSON.stringify(res.body)).toBe(200);
const at = (path: string, branchId: string) => `${path}?branchId=${branchId}`;
const OWNER_PASSWORD = 'till-owner-2026';
/** The POS half of the one login page: username (or email), password and this browser. */
const tillSignIn = (slug: string, login: string, password: string, fingerprint: string, deviceName = 'Counter') =>
  http('POST', `/api/auth/${slug}/till`, null, { login, password, deviceFingerprint: fingerprint, deviceName });
const login = (slug: string, who: string, password: string) =>
  http('POST', `/api/auth/${slug}/login`, null, { login: who, password });

async function restaurant(plan: PlanKey, jurisdiction: 'IN' | 'AE' = 'IN'): Promise<Restaurant> {
  const slug = `till-${randomUUID().slice(0, 8)}`;
  const email = `owner@${slug}.test`;
  const now = Math.floor(Date.now() / 1000);
  const made = await http('POST', '/api/platform/tenants',
    signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY), {
      slug, name: 'Till Place', currency: jurisdiction === 'AE' ? 'AED' : 'INR',
      timezone: jurisdiction === 'AE' ? 'Asia/Dubai' : 'Asia/Kolkata', ownerEmail: email, ownerName: 'Owner',
      firstBranchName: 'Main', planVersionId: versionOf.get(plan)!, taxJurisdiction: jurisdiction, address: '1 Test Road, Pune',
    }, keyed());
  ok(made);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'till-owner-2026' });
  const signedIn = await http('POST', `/api/auth/${slug}/login`, null, { email, password: 'till-owner-2026' });
  const tenantId = made.body['tenantId'] as string;
  planOf.set(tenantId, plan);
  return {
    tenantId, slug, token: signedIn.body['accessToken'] as string,
    branchId: (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id,
  };
}

async function sessionVersion(sessionId: string, token: string): Promise<number> {
  const board = await http('GET', `/api/t/pos/session/${sessionId}/board`, token);
  ok(board);
  return Number((board.body['session'] as Record<string, unknown>)['version']);
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
     VALUES ($1, $2, 'argon2id$stub', 'Till Rep', $3)`, [rep, `till+${rep}@platform.test`, salesRole]);
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
    async get(tenantId: string) { return planDocument(tenantId, planOf.get(tenantId) ?? 'basic'); },
    async put() { /* every document is computed */ },
  } }, new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await restaurant('basic');
  other = await restaurant('basic');

  const printer = await http('POST', at('/api/t/admin/printers', r.branchId), r.token, { name: 'Kitchen printer', connection_kind: 'usb' });
  ok(printer);
  ok(await http('POST', at('/api/t/admin/kitchens', r.branchId), r.token, { name: 'Kitchen', kind: 'food', printerId: printer.body['id'] }));
  const taxClassId = (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [r.tenantId])).rows[0]!.id;
  const category = await http('POST', '/api/t/admin/menu/categories', r.token, { key: 'mains', name: 'Mains', display_order: '1' });
  ok(category);
  const item = await http('POST', at('/api/t/admin/menu/items', r.branchId), r.token, {
    name: 'Dal Tadka', categoryId: category.body['id'], kind: 'single', kitchenCode: 'kitchen', priceMinor: 20000,
    prepMinutes: 10, taxClassId, addOnGroupIds: [],
  });
  ok(item);
  dal = item.body['id'] as string;
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('1. the manager signs in on the one login page', () => {
  it('a manager is told so, and lands on the manager screens', async () => {
    const office = await login(r.slug, `owner@${r.slug}.test`, OWNER_PASSWORD);
    ok(office);
    expect(office.body['lands']).toBe('admin');
    const me = await http('GET', '/api/t/me', office.body['accessToken'] as string);
    expect((me.body['screens'] as Record<string, boolean>)['admin']).toBe(true);
  });

  it('the same email and password make this computer a till -- and give the manager NO POS session', async () => {
    const res = await tillSignIn(r.slug, `owner@${r.slug}.test`, OWNER_PASSWORD, FINGERPRINT, 'Counter computer');
    ok(res);
    expect(res.body).toEqual({ tillOnly: true, deviceId: expect.any(String), branchId: r.branchId });
    const deviceId = res.body['deviceId'] as string;
    const device = await db.query<{ status: string; registered_by_user_id: string; name: string }>(
      `SELECT status, registered_by_user_id, name FROM app.device WHERE id = $1`, [deviceId]);
    expect(device.rows[0]).toMatchObject({ status: 'active', name: 'Counter computer' });
    expect((await db.query(`SELECT 1 FROM app.device_enrolment WHERE tenant_id = $1`, [r.tenantId])).rowCount).toBe(0);

    // The POS is staff's: one signs in on this till by PIN, and that session is the one the flows below use.
    ok(await addStaff(r, 'Till Staff', 'pos', '5927'));
    const staffId = (await db.query<{ id: string }>(
      `SELECT id FROM app.app_user WHERE tenant_id = $1 AND full_name = 'Till Staff'`, [r.tenantId])).rows[0]!.id;
    const pin = await http('POST', `/api/auth/${r.slug}/pin`, null,
      { userId: staffId, pin: '5927', deviceFingerprint: FINGERPRINT, branchId: r.branchId });
    ok(pin);
    till = { deviceId, token: pin.body['accessToken'] as string };
    expect(verifyToken(till.token, KEY)).toMatchObject({ tenant_id: r.tenantId, branch_id: r.branchId, device_id: deviceId, sub: staffId });
  });

  it('the manager\'s PIN is refused on the till, by role', async () => {
    const ownerId = (await db.query<{ id: string }>(
      `SELECT id FROM app.app_user WHERE tenant_id = $1 AND email = $2`, [r.tenantId, `owner@${r.slug}.test`])).rows[0]!.id;
    await db.query(
      `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, 'pin', $4)`,
      [randomUUID(), r.tenantId, ownerId, await hashSecret('4816')]);
    const refused = await http('POST', `/api/auth/${r.slug}/pin`, null,
      { userId: ownerId, pin: '4816', deviceFingerprint: FINGERPRINT, branchId: r.branchId });
    expect([refused.status, refused.body['error']]).toEqual([401, 'authentication_failed']);
    expect(refused.body['accessToken']).toBeUndefined();

    // A manager's till session from before this rule is not renewed: the refresh is refused by role.
    const old = issueSession({ userId: ownerId, tenantId: r.tenantId, branchId: r.branchId, deviceId: till.deviceId }, KEY);
    const renewed = await http('POST', '/api/auth/refresh', null, { refreshToken: old.refreshToken });
    expect(renewed.status).toBe(401);
    expect(renewed.body['accessToken']).toBeUndefined();
  });

  it('the staff sign-in may open KOT and Billing by permission, and not the manager screens', async () => {
    const me = await http('GET', '/api/t/me', till.token);
    ok(me);
    expect(me.body['screens']).toEqual({ kot: true, billing: true, kitchen: false, admin: false, takings: true, bills: true, billEdit: true, dayEnd: true, billEditAny: false, dayReopen: false });
    expect(me.body['deviceName']).toBe('Counter computer');
  });

  it('signs the same till back in, without adding a device', async () => {
    const before = (await db.query(`SELECT 1 FROM app.device WHERE tenant_id = $1`, [r.tenantId])).rowCount;
    const res = await tillSignIn(r.slug, `owner@${r.slug}.test`, OWNER_PASSWORD, FINGERPRINT);
    ok(res);
    expect(res.body['deviceId']).toBe(till.deviceId);
    expect((await db.query(`SELECT 1 FROM app.device WHERE tenant_id = $1`, [r.tenantId])).rowCount).toBe(before);
  });

  it('a wrong password is refused before anything about the browser is decided', async () => {
    const before = (await db.query(`SELECT 1 FROM app.device WHERE tenant_id = $1`, [r.tenantId])).rowCount;
    const res = await tillSignIn(r.slug, `owner@${r.slug}.test`, 'wrong-password', `w${FINGERPRINT}`);
    expect([res.status, res.body['error']]).toEqual([401, 'authentication_failed']);
    expect((await db.query(`SELECT 1 FROM app.device WHERE tenant_id = $1`, [r.tenantId])).rowCount).toBe(before);
    const office = await login(r.slug, 'NOBODY', 'whatever-2026');
    expect([office.status, office.body['error']]).toEqual([401, 'authentication_failed']);
  });
});

describe('2. dine-in, on that one sign-in: order, kitchen, bill, payment', () => {
  it('numbers it at the counter (no tables), prints the kitchen ticket, hands over, bills and takes card + cash', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, { pickupName: 'Window seat' }, keyed());
    ok(opened);
    expect(opened.body['parcelNo']).toEqual(expect.any(Number));
    const listed = await http('GET', '/api/t/pos/dine-ins', till.token);
    ok(listed);
    expect((listed.body as unknown as { sessionId: string }[]).map((x) => x.sessionId)).toContain(opened.body['sessionId']);
    // Not a parcel: the parcel counter does not list it.
    const parcels = await http('GET', '/api/t/pos/parcels', till.token);
    expect((parcels.body as unknown as { sessionId: string }[]).map((x) => x.sessionId)).not.toContain(opened.body['sessionId']);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    ok(kot);
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: dal, quantity: 2 }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token,
      { sessionVersion: await sessionVersion(sid, till.token) }, keyed(kotLease)));
    const printed = await db.query(`SELECT 1 FROM app.print_job pj JOIN app.kot k ON k.id = pj.kot_id
                                     JOIN app.kot_fire f ON f.id = k.fire_id WHERE f.order_id = $1`, [oid]);
    expect(printed.rowCount).toBe(1);
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(kotLease)));

    // The same person, the same sign-in, now as Billing.
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    ok(billing);
    const billLease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(billLease));
    ok(bill);
    const total = bill.body['totalMinor'] as number;
    const paid = await http('POST', `/api/t/pos/bill/${bill.body['billId'] as string}/payment`, till.token,
      { parts: [{ method: 'card', amountMinor: total - 10000 }, { method: 'cash', cashReceivedMinor: 50000 }] }, keyed(billLease));
    ok(paid);
    expect(paid.body).toMatchObject({ settled: true, outstandingMinor: 0, changeMinor: 40000 });
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, till.token, undefined, keyed(billLease)));

    // The audit trail says which capacity took the money: the cashier membership, not owner.
    const capacity = await db.query<{ key: string }>(
      `SELECT r.key FROM app.tenant_audit_log a
         JOIN app.membership m ON m.id = a.authorising_membership_id
         JOIN app.role r ON r.id = m.role_id
        WHERE a.tenant_id = $1 AND a.action = 'payment.collected' ORDER BY a.occurred_at DESC LIMIT 1`, [r.tenantId]);
    expect(capacity.rows[0]!.key).toBe('cashier');
    const row = await db.query<{ service_type: string; seating: string; status: string }>(
      `SELECT service_type, seating, status FROM app.table_session WHERE id = $1`, [sid]);
    expect(row.rows[0]).toEqual({ service_type: 'dine_in', seating: 'counter', status: 'closed' });
  });

  it('a counter order has no table to join or move to', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    const sid = opened.body['sessionId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    // Refused by the plan first: Basic has no tables at all.
    const join = await http('POST', `/api/t/pos/session/${sid}/tables`, till.token, { diningTableId: randomUUID() },
      keyed({ 'x-lease-token': kot.body['token'] as string }));
    expect([join.status, join.body['error']]).toEqual([402, 'upgrade_required']);
  });
});

describe('2b. Basic has no floors, floor types or tables', () => {
  it('refuses the floor plan, naming the plan that has it', async () => {
    for (const path of ['/api/t/admin/floors', '/api/t/admin/floor-types', '/api/t/admin/tables']) {
      const listed = await http('GET', path, r.token);
      expect([listed.status, listed.body['error']], path).toEqual([402, 'upgrade_required']);
      expect(String(listed.body['detail'])).toContain('available on Standard');
    }
    const seated = await http('POST', '/api/t/pos/session', till.token, { diningTableIds: [randomUUID()] }, keyed());
    expect([seated.status, seated.body['error']]).toEqual([402, 'upgrade_required']);
  });

  it('the Excel import refuses a Floors or Tables sheet rather than writing past the plan', async () => {
    const res = await http('POST', at('/api/t/admin/setup/import/preview', r.branchId), r.token, {
      sheets: { floors: [{ row: 2, name: 'Ground floor' }], tables: [{ row: 2, name: 'T1', floor: 'Ground floor', seats: '4' }] },
    });
    ok(res);
    expect(res.body['applied']).toBe(false);
    const messages = (res.body['errors'] as { sheet: string; message: string }[]).map((e) => `${e.sheet}: ${e.message}`);
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining('Floors: This plan has no floors or tables'),
      expect.stringContaining('Tables: This plan has no floors or tables')]));
    expect((await db.query(`SELECT 1 FROM app.floor WHERE tenant_id = $1`, [r.tenantId])).rowCount).toBe(0);
  });
});

describe('3b. the one POS screen: Confirm order, then payment and the receipt', () => {
  it('a customer name over 40 characters is refused with a sentence, and opens nothing', async () => {
    const long = await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'A'.repeat(41) }, keyed());
    expect([long.status, long.body['error']]).toEqual([409, 'invariant_refused']);
    expect(long.body['detail']).toBe('the customer name is at most 40 characters; shorten it and confirm again.');
    ok(await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'A'.repeat(40) }, keyed()));
  });

  it('opens, fills and sends in one go; the kitchen ticket says what to make; paid in parts; the receipt says how', async () => {
    // Exactly the calls the POS's Confirm order makes, with its fixed per-step keys.
    const openKey = `idem-${randomUUID()}`;
    const opened = await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'Meena' }, { 'idempotency-key': openKey });
    ok(opened);
    // A retry with the same key is the same order, not a second one.
    const again = await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'Meena' }, { 'idempotency-key': openKey });
    expect(again.body['sessionId']).toBe(opened.body['sessionId']);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const parcelNo = opened.body['parcelNo'] as number;

    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token,
      { menuItemId: dal, quantity: 2, note: 'less spicy' }, keyed(kotLease)));
    const fireKey = `idem-${randomUUID()}`;
    const fire = { sessionVersion: await sessionVersion(sid, till.token) };
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token, fire, { ...kotLease, 'idempotency-key': fireKey }));
    // A retried send replays; the kitchen gets ONE ticket.
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token, fire, { ...kotLease, 'idempotency-key': fireKey }));

    const tickets = await http('GET', `/api/t/pos/order/${oid}/tickets`, till.token);
    const list = tickets.body as unknown as { ticketText: string; print: { status: string } | null }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.print, 'a print job for the kitchen printer').not.toBeNull();
    for (const text of [`PARCEL P-${parcelNo} Meena`, ' 2 x Dal Tadka', '* less spicy']) {
      expect(list[0]!.ticketText, text).toContain(text);
    }
    // The till prints its KITCHEN COPY from this read; reading it again (a reprint)
    // makes no new print job and no new ticket.
    const jobs = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.print_job WHERE tenant_id = $1 AND kot_id IN
         (SELECT kl.kot_id FROM app.kot_line kl JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id WHERE kl.tenant_id = $1 AND ol.order_id = $2)`, [r.tenantId, oid])).rows[0]!.n);
    const kots = async () => Number((await db.query<{ n: string }>(
      `SELECT count(DISTINCT kot_id)::text AS n FROM app.kot_line kl JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id WHERE kl.tenant_id = $1 AND ol.order_id = $2`, [r.tenantId, oid])).rows[0]!.n);
    const [jobsBefore, kotsBefore] = [await jobs(), await kots()];
    ok(await http('GET', `/api/t/pos/order/${oid}/tickets`, till.token));
    ok(await http('GET', `/api/t/pos/order/${oid}/tickets`, till.token));
    expect([await jobs(), await kots()]).toEqual([jobsBefore, kotsBefore]);
    expect(kotsBefore).toBe(1);

    // No Mark ready and no pickup: the hand-over and closing need neither.
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(kotLease)));
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    const billLease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(billLease));
    ok(bill);
    const billId = bill.body['billId'] as string;
    const total = bill.body['totalMinor'] as number;

    // The printed set (customer + counter) is ONE counted print: copy 1. A reprint is copy 2.
    const set = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed(billLease));
    expect(set.body).toMatchObject({ copyNo: 1, serviceType: 'parcel', pickupName: 'Meena' });
    const reprint = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed(billLease));
    expect(reprint.body['copyNo']).toBe(2);

    // The paper is the branch's (0078). No bill printer chosen: the 3-inch roll,
    // every copy, printed by itself once paid -- what every bill printed before --
    // headed with the default headings of a branch that never set its own (0088).
    expect(set.body['layout']).toEqual({
      printerName: null, connection: null, printerType: 'thermal', paperSize: 'thermal_80', orientation: 'portrait',
      marginMm: 3, fontSizePx: 12, show: { logo: true, details: true, customer: true, tax: true, payments: true, copyLabel: true },
      copies: { customer: true, kitchen: true, counter: true }, autoPrint: true,
      headings: { unpaid: 'BILL', partPaid: 'PART PAID', paid: 'INVOICE' },
    });
    expect(set.body['taxMinor']).toBe(total - (set.body['subtotalMinor'] as number));

    // A printer states its type before its paper, and the table holds the pair
    // together -- each refusal a sentence a manager can act on.
    const SAYS = {
      printer_network_is_thermal: 'must be a thermal printer',
      printer_paper_fits_type: 'does not fit that printer',
      printer_roll_is_portrait: 'portrait only',
    } as const;
    const printers = `/api/t/admin/printers?branchId=${r.branchId}`;
    for (const [body, constraint] of [
      [{ connection_kind: 'network', address: '192.168.0.9', printer_type: 'laser', paper_size: 'a4' }, 'printer_network_is_thermal'],
      [{ connection_kind: 'usb', printer_type: 'thermal', paper_size: 'a4' }, 'printer_paper_fits_type'],
      [{ connection_kind: 'usb', printer_type: 'laser', paper_size: 'thermal_80' }, 'printer_paper_fits_type'],
      [{ connection_kind: 'usb', printer_type: 'thermal', paper_size: 'thermal_58', orientation: 'landscape' }, 'printer_roll_is_portrait'],
    ] as const) {
      const refused = await http('POST', printers, r.token, { name: `Refused ${constraint} ${body.paper_size}`, ...body });
      expect([refused.status, refused.body['error']], constraint).toEqual([409, 'invariant_refused']);
      expect(refused.body['detail'], constraint).toContain(SAYS[constraint]);
    }
    const laser = await http('POST', printers, r.token, {
      name: 'Counter laser', connection_kind: 'usb', printer_type: 'laser', paper_size: 'a4', orientation: 'landscape',
      margin_mm: 10, font_size_px: 14,
    });
    ok(laser);
    const noCopy = await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token,
      { bill_copy_customer: false, bill_copy_kitchen: false, bill_copy_counter: false });
    expect(noCopy.status).toBe(409);
    expect(noCopy.body['detail']).toContain('at least one copy');
    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token,
      { bill_printer_id: laser.body['id'], bill_auto_print: false, bill_copy_kitchen: false, bill_show_tax: false,
        bill_show_copy_label: false }));
    const onLaser = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed(billLease));
    expect(onLaser.body['layout']).toMatchObject({
      printerName: 'Counter laser', connection: 'usb', printerType: 'laser', paperSize: 'a4', orientation: 'landscape',
      marginMm: 10, fontSizePx: 14, show: { tax: false, copyLabel: false }, copies: { customer: true, kitchen: false, counter: true }, autoPrint: false,
    });
    // Printing on another layout is still a counted copy of the same bill; nothing else moves.
    expect(onLaser.body['copyNo']).toBe(3);
    // Back to the roll for the rest of the flow.
    ok(await http('PATCH', `/api/t/admin/branches/${r.branchId}`, r.token,
      { bill_printer_id: null, bill_auto_print: true, bill_copy_kitchen: true, bill_show_tax: true,
        bill_show_copy_label: true }));

    ok(await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'card', amountMinor: 10000 }] }, keyed(billLease)));
    const part = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed(billLease));
    ok(part);
    expect(part.body).toMatchObject({ serviceType: 'parcel', parcelNo, pickupName: 'Meena', totalMinor: total,
      paidMinor: 10000, outstandingMinor: total - 10000 });

    const cash = await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'upi', amountMinor: 5000 }, { method: 'cash', cashReceivedMinor: total }] }, keyed(billLease));
    expect(cash.body).toMatchObject({ settled: true, outstandingMinor: 0, changeMinor: total - (total - 15000) });
    const receipt = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed(billLease));
    expect(receipt.body).toMatchObject({ kind: 'receipt', paidMinor: total, outstandingMinor: 0 });
    expect((receipt.body['tenders'] as { method: string }[]).map((t) => t.method).sort()).toEqual(['card', 'cash', 'upi']);

    ok(await http('DELETE', `/api/t/pos/session/${sid}`, till.token, undefined, keyed(billLease)));
  });
});

describe('3. a parcel, on the same sign-in', () => {
  it('numbers it, sends it, marks it ready without a kitchen screen, hands it over and is paid in two goes', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'Ravi' }, keyed());
    ok(opened);
    expect(opened.body['parcelNo']).toEqual(expect.any(Number));
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: dal, quantity: 1 }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token,
      { sessionVersion: await sessionVersion(sid, till.token) }, keyed(kotLease)));
    const tickets = await http('GET', `/api/t/pos/order/${oid}/tickets`, till.token);
    ok(tickets);
    const kotId = (tickets.body as unknown as { kotId: string }[])[0]!.kotId;
    ok(await http('POST', `/api/t/pos/kot/${kotId}/ready`, till.token, {}, keyed()));
    ok(await http('POST', `/api/t/pos/session/${sid}/pickup`, till.token, {}, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(kotLease)));

    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    const billLease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(billLease));
    ok(bill);
    const billId = bill.body['billId'] as string;
    const total = bill.body['totalMinor'] as number;
    const first = await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'upi', amountMinor: 10000 }] }, keyed(billLease));
    expect(first.body).toMatchObject({ settled: false, outstandingMinor: total - 10000 });
    const rest = await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'cash', cashReceivedMinor: total - 10000 }] }, keyed(billLease));
    expect(rest.body).toMatchObject({ settled: true, changeMinor: 0 });
  });
});

describe('3c. a parcel charge (0081): typed at the till, capped by the branch, taxed with the food', () => {
  const branchUrl = () => `/api/t/admin/branches/${r.branchId}`;
  const quote = (payload: unknown) => http('POST', '/api/t/pos/quote', till.token, payload);
  const gst5 = async () => (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [r.tenantId])).rows[0]!.id;

  it('a branch charges nothing until a manager sets a cap, and a cap needs a tax rate', async () => {
    const refused = await quote({ parcel: true, lines: [], parcelChargeMinor: 2000 });
    expect([refused.status, refused.body['error']]).toEqual([422, 'parcel_charge_above_max']);

    const untaxed = await http('PATCH', branchUrl(), r.token, { parcel_charge_max_minor: 5000 });
    expect([untaxed.status, untaxed.body['error']]).toEqual([409, 'invariant_refused']);
    // Pinned to WHICH refusal: the sentence keyed off branch_parcel_charge_taxed.
    expect(untaxed.body['detail']).toContain('tax rate for parcel charges');

    const overDefault = await http('PATCH', branchUrl(), r.token, {
      parcel_charge_default_minor: 6000, parcel_charge_max_minor: 5000, parcel_charge_tax_class_id: await gst5() });
    expect([overDefault.status, overDefault.body['detail']]).toEqual(
      [409, 'the parcel charge the till fills in cannot be more than the most it may charge.']);

    ok(await http('PATCH', branchUrl(), r.token, {
      parcel_charge_default_minor: 2000, parcel_charge_max_minor: 5000, parcel_charge_tax_class_id: await gst5() }));
  });

  it('the estimate is the server\'s: items + charge, tax per head, payable -- and refuses what the order would', async () => {
    const parcel = await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 2 }] });
    ok(parcel);
    expect(parcel.body).toMatchObject({
      itemsMinor: 40000, parcelChargeMinor: 2000, subtotalMinor: 42000,
      parcelCharge: { defaultMinor: 2000, maxMinor: 5000 },
    });
    const taxes = parcel.body['taxes'] as { name: string; rateBps: number; amountMinor: number }[];
    // 5% of 420.00, struck per piece: 20.00 on the dal, 1.00 on the charge.
    expect(parcel.body['taxMinor']).toBe(2100);
    expect(taxes.reduce((s, t) => s + t.amountMinor, 0)).toBe(2100);
    // This branch has stated no state, so its treatment names no head -- one
    // unnamed tax line, as its printed bill shows (the heads are compared to the
    // paper below).
    expect(taxes).toEqual([{ name: 'Tax', rateBps: 500, amountMinor: 2100 }]);
    expect(parcel.body['totalMinor']).toBe(44100);

    const typed = await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 2 }], parcelChargeMinor: 2500 });
    expect(typed.body).toMatchObject({ parcelChargeMinor: 2500, subtotalMinor: 42500 });
    const none = await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 2 }], parcelChargeMinor: 0 });
    expect(none.body).toMatchObject({ parcelChargeMinor: 0, subtotalMinor: 40000, taxMinor: 2000 });

    const over = await quote({ parcel: true, lines: [], parcelChargeMinor: 5001 });
    expect([over.status, over.body['error']]).toEqual([422, 'parcel_charge_above_max']);
    const negative = await quote({ parcel: true, lines: [], parcelChargeMinor: -1 });
    expect([negative.status, negative.body['error']]).toEqual([400, 'parcel_charge_invalid']);

    const dineIn = await quote({ parcel: false, lines: [{ menuItemId: dal, quantity: 1 }] });
    expect(dineIn.body).toMatchObject({ parcelChargeMinor: 0, subtotalMinor: 20000, parcelCharge: null });
    const charged = await quote({ parcel: false, lines: [], parcelChargeMinor: 1000 });
    expect([charged.status, charged.body['error']]).toEqual([409, 'parcel_charge_not_parcel']);

    // A read: no key, nothing claimed, nothing written.
    const lines = (await db.query(`SELECT 1 FROM app.order_line WHERE tenant_id = $1`, [r.tenantId])).rowCount;
    ok(await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 1 }] }));
    expect((await db.query(`SELECT 1 FROM app.order_line WHERE tenant_id = $1`, [r.tenantId])).rowCount).toBe(lines);
  });

  it('is saved on the order, replaced not added, never sent to the kitchen, on the bill, the paper and every reprint', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', till.token, { pickupName: 'Asha' }, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: dal, quantity: 2 }, keyed(kotLease)));

    ok(await http('POST', `/api/t/pos/order/${oid}/parcel-charge`, till.token, { amountMinor: 3000 }, keyed(kotLease)));
    const set = await http('POST', `/api/t/pos/order/${oid}/parcel-charge`, till.token, { amountMinor: 2500 }, keyed(kotLease));
    ok(set);
    expect(set.body).toMatchObject({ orderId: oid, amountMinor: 2500 });
    const over = await http('POST', `/api/t/pos/order/${oid}/parcel-charge`, till.token, { amountMinor: 9000 }, keyed(kotLease));
    expect([over.status, over.body['error']]).toEqual([422, 'parcel_charge_above_max']);
    const rows = await db.query<{ line_total_minor: string; tax_rate_bps: number; tax_class_key: string }>(
      `SELECT line_total_minor::text, tax_rate_bps, tax_class_key FROM app.order_line
        WHERE tenant_id = $1 AND order_id = $2 AND kind = 'charge'`, [r.tenantId, oid]);
    expect(rows.rows).toEqual([{ line_total_minor: '2500', tax_rate_bps: 500, tax_class_key: 'gst_5' }]);

    // Restored with the order: the board reads it back.
    const board = await http('GET', `/api/t/pos/session/${sid}/board`, till.token);
    expect(JSON.stringify(board.body)).toContain('Parcel charge');

    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token,
      { sessionVersion: await sessionVersion(sid, till.token) }, keyed(kotLease)));
    const tickets = await http('GET', `/api/t/pos/order/${oid}/tickets`, till.token);
    const text = (tickets.body as unknown as { ticketText: string }[]).map((t) => t.ticketText).join('\n');
    expect(text).toContain('Dal Tadka');
    expect(text).not.toContain('Parcel charge');
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(kotLease)));

    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    const billLease = { 'x-lease-token': billing.body['token'] as string };
    const charge = (amountMinor: number) =>
      http('POST', `/api/t/pos/order/${oid}/parcel-charge`, till.token, { amountMinor }, keyed(billLease));
    const makeBill = () => http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(billLease));
    const liveBills = async () => ((await http('GET', `/api/t/pos/session/${sid}/board`, till.token)).body['bills'] as { id: string }[]);

    // With Billing, before any money: a change voids the unpaid bill, and the next bill carries the new charge.
    const first = await makeBill();
    expect(first.body['totalMinor']).toBe(42500 + 2125);
    const raised = await charge(3000);
    expect(raised.body).toMatchObject({ amountMinor: 3000, billsVoided: 1 });
    expect(await liveBills()).toEqual([]);
    const voided = await db.query<{ status: string }>(`SELECT status FROM app.bill WHERE id = $1`, [first.body['billId']]);
    expect(voided.rows[0]!.status).toBe('void');
    expect((await makeBill()).body['totalMinor']).toBe(43000 + 2150);

    // Cleared: the line stays (the voided bill points at it) at 0, and no bill carries it.
    const cleared = await charge(0);
    expect(cleared.body).toMatchObject({ amountMinor: 0, lineId: expect.any(String), billsVoided: 1 });
    const noCharge = await makeBill();
    expect(noCharge.body).toMatchObject({ subtotalMinor: 40000, totalMinor: 42000 });
    const lines = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.bill_line bl JOIN app.order_line ol ON ol.id = bl.order_line_id
        WHERE bl.bill_id = $1 AND ol.kind = 'charge'`, [noCharge.body['billId']]);
    expect(lines.rows[0]!.n).toBe('0');
    expect((await liveBills())[0]).toMatchObject({ items_minor: '40000', parcel_charge_minor: '0' });

    // Added back, and billed.
    ok(await charge(2500));
    const bill = await makeBill();
    ok(bill);
    const estimate = await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 2 }], parcelChargeMinor: 2500 });
    expect(bill.body).toMatchObject({
      subtotalMinor: estimate.body['subtotalMinor'], taxMinor: estimate.body['taxMinor'],
      totalMinor: estimate.body['totalMinor'],
    });
    expect(bill.body['totalMinor']).toBe(42500 + 2125);
    // ₹446.25 is paid to the nearest rupee: 25 paise round off, ₹446 payable -- as the estimate said.
    expect(bill.body).toMatchObject({ roundOffMinor: -25, payableMinor: 44600 });
    expect(estimate.body).toMatchObject({ roundOffMinor: -25, payableMinor: 44600 });
    const billId = bill.body['billId'] as string;
    expect((await liveBills()).map((b) => b.id)).toEqual([billId]);
    // The payment area shows the charge on its own line: the board splits the
    // bill's subtotal as its bill lines hold it, items and the parcel charge.
    expect((await liveBills())[0]).toMatchObject({ subtotal_minor: '42500', items_minor: '40000', parcel_charge_minor: '2500' });

    // Once money is in, the charge is part of what was paid against.
    const part = await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'upi', amountMinor: 10000 }] }, keyed(billLease));
    expect(part.body).toMatchObject({ settled: false });
    const afterPayment = await charge(1000);
    expect([afterPayment.status, afterPayment.body['error']]).toEqual([409, 'parcel_charge_after_payment']);
    expect((await liveBills()).map((b) => b.id)).toEqual([billId]);

    const paid = await http('POST', `/api/t/pos/bill/${billId}/payment`, till.token,
      { parts: [{ method: 'card', amountMinor: (bill.body['payableMinor'] as number) - 10000, reference: 'TXN-77' }] }, keyed(billLease));
    expect(paid.body).toMatchObject({ settled: true, outstandingMinor: 0 });

    const printed = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed());
    ok(printed);
    expect(printed.body).toMatchObject({
      kind: 'receipt', parcelChargeMinor: 2500, subtotalMinor: 42500, totalMinor: 44625,
      roundOffMinor: -25, payableMinor: 44600, paidMinor: 44600, outstandingMinor: 0,
    });
    expect((printed.body['lines'] as { name: string }[]).map((l) => l.name)).toEqual(['Dal Tadka']);
    // The estimate's heads are the paper's: same functions, same split.
    const heads = printed.body['taxes'] as { label: string; amountMinor: number }[];
    const estimated = estimate.body['taxes'] as { name: string; amountMinor: number }[];
    expect(heads.map((h) => h.amountMinor)).toEqual(estimated.map((t) => t.amountMinor));
    expect(heads.map((h) => h.label.split(' ')[0])).toEqual(estimated.map((t) => t.name));
    expect(heads.reduce((s, t) => s + t.amountMinor, 0)).toBe(2125);
    const reprint = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed());
    expect(reprint.body).toMatchObject({ copyNo: 2, parcelChargeMinor: 2500, totalMinor: 44625 });
  });

  it('at a registered branch the charge\'s tax splits CGST + SGST, as every line does', async () => {
    const before = (await db.query<{ gstin: string | null; state_code: string | null; gst_registration: string }>(
      `SELECT gstin, state_code, gst_registration FROM app.branch WHERE id = $1`, [r.branchId])).rows[0]!;
    await db.query(`UPDATE app.branch SET gstin = '29AABCU9603R1ZM', state_code = '29', gst_registration = 'registered'
                     WHERE id = $1`, [r.branchId]);
    try {
      const q = await quote({ parcel: true, lines: [{ menuItemId: dal, quantity: 1 }], parcelChargeMinor: 2000 });
      ok(q);
      // 5% on 200.00 + 20.00 = 11.00, halved per head.
      expect(q.body['taxes']).toEqual([
        { name: 'CGST', rateBps: 250, amountMinor: 550 },
        { name: 'SGST', rateBps: 250, amountMinor: 550 },
      ]);
      expect(q.body).toMatchObject({ subtotalMinor: 22000, taxMinor: 1100, totalMinor: 23100 });
    } finally {
      await db.query(`UPDATE app.branch SET gstin = $2, state_code = $3, gst_registration = $4 WHERE id = $1`,
        [r.branchId, before.gstin, before.state_code, before.gst_registration]);
    }
  });

  it('a ₹221.03 bill is payable ₹221: the bill rounds, so no payment carries a round-off of its own', async () => {
    const opened = await http('POST', '/api/t/pos/parcel', till.token, {}, keyed());
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, till.token, { menuItemId: dal, quantity: 1 }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/parcel-charge`, till.token, { amountMinor: 1050 }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, till.token, { sessionVersion: await sessionVersion(sid, till.token) }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, till.token, {}, keyed(kotLease)));
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, till.token, { deviceId: till.deviceId }, keyed());
    const lease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, till.token, { splitKind: 'whole' }, keyed(lease));
    // 200.00 + 10.50 charge, 5% on each: 10.00 + 0.53 -> 221.03, paid as 221.
    expect(bill.body).toMatchObject({ totalMinor: 22103, roundOffMinor: -3, payableMinor: 22100 });
    const billId = bill.body['billId'] as string;
    const pay = (parts: unknown[]) => http('POST', `/api/t/pos/bill/${billId}/payment`, till.token, { parts }, keyed(lease));

    // The payable is already a whole rupee: a payment's own round-off cannot widen it.
    for (const parts of [
      [{ method: 'card', amountMinor: 22200, roundingMinor: 100 }],
      [{ method: 'card', amountMinor: 10000, roundingMinor: 50 }],
      [{ method: 'card', amountMinor: 22150, roundingMinor: 50 }],
    ]) {
      const refused = await pay(parts);
      expect([refused.status, refused.body['error']], JSON.stringify(parts)).toEqual([422, 'payment_invalid']);
    }
    // ₹221.03 -- the old total -- is now more than is owed.
    const overTotal = await pay([{ method: 'card', amountMinor: 22103 }]);
    expect([overTotal.status, overTotal.body['error']]).toEqual([409, 'payment_exceeds_balance']);
    expect((await db.query(`SELECT 1 FROM app.tender WHERE bill_id = $1`, [billId])).rowCount).toBe(0);

    // ₹221 by card settles it, with nothing left over and no tender rounding.
    const paid = await pay([{ method: 'card', amountMinor: 22100, reference: 'RO-1' }]);
    expect(paid.body).toMatchObject({ settled: true, outstandingMinor: 0, paidMinor: 22100 });
    const row = await db.query<{ amount_minor: string; rounding_minor: string }>(
      `SELECT amount_minor::text, rounding_minor::text FROM app.tender WHERE bill_id = $1`, [billId]);
    expect(row.rows).toEqual([{ amount_minor: '22100', rounding_minor: '0' }]);
    const printed = await http('POST', `/api/t/pos/bill/${billId}/print`, till.token, {}, keyed());
    expect(printed.body).toMatchObject({
      totalMinor: 22103, roundOffMinor: -3, payableMinor: 22100, paidMinor: 22100, outstandingMinor: 0,
    });
  });

  it('a dine-in order takes no parcel charge', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', till.token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const lease = await http('POST', `/api/t/pos/session/${sid}/lease`, till.token, { deviceId: till.deviceId }, keyed());
    const refused = await http('POST', `/api/t/pos/order/${opened.body['orderId'] as string}/parcel-charge`, till.token,
      { amountMinor: 1000 }, keyed({ 'x-lease-token': lease.body['token'] as string }));
    expect([refused.status, refused.body['error']]).toEqual([409, 'parcel_charge_not_parcel']);
  });

  it('the schema holds one charge per order, and a charge is not food', async () => {
    const order = (await db.query<{ order_id: string; branch_id: string; created_by_user_id: string }>(
      `SELECT order_id, branch_id, created_by_user_id FROM app.order_line
        WHERE tenant_id = $1 AND kind = 'charge' LIMIT 1`, [r.tenantId])).rows[0]!;
    const insert = (extra: string, values: string) => db.query(
      `INSERT INTO app.order_line (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor,
         quantity, line_total_minor, created_by_user_id${extra})
       VALUES (gen_random_uuid(), $1, $2, $3, 'charge', 'Parcel charge', 100, 1, 100, $4${values})`,
      [r.tenantId, order.branch_id, order.order_id, order.created_by_user_id]);
    await expect(insert('', '')).rejects.toMatchObject({ constraint: 'order_line_one_charge_per_order' });
    await expect(insert(', menu_item_id', `, '${dal}'`)).rejects.toMatchObject({ constraint: 'order_line_shape_exact' });
  });
});

/** The Sales person who sold these restaurants adds their staff (salesStaffSignIn.test.ts tests the route). */
function salesToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
}
/** The username is the name in capitals, so each test's names are its usernames. */
const usernameOf = (fullName: string): string => fullName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const addStaff = (place: Restaurant, fullName: string, access = 'pos', pin = '5927') =>
  http('POST', `/api/platform/tenants/${place.tenantId}/staff`, salesToken(),
    { fullName, username: usernameOf(fullName), access, pin }, keyed());
const staffPin = (place: Restaurant, userId: string, pin: string, fingerprint: string) =>
  http('POST', `/api/auth/${place.slug}/pin`, null, { userId, pin, deviceFingerprint: fingerprint });

describe('3d. My takings: the till\'s own X-read, never anyone else\'s', () => {
  interface Takings {
    fromDate: string; toDate: string;
    bills: { billId: string; collectedMinor: number; totalMinor: number }[];
    items: { name: string; quantity: number; amountMinor: number }[];
    methods: { method: string; payments: number; amountMinor: number }[];
    totals: { bills: number; payments: number; salesMinor: number; taxMinor: number; collectedMinor: number };
  }
  const takings = async (token: string, period = 'day') => {
    const res = await http('GET', `/api/t/pos/my-takings?period=${period}`, token);
    ok(res);
    return res.body as unknown as Takings;
  };
  /** A dine-in order of `quantity` Dal Tadka taken and billed on the till; payment is the caller's. */
  const billedOrder = async (token: string, quantity: number) => {
    const opened = await http('POST', '/api/t/pos/dine-in', token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, token, { deviceId: till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, token, { menuItemId: dal, quantity }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, token, { sessionVersion: await sessionVersion(sid, token) }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, token, {}, keyed(kotLease)));
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, token, { deviceId: till.deviceId }, keyed());
    const lease = { 'x-lease-token': billing.body['token'] as string };
    const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, token, { splitKind: 'whole' }, keyed(lease));
    ok(bill);
    return { billId: bill.body['billId'] as string, total: bill.body['totalMinor'] as number, lease };
  };
  const pay = (token: string, billId: string, lease: Record<string, string>, parts: unknown[]) =>
    http('POST', `/api/t/pos/bill/${billId}/payment`, token, { parts }, keyed(lease));
  /** The same figures summed straight off the tender rows, independently of the module. */
  const tenderSums = async (userId: string, fromDate: string, toDate: string) => (await db.query<{ method: string; amount: string }>(
    `SELECT t.method, sum(t.amount_minor - t.rounding_minor)::text AS amount
       FROM app.tender t JOIN app.bill b ON b.id = t.bill_id
      WHERE t.tenant_id = $1 AND t.tendered_by_user_id = $2 AND b.branch_id = $3 AND b.status <> 'void'
        AND b.business_date BETWEEN $4::date AND $5::date
      GROUP BY t.method ORDER BY t.method`, [r.tenantId, userId, r.branchId, fromDate, toDate])).rows
    .map((x) => ({ method: x.method, amountMinor: Number(x.amount) }));

  let second: { token: string; userId: string };
  let tillStaffId: string;

  beforeAll(async () => {
    tillStaffId = verifyToken(till.token, KEY)['sub'] as string;
    ok(await addStaff(r, 'Second Cashier', 'pos', '4826'));
    const userId = (await db.query<{ id: string }>(
      `SELECT id FROM app.app_user WHERE tenant_id = $1 AND full_name = 'Second Cashier'`, [r.tenantId])).rows[0]!.id;
    const pin = await staffPin(r, userId, '4826', FINGERPRINT);
    ok(pin);
    second = { token: pin.body['accessToken'] as string, userId };
  });

  it('shows only the bills and payments the signed-in person took, from the recorded tenders', async () => {
    const before = await takings(till.token);

    // One bill the second cashier takes alone; one the two share.
    const theirs = await billedOrder(second.token, 1);
    ok(await pay(second.token, theirs.billId, theirs.lease, [{ method: 'card', amountMinor: theirs.total, reference: 'T-1' }]));
    const shared = await billedOrder(till.token, 2);
    ok(await pay(till.token, shared.billId, shared.lease, [{ method: 'upi', amountMinor: 15000 }]));
    ok(await pay(second.token, shared.billId, shared.lease, [{ method: 'cash', cashReceivedMinor: shared.total - 15000 }]));

    const mine = await takings(till.token);
    const ids = mine.bills.map((b) => b.billId);
    expect(ids).toContain(shared.billId);
    expect(ids).not.toContain(theirs.billId);
    expect(mine.bills.find((b) => b.billId === shared.billId)).toMatchObject({ totalMinor: shared.total, collectedMinor: 15000 });
    expect(mine.totals.bills).toBe(before.totals.bills + 1);
    expect(mine.totals.collectedMinor).toBe(before.totals.collectedMinor + 15000);
    // Transaction totals are the tender rows, summed independently.
    expect(mine.methods.map((m) => ({ method: m.method, amountMinor: m.amountMinor })))
      .toEqual(await tenderSums(tillStaffId, mine.fromDate, mine.toDate));
    expect(mine.totals.collectedMinor).toBe(mine.methods.reduce((n, m) => n + m.amountMinor, 0));
    expect(mine.totals.salesMinor).toBe(mine.bills.reduce((n, b) => n + b.totalMinor, 0));
    expect(mine.totals.payments).toBe(mine.methods.reduce((n, m) => n + m.payments, 0));

    const theirsSummary = await takings(second.token);
    expect(theirsSummary.bills.map((b) => b.billId).sort()).toEqual([shared.billId, theirs.billId].sort());
    expect(theirsSummary.totals.collectedMinor).toBe(theirs.total + shared.total - 15000);
    expect(theirsSummary.methods.map((m) => m.method)).toEqual(['card', 'cash']);
    // Items are the bills' own lines: 1 + 2 Dal Tadka across the two, at the bill's amounts.
    expect(theirsSummary.items).toEqual([{ name: 'Dal Tadka', quantity: 3, amountMinor: 60000 }]);
    // Every bill is this restaurant's, at this branch.
    const owners = await db.query<{ tenant_id: string; branch_id: string }>(
      `SELECT DISTINCT tenant_id, branch_id FROM app.bill WHERE id = ANY($1::uuid[])`, [theirsSummary.bills.map((b) => b.billId)]);
    expect(owners.rows).toEqual([{ tenant_id: r.tenantId, branch_id: r.branchId }]);
  });

  it('day, week and month cover business dates ending today; anything else is refused', async () => {
    const today = (await db.query<{ d: string }>(
      `SELECT app.business_date(timezone, business_day_starts_at, now())::text AS d FROM app.branch WHERE id = $1`, [r.branchId])).rows[0]!.d;
    const day = await takings(second.token, 'day');
    const week = await takings(second.token, 'week');
    const month = await takings(second.token, 'month');
    expect([day.fromDate, day.toDate]).toEqual([today, today]);
    expect(week.toDate).toBe(today);
    expect(new Date(`${week.fromDate}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(month.fromDate).toBe(`${today.slice(0, 8)}01`);
    expect(month.totals.bills).toBeGreaterThanOrEqual(week.totals.bills);
    expect(week.totals.bills).toBeGreaterThanOrEqual(day.totals.bills);
    const bad = await http('GET', '/api/t/pos/my-takings?period=year', second.token);
    expect([bad.status, bad.body['error']]).toEqual([400, 'till_period_unknown']);
  });

  it('a chosen From/To range reads the same person\'s bills on those business dates, and refuses an unusable one', async () => {
    const today = (await db.query<{ d: string; y: string }>(
      `SELECT d::text AS d, (d - 1)::text AS y FROM (
         SELECT app.business_date(timezone, business_day_starts_at, now()) AS d FROM app.branch WHERE id = $1) x`,
      [r.branchId])).rows[0]!;
    const day = await takings(second.token, 'day');
    const chosen = await http('GET', `/api/t/pos/my-takings?from=${today.d}&to=${today.d}`, second.token);
    ok(chosen);
    const range = chosen.body as unknown as Takings & { period: string };
    // A one-day range of today is today's figures, and only this person's.
    expect([range.period, range.fromDate, range.toDate]).toEqual(['custom', today.d, today.d]);
    expect(range.bills.map((b) => b.billId)).toEqual(day.bills.map((b) => b.billId));
    expect(range.totals).toEqual(day.totals);
    expect(range.methods.map((m) => ({ method: m.method, amountMinor: m.amountMinor })))
      .toEqual(await tenderSums(second.userId, today.d, today.d));

    // A range with nothing in it is an answer, not a refusal: every section empty, every total zero.
    const empty = await http('GET', `/api/t/pos/my-takings?from=${today.y}&to=${today.y}`, second.token);
    ok(empty);
    expect(empty.body['bills']).toEqual([]);
    expect(empty.body['items']).toEqual([]);
    expect(empty.body['methods']).toEqual([]);
    expect((empty.body['totals'] as Record<string, number>)['collectedMinor']).toBe(0);

    for (const query of [`from=${today.d}`, `from=${today.d}&to=${today.y}`, 'from=2026-02-30&to=2026-03-01',
      `from=${today.d}&to=2999-01-01`, `from=2000-01-01&to=${today.d}`]) {
      const bad = await http('GET', `/api/t/pos/my-takings?${query}`, second.token);
      expect([query, bad.status, bad.body['error']]).toEqual([query, 400, 'till_range_invalid']);
    }
    const mixed = await http('GET', `/api/t/pos/my-takings?period=week&from=${today.d}&to=${today.d}`, second.token);
    expect([mixed.status, mixed.body['error']]).toEqual([400, 'till_period_unknown']);
    // The range is the till's key too: the manager is refused before any date is read.
    expect((await http('GET', `/api/t/pos/my-takings?from=${today.d}&to=${today.d}`, r.token)).status).toBe(403);
  });

  it('is the till\'s key: the manager, who holds the reports, does not hold it', async () => {
    const refused = await http('GET', '/api/t/pos/my-takings?period=day', r.token);
    expect(refused.status).toBe(403);
  });
});

describe('3e. how a branch charges tax (0083): on or off, NONE / GST / VAT / OTHERS, forward or reverse', () => {
  interface Selling { place: Restaurant; dish: string; till: { deviceId: string; token: string } }
  interface BillRow {
    id: string; subtotal_minor: string; tax_minor: string; total_minor: string; payable_minor: string;
    tax_account_type: string; prices_include_tax: boolean; items_minor: string;
  }
  type Account = 'none' | 'gst' | 'vat' | 'others';
  const terms = (taxEnabled: boolean, taxAccountType: Account, taxCalculationMode: 'forward' | 'reverse', taxRegistrationNo: string | null = null) =>
    ({ taxEnabled, taxAccountType, taxCalculationMode, taxRegistrationNo });
  const setTax = (s: Selling, body: unknown, token = s.place.token) =>
    http('POST', `/api/t/admin/branches/${s.place.branchId}/tax`, token, body, keyed());

  /** A restaurant selling one ₹100 (or AED 100) dish at its 5% class, with a till staffed by a cashier. */
  async function selling(jurisdiction: 'IN' | 'AE'): Promise<Selling> {
    const place = await restaurant('basic', jurisdiction);
    // A stated state, so a GST bill heads CGST + SGST and the GST return can be read.
    if (jurisdiction === 'IN') await db.query(`UPDATE app.branch SET state_code = '29' WHERE id = $1`, [place.branchId]);
    const printer = await http('POST', at('/api/t/admin/printers', place.branchId), place.token, { name: 'Kitchen printer', connection_kind: 'usb' });
    ok(printer);
    ok(await http('POST', at('/api/t/admin/kitchens', place.branchId), place.token, { name: 'Kitchen', kind: 'food', printerId: printer.body['id'] }));
    const taxClassId = (await db.query<{ id: string }>(`SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = $2`,
      [place.tenantId, jurisdiction === 'AE' ? 'vat_5' : 'gst_5'])).rows[0]!.id;
    const category = await http('POST', '/api/t/admin/menu/categories', place.token, { key: 'mains', name: 'Mains', display_order: '1' });
    ok(category);
    const item = await http('POST', at('/api/t/admin/menu/items', place.branchId), place.token, {
      name: 'Thali', categoryId: category.body['id'], kind: 'single', kitchenCode: 'kitchen', priceMinor: 10000,
      prepMinutes: 10, taxClassId, addOnGroupIds: [],
    });
    ok(item);
    const fingerprint = `tax${randomUUID().replace(/-/g, '')}`;
    const tillMade = await tillSignIn(place.slug, `owner@${place.slug}.test`, OWNER_PASSWORD, fingerprint);
    ok(tillMade);
    const staff = await addStaff(place, 'Tax Cashier', 'pos', '5927');
    ok(staff);
    const pin = await staffPin(place, staff.body['userId'] as string, '5927', fingerprint);
    ok(pin);
    return { place, dish: item.body['id'] as string, till: { deviceId: tillMade.body['deviceId'] as string, token: pin.body['accessToken'] as string } };
  }

  /** One dish ordered, billed, paid and closed: the bill as the board, the paper and the bill line hold it. */
  async function sellOne(s: Selling) {
    const token = s.till.token;
    const quote = await http('POST', '/api/t/pos/quote', token, { parcel: false, lines: [{ menuItemId: s.dish, quantity: 1 }] });
    ok(quote);
    const opened = await http('POST', '/api/t/pos/dine-in', token, {}, keyed());
    ok(opened);
    const sid = opened.body['sessionId'] as string;
    const oid = opened.body['orderId'] as string;
    const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, token, { deviceId: s.till.deviceId }, keyed());
    const kotLease = { 'x-lease-token': kot.body['token'] as string };
    ok(await http('POST', `/api/t/pos/order/${oid}/line`, token, { menuItemId: s.dish, quantity: 1 }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/order/${oid}/fire`, token, { sessionVersion: await sessionVersion(sid, token) }, keyed(kotLease)));
    ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, token, {}, keyed(kotLease)));
    const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, token, { deviceId: s.till.deviceId }, keyed());
    const lease = { 'x-lease-token': billing.body['token'] as string };
    const made = await http('POST', `/api/t/pos/session/${sid}/bill`, token, { splitKind: 'whole' }, keyed(lease));
    ok(made);
    const billId = made.body['billId'] as string;
    const bill = ((await http('GET', `/api/t/pos/session/${sid}/board`, token)).body['bills'] as BillRow[])[0]!;
    ok(await http('POST', `/api/t/pos/bill/${billId}/payment`, token,
      { parts: [{ method: 'cash', cashReceivedMinor: Number(bill.payable_minor) }] }, keyed(lease)));
    const printed = await http('POST', `/api/t/pos/bill/${billId}/print`, token, {}, keyed());
    ok(printed);
    ok(await http('DELETE', `/api/t/pos/session/${sid}`, token, undefined, keyed(lease)));
    const line = (await db.query<{ amount_minor: string; tax_minor: string; tax_components: { name: string; amount_minor: number }[] }>(
      `SELECT amount_minor::text, tax_minor::text, tax_components FROM app.bill_line WHERE bill_id = $1`, [billId])).rows[0]!;
    const stamped = (await db.query<{ tax_treatment: string; supplier_gstin: string | null; supplier_gst_registration: string | null; supplier_tax_registration_no: string | null }>(
      `SELECT tax_treatment, supplier_gstin, supplier_gst_registration, supplier_tax_registration_no FROM app.bill WHERE id = $1`, [billId])).rows[0]!;
    return { quote: quote.body, bill, printed: printed.body, line, stamped, orderId: oid };
  }

  let india: Selling;
  let uae: Selling;
  beforeAll(async () => {
    india = await selling('IN');
    uae = await selling('AE');
  });

  it('a new restaurant charges its country\'s tax, forward, until its owner says otherwise -- and the settings read back', async () => {
    const read = async (s: Selling) => ((await http('GET', '/api/t/admin/branches', s.place.token)).body['rows'] as Record<string, unknown>[])[0]!;
    expect(await read(india)).toMatchObject({ tax_enabled: true, tax_account_type: 'gst', tax_calculation_mode: 'forward', tax_registration_no: null });
    expect(await read(uae)).toMatchObject({ tax_enabled: true, tax_account_type: 'vat', tax_calculation_mode: 'forward' });
    // The UAE starts with VAT rates of its own, never India's GST slabs.
    const classes = await db.query<{ key: string }>(`SELECT key FROM app.tax_class WHERE tenant_id = $1 ORDER BY key`, [uae.place.tenantId]);
    expect(classes.rows.map((c) => c.key)).toEqual(['vat_0', 'vat_5']);

    ok(await setTax(uae, terms(true, 'vat', 'reverse', '100123456700003')));
    expect(await read(uae)).toMatchObject({ tax_calculation_mode: 'reverse', tax_registration_no: '100123456700003' });
  });

  it('GST forward adds tax: 100 + 5% = 105, CGST and SGST, the GSTIN-less position stamped as before', async () => {
    const sold = await sellOne(india);
    expect(sold.quote).toMatchObject({ itemsMinor: 10000, subtotalMinor: 10000, taxMinor: 500, totalMinor: 10500, pricesIncludeTax: false, taxAccount: 'gst' });
    expect(sold.bill).toMatchObject({ subtotal_minor: '10000', tax_minor: '500', total_minor: '10500', tax_account_type: 'gst', prices_include_tax: false });
    expect(sold.line.tax_components.map((h) => [h.name, h.amount_minor])).toEqual([['CGST', 250], ['SGST', 250]]);
    expect(sold.stamped).toMatchObject({ tax_treatment: 'intra_state', supplier_gst_registration: 'unstated', supplier_tax_registration_no: null });
    expect(sold.printed).toMatchObject({ taxLabel: 'GST', pricesIncludeTax: false, subtotalMinor: 10000, totalMinor: 10500 });
  });

  it('GST reverse finds the tax inside the price: 100 holds 4.76, taxable 95.24, and the bill totals the price', async () => {
    ok(await setTax(india, terms(true, 'gst', 'reverse')));
    const sold = await sellOne(india);
    expect(sold.quote).toMatchObject({ itemsMinor: 10000, subtotalMinor: 9524, taxMinor: 476, totalMinor: 10000, pricesIncludeTax: true });
    expect(sold.bill).toMatchObject({ subtotal_minor: '9524', tax_minor: '476', total_minor: '10000', payable_minor: '10000', prices_include_tax: true });
    expect(sold.line).toMatchObject({ amount_minor: '9524', tax_minor: '476' });
    // Never double-charged: the heads split the 4.76 that is inside the price.
    expect(sold.line.tax_components.reduce((n, h) => n + h.amount_minor, 0)).toBe(476);
    // The paper shows the dish at the price charged, with nothing taken off it.
    const lines = sold.printed['lines'] as { grossMinor: number; lessMinor: number }[];
    expect(lines).toEqual([expect.objectContaining({ grossMinor: 10000, lessMinor: 0 })]);
    expect(sold.printed).toMatchObject({ pricesIncludeTax: true, subtotalMinor: 9524, taxMinor: 476, totalMinor: 10000 });
    // The order kept the mode it was opened under.
    const order = await db.query<{ prices_include_tax: boolean }>(`SELECT prices_include_tax FROM app.sales_order WHERE id = $1`, [sold.orderId]);
    expect(order.rows[0]!.prices_include_tax).toBe(true);
  });

  it('VAT forward: one VAT head at the class rate, no GST identity, and the TRN on the paper', async () => {
    ok(await setTax(india, terms(true, 'vat', 'forward', 'vat-in 2201')));
    const sold = await sellOne(india);
    expect(sold.bill).toMatchObject({ subtotal_minor: '10000', tax_minor: '500', total_minor: '10500', tax_account_type: 'vat' });
    expect(sold.line.tax_components.map((h) => [h.name, h.amount_minor])).toEqual([['VAT', 500]]);
    expect(sold.stamped).toEqual({ tax_treatment: 'vat', supplier_gstin: null, supplier_gst_registration: null, supplier_tax_registration_no: 'VAT-IN 2201' });
    expect(sold.printed).toMatchObject({ taxLabel: 'VAT', taxes: [{ label: 'VAT 5%', amountMinor: 500 }] });
    expect((sold.printed['restaurant'] as Record<string, unknown>)['taxNumber']).toEqual({ label: 'TRN', value: 'VAT-IN 2201' });
  });

  it('OTHERS reverse: one generic TAX head, inside the price', async () => {
    ok(await setTax(india, terms(true, 'others', 'reverse')));
    const sold = await sellOne(india);
    expect(sold.bill).toMatchObject({ subtotal_minor: '9524', tax_minor: '476', total_minor: '10000', tax_account_type: 'others' });
    expect(sold.line.tax_components.map((h) => h.name)).toEqual(['TAX']);
    expect(sold.stamped.tax_treatment).toBe('other');
    expect(sold.printed).toMatchObject({ taxLabel: 'Tax', taxes: [{ label: 'TAX 5%', amountMinor: 476 }] });
  });

  it('NONE, and tax switched off, charge nothing and print no tax', async () => {
    for (const setting of [terms(true, 'none', 'forward'), terms(false, 'gst', 'reverse')]) {
      ok(await setTax(india, setting));
      const sold = await sellOne(india);
      expect(sold.quote).toMatchObject({ taxMinor: 0, taxes: [], taxAccount: 'none' });
      expect(sold.bill).toMatchObject({ subtotal_minor: '10000', tax_minor: '0', total_minor: '10000', tax_account_type: 'none' });
      expect(sold.line).toMatchObject({ amount_minor: '10000', tax_minor: '0', tax_components: [] });
      expect(sold.stamped).toMatchObject({ tax_treatment: 'none', supplier_gst_registration: null });
      expect(sold.printed).toMatchObject({ taxLabel: null, taxes: [], taxMinor: 0 });
    }
  });

  it('the UAE: VAT reverse in AED with the TRN; GST is not offered there', async () => {
    const sold = await sellOne(uae);
    expect(sold.bill).toMatchObject({ subtotal_minor: '9524', tax_minor: '476', total_minor: '10000', tax_account_type: 'vat', prices_include_tax: true });
    expect(sold.line.tax_components.map((h) => h.name)).toEqual(['VAT']);
    expect(sold.printed).toMatchObject({ currency: 'AED', taxLabel: 'VAT', pricesIncludeTax: true });
    expect((sold.printed['restaurant'] as Record<string, unknown>)['taxNumber']).toEqual({ label: 'TRN', value: '100123456700003' });
    const gst = await setTax(uae, terms(true, 'gst', 'forward'));
    expect([gst.status, gst.body['error']]).toEqual([409, 'tax_account_not_offered']);
    // And the database agrees: a UAE bill can never carry an Indian treatment.
    const ae = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.bill WHERE tenant_id = $1 AND tax_treatment IN ('intra_state', 'inter_state')`, [uae.place.tenantId]);
    expect(ae.rows[0]!.n).toBe('0');
  });

  it('dish sales are ex-tax under either mode, and the GST return reads only the GST bills', async () => {
    const today = (await db.query<{ d: string }>(
      `SELECT app.business_date(timezone, business_day_starts_at, now())::text AS d FROM app.branch WHERE id = $1`, [india.place.branchId])).rows[0]!.d;
    const range = { branchId: india.place.branchId, fromDate: today, toDate: today };
    const rows = await withTenantTransaction(appPool, india.place.tenantId, (c) => salesBy(c, 'item', range));
    // Six thalis: GST forward 100.00, GST reverse 95.24, VAT forward 100.00, OTHERS reverse 95.24, two untaxed 100.00.
    expect(rows).toEqual([expect.objectContaining({ label: 'Thali', quantitySold: 6, netMinor: 10000 + 9524 + 10000 + 9524 + 10000 + 10000, taxMinor: 500 + 476 + 500 + 476 })]);
    const ret = await withTenantTransaction(appPool, india.place.tenantId, (c) => outwardSupplyReturn(c, range));
    // Only the two GST bills: 100.00 + 95.24 taxable, 5.00 + 4.76 tax.
    expect(ret.totals).toEqual({ taxableMinor: 19524, cgstMinor: 250 + 238, sgstMinor: 250 + 238, igstMinor: 0 });
  });

  it('is refused mid-service, refused half-stated, and refused for another restaurant\'s branch', async () => {
    const opened = await http('POST', '/api/t/pos/dine-in', india.till.token, {}, keyed());
    ok(opened);
    const busy = await setTax(india, terms(true, 'gst', 'forward'));
    expect([busy.status, busy.body['error']]).toEqual([409, 'tax_settings_while_orders_open']);
    const kot = await http('POST', `/api/t/pos/session/${opened.body['sessionId']}/lease`, india.till.token, { deviceId: india.till.deviceId }, keyed());
    ok(await http('DELETE', `/api/t/pos/session/${opened.body['sessionId']}`, india.till.token, undefined,
      keyed({ 'x-lease-token': kot.body['token'] as string })));
    ok(await setTax(india, terms(true, 'gst', 'forward')));

    for (const body of [{ taxEnabled: true }, { ...terms(true, 'gst', 'forward'), rateBps: 500 },
      terms(true, 'gst', 'forward', '100123456700003'), terms(true, 'vat', 'sideways' as never)]) {
      const bad = await setTax(india, body);
      expect([bad.status, bad.body['error']]).toEqual([400, 'tax_settings_invalid']);
    }
    // Another restaurant's owner names this branch: it does not exist for them.
    const foreign = await setTax(india, terms(true, 'none', 'forward'), uae.place.token);
    expect([foreign.status, foreign.body['error']]).toEqual([404, 'branch_unknown']);
    const still = await db.query<{ tax_account_type: string }>(`SELECT tax_account_type FROM app.branch WHERE id = $1`, [india.place.branchId]);
    expect(still.rows[0]!.tax_account_type).toBe('gst');
    // The till's own staff do not hold the key.
    expect((await setTax(india, terms(true, 'none', 'forward'), india.till.token)).status).toBe(403);
  });

  it('company details print only when set: the bill name and email from the branch', async () => {
    ok(await http('PATCH', `/api/t/admin/branches/${india.place.branchId}`, india.place.token,
      { bill_name: 'Thali House Pvt Ltd', email: 'bills@thali.in' }, keyed()));
    const sold = await sellOne(india);
    expect(sold.printed['restaurant']).toMatchObject({ name: 'Thali House Pvt Ltd', email: 'bills@thali.in' });
    const badEmail = await http('PATCH', `/api/t/admin/branches/${india.place.branchId}`, india.place.token, { email: 'not-an-email' }, keyed());
    expect([badEmail.status, badEmail.body['error']]).toEqual([409, 'invariant_refused']);
  });

  /* ---------------------------------------------- country and currency (0084) --- */

  async function platformUser(role: string): Promise<string> {
    const id = randomUUID();
    const roleId = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = $1`, [role])).rows[0]!.id;
    await db.query(
      `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
       VALUES ($1, $2, 'argon2id$stub', 'Country Platform', $3)`, [id, `country+${id}@platform.test`, roleId]);
    return id;
  }
  const platformToken = (sub: string, role: string) => {
    const now = Math.floor(Date.now() / 1000);
    return signToken({ sub, platform_role: role, iat: now, exp: now + 600 }, KEY);
  };
  const moveCountry = (s: Selling, token: string, payload: Record<string, unknown>) =>
    http('POST', `/api/platform/tenants/${s.place.tenantId}/country`, token, payload);
  const root = async (tenantId: string) => (await db.query<{ tax_jurisdiction: string; default_currency: string; default_timezone: string }>(
    `SELECT tax_jurisdiction, default_currency, default_timezone FROM platform.tenant WHERE id = $1`, [tenantId])).rows[0]!;
  const dishTerms = async (s: Selling) => (await db.query<{ price_minor: string; key: string }>(
    `SELECT mi.price_minor::text, tc.key FROM app.menu_item mi JOIN app.tax_class tc ON tc.id = mi.tax_class_id WHERE mi.id = $1`,
    [s.dish])).rows[0]!;

  it('India -> UAE before the first bill: previewed, confirmed, converted only by the named rate, then billed in AED to the fils', async () => {
    const s = await selling('IN');
    const admin = platformToken(await platformUser('super_admin'), 'super_admin');

    const unconfirmed = await moveCountry(s, admin, { country: 'AE', rate: '0.05' });
    expect([unconfirmed.status, unconfirmed.body['error']]).toEqual([409, 'country_change_unconfirmed']);

    // The preview writes nothing and says what will happen, including the price.
    const preview = await http('GET', `/api/platform/tenants/${s.place.tenantId}/country-change?country=AE&rate=0.05`, admin);
    ok(preview);
    expect(preview.body).toMatchObject({
      from: { country: 'IN', currency: 'INR' }, to: { country: 'AE', currency: 'AED', timezone: 'Asia/Dubai' },
      rate: '0.05', samples: [{ name: 'Thali', priceMinor: '10000', newPriceMinor: '500' }],
      itemsRetaxed: 1, taxAccount: 'vat',
    });
    expect((preview.body['converted'] as Record<string, number>)['menu_item']).toBe(1);
    expect(await dishTerms(s)).toEqual({ price_minor: '10000', key: 'gst_5' });

    const moved = await moveCountry(s, admin, { country: 'AE', rate: '0.05', confirm: true });
    ok(moved);
    expect(moved.body).toMatchObject({ to: { country: 'AE', currency: 'AED' }, rate: '0.05', itemsRetaxed: 1 });
    expect(await root(s.place.tenantId)).toEqual({ tax_jurisdiction: 'AE', default_currency: 'AED', default_timezone: 'Asia/Dubai' });
    expect(await dishTerms(s)).toEqual({ price_minor: '500', key: 'vat_5' });
    const classes = await db.query<{ key: string; status: string }>(
      `SELECT key, status FROM app.tax_class WHERE tenant_id = $1 ORDER BY key`, [s.place.tenantId]);
    expect(classes.rows).toEqual([
      { key: 'gst_0', status: 'archived' }, { key: 'gst_18', status: 'archived' }, { key: 'gst_5', status: 'archived' },
      { key: 'vat_0', status: 'active' }, { key: 'vat_5', status: 'active' },
    ]);
    const branch = await db.query<{ tax_account_type: string; timezone: string }>(
      `SELECT tax_account_type, timezone FROM app.branch WHERE id = $1`, [s.place.branchId]);
    expect(branch.rows[0]).toEqual({ tax_account_type: 'vat', timezone: 'Asia/Dubai' });
    // Recorded in the platform audit log, with the result.
    const audited = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.platform_audit_log WHERE action = 'tenant.country.changed' AND target_id = $1`,
      [s.place.tenantId]);
    expect(audited.rows[0]!.n).toBe('1');

    // The admin and the till format money from the public lookup.
    const pub = await http('GET', `/api/public/restaurants/${s.place.slug}`, null);
    expect(pub.body).toMatchObject({ currency: 'AED', locale: 'en-AE', billRounding: 'none' });

    // AED 5.00 + 5% VAT = AED 5.25, collected to the fils: no round-off, which
    // India's rule would have taken down to 5.00.
    const sold = await sellOne(s);
    expect(sold.bill).toMatchObject({ subtotal_minor: '500', tax_minor: '25', total_minor: '525', payable_minor: '525', tax_account_type: 'vat' });
    expect(sold.quote).toMatchObject({ roundOffMinor: 0, payableMinor: 525 });
    expect(sold.printed).toMatchObject({ currency: 'AED', taxLabel: 'VAT' });
    const stamped = await db.query<{ currency: string; rounding_rule: string; tax_jurisdiction: string }>(
      `SELECT currency, rounding_rule, tax_jurisdiction FROM app.bill WHERE tenant_id = $1`, [s.place.tenantId]);
    expect(stamped.rows).toEqual([{ currency: 'AED', rounding_rule: 'none', tax_jurisdiction: 'AE' }]);

    // Billed: the country is fixed now, and the bill stays what it was.
    const locked = await moveCountry(s, admin, { country: 'IN', confirm: true });
    expect([locked.status, locked.body['error']]).toEqual([409, 'country_locked_after_billing']);
    expect((await root(s.place.tenantId)).default_currency).toBe('AED');
  });

  it('UAE -> India without a rate keeps every number, re-taxes at the same rate, and Sales may move it only when allowed', async () => {
    const s = await selling('AE');
    const admin = platformToken(await platformUser('super_admin'), 'super_admin');
    const otherRep = platformToken(await platformUser('sales'), 'sales');

    // Off by default: the Sales person who sold it is refused, the change not made.
    const refused = await moveCountry(s, salesToken(), { country: 'IN', confirm: true });
    expect([refused.status, refused.body['error']]).toEqual([403, 'country_change_not_permitted']);

    const allow = await http('PATCH', '/api/platform/settings/countries', admin, { salesMayChangeCountry: true });
    ok(allow);
    try {
      // A Sales person cannot reach the restaurant at all: settings are Super Admin's.
      expect((await http('PATCH', '/api/platform/settings/countries', salesToken(), { salesMayChangeCountry: false })).status).toBe(403);
      // Allowed, but only for restaurants they sold.
      const notTheirs = await moveCountry(s, otherRep, { country: 'IN', confirm: true });
      expect([notTheirs.status, notTheirs.body['error']]).toEqual([404, 'restaurant_unknown']);

      // An open order refuses the move.
      const opened = await http('POST', '/api/t/pos/dine-in', s.till.token, {}, keyed());
      ok(opened);
      const busy = await moveCountry(s, salesToken(), { country: 'IN', confirm: true });
      expect([busy.status, busy.body['error']]).toEqual([409, 'country_change_while_orders_open']);
      const kot = await http('POST', `/api/t/pos/session/${opened.body['sessionId']}/lease`, s.till.token, { deviceId: s.till.deviceId }, keyed());
      ok(await http('DELETE', `/api/t/pos/session/${opened.body['sessionId']}`, s.till.token, undefined,
        keyed({ 'x-lease-token': kot.body['token'] as string })));

      // A rate with no currency change is refused: it would only be a price change.
      const pointless = await moveCountry(s, salesToken(), { country: 'AE', currency: 'AED', timezone: 'Asia/Kolkata', rate: '2', confirm: true });
      expect([pointless.status, pointless.body['error']]).toEqual([400, 'country_change_invalid']);

      const moved = await moveCountry(s, salesToken(), { country: 'IN', confirm: true });
      ok(moved);
      expect(moved.body).toMatchObject({ rate: null, converted: {} });
    } finally {
      ok(await http('PATCH', '/api/platform/settings/countries', admin, { salesMayChangeCountry: false }));
    }
    expect(await root(s.place.tenantId)).toEqual({ tax_jurisdiction: 'IN', default_currency: 'INR', default_timezone: 'Asia/Kolkata' });
    // No exchange rate named: AED 100.00 is now ₹100.00, on India's 5% class.
    expect(await dishTerms(s)).toEqual({ price_minor: '10000', key: 'gst_5' });
    const branch = await db.query<{ tax_account_type: string; tax_registration_no: string | null }>(
      `SELECT tax_account_type, tax_registration_no FROM app.branch WHERE id = $1`, [s.place.branchId]);
    expect(branch.rows[0]).toEqual({ tax_account_type: 'gst', tax_registration_no: null });

    // ₹100 + 5% = ₹105, and India's rule is back on the bill.
    const sold = await sellOne(s);
    expect(sold.bill).toMatchObject({ subtotal_minor: '10000', tax_minor: '500', total_minor: '10500', tax_account_type: 'gst' });
    const stamped = await db.query<{ currency: string; rounding_rule: string }>(
      `SELECT currency, rounding_rule FROM app.bill WHERE tenant_id = $1`, [s.place.tenantId]);
    expect(stamped.rows).toEqual([{ currency: 'INR', rounding_rule: 'nearest_rupee' }]);
    expect(sold.printed).toMatchObject({ currency: 'INR' });
  });

  it('the countries offered are the Super Admin\'s: a restaurant is created only in one, the default among them', async () => {
    const admin = platformToken(await platformUser('super_admin'), 'super_admin');
    const read = await http('GET', '/api/platform/countries', salesToken());
    ok(read);
    expect(read.body).toMatchObject({ defaultCountry: 'IN', currencies: ['INR', 'AED'], salesMayChangeCountry: false });
    expect((read.body['countries'] as { code: string; currency: string; offered: boolean }[])
      .map((c) => [c.code, c.currency, c.offered])).toEqual([['IN', 'INR', true], ['AE', 'AED', true]]);

    for (const bad of [{ offered: [] }, { offered: ['IN', 'ZZ'] }, { offered: ['AE'] }, { defaultCountry: 'ZZ' }]) {
      const refused = await http('PATCH', '/api/platform/settings/countries', admin, bad);
      expect([JSON.stringify(bad), refused.status, refused.body['error']]).toEqual([JSON.stringify(bad), 400, 'country_settings_invalid']);
    }
    ok(await http('PATCH', '/api/platform/settings/countries', admin, { offered: ['IN'] }));
    try {
      await expect(restaurant('basic', 'AE')).rejects.toThrow();
      const currency = await http('POST', '/api/platform/tenants', salesToken(), {
        slug: `cur-${randomUUID().slice(0, 8)}`, name: 'Wrong Money', currency: 'AED', timezone: 'Asia/Kolkata',
        ownerEmail: `o@${randomUUID().slice(0, 6)}.test`, ownerName: 'O', firstBranchName: 'Main',
        planVersionId: versionOf.get('basic')!, taxJurisdiction: 'IN',
      }, keyed());
      expect([currency.status, currency.body['error']]).toEqual([422, 'currency_not_offered']);
    } finally {
      ok(await http('PATCH', '/api/platform/settings/countries', admin, { offered: ['IN', 'AE'] }));
    }
  });
});

describe('4. the Sales person adds staff; staff sign in on the till with their PIN', () => {
  let akhil: string;

  it('staff sign in on the till (POS) with the PIN the Sales person set', async () => {
    const made = await addStaff(r, 'Akhil', 'pos', '3816');
    ok(made);
    akhil = made.body['userId'] as string;
    expect((await staffPin(r, akhil, '3817', FINGERPRINT)).status).toBe(401);
    const res = await staffPin(r, akhil, '3816', FINGERPRINT);
    ok(res);
    const pos = await http('GET', '/api/t/me', res.body['accessToken'] as string);
    expect(pos.body['screens']).toEqual({ kot: true, billing: true, kitchen: false, admin: false, takings: true, bills: true, billEdit: true, dayEnd: true, billEditAny: false, dayReopen: false });
    expect(pos.body['deviceName']).toBe('Counter computer');
  });

  it('staff have no password: nothing signs in with one', async () => {
    const passwords = await db.query(`SELECT 1 FROM app.credential WHERE user_id = $1 AND type = 'password'`, [akhil]);
    expect(passwords.rowCount).toBe(0);
    const office = await http('POST', `/api/auth/${r.slug}/login`, null,
      { login: 'AKHIL', password: 'akhil-pass-2026', audience: 'manager' });
    expect([office.status, office.body['error']]).toEqual([401, 'authentication_failed']);
    expect((await tillSignIn(r.slug, 'AKHIL', 'akhil-pass-2026', FINGERPRINT)).status).toBe(401);
  });

  it('staff cannot reach the manager screens by key on the till session', async () => {
    const staff = (await staffPin(r, akhil, '3816', FINGERPRINT)).body['accessToken'] as string;
    const list = await http('GET', '/api/t/admin/staff', staff);
    expect([list.status, list.body['error']]).toEqual([403, 'forbidden']);
  });

  it('the manager still signs in on the restaurant\'s page and lands on the manager screens', async () => {
    const manager = await http('POST', `/api/auth/${r.slug}/login`, null,
      { login: `owner@${r.slug}.test`, password: OWNER_PASSWORD, audience: 'manager' });
    ok(manager);
    expect(manager.body['lands']).toBe('admin');
  });
});

describe('5. tills: only a manager makes one, within the plan', () => {
  it('the manager\'s sign-in on a new browser makes it a till; the third is refused; an existing one still opens', async () => {
    // `other` has no till yet.
    const first = await tillSignIn(other.slug, `owner@${other.slug}.test`, OWNER_PASSWORD, `o1${FINGERPRINT}`);
    ok(first);
    ok(await tillSignIn(other.slug, `owner@${other.slug}.test`, OWNER_PASSWORD, `o2${FINGERPRINT}`));
    const third = await tillSignIn(other.slug, `owner@${other.slug}.test`, OWNER_PASSWORD, `o3${FINGERPRINT}`);
    expect([third.status, third.body['error']]).toEqual([402, 'upgrade_required']);
    // At the limit, an existing till still signs in.
    ok(await tillSignIn(other.slug, `owner@${other.slug}.test`, OWNER_PASSWORD, `o1${FINGERPRINT}`));
  });

  it('a staff sign-in on a new browser makes a till within the limit (Basic); at the limit it is refused; an existing till opens', async () => {
    const ravi = (await addStaff(other, 'Ravi')).body['userId'] as string;
    // `other` already has its two tills (o1, o2): a third is refused, not quietly made.
    const refused = await staffPin(other, ravi, '5927', `nt${FINGERPRINT}`);
    expect([refused.status, refused.body['error']]).toEqual([402, 'upgrade_required']);
    ok(await staffPin(other, ravi, '5927', `o1${FINGERPRINT}`));
  });

  it('a till taken out of use is set up again on the next sign-in, keeping the browser', async () => {
    const spareFingerprint = `sp${FINGERPRINT}`;
    const spare = await tillSignIn(r.slug, `owner@${r.slug}.test`, OWNER_PASSWORD, spareFingerprint, 'Spare');
    ok(spare);
    ok(await http('DELETE', `/api/t/admin/devices/${spare.body['deviceId'] as string}`, r.token));
    const again = await tillSignIn(r.slug, `owner@${r.slug}.test`, OWNER_PASSWORD, spareFingerprint, 'Spare');
    ok(again);
    expect(again.body['deviceId']).not.toBe(spare.body['deviceId']);
  });
});

describe('6. Basic has four restaurant users, the owner included', () => {
  let shop: Restaurant;
  const users = async () => Number((await db.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM app.app_user WHERE tenant_id = $1 AND status IN ('active','invited'))
           + (SELECT count(*) FROM app.staff_invite WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now()))::text AS n`,
    [shop.tenantId])).rows[0]!.n);

  beforeAll(async () => {
    shop = await restaurant('basic');
  });

  it('refuses the fifth, and the manager has no other way to add one', async () => {
    expect(await users()).toBe(1);
    for (const name of ['Staff 1', 'Staff 2', 'Staff 3']) ok(await addStaff(shop, name));
    expect(await users()).toBe(4);
    const fifth = await addStaff(shop, 'Staff 4');
    expect([fifth.status, fifth.body['error']]).toEqual([402, 'upgrade_required']);
    const direct = await http('POST', '/api/t/admin/users', shop.token, { full_name: 'Sneaky', employee_code: 'SN1' });
    expect(direct.status).toBe(404);
  });

  it('switching someone off is never refused; switching them back on is, when it would go over', async () => {
    const staff = (await db.query<{ id: string }>(
      `SELECT id FROM app.app_user WHERE tenant_id = $1 AND full_name = 'Staff 1'`, [shop.tenantId])).rows[0]!.id;
    const active = (on: boolean) =>
      http('POST', `/api/platform/tenants/${shop.tenantId}/staff/${staff}/active`, salesToken(), { active: on }, keyed());
    ok(await active(false));
    expect(await users()).toBe(3);
    ok(await addStaff(shop, 'Staff 5'));
    const back = await active(true);
    expect([back.status, back.body['error']]).toEqual([402, 'upgrade_required']);
  });

  it('two adds at once for the last slot: exactly one gets it', async () => {
    const extra = await restaurant('basic');
    ok(await addStaff(extra, 'Race 1', 'orders'));
    ok(await addStaff(extra, 'Race 2', 'orders'));
    const results = await Promise.all([addStaff(extra, 'Race 3', 'orders'), addStaff(extra, 'Race 4', 'orders')]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 402]);
  });

  it('platform staff are never counted: the Sales Person who sold it is not a restaurant user', async () => {
    const counted = await db.query(`SELECT 1 FROM app.app_user WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, rep]);
    expect(counted.rowCount).toBe(0);
  });
});
