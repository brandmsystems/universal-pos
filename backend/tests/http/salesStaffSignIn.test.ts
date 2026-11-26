import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planCache } from '../helpers/plans.js';
import { buildServer } from '../../src/app.js';
import { resetRegistry } from '../../src/core/middleware/routeRegistry.js';
import { signToken } from '../../src/modules/auth/jwt.js';
import { hashSecret } from '../../src/modules/auth/deviceAuth.js';
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
 * The Sales person who sold the restaurant sets every sign-in (DECIDED
 * 2026-10-16): the manager's username and password, and a staff member's
 * username and 4-digit till PIN. Staff have no password (DECIDED 2026-10-17).
 * On the till, Staff Login lists the staff (never a manager) and the tapped
 * person types their PIN; the manager signs in with username and password.
 * The manager screens have no credential route.
 */

const KEY = 'sales-staff-pins-signing-key-long-enough-hs256';
const FINGERPRINT = `till-${randomUUID()}`;

let db: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let otherRep: string;
let readOnly: string;
let superAdmin: string;
let basicVersion: string;

interface Restaurant { tenantId: string; slug: string; ownerEmail: string; token: string; ownerId: string; branchId: string }
let r: Restaurant;

async function http(method: string, url: string, token: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method: method as never, url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function platform(sub: string, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub, platform_role: role, iat: now, exp: now + 600 }, KEY);
}

async function platformUser(role: string): Promise<string> {
  const id = randomUUID();
  const roleId = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = $1`, [role])).rows[0]!.id;
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Pins Platform', $3)`, [id, `pins+${id}@platform.test`, roleId]);
  return id;
}

async function restaurant(): Promise<Restaurant> {
  const slug = `pins-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner@${slug}.test`;
  const made = await http('POST', '/api/platform/tenants', platform(rep, 'sales'), {
    slug, name: 'Pins Place', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail, ownerName: 'Pins Owner',
    firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
  }, { 'idempotency-key': `idem-${randomUUID()}` });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'pins-owner-2026' });
  const signedIn = await http('POST', `/api/auth/${slug}/login`, null, { login: ownerEmail, password: 'pins-owner-2026' });
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  const tenantId = made.body['tenantId'] as string;
  return {
    tenantId, slug, ownerEmail, token: signedIn.body['accessToken'] as string, ownerId: made.body['ownerUserId'] as string,
    branchId: (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id,
  };
}

const staffUrl = (tail = '') => `/api/platform/tenants/${r.tenantId}/staff${tail}`;
/** On the till this suite's manager set up (beforeAll): the POS sign-in. */
const tillSignIn = (login: string, password: string) =>
  http('POST', `/api/auth/${r.slug}/till`, null, { login, password, deviceFingerprint: FINGERPRINT });
/** A staff member's PIN on that till. */
const pin = (userId: string, value: string) =>
  http('POST', `/api/auth/${r.slug}/pin`, null, { userId, pin: value, deviceFingerprint: FINGERPRINT, branchId: r.branchId });

let asha: string;

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  rep = await platformUser('sales');
  otherRep = await platformUser('sales');
  readOnly = await platformUser('read_only');
  superAdmin = await platformUser('super_admin');
  basicVersion = (await ensureStandardPlans(db, rep)).get('basic')!;

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((x) => !isUnserved(x.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: planCache('basic') },
    new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await restaurant();
  // The manager makes this browser the till, with their email and password.
  const till = await http('POST', `/api/auth/${r.slug}/till`, null,
    { login: r.ownerEmail, password: 'pins-owner-2026', deviceFingerprint: FINGERPRINT, deviceName: 'Counter' });
  expect(till.status, JSON.stringify(till.body)).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await db?.end();
});

