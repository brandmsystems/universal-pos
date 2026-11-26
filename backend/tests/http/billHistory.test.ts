import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planDocument } from '../helpers/plans.js';
import { buildServer } from '../../src/app.js';
import { resetRegistry } from '../../src/core/middleware/routeRegistry.js';
import { signToken } from '../../src/modules/auth/jwt.js';
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
import { SYSTEM_ROLES } from '../../src/modules/authz/systemRoles.js';
import { separationOfDutiesViolations } from '../../src/modules/authz/separation.js';

/**
 * Bill history, bill edits and day end (0086), over HTTP on a Basic restaurant:
 * a till staffed by a PIN sign-in (the POS capacity) and the manager on the
 * manager screens. Every refusal here is pinned to its code, and every rule is
 * exercised by a request built to break it.
 */

const KEY = 'bill-history-signing-key-long-enough-for-hs256';
const OWNER_PASSWORD = 'bills-owner-2026';

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let versionOf: ReadonlyMap<string, string>;

interface Place {
  tenantId: string; slug: string; manager: string; branchId: string;
  till: { deviceId: string; token: string; userId: string };
  thali: string; lassi: string;
}
let r: Place;
let other: Place;

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
const refused = (res: { status: number; body: Record<string, unknown> }) => [res.status, res.body['error']];
const salesToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY);
};

