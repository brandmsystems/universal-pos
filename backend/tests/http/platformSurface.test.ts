import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { planeGuard } from '../../src/middleware/security/planeGuards.js';
import { impersonationGuard } from '../../src/middleware/security/impersonationGuard.js';
import { registerPlatformRoute } from '../../src/middleware/platformRoute.js';
import { registerTenantRoute, resetRegistry } from '../../src/middleware/routeRegistry.js';
import { ERROR_CONTRACT, toErrorResponse } from '../../src/utils/errors/errors.js';
import { platformRoutes } from '../../src/routes/index.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { isUnserved } from '../../src/routes/lookup.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { MAX_SESSION_MINUTES } from '../../src/modules/platform/impersonation.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { JOBS } from '../../src/jobs/registry.js';

/**
 * The control plane, served.
 *
 * ###########################################################################
 * EVERY ROUTE HERE IS THE FIRST CALLER OF SOMETHING ALREADY BUILT.
 *
 * That is what this file is really testing. `startImpersonation` had no caller
 * anywhere but a test, so no impersonation session had ever existed outside one
 * -- which means the guard that re-reads the session row on every request, the
 * read-only enforcement, the 60-minute CHECK and the append-only trigger were
 * all correct and all unreachable. `applyExpansion` and `scheduleContraction`
 * were both built with nothing able to choose between them. The zero-rating
 * columns on `tenant_tax_profile`, their CHECK and their guard trigger had no
 * writer at all.
 *
 * So the assertions here are about BEHAVIOUR through the surface, not shapes:
 * a session that a revocation ends on the very next request, a read-only
 * session that cannot POST, a cap that survives a token asking for ten hours, a
 * role that may enter a tenant but may not write in it, and a provisioning key
 * that means the same thing twice.
 * ###########################################################################
 */

const KEY = 'platform-surface-signing-key-long-enough';

let db: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;

let superAdminId: string;
let supportId: string;
let readOnlyId: string;

let planId: string;
let planV1: string;
let planV2Higher: string;
let planV3Lower: string;
let planV4Draft: string;

interface Provisioned {
  readonly tenantId: string;
  readonly slug: string;
  readonly subscriptionId: string;
  readonly ownerUserId: string;
  readonly branchId: string;
}

let base: Provisioned;

/* --------------------------------------------------------------- fixtures --- */

function platformToken(userId: string, roleKey: string): string {
  return signToken(
    {
      sub: userId,
      platform_role: roleKey,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    KEY,
  );
}

interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

async function control(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  options: {
    as?: { id: string; role: string };
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
): Promise<Response> {
  const actor = options.as ?? { id: superAdminId, role: 'super_admin' };
  const response = await app.inject({
    method,
    url: `/api/platform${url}`,
    headers: {
      authorization: `Bearer ${platformToken(actor.id, actor.role)}`,
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as never }),
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
    headers: response.headers as Record<string, unknown>,
  };
}

async function impersonated(
  method: 'GET' | 'POST',
  url: string,
  token: string,
): Promise<Response> {
  const response = await app.inject({
    method,
    url: `/api/imp${url}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
    headers: response.headers as Record<string, unknown>,
  };
}

/**
 * A refusal is asserted against the CONTRACT, not against a status written out
 * here.
 *
 * Two things have to hold for a named refusal to be worth naming: the code has
 * to reach the client, and `ERROR_CONTRACT` has to know what it means. A test
 * that hard-coded `expect(status).toBe(409)` would pass while the contract had
 * no entry -- and an unmapped code is answered `500 internal_error,
 * retryable: false`, which is the one thing every one of these refusals is not.
 */
function expectRefusal(result: Response, code: string): void {
  const mapping = ERROR_CONTRACT[code];
  expect(
    mapping,
    `${code} is raised by a served control-plane route but is absent from ` +
      'ERROR_CONTRACT, so it reaches the console as 500 internal_error',
  ).toBeDefined();
  expect(result.body['error'], JSON.stringify(result.body)).toBe(code);
  expect(result.status).toBe(mapping!.status);
  expect(result.body['retryable']).toBe(mapping!.retryable);
}

/** The token's own payload, so a claim can be compared with the row. */
function tokenClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function platformUser(roleKey: string, label: string): Promise<string> {
  const roleId = (await db.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = $1`, [roleKey])).rows[0]!.id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', $3, $4)`,
    [id, `${label}+${id}@platform.test`, label, roleId],
  );
  return id;
}

async function publishVersion(version: number, priceMinor: number, published: boolean): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO platform.plan_version
       (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, $3, $4, 'INR', 'monthly', ${published ? 'now()' : 'NULL'})`,
    [id, planId, version, priceMinor],
  );
  return id;
}

/** A tenant with a taxable tax profile, which is what the exemption route edits. */
async function provisionFresh(prefix: string): Promise<Provisioned> {
  const client = await pool.connect();
  const key = `${prefix}-${randomUUID()}`;
  const slug = `${prefix}${key.slice(prefix.length + 1, prefix.length + 12).replace(/-/g, '')}`;
  try {
    await client.query('BEGIN');
    const result = await provisionTenant(client, {
      idempotencyKey: key, slug, name: 'Platform Surface Probe',
      currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@owner.test`, ownerName: 'Owner',
      firstBranchName: 'Main', planVersionId: planV1, taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    const subscriptionId = (await db.query<{ id: string }>(
      `SELECT id FROM platform.subscription WHERE tenant_id = $1`, [result.tenantId])).rows[0]!.id;
    await db.query(
      `INSERT INTO platform.tenant_tax_profile
         (tenant_id, legal_name, gstin, state_code, country_code, billing_address)
       VALUES ($1, 'Probe Restaurant LLP', NULL, '29', 'IN', 'Bengaluru')`,
      [result.tenantId],
    );
    return {
      tenantId: result.tenantId, slug, subscriptionId,
      ownerUserId: result.ownerUserId, branchId: result.firstBranchId,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function liveSessionRow(sessionId: string): Promise<{
  write_enabled: boolean; revoked_at: string | null; within_cap: boolean;
  minutes: string; expires_epoch: string;
} | undefined> {
  const result = await db.query<{
    write_enabled: boolean; revoked_at: string | null; within_cap: boolean;
    minutes: string; expires_epoch: string;
  }>(
    `SELECT write_enabled, revoked_at::text,
            expires_at <= created_at + interval '60 minutes' AS within_cap,
            (EXTRACT(EPOCH FROM (expires_at - created_at)) / 60)::text AS minutes,
            EXTRACT(EPOCH FROM expires_at)::text AS expires_epoch
       FROM platform.impersonation_session WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0];
}

async function startSession(
  options: {
    slug?: string;
    as?: { id: string; role: string };
    minutes?: number;
    write?: { reasonCode: string; reasonDetail: string };
  } = {},
): Promise<Response> {
  return control('POST', '/impersonation', {
    ...(options.as ? { as: options.as } : {}),
    payload: {
      tenantSlug: options.slug ?? base.slug,
      reasonCode: 'support_ticket',
      reasonDetail: 'ticket 4711: the kitchen board shows nothing after a fire',
      ...(options.minutes === undefined ? {} : { minutes: options.minutes }),
      ...(options.write === undefined ? {} : { write: options.write }),
    },
  });
}

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 8 });

  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);

  superAdminId = await platformUser('super_admin', 'Root');
  supportId = await platformUser('support', 'Support');
  readOnlyId = await platformUser('read_only', 'Analyst');

  planId = randomUUID();
  await db.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, $2, 'Platform Surface Plan')`,
    [planId, `psurf_${planId.slice(0, 8)}`]);
  planV1 = await publishVersion(1, 100_000, true);
  planV2Higher = await publishVersion(2, 250_000, true);
  planV3Lower = await publishVersion(3, 40_000, true);
  planV4Draft = await publishVersion(4, 500_000, false);

  base = await provisionFresh('psa');

  resetRegistry();

  app = Fastify();
  app.setErrorHandler(async (error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    await reply.code(status).send(body);
  });

  // ---- the control plane, exactly as buildServer mounts it ----------------
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('platform', KEY));
    for (const route of platformRoutes(platformHandlers(KEY))) {
      // If any of the twelve is still unserved this loop silently shrinks, so
      // the first assertion below pins the count.
      if (isUnserved(route.handler)) continue;
      registerPlatformRoute(scope, { pool }, route);
    }
  }, { prefix: '/api/platform' });

  // ---- somewhere for an impersonation token to be USED --------------------
  //
  // Two tenant-plane routes with NO permission declared, so the scope check is
  // not what is under test here -- the read-only enforcement is. The POST
  // carries a real audit descriptor, because "every write is tagged in the
  // tenant's own audit log" is half the reason a write session is allowed at all.
  app.register(async (scope) => {
    scope.addHook('onRequest', impersonationGuard(pool, KEY));
    registerTenantRoute(scope, { pool }, {
      method: 'GET', url: '/probe', plane: 'tenant', audit: 'none',
      handler: async (_request, _reply, context) => ({ tenantId: context.tenantId }),
    });
    registerTenantRoute(scope, { pool }, {
      method: 'POST', url: '/probe', plane: 'tenant',
      audit: { action: 'probe.written', target: 'probe' },
      handler: async () => ({ written: true }),
    });
  }, { prefix: '/api/imp' });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.end();
});

