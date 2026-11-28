import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { buildServer } from '../../src/server/app.js';
import { resetRegistry, type RouteDefinition } from '../../src/middleware/routeRegistry.js';
import { allRoutes } from '../../src/routes/index.js';
import { authHandlers } from '../../src/routes/handlers/auth.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { syncHandlers } from '../../src/routes/handlers/sync.js';
import { withTenantTransaction } from '../../src/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/database/tenantContext.js';
import { hashSecret, revokeDevice } from '../../src/modules/authentication/deviceAuth.js';
import { checkPlane } from '../../src/middleware/security/planeGuards.js';
import { verifyToken } from '../../src/modules/authentication/jwt.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { mergeHandlers } from '../../src/routes/lookup.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { staffHandlers } from '../../src/routes/handlers/staff.js';
import { reportHandlers } from '../../src/routes/handlers/reports.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { planCache } from '../helpers/plans.js';

/**
 * The pre-auth surface, driven through the real server.
 *
 * ###########################################################################
 * THE POOL IS THE APP ROLE, NOT THE OWNER, AND THAT IS THE POINT.
 *
 * The production registrar takes a connection from the app pool, and the app
 * role is NOBYPASSRLS. If `platform.tenant` were not readable by it, or
 * `platform.auth_attempt` not insertable, every login would fail in production
 * and pass in a test that used the owner pool. That is the shape of defect this
 * whole file exists to refuse: a login path proven against a role nobody logs in
 * with.
 * ###########################################################################
 */

const JWT_KEY = 'auth-surface-test-key';
const PASSWORD = 'correct-horse-battery-staple';
const PIN = '4816';

let owner: pg.Client;
/** The app-role pool the server runs on. */
let appPool: pg.Pool;
/** An owner pool, for fixtures only -- never for the server. */
let ownerPool: pg.Pool;

let tenantId: string;
let slug: string;
let branchId: string;
let userId: string;
let email: string;

function ctx(): TenantContext {
  return peekTenantContext()!;
}

function server(): ReturnType<typeof buildServer> {
  resetRegistry();
  const handlers: Record<string, RouteDefinition['handler']> = {
    ...mergeHandlers(
      posHandlers(), syncHandlers(),
      adminHandlers(), staffHandlers(), reportHandlers(),
      platformHandlers(JWT_KEY), authHandlers(JWT_KEY)),
  };
  const routes = allRoutes(handlers).filter((r) => r.plane === 'public');
  const served = new Set(routes.map((r) => `${r.method} ${r.url}`));
  return buildServer({ pool: appPool, jwtKey: JWT_KEY, entitlements: planCache(), routes }, served);
}

async function attempts(where: string, params: readonly unknown[] = []): Promise<
  ReadonlyArray<Record<string, unknown>>
> {
  const result = await owner.query<Record<string, unknown>>(
    `SELECT method, outcome, reason, tenant_id, claimed_subject, resolved_user_id,
            branch_id, device_fingerprint
       FROM platform.auth_attempt WHERE ${where} ORDER BY occurred_at DESC`,
    [...params],
  );
  return result.rows;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });

  await seedPlatformAuthz(owner);
  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3)`,
    [superAdminId, `auth+${superAdminId}@platform.test`, roleId]);

  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'auth_plan', 'Auth Plan')
     ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key = 'auth_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, 1, 100000, 'INR', 'monthly', now())
     ON CONFLICT (plan_id, version) DO NOTHING`, [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id = $1 AND version = 1`,
    [planId])).rows[0]!.id;

  const key = `auth-${randomUUID()}`;
  slug = `a${key.slice(5, 13)}`;
  email = `${key}@owner.test`;
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    const result = await provisionTenant(client, {
      idempotencyKey: key, slug, name: 'Auth Probe', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Owner',
      firstBranchName: 'Main', planVersionId, taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = result.tenantId;
    branchId = result.firstBranchId;
    userId = result.ownerUserId;
  } finally {
    client.release();
  }

  await owner.query(`UPDATE app.app_user SET status = 'active' WHERE id = $1`, [userId]);
  for (const [type, secret] of [['password', PASSWORD], ['pin', PIN]] as const) {
    await owner.query(
      `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId, userId, type, await hashSecret(secret)]);
  }
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await owner?.end();
});