async function place(): Promise<Place> {
  const slug = `bills-${randomUUID().slice(0, 8)}`;
  const email = `owner@${slug}.test`;
  const made = await http('POST', '/api/platform/tenants', salesToken(), {
    slug, name: 'Bills Place', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Owner',
    firstBranchName: 'Main', planVersionId: versionOf.get('basic')!, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
  }, keyed());
  ok(made);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: OWNER_PASSWORD });
  const manager = (await http('POST', `/api/auth/${slug}/login`, null, { email, password: OWNER_PASSWORD })).body['accessToken'] as string;
  const tenantId = made.body['tenantId'] as string;
  const branchId = (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;
  await db.query(`UPDATE app.branch SET state_code = '27' WHERE id = $1`, [branchId]);

  const at = (path: string) => `${path}?branchId=${branchId}`;
  const printer = await http('POST', at('/api/t/admin/printers'), manager, { name: 'Kitchen printer', connection_kind: 'usb' });
  ok(printer);
  ok(await http('POST', at('/api/t/admin/kitchens'), manager, { name: 'Kitchen', kind: 'food', printerId: printer.body['id'] }));
  const taxClassId = (await db.query<{ id: string }>(
    `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [tenantId])).rows[0]!.id;
  const category = await http('POST', '/api/t/admin/menu/categories', manager, { key: 'mains', name: 'Mains', display_order: '1' });
  ok(category);
  const dish = async (name: string, priceMinor: number) => {
    const item = await http('POST', at('/api/t/admin/menu/items'), manager, {
      name, categoryId: category.body['id'], kind: 'single', kitchenCode: 'kitchen', priceMinor,
      prepMinutes: 5, taxClassId, addOnGroupIds: [],
    });
    ok(item);
    return item.body['id'] as string;
  };
  const thali = await dish('Thali', 10000);
  const lassi = await dish('Lassi', 5000);

  const fingerprint = `bills${randomUUID().replace(/-/g, '')}`;
  const tillMade = await http('POST', `/api/auth/${slug}/till`, null,
    { login: email, password: OWNER_PASSWORD, deviceFingerprint: fingerprint, deviceName: 'Counter' });
  ok(tillMade);
  const staff = await http('POST', `/api/platform/tenants/${tenantId}/staff`, salesToken(),
    { fullName: 'Asha Till', username: 'ASHATILL', access: 'pos', pin: '5927' }, keyed());
  ok(staff);
  const userId = staff.body['userId'] as string;
  const pin = await http('POST', `/api/auth/${slug}/pin`, null, { userId, pin: '5927', deviceFingerprint: fingerprint });
  ok(pin);
  return {
    tenantId, slug, manager, branchId, thali, lassi,
    till: { deviceId: tillMade.body['deviceId'] as string, token: pin.body['accessToken'] as string, userId },
  };
}

async function sessionVersion(sessionId: string, token: string): Promise<number> {
  const board = await http('GET', `/api/t/pos/session/${sessionId}/board`, token);
  ok(board);
  return Number((board.body['session'] as Record<string, unknown>)['version']);
}

interface Billed { sid: string; billId: string; billNo: number; payable: number; lease: Record<string, string> }

/** An order taken, sent and billed on the till; payment is the caller's. */
async function billed(p: Place, lines: { menuItemId: string; quantity: number }[], pickupName?: string): Promise<Billed> {
  const token = p.till.token;
  const opened = pickupName === undefined
    ? await http('POST', '/api/t/pos/dine-in', token, {}, keyed())
    : await http('POST', '/api/t/pos/parcel', token, { pickupName }, keyed());
  ok(opened);
  const sid = opened.body['sessionId'] as string;
  const oid = opened.body['orderId'] as string;
  const kot = await http('POST', `/api/t/pos/session/${sid}/lease`, token, { deviceId: p.till.deviceId }, keyed());
  const kotLease = { 'x-lease-token': kot.body['token'] as string };
  for (const line of lines) ok(await http('POST', `/api/t/pos/order/${oid}/line`, token, line, keyed(kotLease)));
  ok(await http('POST', `/api/t/pos/order/${oid}/fire`, token, { sessionVersion: await sessionVersion(sid, token) }, keyed(kotLease)));
  ok(await http('POST', `/api/t/pos/session/${sid}/ready-for-billing`, token, {}, keyed(kotLease)));
  const billing = await http('POST', `/api/t/pos/session/${sid}/billing-lease`, token, { deviceId: p.till.deviceId }, keyed());
  ok(billing);
  const lease = { 'x-lease-token': billing.body['token'] as string };
  const bill = await http('POST', `/api/t/pos/session/${sid}/bill`, token, { splitKind: 'whole' }, keyed(lease));
  ok(bill);
  return { sid, billId: bill.body['billId'] as string, billNo: bill.body['billNo'] as number, payable: bill.body['payableMinor'] as number, lease };
}

async function payAndClose(p: Place, b: { sid: string; billId: string; payable: number }, method = 'cash'): Promise<void> {
  const billing = await http('POST', `/api/t/pos/session/${b.sid}/billing-lease`, p.till.token, { deviceId: p.till.deviceId }, keyed());
  ok(billing);
  const lease = { 'x-lease-token': billing.body['token'] as string };
  const part = method === 'cash' ? { method, cashReceivedMinor: b.payable } : { method, amountMinor: b.payable };
  ok(await http('POST', `/api/t/pos/bill/${b.billId}/payment`, p.till.token, { parts: [part] }, keyed(lease)));
  ok(await http('DELETE', `/api/t/pos/session/${b.sid}`, p.till.token, undefined, keyed(lease)));
}

interface DetailLine { lineId: string; name: string; quantity: number; remainingQuantity: number; kind: string }
const detail = async (p: Place, billId: string, token = p.till.token, admin = false) => {
  const res = await http('GET', `/api/t/${admin ? 'admin' : 'pos'}/bills/${billId}`, token);
  ok(res);
  return res.body as unknown as {
    bill: { billNo: number; status: string; version: number; editState: string; canEdit: boolean; payableMinor: number;
      paidMinor: number; refundedMinor: number; replacedByBillNo: number | null; lastEdit: { authority: string } | null };
    lines: DetailLine[]; revisions: { authority: string; reason: string; reopened: unknown }[];
  };
};
const lineNamed = (lines: DetailLine[], name: string) => lines.find((l) => l.name === name)!;
const revise = (p: Place, billId: string, body: unknown, token = p.till.token, admin = false) =>
  http('POST', `/api/t/${admin ? 'admin' : 'pos'}/bills/${billId}/revise`, token, body, admin ? {} : keyed());
const today = async (p: Place) => (await db.query<{ d: string }>(
  `SELECT app.business_date(timezone, business_day_starts_at, now())::text AS d FROM app.branch WHERE id = $1`,
  [p.branchId])).rows[0]!.d;

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const salesRole = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Bills Rep', $3)`, [rep, `bills+${rep}@platform.test`, salesRole]);
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
    async get(tenantId: string) { return planDocument(tenantId, 'basic'); },
    async put() { /* computed */ },
  } }, new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await place();
  other = await place();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('1. the keys: the till corrects today, the manager adjusts, and no role breaks a separation rule', () => {
  it('the till roles hold bill.edit and Submit Day Bills but never bill.edit.any or the reopen', () => {
    const cashier = SYSTEM_ROLES.find((role) => role.key === 'cashier')!;
    const counter = SYSTEM_ROLES.find((role) => role.key === 'counter')!;
    for (const role of [cashier, counter]) {
      expect(role.permissions).toEqual(expect.arrayContaining(['bill.view', 'bill.edit', 'payment.settlement.close']));
      expect(role.permissions).not.toContain('bill.edit.any');
      expect(role.permissions).not.toContain('payment.settlement.reopen');
    }
    const owner = SYSTEM_ROLES.find((role) => role.key === 'owner')!;
    expect(owner.permissions).toEqual(expect.arrayContaining(['bill.edit.any', 'payment.settlement.reopen', 'payment.settlement.close']));
    // A till role holding the manager's edit would be a separation violation, by the rule set itself.
    expect(separationOfDutiesViolations([...cashier.permissions, 'bill.edit.any']).map((v) => v.rule)).toEqual(['till-vs-record']);
    expect(separationOfDutiesViolations([...cashier.permissions, 'payment.settlement.reopen']).map((v) => v.rule)).toEqual(['till-vs-record']);
    for (const role of SYSTEM_ROLES) expect(separationOfDutiesViolations(role.permissions), role.key).toEqual([]);
  });

  it('/me offers the till Bills, Edit and Submit Day Bills from its keys', async () => {
    const me = await http('GET', '/api/t/me', r.till.token);
    expect(me.body['screens']).toMatchObject({ bills: true, billEdit: true, dayEnd: true, admin: false });
  });

  it('the till cannot use the manager\'s routes: the edit, the day reopen', async () => {
    const b = await billed(r, [{ menuItemId: r.thali, quantity: 1 }]);
    const asTill = await http('POST', `/api/t/admin/bills/${b.billId}/revise`, r.till.token,
      { expectedVersion: 1, reason: 'trying the manager route', remove: [], add: [{ menuItemId: r.lassi, quantity: 1 }] });
    expect(refused(asTill)).toEqual([403, 'forbidden']);
    const reopen = await http('POST', `/api/t/admin/days/${await today(r)}/reopen`, r.till.token, { reason: 'till wants to reopen' });
    expect(refused(reopen)).toEqual([403, 'forbidden']);
    await payAndClose(r, b);
  });
});