/* ------------------------------------------------------------- the surface --- */

describe('a scheduled change can be SEEN and CALLED OFF', () => {
  /**
   * #######################################################################
   * INVISIBLE AND IRREVOCABLE, WITH BOTH FUNCTIONS ALREADY WRITTEN.
   *
   * A downgrade or a seat decrease is scheduled for the period end rather than
   * applied at once -- the right answer to "do not take away what has been paid
   * for". `pendingChangeFor` and `revokeScheduledChange` implemented reading and
   * cancelling it and had exactly one caller each: a test. So an agent could
   * queue a downgrade for a customer, not see that one was queued, and not undo
   * it when the customer rang back.
   * #######################################################################
   */
  it('reports nothing queued as NULL rather than as an empty object', async () => {
    const tenant = await provisionFresh('pcn');
    const result = await control('GET',
      `/subscriptions/${tenant.subscriptionId}/pending-change`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['pending']).toBeNull();
  });

  it('shows a queued downgrade, then calls it off', async () => {
    const tenant = await provisionFresh('pcs');
    const scheduled = await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
      { payload: { planVersionId: planV3Lower } });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body['effect']).toBe('at_period_end');

    const pending = await control('GET',
      `/subscriptions/${tenant.subscriptionId}/pending-change`);
    expect(pending.body['pending'], 'the queued change is visible').not.toBeNull();

    const revoked = await control('DELETE',
      `/subscriptions/${tenant.subscriptionId}/pending-change`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const after = await control('GET',
      `/subscriptions/${tenant.subscriptionId}/pending-change`);
    expect(after.body['pending'], 'and gone once called off').toBeNull();
  });

  it('404s a second revoke, so "nothing to cancel" never reads as "cancelled"',
    async () => {
      const tenant = await provisionFresh('pcr');
      const result = await control('DELETE',
        `/subscriptions/${tenant.subscriptionId}/pending-change`);
      expect(result.status).toBe(404);
      expect(result.body['error']).toBe('no_pending_change');
    });
});

describe('the control plane serves the whole declared surface', () => {
  it('supplies a handler for every platform route the table asks for', () => {
    const routes = platformRoutes(platformHandlers(KEY));
    const unserved = routes.filter((route) => isUnserved(route.handler))
      .map((route) => `${route.method} ${route.url}`);
    expect(unserved, 'the control plane declares these and answers with the stub').toEqual([]);
    // 12 -> 14 when the scheduled change became visible and revocable. Both
    // domain functions existed with a test as their only caller, so an agent
    // could queue a downgrade and then neither see nor undo it.
    // 14 -> 16 when platform staff creation got a route: `platform.user.create`
    // has been in the catalogue since phase 1 and nothing ever served it, so a
    // Super Admin could not add a Salesperson without shell access to the
    // database -- the platform-side twin of `POST /tenants` before this week.
    // 16 -> 23 with restaurant management: tenant edit/deactivate/reactivate,
    // the Sales Person list, staff edit and status, and plan versions.
    // 23 -> 27: the owner setup link, a staff password reset, plan
    // active/inactive, and subscription renewal.
    // 27 -> 28: GET /me, the signed-in user's own account for the console header.
    // 28 -> 29: GET /tenants/slug-available, the create form's live slug check.
    // 31 -> 32: POST /tenants/:id/slug, a Super Admin giving a restaurant a new address.
    // 32 -> 37: the Sales person's staff PINs -- list, add, edit, set PIN, switch.
    // 37 -> 38: POST /tenants/:id/staff/:userId/credentials, the Sales person setting a username and password.
    // 38 -> 42: country and currency (0084) -- the countries offered, their
    // settings, and a restaurant's country-change preview and change.
    expect(routes.length).toBe(42);
  });

  it('refuses a tenant-plane token outright, before any handler', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/platform/tenants',
      headers: {
        authorization: `Bearer ${signToken(
          { sub: base.ownerUserId, tenant_id: base.tenantId,
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 },
          KEY)}`,
      },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as Record<string, unknown>)['error'])
      .toBe('tenant_token_on_platform_plane');
  });
});

/* ------------------------------------------------------------ impersonation --- */

