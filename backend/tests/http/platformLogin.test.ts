import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { hashSecret } from '../../src/modules/auth/deviceAuth.js';
import { verifyToken } from '../../src/modules/auth/jwt.js';
import { registerPublicRoute } from '../../src/core/middleware/publicRoute.js';
import { allRoutes } from '../../src/routes/index.js';
import { authHandlers } from '../../src/routes/handlers/auth.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import { readPlatformRefreshClaims, issueSession } from '../../src/modules/auth/session.js';

/**
 * ###########################################################################
 * THE CONTROL PLANE HAD A LOCK AND NO DOOR.
 *
 * `platform.platform_user` has carried `password_hash`, `failed_login_count`,
 * `locked_until` and `last_login_at` since migration 0002. Nothing performed
 * that login: every auth route was tenant-scoped, and `platformRoute` read its
 * actor from a `sub` claim nothing in the product could mint. So all 28
 * control-plane routes were reachable only with a hand-signed token, and four
 * columns were written by nothing.
 *
 * These tests are therefore mostly about the SEAM rather than about passwords:
 * that the token this mints is accepted where it should be, refused where it
 * should not, and that neither plane's refresh token works on the other's route.
 * ###########################################################################
 */

const KEY = 'platform-login-test-signing-key';
const PASSWORD = 'a-long-enough-platform-password';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let superAdminId: string, superAdminEmail: string, readOnlyEmail: string;