describe('2. bill history', () => {
  it('lists today\'s bills, with the day\'s figures, and searches by bill number, D-/P- number and pickup name', async () => {
    const dine = await billed(r, [{ menuItemId: r.thali, quantity: 2 }]);
    await payAndClose(r, dine, 'upi');
    const parcel = await billed(r, [{ menuItemId: r.lassi, quantity: 1 }], 'Meenakshi');
    await payAndClose(r, parcel);

    const listed = await http('GET', '/api/t/pos/bills?period=today', r.till.token);
    ok(listed);
    const day = (listed.body['days'] as { businessDate: string; state: string; figures: { billCount: number; methods: { method: string }[] };
      bills: { billNo: number; orderNo: number | null; pickupName: string | null; editState: string; canEdit: boolean; methods: string[] }[] }[])[0]!;
    expect(day.businessDate).toBe(await today(r));
    expect(day.state).toBe('open');
    expect(day.bills.map((b) => b.billNo)).toEqual(expect.arrayContaining([dine.billNo, parcel.billNo]));
    expect(day.figures.billCount).toBe(day.bills.length);
    expect(day.figures.methods.map((m) => m.method)).toEqual(expect.arrayContaining(['cash', 'upi']));
    expect(day.bills.every((b) => b.editState === 'editable' && b.canEdit)).toBe(true);

    const byNo = await http('GET', `/api/t/pos/bills?period=today&q=${dine.billNo}`, r.till.token);
    const found = (byNo.body['days'] as { bills: { billNo: number }[] }[]).flatMap((d) => d.bills).map((b) => b.billNo);
    expect(found).toContain(dine.billNo);
    const parcelNo = (await db.query<{ parcel_no: number }>(`SELECT parcel_no FROM app.table_session WHERE id = $1`, [parcel.sid])).rows[0]!.parcel_no;
    const byCounter = await http('GET', `/api/t/pos/bills?period=today&q=P-${parcelNo}`, r.till.token);
    expect((byCounter.body['days'] as { bills: { billNo: number }[] }[]).flatMap((d) => d.bills).map((b) => b.billNo)).toEqual([parcel.billNo]);
    const byName = await http('GET', '/api/t/pos/bills?period=today&q=meenak', r.till.token);
    expect((byName.body['days'] as { bills: { pickupName: string }[] }[]).flatMap((d) => d.bills).map((b) => b.pickupName)).toEqual(['Meenakshi']);

    for (const period of ['yesterday', 'week', 'month']) ok(await http('GET', `/api/t/pos/bills?period=${period}`, r.till.token));
    const custom = await http('GET', `/api/t/pos/bills?from=${await today(r)}&to=${await today(r)}`, r.till.token);
    expect(custom.body['period']).toBe('custom');
    expect(refused(await http('GET', '/api/t/pos/bills?period=decade', r.till.token))).toEqual([400, 'history_period_unknown']);
  });

  it('a bill\'s detail carries its lines, payments and the till that took them', async () => {
    const b = await billed(r, [{ menuItemId: r.thali, quantity: 1 }]);
    await payAndClose(r, b, 'card');
    const read = await http('GET', `/api/t/pos/bills/${b.billId}`, r.till.token);
    ok(read);
    expect((read.body['tenders'] as { method: string; by: string }[])[0]).toMatchObject({ method: 'card', by: 'Asha Till' });
    expect((read.body['lines'] as DetailLine[])[0]).toMatchObject({ name: 'Thali', quantity: 1, remainingQuantity: 1, kind: 'item' });
  });
});