/* --------------------------------------------------------------------- A --- */

describe('A. password login, on the app role', () => {
  it('issues a session and records the attempt', async () => {
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email, password: PASSWORD },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const session = response.json() as Record<string, unknown>;
    expect(typeof session['accessToken']).toBe('string');
    expect(typeof session['refreshToken']).toBe('string');

    // The access token is usable on the tenant plane; the refresh token is not.
    const access = verifyToken(session['accessToken'] as string, JWT_KEY);
    expect(access['tenant_id']).toBe(tenantId);
    expect(checkPlane('tenant', access)).toBeNull();
    const refresh = verifyToken(session['refreshToken'] as string, JWT_KEY);
    expect(checkPlane('tenant', refresh)?.code).toBe('refresh_token_on_api_plane');

    const [row] = await attempts(
      `method = 'password' AND outcome = 'success' AND claimed_subject = $1`, [email]);
    expect(row, 'a successful login must be recorded').toBeDefined();
    expect(row!['tenant_id']).toBe(tenantId);
    expect(row!['resolved_user_id']).toBe(userId);
    expect(row!['reason']).toBeNull();
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const app = server();
    await app.ready();
    const unknown = `nobody-${randomUUID()}@owner.test`;
    const wrong = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email, password: 'not-the-password' },
    });
    const absent = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email: unknown, password: PASSWORD },
    });
    await app.close();

    expect(wrong.statusCode).toBe(401);
    expect(absent.statusCode).toBe(401);
    // Byte-identical. A membership oracle is a difference of any kind.
    expect(absent.json()).toEqual(wrong.json());
    expect(wrong.json()).toMatchObject({ error: 'authentication_failed' });

    // Recorded differently, because the operator needs what the caller must not get.
    const [unknownRow] = await attempts(`claimed_subject = $1`, [unknown]);
    expect(unknownRow!['outcome']).toBe('rejected');
    expect(unknownRow!['reason']).toBe('credential_invalid');
    expect(unknownRow!['resolved_user_id']).toBeNull();
  });

  it('records the lockout increment and its reason in the same commit', async () => {
    const before = (await owner.query<{ n: string }>(
      `SELECT failed_attempt_count::text AS n FROM app.credential
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'password'`,
      [tenantId, userId])).rows[0]!.n;

    const app = server();
    await app.ready();
    await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email, password: 'still-not-it' },
    });
    await app.close();

    const after = (await owner.query<{ n: string }>(
      `SELECT failed_attempt_count::text AS n FROM app.credential
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'password'`,
      [tenantId, userId])).rows[0]!.n;

    // Both sides of the transaction the registrar opened: the counter moved AND
    // the row explaining why exists. Either without the other is the bug.
    expect(Number(after)).toBe(Number(before) + 1);
    const rows = await attempts(
      `method = 'password' AND outcome = 'rejected' AND claimed_subject = $1`, [email]);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    await owner.query(
      `UPDATE app.credential SET failed_attempt_count = 0, locked_until = NULL
        WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  });
});

/* --------------------------------------------------------------------- B --- */

describe('B. the tenant in the path', () => {
  it('refuses an unknown slug without naming it as the reason', async () => {
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/no-such-tenant-${Date.now()}/login`,
      payload: { email, password: PASSWORD },
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'authentication_failed' });
    const [row] = await attempts(`reason = 'tenant_unknown'`);
    expect(row, 'the attempt is recorded even with no tenant to attribute it to').toBeDefined();
    expect(row!['tenant_id']).toBeNull();
  });

  it('refuses a hard_lock tenant, which is the ladder as specified', async () => {
    // `tenant_delinquency_consistent` is a biconditional: a ladder status with a
    // NULL delinquent_since has no computable threshold, so the fixture must set
    // day 0 as the real ladder would.
    await owner.query(
      `UPDATE platform.tenant SET status = 'hard_lock', delinquent_since = now() - interval '20 days'
        WHERE id = $1`, [tenantId]);
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email, password: PASSWORD },
    });
    await app.close();
    await owner.query(
      `UPDATE platform.tenant SET status = 'active', delinquent_since = NULL WHERE id = $1`,
      [tenantId]);

    expect(response.statusCode).toBe(401);
    const [row] = await attempts(`reason = 'tenant_login_blocked'`);
    expect(row).toBeDefined();
  });

  it('permits soft_lock, because read-only still has to be seen', async () => {
    await owner.query(
      `UPDATE platform.tenant SET status = 'soft_lock', delinquent_since = now() - interval '8 days'
        WHERE id = $1`, [tenantId]);
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/login`,
      payload: { email, password: PASSWORD },
    });
    await app.close();
    await owner.query(
      `UPDATE platform.tenant SET status = 'active', delinquent_since = NULL WHERE id = $1`,
      [tenantId]);
    expect(response.statusCode).toBe(200);
  });
});

/* --------------------------------------------------------------------- D --- */

describe('D. PIN login, refresh, and revocation', () => {
  let fingerprint: string;
  let deviceId: string;
  /** A staff member: the till's PIN is staff's, and the owner (a manager) is refused one. */
  let staffId: string;

  beforeAll(async () => {
    staffId = randomUUID();
    await owner.query(
      `INSERT INTO app.app_user (id, tenant_id, full_name, employee_code, status) VALUES ($1, $2, 'Staff W', 'W99', 'active')`,
      [staffId, tenantId]);
    const waiter = (await owner.query<{ id: string; assignable_scope: string }>(
      `SELECT id, assignable_scope FROM app.role WHERE tenant_id = $1 AND key = 'waiter'`, [tenantId])).rows[0]!;
    await owner.query(
      `INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), tenantId, staffId, branchId, waiter.id, waiter.assignable_scope]);
    await owner.query(
      `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, 'pin', $4)`,
      [randomUUID(), tenantId, staffId, await hashSecret(PIN)]);

    // A registered till (a fixture: there are no setup codes to redeem).
    fingerprint = `pin-${randomUUID()}`;
    deviceId = randomUUID();
    await owner.query(
      `INSERT INTO app.device (id, tenant_id, branch_id, name, fingerprint, registered_by_user_id)
       VALUES ($1, $2, $3, 'PIN till', $4, $5)`,
      [deviceId, tenantId, branchId, fingerprint, userId]);
  });

  it('refuses a MANAGER\'s PIN by role: answered as a wrong PIN, recorded as manager_use_login, no lockout counted', async () => {
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/pin`,
      payload: { userId, pin: PIN, deviceFingerprint: fingerprint, branchId },
    });
    await app.close();
    expect([response.statusCode, (response.json() as { error: string }).error]).toEqual([401, 'authentication_failed']);
    expect((response.json() as { accessToken?: string }).accessToken).toBeUndefined();
    const rows = await attempts(`method = 'pin' AND device_fingerprint = $1 AND reason = 'manager_use_login'`, [fingerprint]);
    expect(rows).toHaveLength(1);
    const counted = await owner.query<{ failed_attempt_count: number }>(
      `SELECT failed_attempt_count FROM app.credential WHERE user_id = $1 AND type = 'pin' AND status = 'active'`, [userId]);
    expect(counted.rows[0]!.failed_attempt_count).toBe(0);
  });

  it('issues a branch- and device-scoped session', async () => {
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/pin`,
      payload: { userId: staffId, pin: PIN, deviceFingerprint: fingerprint, branchId },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const access = verifyToken(
      (response.json() as { accessToken: string }).accessToken, JWT_KEY);
    // The branch comes from the DEVICE ROW, not from the body that also named it.
    expect(access['branch_id']).toBe(branchId);

    const [row] = await attempts(
      `method = 'pin' AND outcome = 'success' AND device_fingerprint = $1`, [fingerprint]);
    expect(row!['branch_id']).toBe(branchId);
    expect(row!['resolved_user_id']).toBe(staffId);
  });

  /**
   * #######################################################################
   * A WAITER SIGNS IN WITH A CODE, NOT A UUID.
   *
   * The screen asked for `userId`. On a tablet, at the start of a shift, that
   * is a 36-character uuid typed by hand -- which made the product unusable in
   * a restaurant whatever else worked, and no amount of backend correctness
   * changed it.
   *
   * A roster endpoint was the obvious fix and was rejected: that read happens
   * before anyone authenticates, so it hands every staff name to whoever is
   * holding the tablet. `employee_code` is unique per tenant and already
   * existed, so the credential is a short code the person knows plus the PIN
   * only they know.
   * #######################################################################
   */
  it('signs in with an employee code, which is a thing a person can type',
    async () => {
      await owner.query(
        `UPDATE app.app_user SET employee_code = 'W12' WHERE tenant_id=$1 AND id=$2`,
        [tenantId, staffId]);

      const app = server();
      await app.ready();
      const response = await app.inject({
        method: 'POST', url: `/api/auth/${slug}/pin`,
        payload: { employeeCode: 'W12', pin: PIN, deviceFingerprint: fingerprint, branchId },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const access = verifyToken(
        (response.json() as { accessToken: string }).accessToken, JWT_KEY);
      // Resolved to the same person the uuid would have named.
      expect(access['sub']).toBe(staffId);
      expect(access['branch_id']).toBe(branchId);
    });

  it('accepts the code however it was heard across a kitchen', async () => {
    // Read aloud, typed as heard. 'W12' working and ' w12 ' failing is a
    // support call, not a security property.
    await owner.query(
      `UPDATE app.app_user SET employee_code = 'W12' WHERE tenant_id=$1 AND id=$2`,
      [tenantId, staffId]);
    const app = server();
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/pin`,
      payload: { employeeCode: ' w12 ', pin: PIN, deviceFingerprint: fingerprint, branchId },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
  });

  it('answers an unknown code and a wrong PIN IDENTICALLY to the client',
    async () => {
      // Otherwise the sign-in screen is an employee-code oracle: type codes
      // until one stops saying "unknown", and you have learned who works here.
      const app = server();
      await app.ready();
      const unknownCode = await app.inject({
        method: 'POST', url: `/api/auth/${slug}/pin`,
        payload: { employeeCode: 'NOBODY', pin: PIN, deviceFingerprint: fingerprint, branchId },
      });
      const wrongPin = await app.inject({
        method: 'POST', url: `/api/auth/${slug}/pin`,
        payload: { employeeCode: 'W12', pin: '0000', deviceFingerprint: fingerprint, branchId },
      });
      await app.close();

      expect(unknownCode.statusCode).toBe(wrongPin.statusCode);
      expect(unknownCode.json()).toEqual(wrongPin.json());

      // And the SERVER still knows the difference, because an investigation
      // needs it. The attempt row carries the reason and what was typed.
      const [row] = await attempts(
        `method = 'pin' AND outcome = 'rejected' AND claimed_subject = $1`, ['NOBODY']);
      expect(row!['reason']).toBe('subject_unknown');
      expect(row!['resolved_user_id']).toBeNull();
    });

  it('refuses an access token presented as a refresh token', async () => {
    const app = server();
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/pin`,
      payload: { userId: staffId, pin: PIN, deviceFingerprint: fingerprint, branchId },
    });
    const { accessToken, refreshToken } = login.json() as Record<string, string>;

    const wrongToken = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: accessToken },
    });
    const refreshed = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken },
    });
    await app.close();

    expect(wrongToken.statusCode).toBe(401);
    const [wrongRow] = await attempts(`reason = 'refresh_not_a_refresh_token'`);
    expect(wrongRow, 'the type confusion must be visible to an operator').toBeDefined();

    expect(refreshed.statusCode).toBe(200);
    const next = verifyToken(
      (refreshed.json() as { accessToken: string }).accessToken, JWT_KEY);
    expect(next['tenant_id']).toBe(tenantId);
    expect(next['branch_id']).toBe(branchId);
  });

  it('stops refreshing once the device is revoked', async () => {
    const app = server();
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: `/api/auth/${slug}/pin`,
      payload: { userId: staffId, pin: PIN, deviceFingerprint: fingerprint, branchId },
    });
    const { refreshToken } = login.json() as Record<string, string>;

    await withTenantTransaction(ownerPool, tenantId, async () => {
      await revokeDevice(ctx(), deviceId, userId);
    });

    const after = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken },
    });
    await app.close();

    // The token is still perfectly valid and signed. The device is not, and the
    // refresh path is where that is noticed rather than in twelve hours.
    expect(after.statusCode).toBe(401);
    const [row] = await attempts(`reason = 'device_revoked'`);
    expect(row).toBeDefined();
  });
});