async function post(url: string, payload: Record<string, unknown>): Promise<{
  status: number; body: Record<string, unknown>;
}> {
  const response = await app.inject({
    method: 'POST', url, headers: { 'content-type': 'application/json' },
    payload: payload as never,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function makePlatformUser(roleKey: string, opts: { status?: string } = {}): Promise<{
  id: string; email: string;
}> {
  const id = randomUUID();
  const email = `${id.slice(0, 8)}@platform.test`;
  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key=$1`, [roleKey])).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.platform_user
       (id,email,password_hash,full_name,platform_role_id,status)
     VALUES ($1,$2,$3,'Platform Tester',$4,$5)`,
    [id, email, await hashSecret(PASSWORD), roleId, opts.status ?? 'active']);
  return { id, email };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 4 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const sa = await makePlatformUser('super_admin');
  superAdminId = sa.id; superAdminEmail = sa.email;
  readOnlyEmail = (await makePlatformUser('read_only')).email;

  app = Fastify();
  // The real route table, with the real handler map -- not a hand-built route.
  // A test that declared its own route would prove the handler works and say
  // nothing about whether the product serves it, which is exactly the gap this
  // whole feature was sitting in.
  for (const route of allRoutes(authHandlers(KEY) as never).filter((r) => r.plane === 'public')) {
    registerPublicRoute(app, { pool }, route);
  }
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe('A. the door opens for the right people', () => {
  it('mints a token carrying the platform role and NO tenant', async () => {
    const { status, body } = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: PASSWORD });
    expect(status).toBe(200);

    const claims = verifyToken(body['accessToken'] as string, KEY);
    expect(claims['sub']).toBe(superAdminId);
    expect(claims['platform_role']).toBe('super_admin');
    // ###################################################################
    // THE ABSENCE IS THE ASSERTION. A platform token carrying a tenant id
    // would be a credential for both planes at once, which is the one thing
    // the two-plane split exists to prevent.
    // ###################################################################
    expect(claims['tenant_id']).toBeUndefined();
    expect(claims['branch_id']).toBeUndefined();
  });

  it('reports the role, so the console can render its own navigation', async () => {
    const { body } = await post('/api/auth/platform/login',
      { email: readOnlyEmail, password: PASSWORD });
    expect(body['role']).toBe('read_only');
  });

  it('stamps last_login_at, which nothing has ever written', async () => {
    await owner.query(`UPDATE platform.platform_user SET last_login_at=NULL WHERE id=$1`,
      [superAdminId]);
    await post('/api/auth/platform/login', { email: superAdminEmail, password: PASSWORD });
    const row = (await owner.query<{ last_login_at: Date | null }>(
      `SELECT last_login_at FROM platform.platform_user WHERE id=$1`, [superAdminId])).rows[0]!;
    expect(row.last_login_at).not.toBeNull();
  });

  it('records the attempt against the PLATFORM subject, not a tenant one', async () => {
    await post('/api/auth/platform/login', { email: superAdminEmail, password: PASSWORD });
    const row = (await owner.query<{
      platform_user_id: string | null; tenant_id: string | null;
      resolved_user_id: string | null; outcome: string;
    }>(
      `SELECT platform_user_id, tenant_id, resolved_user_id, outcome
         FROM platform.auth_attempt
        WHERE platform_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [superAdminId])).rows[0];
    expect(row, 'a successful platform login must be recorded').toBeDefined();
    expect(row!.outcome).toBe('success');
    // `auth_attempt_one_plane` says the same thing in the database; this asserts
    // the WRITER agrees with it, rather than relying on the constraint to catch a
    // row the product should never have built.
    expect(row!.tenant_id).toBeNull();
    expect(row!.resolved_user_id).toBeNull();
  });
});

describe('B. and stays shut otherwise', () => {
  it('refuses a wrong password', async () => {
    const { status, body } = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: 'not-the-password' });
    expect(status).toBe(401);
    expect(body['error']).toBe('authentication_failed');
    expect(body['accessToken']).toBeUndefined();
  });

  it('answers an unknown email IDENTICALLY to a wrong password', async () => {
    // Otherwise the route is an oracle for "which addresses are platform staff",
    // which is exactly the list worth having before phishing one of them.
    const unknown = await post('/api/auth/platform/login',
      { email: 'nobody@platform.test', password: PASSWORD });
    const wrong = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: 'not-the-password' });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('refuses a suspended account, and says so distinguishably in the LOG', async () => {
    const user = await makePlatformUser('support', { status: 'suspended' });
    const { status } = await post('/api/auth/platform/login',
      { email: user.email, password: PASSWORD });
    expect(status).toBe(401);
    const row = (await owner.query<{ reason: string }>(
      `SELECT reason FROM platform.auth_attempt
        WHERE claimed_subject = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [user.email])).rows[0]!;
    // The client cannot tell the two apart; the log can. An investigation needs
    // the difference and a prober must not have it -- the same split the tenant
    // PIN path already makes.
    expect(row.reason).toBe('user_inactive');
  });

  it('locks out after repeated failures, using the column that existed all along',
    async () => {
      const user = await makePlatformUser('support');
      let retryAfter: unknown;
      for (let i = 0; i < 6; i += 1) {
        const { body } = await post('/api/auth/platform/login',
          { email: user.email, password: 'wrong' });
        retryAfter = body['retryAfterSeconds'] ?? retryAfter;
      }
      expect(retryAfter, 'the lockout curve must engage').toBeTypeOf('number');

      const row = (await owner.query<{ failed_login_count: number; locked_until: Date | null }>(
        `SELECT failed_login_count, locked_until FROM platform.platform_user WHERE id=$1`,
        [user.id])).rows[0]!;
      expect(row.locked_until).not.toBeNull();
      // ###################################################################
      // THE COUNTER FREEZES AT THE LOCK, AND THAT IS CORRECT.
      //
      // `lockoutSeconds` returns 0 below three failures and locks from the
      // third. Once locked, a further attempt is refused BEFORE argon2 runs, so
      // the counter stops climbing -- six wrong passwords leave it at 3, not 6.
      //
      // Asserted rather than assumed because the naive expectation (one
      // increment per attempt) is what this test was first written with. A
      // counter that kept climbing while locked would mean every attempt paid
      // the verification cost, which is the denial-of-service this short-circuit
      // exists to avoid.
      // ###################################################################
      expect(row.failed_login_count).toBe(3);

      // And the RIGHT password is refused while locked, or the lockout is decor.
      const { status } = await post('/api/auth/platform/login',
        { email: user.email, password: PASSWORD });
      expect(status).toBe(401);
    });

  it('clears the counter on a good password, so a typo is not permanent', async () => {
    const user = await makePlatformUser('support');
    await post('/api/auth/platform/login', { email: user.email, password: 'wrong' });
    await post('/api/auth/platform/login', { email: user.email, password: PASSWORD });
    const row = (await owner.query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM platform.platform_user WHERE id=$1`,
      [user.id])).rows[0]!;
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it('refuses a missing credential', async () => {
    const { status } = await post('/api/auth/platform/login', { email: superAdminEmail });
    expect(status).toBe(401);
  });
});

describe('C. the two planes do not accept each other credentials', () => {
  it('refuses a TENANT refresh token on the platform refresh route', async () => {
    // ###################################################################
    // THE CROSSING TEST, IN BOTH DIRECTIONS.
    //
    // Both token families are HS256 under one key, so nothing but the claim
    // shape separates them. A tenant refresh token accepted here would mint a
    // control-plane session for whatever `platform_role` an attacker could get
    // into a tenant token.
    // ###################################################################
    const tenantSession = issueSession(
      { userId: randomUUID(), tenantId: randomUUID(), branchId: null, deviceId: null }, KEY);
    const { status } = await post('/api/auth/platform/refresh',
      { refreshToken: tenantSession.refreshToken });
    expect(status).toBe(401);
  });

  it('refuses a PLATFORM refresh token on the tenant refresh route', async () => {
    const { body } = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: PASSWORD });
    const { status } = await post('/api/auth/refresh', { refreshToken: body['refreshToken'] });
    expect(status).toBe(401);
  });

  it('refuses an ACCESS token presented as a refresh token', async () => {
    const { body } = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: PASSWORD });
    const { status } = await post('/api/auth/platform/refresh',
      { refreshToken: body['accessToken'] });
    expect(status).toBe(401);
  });

  it('is not vacuous: the platform refresh token DOES work on its own route', async () => {
    const { body } = await post('/api/auth/platform/login',
      { email: superAdminEmail, password: PASSWORD });
    const { status, body: refreshed } = await post('/api/auth/platform/refresh',
      { refreshToken: body['refreshToken'] });
    expect(status).toBe(200);
    expect(verifyToken(refreshed['accessToken'] as string, KEY)['sub']).toBe(superAdminId);
  });
});

describe('D. refresh re-reads the account rather than trusting the token', () => {
  it('drops a session whose account was suspended after the token was issued', async () => {
    const user = await makePlatformUser('support');
    const { body } = await post('/api/auth/platform/login',
      { email: user.email, password: PASSWORD });

    await owner.query(`UPDATE platform.platform_user SET status='suspended' WHERE id=$1`,
      [user.id]);

    const { status } = await post('/api/auth/platform/refresh',
      { refreshToken: body['refreshToken'] });
    // Twelve hours is how long this would otherwise keep working.
    expect(status).toBe(401);
  });

  it('picks up a role CHANGE rather than replaying the role in the token', async () => {
    const user = await makePlatformUser('read_only');
    const { body } = await post('/api/auth/platform/login',
      { email: user.email, password: PASSWORD });
    expect(verifyToken(body['accessToken'] as string, KEY)['platform_role']).toBe('read_only');

    const supportRoleId = (await owner.query<{ id: string }>(
      `SELECT id FROM platform.platform_role WHERE key='support'`)).rows[0]!.id;
    await owner.query(`UPDATE platform.platform_user SET platform_role_id=$2 WHERE id=$1`,
      [user.id, supportRoleId]);

    const { body: refreshed } = await post('/api/auth/platform/refresh',
      { refreshToken: body['refreshToken'] });
    expect(
      verifyToken(refreshed['accessToken'] as string, KEY)['platform_role'],
      'the role must be a query, not a claim -- otherwise a revocation waits 12 hours',
    ).toBe('support');
  });

  it('reads malformed claims purely, with no database call', () => {
    expect(readPlatformRefreshClaims('not-a-token', KEY)).toEqual({ refusal: 'refresh_malformed' });
    expect(readPlatformRefreshClaims('', KEY)).toEqual({ refusal: 'refresh_malformed' });
  });
});