describe('3. the till edits today\'s bills before day end', () => {
  it('an unpaid bill is voided, kept, and reissued under a new number from the server\'s own totals', async () => {
    const b = await billed(r, [{ menuItemId: r.thali, quantity: 2 }]);
    const before = await detail(r, b.billId);
    const thali = lineNamed(before.lines, 'Thali');
    const change = { expectedVersion: before.bill.version, reason: 'guest wanted one thali and a lassi',
      remove: [{ lineId: thali.lineId, quantity: 1 }], add: [{ menuItemId: r.lassi, quantity: 1 }] };

    // The preview is the server's figures with nothing kept.
    const preview = await http('POST', `/api/t/pos/bills/${b.billId}/revise/preview`, r.till.token, change, keyed());
    ok(preview);
    expect(preview.body['preview']).toBe(true);
    // ₹100 + ₹50 at 5% = ₹157.50, paid to the rupee: ₹158.
    expect((preview.body['after'] as { totalMinor: number; payableMinor: number })).toMatchObject({ totalMinor: 15750, payableMinor: 15800 });
    expect((await db.query(`SELECT 1 FROM app.bill_revision WHERE bill_id = $1`, [b.billId])).rowCount).toBe(0);
    expect((await db.query<{ status: string }>(`SELECT status FROM app.bill WHERE id = $1`, [b.billId])).rows[0]!.status).toBe('open');

    // Without a reason, refused; with a stale version, refused.
    expect(refused(await revise(r, b.billId, { ...change, reason: ' ' }))).toEqual([400, 'bill_edit_reason_required']);
    expect(refused(await revise(r, b.billId, { ...change, expectedVersion: before.bill.version + 5 }))).toEqual([409, 'bill_edit_stale']);

    const edited = await revise(r, b.billId, change);
    ok(edited);
    const replacement = edited.body['replacementBill'] as { billId: string; billNo: number; payableMinor: number };
    expect(replacement.billNo).not.toBe(b.billNo);
    expect(replacement.payableMinor).toBe(15800);

    // The original stands, void, with its number; the new bill says what it replaced.
    const old = await detail(r, b.billId);
    expect(old.bill).toMatchObject({ status: 'void', billNo: b.billNo, replacedByBillNo: replacement.billNo, canEdit: false });
    const fresh = await detail(r, replacement.billId);
    expect(fresh.bill.lastEdit).toMatchObject({ authority: 'pos' });
    expect(fresh.revisions).toEqual([expect.objectContaining({ authority: 'pos', reason: 'guest wanted one thali and a lassi', reopened: null })]);
    // The removal is a void row with the edit's reason, never an update of the line.
    const voids = await db.query<{ quantity: number; adjustment_note: string }>(
      `SELECT quantity, adjustment_note FROM app.order_line WHERE adjusts_line_id = $1 AND kind = 'void'`, [thali.lineId]);
    expect(voids.rows).toEqual([{ quantity: -1, adjustment_note: 'guest wanted one thali and a lassi' }]);

    // The same edit again, on the bill it already replaced: refused, not applied twice.
    expect(refused(await revise(r, b.billId, { ...change, expectedVersion: old.bill.version }))).toEqual([409, 'bill_edit_not_editable']);
    await payAndClose(r, { sid: b.sid, billId: replacement.billId, payable: replacement.payableMinor });
  });

  it('a paid bill keeps its payment: the till may add (a supplementary bill to collect) but never take off', async () => {
    const b = await billed(r, [{ menuItemId: r.thali, quantity: 1 }]);
    await payAndClose(r, b);
    const before = await detail(r, b.billId);
    const tendersBefore = await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [b.billId]);

    const takeOff = await revise(r, b.billId, { expectedVersion: before.bill.version, reason: 'customer returned it',
      remove: [{ lineId: lineNamed(before.lines, 'Thali').lineId, quantity: 1 }] });
    expect(refused(takeOff)).toEqual([403, 'bill_edit_reduces_paid_bill']);

    const added = await revise(r, b.billId, { expectedVersion: before.bill.version, reason: 'one more lassi for the table',
      add: [{ menuItemId: r.lassi, quantity: 1 }] });
    ok(added);
    const supplementary = added.body['supplementaryBill'] as { billId: string; payableMinor: number };
    expect(supplementary.payableMinor).toBe(5300); // ₹52.50 to the rupee
    expect(added.body['refund']).toBeNull();
    // The payment rows are exactly as they were; the order is back on the queue to collect the rest.
    expect((await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [b.billId])).rows).toEqual(tendersBefore.rows);
    expect((await db.query<{ status: string }>(`SELECT status FROM app.table_session WHERE id = $1`, [b.sid])).rows[0]!.status).toBe('open');
    // The added item went to the kitchen like any other.
    const ticket = await db.query(
      `SELECT 1 FROM app.kot_line kl JOIN app.order_line ol ON ol.id = kl.order_line_id
        WHERE ol.display_name = 'Lassi' AND ol.order_id = (SELECT id FROM app.sales_order WHERE session_id = $1)`, [b.sid]);
    expect(ticket.rowCount).toBe(1);
    await payAndClose(r, { sid: b.sid, billId: supplementary.billId, payable: supplementary.payableMinor });
    expect((await detail(r, supplementary.billId)).bill.status).toBe('settled');
  });

  it('a previous day\'s bill is closed to the till, and open to the manager', async () => {
    const b = await billed(r, [{ menuItemId: r.thali, quantity: 2 }]);
    // Moved to yesterday: the fixture is built to break the rule.
    await db.query(`UPDATE app.bill SET business_date = business_date - 1 WHERE id = $1`, [b.billId]);
    await db.query(`UPDATE app.table_session SET business_date = business_date - 1 WHERE id = $1`, [b.sid]);
    await db.query(`UPDATE app.sales_order SET business_date = business_date - 1 WHERE session_id = $1`, [b.sid]);
    const seen = await detail(r, b.billId);
    expect(seen.bill).toMatchObject({ editState: 'locked', canEdit: false });
    const thali = lineNamed(seen.lines, 'Thali');
    const change = { expectedVersion: seen.bill.version, reason: 'billed two by mistake', remove: [{ lineId: thali.lineId, quantity: 1 }] };
    expect(refused(await revise(r, b.billId, change))).toEqual([403, 'bill_edit_previous_day']);

    const byManager = await revise(r, b.billId, change, r.manager, true);
    ok(byManager);
    const replacement = byManager.body['replacementBill'] as { billId: string; payableMinor: number };
    const row = await db.query<{ business_date: string; authority: string }>(
      `SELECT b.business_date::text, rv.authority FROM app.bill_revision rv JOIN app.bill b ON b.id = rv.replacement_bill_id
        WHERE rv.bill_id = $1`, [b.billId]);
    // Reissued on the bill's own day (yesterday), as a manager edit.
    expect(row.rows[0]!.authority).toBe('manager');
    expect(row.rows[0]!.business_date < (await today(r))).toBe(true);
    await payAndClose(r, { sid: b.sid, billId: replacement.billId, payable: replacement.payableMinor });
  });
});