describe('the Sales person adds staff with a username and a PIN, and no password', () => {
  it('adds a person with a hashed PIN only, and never writes it to the audit log', async () => {
    const made = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Asha Rao', username: 'asha', pin: '5927', access: 'pos' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ fullName: 'Asha Rao', staffCode: 'ASHA', access: 'pos' });
    asha = made.body['userId'] as string;

    const credentials = await db.query<{ type: string; secret_hash: string }>(
      `SELECT type, secret_hash FROM app.credential WHERE user_id = $1 AND status = 'active'`, [asha]);
    expect(credentials.rows.map((c) => c.type)).toEqual(['pin']);
    for (const c of credentials.rows) expect(c.secret_hash).toMatch(/^\$argon2id\$/);

    const roles = await db.query<{ key: string; branch_id: string | null }>(
      `SELECT r.key, m.branch_id FROM app.membership m JOIN app.role r ON r.id = m.role_id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY r.key`, [asha]);
    expect(roles.rows).toEqual([{ key: 'cashier', branch_id: r.branchId }, { key: 'waiter', branch_id: r.branchId }]);

    const audit = await db.query<{ actor: string; row: string }>(
      `SELECT actor_platform_user_id::text AS actor, row_to_json(l)::text AS row
         FROM platform.platform_audit_log l WHERE target_id = $1 AND action = 'tenant.staff.created'`, [r.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor).toBe(rep);
    expect(audit.rows[0]!.row).not.toContain('5927');
  });

  it('refuses a bad username, a missing or trivial PIN, a password, a taken username and a manager access level', async () => {
    for (const [body, detail] of [
      [{ username: 'ra vi', pin: '6038' }, 'username'],
      [{ username: '', pin: '6038' }, 'username'],
      [{ username: 'RAVI' }, 'PIN'],
      [{ username: 'RAVI', pin: '1234' }, 'PIN'],
      [{ username: 'RAVI', pin: '59a7' }, 'PIN'],
    ] as const) {
      const refused = await http('POST', staffUrl(), platform(rep, 'sales'), { fullName: 'Ravi', access: 'pos', ...body });
      expect([refused.status, refused.body['error']], JSON.stringify(body)).toEqual([422, 'tenant_staff_invalid']);
      expect(String(refused.body['detail'])).toContain(detail);
    }
    // Refused, not dropped: a caller sending a password would believe it was set.
    const withPassword = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Ravi', username: 'RAVI', password: 'ravi-pass-2026', pin: '6038', access: 'pos' });
    expect([withPassword.status, withPassword.body['error']]).toEqual([409, 'tenant_staff_uses_pin']);
    const taken = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Another Asha', username: 'ASHA', pin: '6038', access: 'pos' });
    expect([taken.status, taken.body['error']]).toEqual([409, 'staff_identifier_taken']);
    const level = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Ravi', username: 'RAVI', pin: '6038', access: 'owner' });
    expect([level.status, level.body['error']]).toEqual([422, 'tenant_staff_invalid']);
  });
});

describe('staff sign in on the POS with their PIN; a password signs them in nowhere', () => {
  it('the till session is staff\'s: no manager screens', async () => {
    const token = (await pin(asha, '5927')).body['accessToken'] as string;
    const me = await http('GET', '/api/t/me', token);
    expect(me.body['screens']).toMatchObject({ admin: false, billing: true });
    expect((await http('GET', '/api/t/admin/access', token)).status).toBe(403);
  });

  it('a password for a staff username is refused like a wrong one, on the till and the manager login', async () => {
    const onTill = await tillSignIn('ASHA', 'any-pass-2026');
    const unknown = await tillSignIn('NOBODY', 'any-pass-2026');
    expect([onTill.status, onTill.body['error']]).toEqual([unknown.status, unknown.body['error']]);
    expect(onTill.status).toBe(401);
    const office = await http('POST', `/api/auth/${r.slug}/login`, null, { login: 'ASHA', password: 'any-pass-2026', audience: 'manager' });
    expect(office.status).toBe(401);
    expect(office.body['accessToken']).toBeUndefined();
  });

  it('on Basic a staff PIN on a new browser makes it a till, within the plan\'s two', async () => {
    const before = Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.device WHERE tenant_id = $1 AND status = 'active'`, [r.tenantId])).rows[0]!.n);
    expect(before).toBe(1);
    const fresh = await http('POST', `/api/auth/${r.slug}/pin`, null,
      { userId: asha, pin: '5927', deviceFingerprint: `new-${randomUUID()}` });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body['accessToken']).toEqual(expect.any(String));
    const third = await http('POST', `/api/auth/${r.slug}/pin`, null,
      { userId: asha, pin: '5927', deviceFingerprint: `third-${randomUUID()}` });
    expect([third.status, third.body['error']]).toEqual([402, 'upgrade_required']);
    // Back to one till, so the suite below sees the restaurant as it was.
    await db.query(`UPDATE app.device SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
                      WHERE tenant_id = $1 AND id = $3`, [r.tenantId, r.ownerId, fresh.body['deviceId']]);
  });

});

describe('Staff Login on the till: the staff cards, then the PIN', () => {
  const tillNames = async (fingerprint = FINGERPRINT) => http('GET', `/api/public/restaurants/${r.slug}/till/staff`, null, undefined,
    { 'x-device-fingerprint': fingerprint });

  it('lists the staff by name, and never the manager', async () => {
    const listed = await tillNames();
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const names = (listed.body['staff'] as { fullName: string }[]).map((s) => s.fullName);
    expect(names).toContain('Asha Rao');
    expect(names).not.toContain('Pins Owner');
    // The manager holds the cashier membership too -- the role that would list them -- and still is not listed.
    await db.query(
      `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, 'pin', $4)`,
      [randomUUID(), r.tenantId, r.ownerId, await hashSecret('4816')]);
    const again = (await tillNames()).body['staff'] as { userId: string }[];
    expect(again.map((s) => s.userId)).not.toContain(r.ownerId);
  });

  it('lists staff without a PIN too, flagged, so the till can say so; the PIN pad is only for those with one', async () => {
    const made = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'No Pin Yet', username: 'NOPIN', pin: '6038', access: 'pos' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    // An account whose PIN was revoked: the route never makes one without.
    await db.query(`UPDATE app.credential SET status = 'revoked', revoked_at = now() WHERE user_id = $1`, [made.body['userId']]);
    const listed = (await tillNames()).body['staff'] as { fullName: string; hasPin: boolean }[];
    expect(listed.find((s) => s.fullName === 'No Pin Yet')).toMatchObject({ hasPin: false });
    expect(listed.find((s) => s.fullName === 'Asha Rao')).toMatchObject({ hasPin: true });
    // Names and the flag only -- no username, no contact.
    expect(Object.keys(listed[0]!).sort()).toEqual(['fullName', 'hasPin', 'userId']);
    // Switched off again so the four-user count below is unchanged.
    expect((await http('POST', staffUrl(`/${made.body['userId'] as string}/active`), platform(rep, 'sales'), { active: false })).status).toBe(200);
  });

  it('a browser that is not a till yet still gets the staff cards (the restaurant\'s one branch)', async () => {
    const named = await tillNames(`not-a-till-${randomUUID()}`);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect((named.body['staff'] as { fullName: string }[]).map((s) => s.fullName)).toContain('Asha Rao');
    const bare = await http('GET', `/api/public/restaurants/${r.slug}/till/staff`, null);
    expect(bare.status).toBe(200);
    expect((bare.body['staff'] as { fullName: string }[]).map((s) => s.fullName)).not.toContain('Pins Owner');
  });

  it('a correct PIN on a new browser makes it the till, and says which; a wrong PIN makes nothing', async () => {
    const devices = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.device WHERE tenant_id = $1 AND status = 'active'`, [r.tenantId])).rows[0]!.n);
    const before = await devices();
    const fingerprint = `pin-new-${randomUUID()}`;
    const wrong = await http('POST', `/api/auth/${r.slug}/pin`, null, { userId: asha, pin: '0482', deviceFingerprint: fingerprint });
    expect(wrong.status).toBe(401);
    expect(await devices()).toBe(before);
    const right = await http('POST', `/api/auth/${r.slug}/pin`, null, { userId: asha, pin: '5927', deviceFingerprint: fingerprint });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(right.body).toMatchObject({ userId: asha, deviceId: expect.any(String), branchId: r.branchId });
    expect(await devices()).toBe(before + 1);
    // Signing in again on it uses the same till.
    const again = await http('POST', `/api/auth/${r.slug}/pin`, null, { userId: asha, pin: '5927', deviceFingerprint: fingerprint });
    expect(again.body['deviceId']).toBe(right.body['deviceId']);
    await db.query(`UPDATE app.device SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
                      WHERE tenant_id = $1 AND id = $3`, [r.tenantId, r.ownerId, right.body['deviceId']]);
    // A till taken out of use stays refused: a PIN does not re-make it.
    const revoked = await http('POST', `/api/auth/${r.slug}/pin`, null, { userId: asha, pin: '5927', deviceFingerprint: fingerprint });
    expect([revoked.status, revoked.body['error']]).toEqual([401, 'tablet_not_set_up']);
    expect((await tillNames(fingerprint)).status).toBe(401);
  });

  it('the tapped person signs in with their PIN; a wrong PIN does not; a reset PIN replaces the old at once', async () => {
    expect((await pin(asha, '5928')).status).toBe(401);
    const right = await pin(asha, '5927');
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(right.body['userId']).toBe(asha);
    const reset = await http('POST', staffUrl(`/${asha}/pin`), platform(rep, 'sales'), { pin: '7149' });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect((await pin(asha, '5927')).status).toBe(401);
    expect((await pin(asha, '7149')).status).toBe(200);
  });

  it('the Sales person never sets a manager\'s PIN', async () => {
    const refused = await http('POST', staffUrl(`/${r.ownerId}/pin`), platform(rep, 'sales'), { pin: '6038' });
    expect([refused.status, refused.body['error']]).toEqual([409, 'tenant_staff_is_manager']);
  });
});