describe('an impersonation session can be created, and only by a role that may', () => {
  it('creates a read-only session and hands back a token that works', async () => {
    const started = await startSession();
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const sessionId = String(started.body['sessionId']);
    const row = await liveSessionRow(sessionId);
    expect(row, 'the session must exist as a ROW; the token is only a reference').toBeDefined();
    expect(row!.write_enabled).toBe(false);

    const used = await impersonated('GET', '/probe', String(started.body['token']));
    expect(used.status, JSON.stringify(used.body)).toBe(200);
    // The tenant came from the SESSION ROW, not from the token's act_tenant_id.
    expect(used.body['tenantId']).toBe(base.tenantId);
    // The banner headers the console must show for the whole session.
    expect(used.headers['x-impersonation-session']).toBe(sessionId);
    expect(used.headers['x-impersonation-write']).toBe('false');
  });

  it('is READ-ONLY: the same token cannot POST', async () => {
    const started = await startSession();
    const token = String(started.body['token']);

    expect((await impersonated('GET', '/probe', token)).status).toBe(200);

    const write = await impersonated('POST', '/probe', token);
    expect(write.status).toBe(403);
    expect(write.body['error']).toBe('impersonation_read_only');
    // Enforced in the guard, in front of the handler -- so no audit row either.
    const audit = await db.query(
      `SELECT 1 FROM app.tenant_audit_log
        WHERE tenant_id = $1 AND action = 'probe.written'
          AND impersonation_session_id = $2`,
      [base.tenantId, started.body['sessionId']]);
    expect(audit.rowCount).toBe(0);
  });

  it('refuses read_only outright, and creates nothing', async () => {
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.impersonation_session
        WHERE platform_user_id = $1`, [readOnlyId]);

    const attempt = await startSession({ as: { id: readOnlyId, role: 'read_only' } });
    expect(attempt.status).toBe(403);
    expect(attempt.body['error']).toBe('forbidden');
    // No hint about which key was missing: a prober learns nothing.
    expect(Object.keys(attempt.body)).not.toContain('permission');

    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.impersonation_session
        WHERE platform_user_id = $1`, [readOnlyId]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('lets support start a read-only session but NOT a write one', async () => {
    // The catalogue says support "May impersonate read-only": it holds
    // platform.impersonation.start and not platform.impersonation.write. The
    // route table can declare only one key, so this is the check that makes the
    // second one real.
    const readOnly = await startSession({ as: { id: supportId, role: 'support' } });
    expect(readOnly.status, JSON.stringify(readOnly.body)).toBe(200);
    expect((await liveSessionRow(String(readOnly.body['sessionId'])))!.write_enabled).toBe(false);

    const withWrite = await startSession({
      as: { id: supportId, role: 'support' },
      write: { reasonCode: 'data_correction', reasonDetail: 'correcting a mis-keyed tender' },
    });
    expectRefusal(withWrite, 'impersonation_write_not_permitted');

    const created = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.impersonation_session
        WHERE platform_user_id = $1 AND write_enabled`, [supportId]);
    expect(created.rows[0]!.n, 'not a single write session for support').toBe('0');
  });

  it('gives super_admin a write session, and tags the write in the TENANT audit log',
    async () => {
      const started = await startSession({
        write: { reasonCode: 'data_correction', reasonDetail: 'ticket 4712: fixing a bad price' },
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(started.body['writeEnabled']).toBe(true);

      const token = String(started.body['token']);
      const write = await impersonated('POST', '/probe', token);
      expect(write.status, JSON.stringify(write.body)).toBe(200);

      const audit = await db.query<{ actor_kind: string; via_impersonation: boolean }>(
        `SELECT actor_kind, via_impersonation FROM app.tenant_audit_log
          WHERE tenant_id = $1 AND impersonation_session_id = $2 AND action = 'probe.written'`,
        [base.tenantId, started.body['sessionId']]);
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]!.actor_kind).toBe('impersonation');
      expect(audit.rows[0]!.via_impersonation).toBe(true);
    });

  it('refuses a purged tenant, because there is nothing left to see', async () => {
    const doomed = await provisionFresh('psb');
    await db.query(
      `UPDATE platform.tenant
          SET status = 'purged', delinquent_since = now() - interval '200 days',
              status_changed_at = now()
        WHERE id = $1`, [doomed.tenantId]);

    expectRefusal(await startSession({ slug: doomed.slug }), 'tenant_not_impersonable');
  });

  it('refuses a slug nobody has, rather than leaking whether an id exists', async () => {
    expectRefusal(await startSession({ slug: 'no-such-tenant-at-all' }), 'tenant_slug_unknown');
  });

  it('records the start in the PLATFORM audit log, with the role read from the database',
    async () => {
      const started = await startSession();
      const audit = await db.query<{
        action: string; actor_role_key: string; actor_platform_user_id: string;
      }>(
        `SELECT action, actor_role_key, actor_platform_user_id
           FROM platform.platform_audit_log
          WHERE action = 'impersonation.started' AND actor_platform_user_id = $1
          ORDER BY occurred_at DESC LIMIT 1`, [superAdminId]);
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]!.actor_role_key).toBe('super_admin');
      expect(started.body['sessionId']).toBeTruthy();
    });
});

describe('the 60-minute cap is on the ROW, not on the token', () => {
  it('clamps a request for ten hours to the cap', async () => {
    const started = await startSession({ minutes: 600 });
    expect(started.status).toBe(200);

    const row = await liveSessionRow(String(started.body['sessionId']))!;
    // Measured against the row's own created_at, server-side: the cap is
    // `expires_at <= created_at + interval '60 minutes'` and that is the
    // relationship to assert, not a comparison to this process's clock.
    expect(row!.within_cap, `granted ${row!.minutes} minutes`).toBe(true);
    expect(Number(row!.minutes)).toBe(MAX_SESSION_MINUTES);

    // And the token cannot claim more than the row allows: its exp IS the row's
    // expiry, not a separately computed lifetime.
    // Floored, exactly as signToken computes it from the returned expires_at:
    // the token's exp IS the row's expiry rather than a separately computed
    // lifetime, so a whole-second comparison is the assertion, not a tolerance.
    expect(Number(tokenClaims(String(started.body['token']))['exp']))
      .toBe(Math.floor(Number(row!.expires_epoch)));
  });

  it('ignores a token that claims ten hours when the ROW has expired', async () => {
    // THE SYNTHETIC VIOLATION: a reissued or hand-forged token with a long exp
    // against a session row that is already over. `exp <= iat + 3600` would cap
    // a token; reissue for eight hours and that cap is decorative. The row is
    // what cannot be extended, and the guard resolves expiry against server time.
    const sessionId = randomUUID();
    await db.query(
      `INSERT INTO platform.impersonation_session
         (id, tenant_id, platform_user_id, reason_code, reason_detail,
          created_at, expires_at)
       VALUES ($1, $2, $3, 'incident', 'a reason detail long enough to pass',
               now() - interval '91 minutes', now() - interval '31 minutes')`,
      [sessionId, base.tenantId, superAdminId]);

    const forged = signToken(
      {
        typ: 'impersonation', sub: superAdminId, act_tenant_id: base.tenantId,
        sid: sessionId, write: true,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 36_000,
      },
      KEY);

    const used = await impersonated('GET', '/probe', forged);
    expect(used.status).toBe(403);
    expect(used.body['error']).toBe('impersonation_session_not_live');
  });
});

describe('revocation is immediate, because the row is re-read every request', () => {
  it('makes the same token unusable on the very next request', async () => {
    const started = await startSession();
    const token = String(started.body['token']);
    const sessionId = String(started.body['sessionId']);

    // Works. Twice, so the second call cannot be dismissed as a cold start.
    expect((await impersonated('GET', '/probe', token)).status).toBe(200);
    expect((await impersonated('GET', '/probe', token)).status).toBe(200);

    const revoked = await control('DELETE', `/impersonation/${sessionId}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body['revoked']).toBe(true);

    // No new token was issued, nothing was flushed, and no TTL elapsed. The
    // guard reads platform.impersonation_session on every request and this is
    // the request after the UPDATE.
    const after = await impersonated('GET', '/probe', token);
    expect(after.status).toBe(403);
    expect(after.body['error']).toBe('impersonation_session_not_live');

    expect((await liveSessionRow(sessionId))!.revoked_at).not.toBeNull();
  });

  it('refuses a second revocation instead of reporting one that did not happen',
    async () => {
      const started = await startSession();
      const sessionId = String(started.body['sessionId']);
      expect((await control('DELETE', `/impersonation/${sessionId}`)).status).toBe(200);

      // The route declares audit: { action: 'impersonation.revoked' }, and the
      // registrar writes that row on any non-throwing return -- so a 200 on a
      // no-op would put a revocation in the platform audit log for a session
      // nobody revoked. Counted across the failed call, not merely observed.
      const before = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform.platform_audit_log
          WHERE action = 'impersonation.revoked'`);
      expect(Number(before.rows[0]!.n), 'the first revocation is audited').toBeGreaterThan(0);

      const again = await control('DELETE', `/impersonation/${sessionId}`);
      expectRefusal(again, 'impersonation_session_not_revocable');

      const after = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform.platform_audit_log
          WHERE action = 'impersonation.revoked'`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

  it('lets support revoke, which is a separate key from starting', async () => {
    const started = await startSession();
    const revoked = await control(
      'DELETE', `/impersonation/${String(started.body['sessionId'])}`,
      { as: { id: supportId, role: 'support' } });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });

  it('refuses read_only, which holds neither key', async () => {
    const started = await startSession();
    const attempt = await control(
      'DELETE', `/impersonation/${String(started.body['sessionId'])}`,
      { as: { id: readOnlyId, role: 'read_only' } });
    expect(attempt.status).toBe(403);
    expect((await liveSessionRow(String(started.body['sessionId'])))!.revoked_at).toBeNull();
  });
});

/* ------------------------------------------------------------ provisioning --- */

describe('provisioning is idempotent on its key, and refuses a reused one', () => {
  function request(slug: string): Record<string, unknown> {
    return {
      slug, name: 'Idempotent Diner', currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `${slug}@owner.test`, ownerName: 'Owner',
      firstBranchName: 'Main', planVersionId: planV1, taxJurisdiction: 'IN',
    };
  }

  it('returns the SAME tenant for a repeated key, and the token only once', async () => {
    const key = `idem-${randomUUID()}`;
    const slug = `pi${key.slice(5, 16).replace(/-/g, '')}`;

    const first = await control('POST', '/tenants',
      { payload: request(slug), idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['created']).toBe(true);
    expect(first.body['inviteToken']).toBeTruthy();

    const retry = await control('POST', '/tenants',
      { payload: request(slug), idempotencyKey: key });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body['tenantId']).toBe(first.body['tenantId']);
    expect(retry.body['created']).toBe(false);
    // The raw token is shown once, at creation. A retry cannot resurrect it.
    expect(retry.body['inviteToken']).toBeNull();

    // And exactly one tenant exists, not two with different slugs.
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.tenant WHERE slug = $1`, [slug]);
    expect(count.rows[0]!.n).toBe('1');
  });

  it('refuses the same key with different parameters rather than handing back a tenant',
    async () => {
      const key = `idem-${randomUUID()}`;
      const slug = `pj${key.slice(5, 16).replace(/-/g, '')}`;
      const created = await control('POST', '/tenants',
        { payload: request(slug), idempotencyKey: key });
      expect(created.status).toBe(200);

      const conflicting = await control('POST', '/tenants', {
        payload: { ...request(slug), ownerEmail: 'somebody-else@owner.test' },
        idempotencyKey: key,
      });
      expectRefusal(conflicting, 'provisioning_key_reused');
    });

  it('requires the key, rather than treating its absence as a fresh request', async () => {
    const slug = `pk${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    const missing = await control('POST', '/tenants', { payload: request(slug) });
    expectRefusal(missing, 'idempotency_key_required');
    expect((await db.query(
      `SELECT 1 FROM platform.tenant WHERE slug = $1`, [slug])).rowCount).toBe(0);
  });

  it('refuses a tenant with NO jurisdiction, and hands back the catalogue', async () => {
    // #####################################################################
    // THE FIELD THAT MUST NOT HAVE A DEFAULT.
    //
    // One product for the whole world, India launched first -- so 'IN' is the
    // answer almost every time, which is exactly why it cannot fill itself in.
    // A default here is a restaurant in Dubai whose bills carry CGST and SGST,
    // add up to the paisa, and are found by an assessment; nothing would fail,
    // because the forgotten field supplied the answer that is usually right.
    //
    // Asserted at the ROUTE and not only at the type, because a JSON client
    // has no types. And the refusal must carry the catalogue: "taxJurisdiction
    // is required" tells an integrator nothing about which codes exist or
    // which of them this product can actually tax.
    // #####################################################################
    const slug = `pm${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    const { taxJurisdiction: _omitted, ...withoutIt } = request(slug);
    const missing = await control('POST', '/tenants', {
      payload: withoutIt, idempotencyKey: `idem-${randomUUID()}`,
    });
    expectRefusal(missing, 'tax_jurisdiction_required');
    expect(String(missing.body['detail'])).toContain('IN (India, implemented)');
    // Nothing written, and -- because the check runs before the idempotency
    // claim -- the key is still usable for the corrected request.
    expect((await db.query(
      `SELECT 1 FROM platform.tenant WHERE slug = $1`, [slug])).rowCount).toBe(0);
  });

  it('refuses a jurisdiction nobody has heard of, without consuming the key', async () => {
    const slug = `pn${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    const key = `idem-${randomUUID()}`;
    const bad = await control('POST', '/tenants', {
      payload: { ...request(slug), taxJurisdiction: 'ZZ' }, idempotencyKey: key,
    });
    expectRefusal(bad, 'tax_jurisdiction_unknown');

    // THE POINT OF CHECKING BEFORE THE CLAIM: the fix for a typo is to retry
    // with the right code. If the refused attempt had taken the key, that retry
    // would come back `provisioning_key_reused` and the caller would be stuck
    // between two refusals with no way forward.
    const good = await control('POST', '/tenants', {
      payload: request(slug), idempotencyKey: key,
    });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body['created']).toBe(true);
  });

  it('STORES the jurisdiction, because every bill will be taxed under it', async () => {
    const slug = `po${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    const made = await control('POST', '/tenants', {
      payload: request(slug), idempotencyKey: `idem-${randomUUID()}`,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const row = await db.query<{ tax_jurisdiction: string }>(
      `SELECT tax_jurisdiction FROM platform.tenant WHERE slug = $1`, [slug]);
    expect(row.rows[0]!.tax_jurisdiction).toBe('IN');
  });

  it('treats a CHANGED jurisdiction as a different request, not a retry', async () => {
    // In the digest, because it decides the tax on every bill the tenant will
    // ever raise. Reusing a key with a different one is the clearest possible
    // case of a retry that is not a retry -- and answering it with the first
    // tenant would hand back a restaurant in the wrong tax regime.
    const key = `idem-${randomUUID()}`;
    const slug = `pp${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    expect((await control('POST', '/tenants',
      { payload: request(slug), idempotencyKey: key })).status).toBe(200);
    const conflicting = await control('POST', '/tenants', {
      payload: { ...request(slug), taxJurisdiction: 'ZZ' }, idempotencyKey: key,
    });
    // Refused for the CODE before the key is even consulted, which is the
    // stronger of the two refusals and the one that fires first.
    expectRefusal(conflicting, 'tax_jurisdiction_unknown');
  });

  it('refuses read_only, which cannot provision', async () => {
    const slug = `pl${randomUUID().slice(0, 10).replace(/-/g, '')}`;
    const attempt = await control('POST', '/tenants', {
      as: { id: readOnlyId, role: 'read_only' },
      payload: request(slug), idempotencyKey: `idem-${randomUUID()}`,
    });
    expect(attempt.status).toBe(403);
    expect((await db.query(
      `SELECT 1 FROM platform.tenant WHERE slug = $1`, [slug])).rowCount).toBe(0);
  });
});

/* ------------------------------------------------------------- platform staff --- */

/**
 * `platform.user.create` has been in the catalogue since phase 1 and, until
 * this route existed, nothing served it -- a Super Admin could not onboard a
 * Salesperson without shell access to the database. See `src/modules/platform/staff.ts`.
 */
describe('a Super Admin can create platform staff, and nobody else can', () => {
  it('creates a sales account whose password actually verifies', async () => {
    const email = `sales-${randomUUID()}@platform.test`;
    const created = await control('POST', '/users', {
      payload: {
        email, fullName: 'A. Salesperson', password: 'correct-horse-battery',
        roleKey: 'sales',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body['roleKey']).toBe('sales');

    const row = await db.query<{ role_key: string; created_by: string | null }>(
      `SELECT r.key AS role_key, u.created_by_platform_user_id AS created_by
         FROM platform.platform_user u
         JOIN platform.platform_role r ON r.id = u.platform_role_id
        WHERE u.email = $1`,
      [email]);
    expect(row.rows[0]?.role_key).toBe('sales');
    // From the TOKEN, never the body -- there is nothing in the request naming
    // who created this account.
    expect(row.rows[0]?.created_by).toBe(superAdminId);

    const { authenticatePlatformUser } = await import('../../src/modules/authentication/platformAuth.js');
    const verified = await authenticatePlatformUser(
      db, { email, password: 'correct-horse-battery' });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
  });

  it('refuses a password under the length floor, and creates nothing', async () => {
    const email = `short-${randomUUID()}@platform.test`;
    const result = await control('POST', '/users', {
      payload: { email, fullName: 'X', password: 'too-short', roleKey: 'sales' },
    });
    expectRefusal(result, 'platform_password_too_short');
    expect((await db.query(
      `SELECT 1 FROM platform.platform_user WHERE email = $1`, [email])).rowCount).toBe(0);
  });

  it('refuses an unknown role key, and creates nothing', async () => {
    const email = `bogus-${randomUUID()}@platform.test`;
    const result = await control('POST', '/users', {
      payload: {
        email, fullName: 'X', password: 'correct-horse-battery', roleKey: 'astronaut',
      },
    });
    expectRefusal(result, 'platform_role_unknown');
    expect((await db.query(
      `SELECT 1 FROM platform.platform_user WHERE email = $1`, [email])).rowCount).toBe(0);
  });

  it('refuses support, billing and read_only, none of which hold platform.user.create',
    async () => {
      for (const role of ['support', 'billing', 'read_only'] as const) {
        const email = `denied-${role}-${randomUUID()}@platform.test`;
        const result = await control('POST', '/users', {
          as: { id: role === 'support' ? supportId : role === 'billing'
            ? await platformUser('billing', 'billing-user') : readOnlyId, role },
          payload: {
            email, fullName: 'X', password: 'correct-horse-battery', roleKey: 'sales',
          },
        });
        expect(result.status, `${role}: ${JSON.stringify(result.body)}`).toBe(403);
        expect((await db.query(
          `SELECT 1 FROM platform.platform_user WHERE email = $1`, [email])).rowCount)
          .toBe(0);
      }
    });

  /**
   * The route-level permission gate only proves the GRANTER holds
   * `platform.user.create`. It says nothing about whether the granter's own
   * role covers the TARGET role -- that is the subset rule, and today no role
   * holding the create key is anything but `super_admin`, so this path is
   * unreachable through the live route table. Per the testing standard, a
   * rule is proven against a fixture built to violate it, not against
   * production data that happens to comply: this calls the domain function
   * directly with a synthetic granter that could never occur via HTTP.
   */
  it('the subset rule refuses a grant the granter could not itself perform', async () => {
    const { createPlatformUser, PlatformGrantExceedsAuthorityError } =
      await import('../../src/modules/platform/staff.js');
    await expect(createPlatformUser(db, {
      email: `synthetic-${randomUUID()}@platform.test`,
      fullName: 'X', password: 'correct-horse-battery', roleKey: 'super_admin',
      createdByPlatformUserId: superAdminId,
      // Bypasses the route's permission gate on purpose: `sales` holds none
      // of the keys that would let it reach this handler at all, so the ONLY
      // way to exercise the subset check underneath is to call the domain
      // function directly, the same way a role that DID hold
      // `platform.user.create` without holding every key `super_admin` does
      // would be refused.
      granterRoleKey: 'sales',
    })).rejects.toBeInstanceOf(PlatformGrantExceedsAuthorityError);
  });
});

/* ------------------------------------------------------ subscription change --- */

describe('a subscription change goes to the arm the asymmetry demands', () => {
  it('applies an expansion immediately', async () => {
    const tenant = await provisionFresh('pse');
    const result = await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
      { payload: { planVersionId: planV2Higher } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['direction']).toBe('expand');
    expect(result.body['effect']).toBe('immediate');

    const sub = await db.query<{ plan_version_id: string }>(
      `SELECT plan_version_id FROM platform.subscription WHERE id = $1`,
      [tenant.subscriptionId]);
    expect(sub.rows[0]!.plan_version_id).toBe(planV2Higher);

    const segment = await db.query<{ plan_version_id: string; quantity: number }>(
      `SELECT plan_version_id, quantity FROM platform.subscription_segment
        WHERE subscription_id = $1 AND ends_at IS NULL`, [tenant.subscriptionId]);
    expect(segment.rowCount, 'the open segment is what an invoice bills').toBe(1);
    expect(segment.rows[0]!.plan_version_id).toBe(planV2Higher);

    // No scheduled change: an expansion is never deferred.
    expect((await db.query(
      `SELECT 1 FROM platform.scheduled_subscription_change
        WHERE subscription_id = $1`, [tenant.subscriptionId])).rowCount).toBe(0);
  });

  it('defers a contraction to the period boundary and leaves the plan alone', async () => {
    const tenant = await provisionFresh('psc');
    const result = await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
      { payload: { planVersionId: planV3Lower } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['direction']).toBe('contract');
    expect(result.body['effect']).toBe('at_period_end');

    // Still on the plan they paid for: no unused value exists to refund.
    const sub = await db.query<{ plan_version_id: string; current_period_end: string }>(
      `SELECT plan_version_id, current_period_end::text FROM platform.subscription WHERE id = $1`,
      [tenant.subscriptionId]);
    expect(sub.rows[0]!.plan_version_id).toBe(planV1);

    const pending = await db.query<{
      kind: string; status: string; target_plan_version_id: string; effective_at: string;
    }>(
      `SELECT kind, status, target_plan_version_id, effective_at::text
         FROM platform.scheduled_subscription_change WHERE subscription_id = $1`,
      [tenant.subscriptionId]);
    expect(pending.rowCount).toBe(1);
    expect(pending.rows[0]!.kind).toBe('downgrade');
    expect(pending.rows[0]!.status).toBe('pending');
    expect(pending.rows[0]!.target_plan_version_id).toBe(planV3Lower);
    expect(pending.rows[0]!.effective_at).toBe(sub.rows[0]!.current_period_end);
  });

  it('refuses a second pending contraction', async () => {
    const tenant = await provisionFresh('psd');
    expect((await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
      { payload: { planVersionId: planV3Lower } })).status).toBe(200);
    expectRefusal(
      await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
        { payload: { quantity: 1, planVersionId: planV3Lower } }),
      'pending_change_exists');
  });

  it('refuses an unpublished target version', async () => {
    const tenant = await provisionFresh('psf');
    expectRefusal(
      await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
        { payload: { planVersionId: planV4Draft } }),
      'plan_version_not_published');
  });

  it('refuses a no-op rather than splitting the open segment in two', async () => {
    const tenant = await provisionFresh('psg');
    expectRefusal(
      await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
        { payload: { planVersionId: planV1 } }),
      'plan_change_is_a_no_op');
  });

  it('refuses a plan version that does not exist', async () => {
    const tenant = await provisionFresh('psh');
    expectRefusal(
      await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
        { payload: { planVersionId: randomUUID() } }),
      'plan_version_unknown');
  });

  it('refuses a cancelled subscription rather than re-pricing a closed record',
    async () => {
      const tenant = await provisionFresh('psj');
      await db.query(
        `UPDATE platform.subscription SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1`, [tenant.subscriptionId]);
      expectRefusal(
        await control('POST', `/subscriptions/${tenant.subscriptionId}/change`,
          { payload: { planVersionId: planV2Higher } }),
        'subscription_not_live');
    });

  it('refuses read_only', async () => {
    const attempt = await control('POST', `/subscriptions/${base.subscriptionId}/change`,
      { as: { id: readOnlyId, role: 'read_only' }, payload: { planVersionId: planV2Higher } });
    expect(attempt.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ money --- */

describe('the invoice and dunning screens read what the documents say', () => {
  let invoiceTenant: Provisioned;

  beforeAll(async () => {
    invoiceTenant = await provisionFresh('psi');
    // An issued, overdue invoice, WITH its line and its two components: the
    // deferred `invoice_line_consistent` trigger checks the sums and the
    // component set against the declared treatment, so a fixture without them
    // would be a document the schema considers unissuable. `generateInvoice`
    // itself is exercised in tests/billing; what is under test here is the READ.
    const invoiceId = randomUUID();
    const invoiceLineId = randomUUID();
    const segmentId = randomUUID();
    // ONE transaction for the whole document. `invoice_line_consistent` and
    // `invoice_tax_component_consistent` are DEFERRABLE INITIALLY DEFERRED, so
    // they fire at COMMIT -- and on an autocommit connection each INSERT is its
    // own transaction, which means the line would be checked against components
    // that do not exist yet. That is the constraint working, not a nuisance: in
    // production `generateInvoice` writes all of it inside one transaction too.
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO platform.invoice
           (id, tenant_id, subscription_id, financial_year, sequence_no, number,
            period_start, period_end, issue_date, due_date,
            supplier_gstin, supplier_state_code, supplier_legal_name,
            recipient_gstin, recipient_state_code, recipient_legal_name, recipient_address,
            place_of_supply_state_code, tax_treatment, currency,
            subtotal_minor, tax_minor, round_off_minor, total_minor)
         VALUES ($1, $2, $3, '2026-27', 1, $4,
                 '2026-06-01', '2026-07-01', '2026-06-01', '2026-06-08',
                 '29ABCDE1234F1Z5', '29', 'Kat Kitchen Pvt Ltd',
                 NULL, '29', 'Probe Restaurant LLP AS INVOICED', 'Bengaluru',
                 '29', 'intra_state', 'INR', 100000, 18000, 0, 118000)`,
        [invoiceId, invoiceTenant.tenantId, invoiceTenant.subscriptionId,
         `INV/${invoiceTenant.slug.toUpperCase()}/2026-27/000001`]);

      // `invoice_line_shape_exact` requires a segment line to NAME its segment,
      // which is what makes generation idempotent -- so the fixture must have
      // one, and it is written by hand for the same reason the invoice is:
      // provisionTenant opens no segment at all (see the report).
      await db.query(
        `INSERT INTO platform.subscription_segment
           (id, tenant_id, subscription_id, plan_id, plan_version_id, quantity,
            starts_at, ends_at, invoiced_on_invoice_id)
         VALUES ($1, $2, $3, $4, $5, 1, '2026-06-01', '2026-07-01', $6)`,
        [segmentId, invoiceTenant.tenantId, invoiceTenant.subscriptionId,
         planId, planV1, invoiceId]);

      await db.query(
        `INSERT INTO platform.invoice_line
           (id, tenant_id, invoice_id, kind, line_no, segment_id, description, sac_code,
            period_from, period_to, quantity, unit_price_minor, amount_minor)
         VALUES ($1, $2, $3, 'segment', 1, $4, 'Platform Surface Plan x1', '997331',
                 '2026-06-01', '2026-07-01', 1, 100000, 100000)`,
        [invoiceLineId, invoiceTenant.tenantId, invoiceId, segmentId]);

      // CGST and SGST at equal rates, which is what an intra-state invoice has
      // to carry: `assert_invoice_consistent` makes any other component set
      // unissuable, per line.
      for (const name of ['CGST', 'SGST']) {
        await db.query(
          `INSERT INTO platform.invoice_tax_component
             (id, tenant_id, invoice_id, invoice_line_id, name, rate_bps, amount_minor)
           VALUES ($1, $2, $3, $4, $5, 900, 9000)`,
          [randomUUID(), invoiceTenant.tenantId, invoiceId, invoiceLineId, name]);
      }

      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    // And the tax profile now says something else, so a screen that dereferenced
    // it instead of reading the snapshot would be visibly wrong.
    await db.query(
      `UPDATE platform.tenant_tax_profile SET legal_name = 'RENAMED SINCE'
        WHERE tenant_id = $1`, [invoiceTenant.tenantId]);
  });

  it('shows the recipient the INVOICE recorded, not the tenant\'s current name',
    async () => {
      const result = await control('GET', `/invoices?tenantId=${invoiceTenant.tenantId}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const rows = result.body as unknown as Record<string, unknown>[];
      expect(rows.length).toBe(1);
      expect(rows[0]!['recipientLegalName']).toBe('Probe Restaurant LLP AS INVOICED');
      expect(rows[0]!['totalMinor']).toBe(118000);
      expect(rows[0]!['capturedMinor']).toBe(0);
      expect(rows[0]!['overdue'], 'issued and past its due date').toBe(true);
    });

  it('filters to overdue only, and read_only may look', async () => {
    // Scoped to THIS tenant, not paged across the whole install. The first
    // version asked for `limit=200` and asserted its own invoice was somewhere
    // in the page -- which held until the shared dev database accumulated more
    // than two hundred overdue invoices from earlier runs, at which point the
    // test's own tenant fell off the end. The same failure shape as the
    // print-worker suite: a test measuring how much residue the database has.
    const result = await control(
      'GET', `/invoices?overdue=true&tenantId=${invoiceTenant.tenantId}`,
      { as: { id: readOnlyId, role: 'read_only' } });
    expect(result.status).toBe(200);
    const rows = result.body as unknown as Record<string, unknown>[];
    expect(rows.every((row) => row['overdue'] === true)).toBe(true);
    expect(rows.every((row) => row['tenantId'] === invoiceTenant.tenantId)).toBe(true);
    expect(rows.length, 'this tenant has an overdue invoice').toBeGreaterThan(0);
  });

  it('puts the overdue invoice on the dunning queue with a soft-lock countdown',
    async () => {
      const queue = await control('GET', '/dunning');
      expect(queue.status, JSON.stringify(queue.body)).toBe(200);
      const rows = queue.body as unknown as Record<string, unknown>[];
      const mine = rows.find((row) => row['tenantId'] === invoiceTenant.tenantId);
      expect(mine, 'an issued invoice past its due date is the queue').toBeDefined();
      expect(mine!['lastOutreachAt']).toBeNull();
    });

  it('records outreach, which is a WRITE and shows up on the queue', async () => {
    const logged = await control('POST', `/dunning/${invoiceTenant.tenantId}/outreach`,
      { payload: { channel: 'phone', note: 'spoke to the owner; card expired' } });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    expect(logged.body['outreachId']).toBeTruthy();

    const queue = await control('GET', '/dunning');
    const rows = queue.body as unknown as Record<string, unknown>[];
    const mine = rows.find((row) => row['tenantId'] === invoiceTenant.tenantId)!;
    expect(mine['lastOutreachAt'], 'the record is what stops the next person calling again')
      .not.toBeNull();

    // Attributed to the token's subject, and audited on the control plane with
    // the tenant it was about.
    const row = await db.query<{ contacted_by_platform_user_id: string }>(
      `SELECT contacted_by_platform_user_id FROM platform.dunning_outreach
        WHERE id = $1`, [logged.body['outreachId']]);
    expect(row.rows[0]!.contacted_by_platform_user_id).toBe(superAdminId);

    const audit = await db.query<{ target_tenant_id: string | null }>(
      `SELECT target_tenant_id FROM platform.platform_audit_log
        WHERE action = 'dunning.outreach' AND actor_platform_user_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [superAdminId]);
    // The registrar reads :tenantId from the PATH. This is the one audited
    // control-plane route whose URL names the tenant, so it is the only one
    // where this column is populated -- see the report.
    expect(audit.rows[0]!.target_tenant_id).toBe(invoiceTenant.tenantId);
  });

  it('refuses read_only on outreach: the view key is not the write key', async () => {
    // read_only holds platform.payment.view and can see the queue; the outreach
    // route is keyed platform.dunning.outreach precisely so it cannot log a call.
    expect((await control('GET', '/dunning',
      { as: { id: readOnlyId, role: 'read_only' } })).status).toBe(200);
    const attempt = await control('POST', `/dunning/${invoiceTenant.tenantId}/outreach`,
      { as: { id: readOnlyId, role: 'read_only' }, payload: { channel: 'email' } });
    expect(attempt.status).toBe(403);
  });
});

/* --------------------------------------------------------- tax exemption --- */

describe('zero-rating is granted by a platform user, against evidence', () => {
  it('writes the claim with its attribution, which the tenant plane cannot forge',
    async () => {
      const tenant = await provisionFresh('pst');
      const granted = await control('POST', `/tenants/${tenant.tenantId}/tax-exemption`, {
        payload: {
          isSez: true, countryCode: 'IN', lutNumber: 'LUT/2026/44',
          sezLoaNumber: 'LOA/2026/1', evidence: 'Scanned LOA and LUT on file, ticket 5120',
        },
      });
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      expect(granted.body['zeroRated']).toBe(true);
      expect(granted.body['grantedByPlatformUserId']).toBe(superAdminId);

      const row = await db.query<{
        is_sez: boolean; exemption_granted_by_platform_user_id: string;
        exemption_granted_at: string; exemption_evidence: string;
      }>(
        `SELECT is_sez, exemption_granted_by_platform_user_id,
                exemption_granted_at::text, exemption_evidence
           FROM platform.tenant_tax_profile WHERE tenant_id = $1`, [tenant.tenantId]);
      expect(row.rows[0]!.is_sez).toBe(true);
      expect(row.rows[0]!.exemption_granted_by_platform_user_id).toBe(superAdminId);
      expect(row.rows[0]!.exemption_evidence).toContain('ticket 5120');
    });

  it('is refused by the schema when the undertaking is missing, and names the constraint',
    async () => {
      const tenant = await provisionFresh('psu');
      const refused = await control('POST', `/tenants/${tenant.tenantId}/tax-exemption`, {
        payload: { isSez: true, evidence: 'a claim with no undertaking behind it' },
      });
      // NOT validated twice. `tenant_exemption_attributed` is the authority --
      // it demands the LUT, the LOA and the attribution together -- and a copy
      // of that rule here would be a copy that drifts from it. What the client
      // gets is the constraint NAME (a stable schema identifier) and not the
      // row values from the trigger's message.
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('invariant_refused');
      expect(String(refused.body['detail'])).toContain('tenant_exemption_attributed');

      const row = await db.query<{ is_sez: boolean }>(
        `SELECT is_sez FROM platform.tenant_tax_profile WHERE tenant_id = $1`,
        [tenant.tenantId]);
      expect(row.rows[0]!.is_sez, 'nothing partially applied').toBe(false);
    });

  it('refuses a tenant with no tax profile at all', async () => {
    const client = await pool.connect();
    let bare: string;
    try {
      await client.query('BEGIN');
      const key = `psv-${randomUUID()}`;
      const result = await provisionTenant(client, {
        idempotencyKey: key, slug: `psv${key.slice(4, 14).replace(/-/g, '')}`,
        name: 'No Profile', currency: 'INR', timezone: 'Asia/Kolkata',
        ownerEmail: `${key}@o.test`, ownerName: 'Owner', firstBranchName: 'Main',
        planVersionId: planV1, requestedByPlatformUserId: superAdminId,
        // Required, no default: see ProvisionRequest.taxJurisdiction.
        taxJurisdiction: 'IN',
      });
      await client.query('COMMIT');
      bare = result.tenantId;
    } finally {
      client.release();
    }
    expectRefusal(
      await control('POST', `/tenants/${bare}/tax-exemption`,
        { payload: { isSez: true, lutNumber: 'LUT/1', evidence: 'evidence enough' } }),
      'no_tax_profile');
  });

  it('refuses read_only, which does not hold platform.tenant.edit', async () => {
    const attempt = await control('POST', `/tenants/${base.tenantId}/tax-exemption`,
      { as: { id: readOnlyId, role: 'read_only' },
        payload: { isSez: false, evidence: 'nothing to see' } });
    expect(attempt.status).toBe(403);
  });
});

/* ------------------------------------------------------------- the lists --- */

describe('the tenant and plan lists answer from the control plane alone', () => {
  it('lists the provisioned tenant with its live subscription and plan', async () => {
    const result = await control('GET', `/tenants?search=${base.slug}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const rows = result.body as unknown as Record<string, unknown>[];
    const mine = rows.find((row) => row['tenantId'] === base.tenantId);
    expect(mine, 'the search must find it by slug').toBeDefined();
    expect(mine!['status']).toBe('active');
    expect(mine!['delinquentSince'], 'active means no ladder clock').toBeNull();
    expect(mine!['subscriptionStatus']).toBe('trialing');
    expect(mine!['planVersion']).toBe(1);
    expect(mine!['impersonable']).toBe(true);
  });

  /**
   * `sales` holds the same unscoped `platform.tenant.view` key as every other
   * role -- the scoping lives in the read model, not the catalogue, because
   * there is exactly one role this applies to today. Proven with two
   * DIFFERENT salespeople so the fixture cannot pass by accident: a bug that
   * showed every tenant to every sales user would still pass a test using
   * only one.
   */
  it('scopes a Salesperson to the restaurants THEY provisioned, and nobody else\'s',
    async () => {
      const salesA = await platformUser('sales', 'Rep A');
      const salesB = await platformUser('sales', 'Rep B');
      const prefix = `slscope${randomUUID().slice(0, 6)}`;

      function payload(slug: string): Record<string, unknown> {
        return {
          slug, name: 'Sales Scope Probe', currency: 'INR', timezone: 'Asia/Kolkata',
          ownerEmail: `${slug}@owner.test`, ownerName: 'Owner', firstBranchName: 'Main',
          planVersionId: planV1, taxJurisdiction: 'IN',
        };
      }

      const slugA = `${prefix}a`;
      const slugB = `${prefix}b`;
      const madeA = await control('POST', '/tenants', {
        as: { id: salesA, role: 'sales' },
        payload: payload(slugA), idempotencyKey: `idem-${randomUUID()}`,
      });
      const madeB = await control('POST', '/tenants', {
        as: { id: salesB, role: 'sales' },
        payload: payload(slugB), idempotencyKey: `idem-${randomUUID()}`,
      });
      expect(madeA.status, JSON.stringify(madeA.body)).toBe(200);
      expect(madeB.status, JSON.stringify(madeB.body)).toBe(200);

      const seenByA = await control('GET', `/tenants?search=${prefix}`,
        { as: { id: salesA, role: 'sales' } });
      const slugsA = (seenByA.body as unknown as Record<string, unknown>[])
        .map((row) => row['slug']);
      expect(slugsA).toContain(slugA);
      expect(slugsA, 'Rep A must not see what Rep B provisioned').not.toContain(slugB);

      const seenByB = await control('GET', `/tenants?search=${prefix}`,
        { as: { id: salesB, role: 'sales' } });
      const slugsB = (seenByB.body as unknown as Record<string, unknown>[])
        .map((row) => row['slug']);
      expect(slugsB).toContain(slugB);
      expect(slugsB, 'Rep B must not see what Rep A provisioned').not.toContain(slugA);

      // Unaffected: super_admin's read stays unscoped and sees both.
      const seenBySuperAdmin = await control('GET', `/tenants?search=${prefix}`);
      const slugsSuper = (seenBySuperAdmin.body as unknown as Record<string, unknown>[])
        .map((row) => row['slug']);
      expect(slugsSuper).toEqual(expect.arrayContaining([slugA, slugB]));
    });

  it('caps the page however large a limit is asked for', async () => {
    const result = await control('GET', '/tenants?limit=100000');
    const rows = result.body as unknown as Record<string, unknown>[];
    expect(rows.length).toBeLessThanOrEqual(200);
  });

  it('filters by ladder status', async () => {
    const result = await control('GET', '/tenants?status=purged');
    const rows = result.body as unknown as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row['status'] === 'purged')).toBe(true);
    expect(rows.every((row) => row['impersonable'] === false)).toBe(true);
  });

  it('lists plan versions with how many live subscriptions sit on each', async () => {
    const result = await control('GET', '/plans',
      { as: { id: readOnlyId, role: 'read_only' } });
    expect(result.status).toBe(200);
    const plans = result.body as unknown as Record<string, unknown>[];
    const mine = plans.find((plan) => plan['planId'] === planId);
    expect(mine).toBeDefined();
    const versions = mine!['versions'] as Record<string, unknown>[];
    expect(versions.map((v) => v['version'])).toEqual([1, 2, 3, 4]);
    // The draft is listed and marked, not hidden: a version nobody can be sold
    // is still a version somebody has to publish.
    expect(versions[3]!['publishedAt']).toBeNull();
    // Every tenant this suite provisioned starts on v1, so nobody can claim the
    // count is trivially zero.
    expect(Number(versions[0]!['liveSubscriptions'])).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------- the system --- */

describe('system health reports what it actually looked at', () => {
  it('lists every registry job, and counts a job that never ran as overdue',
    async () => {
      const result = await control('GET', '/system/jobs',
        { as: { id: readOnlyId, role: 'read_only' } });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const jobs = result.body['jobs'] as Record<string, unknown>[];
      // Derived from the REGISTRY, not from platform.job_run: a job that never
      // ran writes no rows, and that is the case that matters.
      expect(jobs.map((job) => job['job']).sort()).toEqual(JOBS.map((j) => j.name).sort());
      const never = jobs.filter((job) => job['lastSuccessAt'] === null);
      expect(never.length).toBeGreaterThan(0);
      expect(never.every((job) => job['overdue'] === true)).toBe(true);
      expect(result.body['overdue'] as string[]).toEqual(
        expect.arrayContaining(never.map((job) => job['job'])));
    });

  it('names the role it probed as, and does not pretend to have run the pooling probe',
    async () => {
      const result = await control('GET', '/system/health');
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body['databaseRole']).toBe('katkitchen_owner');

      const checks = result.body['checks'] as Record<string, unknown>[];
      const byName = new Map(checks.map((check) => [check['name'], check]));
      expect([...byName.keys()].sort()).toEqual([
        'audit_logs_append_only', 'audit_partitions_present', 'ladder_cache_agrees',
        'outbox_draining', 'rls_applies_to_request_role', 'rls_not_bypassed',
        'transaction_scoped_pooling',
      ]);

      // The probe that cannot run inside a request transaction says so, rather
      // than being silently dropped from a report an operator reads as complete.
      expect(byName.get('transaction_scoped_pooling')!['state']).toBe('not_probed');
      expect(String(byName.get('transaction_scoped_pooling')!['detail']))
        .toContain('BEGIN/COMMIT');
      // Every check carries something an operator can act on, ok included.
      expect(checks.every((check) => String(check['detail']).length > 10)).toBe(true);
    });

  it('is not vacuous: the posture checks FIRE for a role RLS does not apply to',
    async () => {
      // This suite connects as katkitchen_owner, which owns schema app and can
      // UPDATE the audit logs. In production the request pool is katkitchen_app
      // and both of these read `ok` -- so running as the owner is what
      // demonstrates the failing direction, which is the direction that has
      // never been observed for a check nobody has shown to work.
      const result = await control('GET', '/system/health');
      const checks = result.body['checks'] as Record<string, unknown>[];
      const byName = new Map(checks.map((check) => [check['name'], check]));

      expect(byName.get('rls_applies_to_request_role')!['state']).toBe('failed');
      expect(String(byName.get('rls_applies_to_request_role')!['detail']))
        .toContain('owns');
      expect(byName.get('audit_logs_append_only')!['state']).toBe('failed');
      // And the one that is genuinely fine for this role is not swept up with them.
      expect(byName.get('rls_not_bypassed')!['state']).toBe('ok');
      // The headline is the worst check, never the best.
      expect(result.body['state']).toBe('failed');
    });

  it('writes no audit row for a read, because both system routes declare none',
    async () => {
      const before = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform.platform_audit_log`);
      await control('GET', '/system/health');
      await control('GET', '/system/jobs');
      await control('GET', '/tenants');
      const after = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform.platform_audit_log`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });
});