describe('4. Submit Day Bills locks the day; only a manager reopens it', () => {
  let paid: Billed;

  it('refuses while an order is open, and on figures nobody confirmed', async () => {
    const open = await billed(r, [{ menuItemId: r.thali, quantity: 1 }]);
    const blocked = await http('POST', '/api/t/pos/day/submit', r.till.token, {}, keyed());
    expect(refused(blocked)).toEqual([409, 'day_has_open_orders']);
    await payAndClose(r, open);
    paid = open;

    const review = await http('GET', '/api/t/pos/day', r.till.token);
    ok(review);
    const figures = review.body['figures'] as { billCount: number; payableMinor: number };
    expect(review.body['openOrders']).toBe(0);
    const stale = await http('POST', '/api/t/pos/day/submit', r.till.token,
      { expected: { billCount: figures.billCount + 1, payableMinor: figures.payableMinor } }, keyed());
    expect(refused(stale)).toEqual([409, 'day_changed']);
  });

  it('submits once: a second tap returns the same submission and writes no second row', async () => {
    const review = (await http('GET', '/api/t/pos/day', r.till.token)).body['figures'] as { billCount: number; payableMinor: number };
    const expected = { billCount: review.billCount, payableMinor: review.payableMinor };
    const first = await http('POST', '/api/t/pos/day/submit', r.till.token, { expected }, keyed());
    ok(first);
    expect(first.body).toMatchObject({ state: 'submitted', alreadySubmitted: false });
    const again = await http('POST', '/api/t/pos/day/submit', r.till.token, { expected }, keyed());
    ok(again);
    expect(again.body).toMatchObject({ state: 'submitted', alreadySubmitted: true });
    const rows = await db.query<{ status: string; bill_count: number }>(
      `SELECT status, bill_count FROM app.day_submission WHERE branch_id = $1 AND business_date = $2::date`, [r.branchId, await today(r)]);
    expect(rows.rows).toEqual([{ status: 'submitted', bill_count: expected.billCount }]);
  });

  it('after submission the till edits nothing of that day, and voids no tender', async () => {
    const seen = await detail(r, paid.billId);
    expect(seen.bill).toMatchObject({ editState: 'submitted', canEdit: false });
    const add = await revise(r, paid.billId, { expectedVersion: seen.bill.version, reason: 'add a lassi after day end',
      add: [{ menuItemId: r.lassi, quantity: 1 }] });
    expect(refused(add)).toEqual([403, 'bill_edit_day_submitted']);

    // An order taken after the submission, on the same business day: its money is locked too.
    const late = await billed(r, [{ menuItemId: r.lassi, quantity: 1 }]);
    const taken = await http('POST', `/api/t/pos/bill/${late.billId}/payment`, r.till.token,
      { parts: [{ method: 'card', amountMinor: 1000 }] }, keyed(late.lease));
    ok(taken);
    const tenderId = (taken.body['tenders'] as { tenderId: string }[])[0]!.tenderId;
    const reason = (await db.query<{ id: string }>(
      `SELECT id FROM app.adjustment_reason WHERE tenant_id = $1 AND key = 'bill_corrected'`, [r.tenantId])).rows[0]!.id;
    const voided = await http('POST', `/api/t/pos/bill/${late.billId}/tender/${tenderId}/void`, r.till.token, { reasonId: reason }, keyed(late.lease));
    expect(refused(voided)).toEqual([403, 'bill_edit_day_submitted']);
    await http('POST', `/api/t/pos/bill/${late.billId}/payment`, r.till.token,
      { parts: [{ method: 'cash', cashReceivedMinor: late.payable - 1000 }] }, keyed(late.lease));
    ok(await http('DELETE', `/api/t/pos/session/${late.sid}`, r.till.token, undefined, keyed(late.lease)));
  });

  it('the manager must reopen, with a reason, before editing; the till stays locked out of a reopened day', async () => {
    const seen = await detail(r, paid.billId, r.manager, true);
    const change = { expectedVersion: seen.bill.version, reason: 'thali returned, refunded in cash',
      remove: [{ lineId: lineNamed(seen.lines, 'Thali').lineId, quantity: 1 }] };
    expect(refused(await revise(r, paid.billId, change, r.manager, true))).toEqual([409, 'bill_edit_reopen_first']);

    const date = await today(r);
    expect(refused(await http('POST', `/api/t/admin/days/${date}/reopen`, r.manager, { reason: 'no' }))).toEqual([400, 'day_reopen_reason_required']);
    const reopened = await http('POST', `/api/t/admin/days/${date}/reopen`, r.manager, { reason: 'refund a returned thali' });
    ok(reopened);
    expect(reopened.body).toMatchObject({ state: 'reopened' });
    expect((await detail(r, paid.billId)).bill).toMatchObject({ editState: 'reopened', canEdit: false });

    const tillTry = await revise(r, paid.billId, { ...change, expectedVersion: seen.bill.version });
    expect(refused(tillTry)).toEqual([403, 'bill_edit_day_submitted']);
  });

  it('a manager edit of a paid bill refunds what came off -- a credit note, the payment untouched -- and names the reopening', async () => {
    const order = await billed(r, [{ menuItemId: r.thali, quantity: 1 }, { menuItemId: r.lassi, quantity: 1 }]);
    await payAndClose(r, order);
    const seen = await detail(r, order.billId, r.manager, true);
    const tenders = await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [order.billId]);
    const edited = await revise(r, order.billId, { expectedVersion: seen.bill.version, reason: 'lassi was never served',
      remove: [{ lineId: lineNamed(seen.lines, 'Lassi').lineId, quantity: 1 }], refundMethod: 'cash' }, r.manager, true);
    ok(edited);
    // ₹50 + 5% tax, as the bill charged it.
    expect(edited.body['refund']).toMatchObject({ amountMinor: 5250, method: 'cash' });
    expect((await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [order.billId])).rows).toEqual(tenders.rows);
    const refundRow = await db.query<{ amount_minor: string; taxable_minor: string; tax_minor: string; note: string }>(
      `SELECT amount_minor::text, taxable_minor::text, tax_minor::text, note FROM app.refund WHERE bill_id = $1`, [order.billId]);
    expect(refundRow.rows).toEqual([{ amount_minor: '5250', taxable_minor: '5000', tax_minor: '250', note: 'lassi was never served' }]);
    const revision = await db.query<{ authority: string; day_submission_id: string | null; status: string }>(
      `SELECT rv.authority, rv.day_submission_id, ds.status FROM app.bill_revision rv
         LEFT JOIN app.day_submission ds ON ds.id = rv.day_submission_id WHERE rv.bill_id = $1`, [order.billId]);
    expect(revision.rows).toEqual([{ authority: 'manager', day_submission_id: expect.any(String), status: 'reopened' }]);
    const after = await detail(r, order.billId, r.manager, true);
    expect(after.bill.refundedMinor).toBe(5250);
    expect(lineNamed(after.lines, 'Lassi').remainingQuantity).toBe(0);
  });

  it('the manager submits the day again; the reopening stays on record', async () => {
    const date = await today(r);
    const again = await http('POST', `/api/t/admin/days/${date}/submit`, r.manager, {});
    ok(again);
    expect(again.body).toMatchObject({ state: 'submitted', alreadySubmitted: false });
    const rows = await db.query<{ status: string; reopen_reason: string | null }>(
      `SELECT status, reopen_reason FROM app.day_submission WHERE branch_id = $1 AND business_date = $2::date ORDER BY submitted_at`,
      [r.branchId, date]);
    expect(rows.rows).toEqual([
      { status: 'reopened', reopen_reason: 'refund a returned thali' },
      { status: 'submitted', reopen_reason: null },
    ]);
    // What was handed over is a record: the database refuses to rewrite it, even for the owner role.
    await expect(db.query(`UPDATE app.day_submission SET bill_count = bill_count + 1 WHERE branch_id = $1`, [r.branchId]))
      .rejects.toThrow(/does not change/);
  });
});