describe('the Sales person sets every sign-in, the manager\'s included', () => {
  it('a staff member is given no password; their username is changed by an edit, the PIN untouched', async () => {
    const set = await http('POST', staffUrl(`/${asha}/credentials`), platform(rep, 'sales'),
      { username: 'ASHAR', password: 'asha-new-2026' });
    expect([set.status, set.body['error']]).toEqual([409, 'tenant_staff_uses_pin']);
    const passwords = await db.query(`SELECT 1 FROM app.credential WHERE user_id = $1 AND type = 'password'`, [asha]);
    expect(passwords.rowCount).toBe(0);

    const renamed = await http('PATCH', staffUrl(`/${asha}`), platform(rep, 'sales'), { username: 'ashar' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const code = await db.query<{ employee_code: string }>(`SELECT employee_code FROM app.app_user WHERE id = $1`, [asha]);
    expect(code.rows[0]!.employee_code).toBe('ASHAR');
    expect((await pin(asha, '7149')).status).toBe(200);
  });

  it('the manager\'s username and password: set by the Sales person, the setup link revoked, the old password dead', async () => {
    // A setup link still pending from provisioning would let the manager choose a password themselves.
    const link = await http('POST', `/api/platform/tenants/${r.tenantId}/owner-invite`, platform(rep, 'sales'),
      { reason: 'The manager asked for a new password' });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const token = link.body['inviteToken'] ?? link.body['token'];
    expect(token).toEqual(expect.any(String));
    const set = await http('POST', staffUrl(`/${r.ownerId}/credentials`), platform(rep, 'sales'),
      { username: 'meera', password: 'meera-pass-2026' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const pending = await db.query(`SELECT 1 FROM platform.tenant_owner_invite WHERE tenant_id = $1 AND status = 'pending'`, [r.tenantId]);
    expect(pending.rowCount).toBe(0);
    const redeemed = await http('POST', '/api/auth/invite/accept', null, { token, password: 'manager-own-2026' });
    expect(redeemed.status).not.toBe(200);

    const old = await http('POST', `/api/auth/${r.slug}/login`, null, { login: r.ownerEmail, password: 'pins-owner-2026', audience: 'manager' });
    expect(old.status).toBe(401);
    const office = await http('POST', `/api/auth/${r.slug}/login`, null, { login: 'MEERA', password: 'meera-pass-2026', audience: 'manager' });
    expect([office.status, office.body['lands']]).toEqual([200, 'admin']);
    // On the till the same username and password only confirm the till: a manager gets no POS session.
    const onTill = await tillSignIn('MEERA', 'meera-pass-2026');
    expect(onTill.status).toBe(200);
    expect(onTill.body['tillOnly']).toBe(true);
    expect(onTill.body['accessToken']).toBeUndefined();
    // An existing account's email still signs in -- the username is added, nothing else is taken away.
    expect((await http('POST', `/api/auth/${r.slug}/login`, null,
      { login: r.ownerEmail, password: 'meera-pass-2026', audience: 'manager' })).status).toBe(200);
  });

  it('a manager set up by the create form signs in: the setup link was never redeemed', async () => {
    // What the form does: create, then set the sign-in. Nobody opens a setup link.
    const slug = `pins-${randomUUID().slice(0, 8)}`;
    const made = await http('POST', '/api/platform/tenants', platform(rep, 'sales'), {
      slug, name: 'Form Place', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `owner@${slug}.test`, ownerName: 'Form Owner',
      firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
    }, { 'idempotency-key': `idem-${randomUUID()}` });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const tenantId = made.body['tenantId'] as string;
    const ownerId = made.body['ownerUserId'] as string;
    const before = await db.query<{ status: string }>(`SELECT status FROM app.app_user WHERE id = $1`, [ownerId]);
    expect(before.rows[0]!.status).toBe('invited');

    const set = await http('POST', `/api/platform/tenants/${tenantId}/staff/${ownerId}/credentials`, platform(rep, 'sales'),
      { username: 'formowner', password: 'form-owner-2026' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const signedIn = await http('POST', `/api/auth/${slug}/login`, null,
      { login: 'FORMOWNER', password: 'form-owner-2026', audience: 'manager' });
    expect([signedIn.status, signedIn.body['lands']], JSON.stringify(signedIn.body)).toEqual([200, 'admin']);

    // Only an invitation is completed: a manager someone switched off is not switched back on by a new password.
    await db.query(`UPDATE app.app_user SET status = 'disabled' WHERE tenant_id = $1 AND id = $2`, [tenantId, ownerId]);
    const again = await http('POST', `/api/platform/tenants/${tenantId}/staff/${ownerId}/credentials`, platform(rep, 'sales'),
      { username: 'formowner', password: 'form-owner-2027' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const after = await db.query<{ status: string }>(`SELECT status FROM app.app_user WHERE id = $1`, [ownerId]);
    expect(after.rows[0]!.status).toBe('disabled');
    const refused = await http('POST', `/api/auth/${slug}/login`, null,
      { login: 'FORMOWNER', password: 'form-owner-2027', audience: 'manager' });
    expect([refused.status, refused.body['error']]).toEqual([401, 'authentication_failed']);
    // Which refusal: the answer is uniform, the attempt log is not.
    const reason = await db.query<{ reason: string }>(
      `SELECT reason FROM platform.auth_attempt WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [tenantId]);
    expect(reason.rows[0]!.reason).toBe('user_inactive');
  });

  it('the audit row names the Sales person and holds no password', async () => {
    const audit = await db.query<{ row: string }>(
      `SELECT row_to_json(l)::text AS row FROM platform.platform_audit_log l
        WHERE target_id = $1 AND action = 'tenant.staff.credentials_set'`, [r.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.row).not.toContain('meera-pass-2026');
  });

  it('the manager screens have no credential route at all', async () => {
    const office = (await http('POST', `/api/auth/${r.slug}/login`, null,
      { login: 'MEERA', password: 'meera-pass-2026', audience: 'manager' })).body['accessToken'] as string;
    for (const [method, url] of [
      ['POST', '/api/t/admin/access/me/pin'], ['POST', '/api/t/admin/staff'], ['POST', '/api/t/admin/staff/accounts'],
      ['POST', `/api/t/admin/access/${asha}/reset-pin`], ['PATCH', `/api/t/admin/users/${asha}`],
    ] as const) {
      expect((await http(method, url, office, {})).status, `${method} ${url}`).toBe(404);
    }
  });

  it('only at a restaurant they sold; a Super Admin anywhere; read-only nowhere', async () => {
    const stranger = await http('POST', staffUrl(`/${r.ownerId}/credentials`), platform(otherRep, 'sales'),
      { username: 'MEERA', password: 'stolen-pass-2026' });
    expect([stranger.status, stranger.body['error']]).toEqual([404, 'tenant_staff_unknown']);
    const viewer = await http('POST', staffUrl(`/${r.ownerId}/credentials`), platform(readOnly, 'read_only'),
      { username: 'MEERA', password: 'stolen-pass-2026' });
    expect(viewer.status).toBe(403);
    expect((await http('GET', staffUrl(), platform(superAdmin, 'super_admin'))).status).toBe(200);
    // Neither changed anything.
    expect((await http('POST', `/api/auth/${r.slug}/login`, null,
      { login: 'MEERA', password: 'meera-pass-2026', audience: 'manager' })).status).toBe(200);
  });
});

describe('switching off, and the four-user limit', () => {
  it('a switched-off person cannot sign in; switching back restores them', async () => {
    const off = await http('POST', staffUrl(`/${asha}/active`), platform(rep, 'sales'), { active: false });
    expect([off.status, off.body['status']]).toEqual([200, 'disabled']);
    expect((await pin(asha, '7149')).status).not.toBe(200);
    const on = await http('POST', staffUrl(`/${asha}/active`), platform(rep, 'sales'), { active: true });
    expect([on.status, on.body['status']]).toEqual([200, 'active']);
    expect((await pin(asha, '7149')).status).toBe(200);
  });

  it('Basic is four users, the manager included: the fifth is refused, and switching on over it too', async () => {
    for (const name of ['Ravi', 'Meena']) {
      const made = await http('POST', staffUrl(), platform(rep, 'sales'),
        { fullName: name, username: name, pin: '6038', access: 'orders' });
      expect(made.status, JSON.stringify(made.body)).toBe(200);
    }
    const fifth = await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Five', username: 'FIVE', pin: '6038', access: 'billing' });
    expect([fifth.status, fifth.body['error']]).toEqual([402, 'upgrade_required']);
    const listed = await http('GET', staffUrl(), platform(rep, 'sales'));
    expect([listed.body['used'], listed.body['limit']]).toEqual([4, 4]);

    expect((await http('POST', staffUrl(`/${asha}/active`), platform(rep, 'sales'), { active: false })).status).toBe(200);
    expect((await http('POST', staffUrl(), platform(rep, 'sales'),
      { fullName: 'Four', username: 'FOUR', pin: '6038', access: 'billing' })).status).toBe(200);
    const back = await http('POST', staffUrl(`/${asha}/active`), platform(rep, 'sales'), { active: true });
    expect([back.status, back.body['error']]).toEqual([402, 'upgrade_required']);
  });

  it('editing changes the name and what they can use, and keeps the history', async () => {
    const meena = (await db.query<{ id: string }>(
      `SELECT id FROM app.app_user WHERE tenant_id = $1 AND full_name = 'Meena'`, [r.tenantId])).rows[0]!.id;
    const edited = await http('PATCH', staffUrl(`/${meena}`), platform(rep, 'sales'), { fullName: 'Meena K', access: 'billing' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const memberships = await db.query<{ key: string; status: string }>(
      `SELECT r.key, m.status FROM app.membership m JOIN app.role r ON r.id = m.role_id WHERE m.user_id = $1 ORDER BY m.status, r.key`,
      [meena]);
    expect(memberships.rows).toEqual([{ key: 'cashier', status: 'active' }, { key: 'waiter', status: 'revoked' }]);
  });

  it('the manager\'s access is still not the Sales person\'s: no edit, no switch-off', async () => {
    const off = await http('POST', staffUrl(`/${r.ownerId}/active`), platform(rep, 'sales'), { active: false });
    expect([off.status, off.body['error']]).toEqual([409, 'tenant_staff_is_manager']);
    const edit = await http('PATCH', staffUrl(`/${r.ownerId}`), platform(rep, 'sales'), { access: 'pos' });
    expect([edit.status, edit.body['error']]).toEqual([409, 'tenant_staff_is_manager']);
  });
});