describe('5. one restaurant never reaches another\'s bills', () => {
  it('another restaurant\'s manager and till get not-found, and list nothing of ours', async () => {
    const ours = await billed(r, [{ menuItemId: r.thali, quantity: 1 }]);
    const theirRead = await http('GET', `/api/t/admin/bills/${ours.billId}`, other.manager);
    expect(refused(theirRead)).toEqual([404, 'history_bill_unknown']);
    const theirTill = await http('GET', `/api/t/pos/bills/${ours.billId}`, other.till.token);
    expect(refused(theirTill)).toEqual([404, 'history_bill_unknown']);
    const theirEdit = await http('POST', `/api/t/admin/bills/${ours.billId}/revise`, other.manager,
      { expectedVersion: 1, reason: 'not our bill at all', add: [{ menuItemId: other.lassi, quantity: 1 }] });
    expect(refused(theirEdit)).toEqual([404, 'bill_edit_unknown']);
    const list = await http('GET', '/api/t/admin/bills?period=today', other.manager);
    ok(list);
    const ids = (list.body['days'] as { bills: { billId: string }[] }[]).flatMap((d) => d.bills).map((b) => b.billId);
    expect(ids).not.toContain(ours.billId);
    // Untouched by the attempt.
    expect((await db.query(`SELECT 1 FROM app.bill_revision WHERE bill_id = $1`, [ours.billId])).rowCount).toBe(0);
    await payAndClose(r, ours);
  });
});

describe('6. Allow POS Bill Editing: the manager lets the till edit today\'s submitted bills, and takes it back', () => {
  // A restaurant of its own, so the day's state is this section's alone.
  let g: Place;
  let date: string;
  let paid: Billed;
  let grantId: string;
  const enable = (reason: unknown, token = g.manager, on = date) =>
    http('POST', `/api/t/admin/days/${on}/pos-editing/enable`, token, { reason });
  const disable = (token = g.manager, on = date) => http('POST', `/api/t/admin/days/${on}/pos-editing/disable`, token, {});
  const addLassi = async (billId: string) => revise(g, billId, {
    expectedVersion: (await detail(g, billId)).bill.version, reason: 'guest asked for a lassi',
    add: [{ menuItemId: g.lassi, quantity: 1 }],
  });
  const grants = async () => (await db.query<{ id: string; status: string; reason: string; disabled_by_user_id: string | null }>(
    `SELECT id, status, reason, disabled_by_user_id FROM app.pos_edit_grant WHERE tenant_id = $1 ORDER BY enabled_at`,
    [g.tenantId])).rows;

  beforeAll(async () => {
    g = await place();
    date = await today(g);
  }, 120_000);

  it('only a manager switches it, only for today, and only once the day is submitted', async () => {
    // The till holds no key for it, whichever way.
    expect(refused(await enable('till lets itself edit', g.till.token))).toEqual([403, 'forbidden']);
    expect(refused(await disable(g.till.token))).toEqual([403, 'forbidden']);
    // Not submitted yet: the till already edits today, so there is nothing to allow.
    expect(refused(await enable('nothing to allow yet'))).toEqual([409, 'pos_editing_day_open']);

    paid = await billed(g, [{ menuItemId: g.thali, quantity: 2 }]);
    await payAndClose(g, paid);
    ok(await http('POST', '/api/t/pos/day/submit', g.till.token, {}, keyed()));

    // Never a previous day, and never one that has not come.
    const yesterday = (await db.query<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [date])).rows[0]!.d;
    expect(refused(await enable('open yesterday to the till', g.manager, yesterday))).toEqual([409, 'pos_editing_today_only']);
    const tomorrow = (await db.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [date])).rows[0]!.d;
    expect(refused(await enable('open tomorrow to the till', g.manager, tomorrow))).toEqual([400, 'business_date_invalid']);
    // Switching on needs a reason.
    expect(refused(await enable('no'))).toEqual([400, 'pos_editing_reason_required']);
    expect(await grants()).toEqual([]);
  });

  it('OFF after submission: the till is refused, and its screens say the bill is locked', async () => {
    const seen = await detail(g, paid.billId);
    expect(seen.bill).toMatchObject({ editState: 'submitted', canEdit: false });
    expect(refused(await addLassi(paid.billId))).toEqual([403, 'bill_edit_day_submitted']);
    const day = await http('GET', '/api/t/pos/day', g.till.token);
    expect(day.body).toMatchObject({ state: 'submitted', posEditing: null });
  });

  it('ON: the till edits today\'s bills again, and each edit names the manager\'s grant', async () => {
    const on = await enable('guest came back for a lassi');
    ok(on);
    expect(on.body).toMatchObject({ state: 'submitted', posEditing: { on: true, enabledBy: 'Owner', reason: 'guest came back for a lassi' } });
    grantId = (on.body['posEditing'] as { grantId: string }).grantId;
    // A second tap is the same grant, not a second one.
    const again = await enable('tapped twice by accident');
    ok(again);
    expect((again.body['posEditing'] as { grantId: string }).grantId).toBe(grantId);
    expect((await grants()).map((x) => x.status)).toEqual(['on']);

    expect((await detail(g, paid.billId)).bill).toMatchObject({ editState: 'granted', canEdit: true });
    // The grant opens the day to the TILL; a manager still reopens a submitted day.
    expect((await detail(g, paid.billId, g.manager, true)).bill).toMatchObject({ editState: 'granted', canEdit: false });

    const tenders = await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [paid.billId]);
    const edited = await addLassi(paid.billId);
    ok(edited);
    const supplementary = edited.body['supplementaryBill'] as { billId: string; payableMinor: number };
    // ₹50 + 5% = ₹52.50, priced by the server from the menu, paid to the nearest rupee.
    expect(supplementary.payableMinor).toBe(5300);
    expect((await db.query(`SELECT id, amount_minor FROM app.tender WHERE bill_id = $1 ORDER BY id`, [paid.billId])).rows)
      .toEqual(tenders.rows);
    const submissionId = (await db.query<{ id: string }>(
      `SELECT id FROM app.day_submission WHERE branch_id = $1 AND status = 'submitted'`, [g.branchId])).rows[0]!.id;
    const revision = await db.query(
      `SELECT authority, day_submission_id, pos_edit_grant_id, edited_by_user_id FROM app.bill_revision WHERE bill_id = $1`,
      [paid.billId]);
    expect(revision.rows).toEqual([
      { authority: 'pos', day_submission_id: submissionId, pos_edit_grant_id: grantId, edited_by_user_id: g.till.userId },
    ]);
    const history = (await detail(g, paid.billId)).revisions as unknown as { authority: string; allowedBy: unknown; reopened: unknown }[];
    expect(history).toEqual([expect.objectContaining({
      authority: 'pos', reopened: null, allowedBy: { by: 'Owner', at: expect.any(String), reason: 'guest came back for a lassi' },
    })]);
    await payAndClose(g, { sid: paid.sid, billId: supplementary.billId, payable: supplementary.payableMinor });
  });

  it('OFF again: the very next till edit is refused, with no new sign-in, and the decision stays on record', async () => {
    const off = await disable();
    ok(off);
    expect(off.body).toMatchObject({ posEditing: { on: false, grantId, disabledBy: 'Owner', disabledAt: expect.any(String) } });
    expect((await detail(g, paid.billId)).bill).toMatchObject({ editState: 'submitted', canEdit: false });
    // Same till token as the edit that just worked.
    expect(refused(await addLassi(paid.billId))).toEqual([403, 'bill_edit_day_submitted']);
    // Switching off twice changes nothing.
    ok(await disable());
    const rows = await grants();
    expect(rows).toEqual([{ id: grantId, status: 'off', reason: 'guest came back for a lassi', disabled_by_user_id: expect.any(String) }]);

    const audit = await db.query<{ action: string; actor_user_id: string; target_type: string }>(
      `SELECT action, actor_user_id, target_type FROM app.tenant_audit_log
        WHERE tenant_id = $1 AND action LIKE 'day.pos_editing.%' ORDER BY occurred_at`, [g.tenantId]);
    expect(audit.rows.map((a) => a.action)).toEqual([
      'day.pos_editing.enabled', 'day.pos_editing.enabled', 'day.pos_editing.disabled', 'day.pos_editing.disabled',
    ]);
    expect(new Set(audit.rows.map((a) => a.actor_user_id))).toEqual(new Set([rows[0]!.disabled_by_user_id]));

    // Who allowed it, when and why is a record; a switched-off grant stays off.
    await expect(db.query(`UPDATE app.pos_edit_grant SET reason = 'rewritten later' WHERE id = $1`, [grantId]))
      .rejects.toThrow(/does not change/);
    await expect(db.query(`UPDATE app.pos_edit_grant SET status = 'on', disabled_at = NULL, disabled_by_user_id = NULL WHERE id = $1`, [grantId]))
      .rejects.toThrow(/stays off/);
    // And a till edit of a submitted day that names no grant is refused by the table itself.
    await expect(db.query(
      `INSERT INTO app.bill_revision (id, tenant_id, branch_id, business_date, bill_id, authority, day_submission_id,
         reason, edited_by_user_id, before, after, before_payable_minor, after_payable_minor)
       SELECT gen_random_uuid(), tenant_id, branch_id, business_date, bill_id, 'pos', day_submission_id,
              reason, edited_by_user_id, before, after, before_payable_minor, after_payable_minor
         FROM app.bill_revision WHERE pos_edit_grant_id = $1`, [grantId]))
      .rejects.toThrow(/bill_revision_pos_on_submitted_day_needs_grant/);
  });

  it('a previous day\'s bill never opens to the till, even with today\'s grant on', async () => {
    const old = await billed(g, [{ menuItemId: g.thali, quantity: 1 }]);
    await payAndClose(g, old);
    // Moved to yesterday: the fixture is built to break the rule.
    await db.query(`UPDATE app.bill SET business_date = business_date - 1 WHERE id = $1`, [old.billId]);
    await db.query(`UPDATE app.table_session SET business_date = business_date - 1 WHERE id = $1`, [old.sid]);
    await db.query(`UPDATE app.sales_order SET business_date = business_date - 1 WHERE session_id = $1`, [old.sid]);
    ok(await enable('second correction of the day'));
    expect((await grants()).map((x) => x.status)).toEqual(['off', 'on']);

    expect((await detail(g, old.billId)).bill).toMatchObject({ editState: 'locked', canEdit: false });
    expect(refused(await addLassi(old.billId))).toEqual([403, 'bill_edit_previous_day']);
    // Today's bill, under the same grant, still opens.
    expect((await detail(g, paid.billId)).bill).toMatchObject({ editState: 'granted', canEdit: true });
  });

  it('Submit Day Bills again starts with it OFF: the grant belonged to the submission it relaxed', async () => {
    const submitted = await http('POST', '/api/t/pos/day/submit', g.till.token, {}, keyed());
    ok(submitted);
    expect(submitted.body).toMatchObject({ state: 'submitted', alreadySubmitted: false, posEditing: null });
    expect((await detail(g, paid.billId)).bill).toMatchObject({ editState: 'submitted', canEdit: false });
    expect(refused(await addLassi(paid.billId))).toEqual([403, 'bill_edit_day_submitted']);
  });

  it('another restaurant\'s manager switches only their own day, and never ours', async () => {
    const before = await grants();
    // Their day is not submitted; the branch is theirs, from their token, whatever the date names.
    expect(refused(await enable('reach into another restaurant', other.manager))).toEqual([409, 'pos_editing_day_open']);
    expect(refused(await disable(other.manager))).toEqual([409, 'pos_editing_day_open']);
    expect(await grants()).toEqual(before);
  });
});
