import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { planeGuard } from '../../src/middleware/security/planeGuards.js';
import {
  registerTenantRoute, resetRegistry, leasedOn, MUTATING_METHODS,
} from '../../src/middleware/routeRegistry.js';
import { requiresIdempotency, POS_POST_READS } from '../../src/middleware/posHeaders.js';
import { toErrorResponse } from '../../src/utils/errors/errors.js';
import { requireIdempotencyKey, requireLeaseToken } from '../../src/middleware/posHeaders.js';
import { posRoutes } from '../../src/routes/pos.js';
import { withTenantTransaction } from '../../src/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/database/tenantContext.js';
import { claimLease, renewLease, releaseLease, forceReleaseLease } from '../../src/modules/offline/lease.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

/**
 * The lease is enforced on the ONLINE path, and this file is the gate.
 *
 * ###########################################################################
 * WHAT THIS FILE EXISTS BECAUSE OF.
 *
 * Thirteen POS routes declared `lease: 'required'`. `requireLease` -- the guard
 * that resolves the row and refuses -- had exactly one caller in the entire
 * tree, and it was a test. The header-presence check in app.ts read
 * `config.posLease`, which the registrar never set, so `undefined !== 'required'`
 * was quietly false on every request: the declaration was read by nothing that
 * ran. A device whose session had just been force-released could keep adding
 * lines over HTTP indefinitely, which is precisely the window force release
 * creates and precisely what it assumes is closed.
 *
 * That is the fifth gate family: code that exists, is correct, is tested in
 * isolation, and is joined to the running system by nothing. So the assertions
 * here are not "the guard rejects a bad lease" -- the unit tests in
 * tests/offline/offlinePos.test.ts already said that, truthfully, while
 * production was unguarded. They are "a request through the registrar does not
 * reach a handler without a live lease", and every one of them checks the
 * HANDLER-REACHED flag rather than only the status code.
 * ###########################################################################
 */

const KEY = 'lease-enforcement-signing-key';
const DATE = '2026-04-01';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let tenantId: string, branchId: string, userId: string;
let deviceA: string, deviceB: string, reasonId: string;

/** Set by the synthetic handlers. The assertion that matters. */
let reached: string[] = [];
let seenDeviceId: string | null = null;

const ctx = (): TenantContext => peekTenantContext()!;
const tx = <T>(fn: () => Promise<T>) => withTenantTransaction(pool, tenantId, fn);

function token(): string {
  return signToken(
    { sub: userId, tenant_id: tenantId, branch_id: branchId,
      exp: Math.floor(Date.now() / 1000) + 600 },
    KEY,
  );
}

async function makeSessionWithOrder(): Promise<{ sessionId: string; orderId: string }> {
  const sessionId = randomUUID();
  const orderId = randomUUID();
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,$5)`, [sessionId, tenantId, branchId, DATE, userId]);
  await owner.query(
    `INSERT INTO app.sales_order
       (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6)`,
    [orderId, tenantId, branchId, sessionId, DATE, userId]);
  return { sessionId, orderId };
}

async function makeDevice(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.device (id,tenant_id,branch_id,name,fingerprint,registered_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, tenantId, branchId, name, randomUUID().replace(/-/g, ''), userId]);
  return id;
}

async function claim(sessionId: string, deviceId: string): Promise<string> {
  const lease = await tx(() => claimLease(ctx(), { sessionId, deviceId, branchId }));
  return lease.token;
}

interface Sent {
  readonly status: number;
  readonly error: string | null;
  readonly reached: boolean;
}

async function send(
  url: string,
  options: { leaseToken?: string | null } = {},
): Promise<Sent> {
  reached = [];
  seenDeviceId = null;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token()}`,
    'idempotency-key': randomUUID(),
    'content-type': 'application/json',
  };
  if (options.leaseToken !== undefined && options.leaseToken !== null) {
    headers['x-lease-token'] = options.leaseToken;
  }
  const response = await app.inject({ method: 'POST', url, headers, payload: {} });
  const body = response.json() as Record<string, unknown>;
  return {
    status: response.statusCode,
    error: typeof body['error'] === 'string' ? body['error'] : null,
    reached: reached.length > 0,
  };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `lease+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'lease_plan','Lease')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='lease_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `lse-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `l${key.slice(4, 12)}`, name: 'Lease Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@l.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }

  // Provisioning leaves the owner INVITED; an invited user resolves to no
  // actor and every route answers 403, which would make this whole file pass
  // for the wrong reason.
  await owner.query(`UPDATE app.app_user SET status = 'active' WHERE id = $1`, [userId]);

  deviceA = await makeDevice('Terminal A');
  deviceB = await makeDevice('Terminal B');
  reasonId = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
     VALUES ($1,$2,'dead_tablet','Tablet unresponsive')`, [reasonId, tenantId]);

  resetRegistry();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    void reply.code(status).send(body);
  });
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', KEY));
    // The production hook, verbatim in shape: idempotency and the token's
    // PRESENCE before a pooled connection is taken.
    scope.addHook('onRequest', async (request) => {
      const config = request.routeOptions.config as { posLease?: unknown } | undefined;
      if (MUTATING_METHODS.includes(request.method as never)) {
        requireIdempotencyKey(request);
      }
      if (config?.posLease !== undefined && config.posLease !== 'exempt') {
        requireLeaseToken(request, request.url);
      }
    });

    const record = (label: string) =>
      async (request: Parameters<Parameters<typeof registerTenantRoute>[2]['handler']>[0]) => {
        reached.push(label);
        seenDeviceId = request.heldLease?.deviceId ?? null;
        return { ok: true };
      };

    // Leased on the ORDER: the shape the defect lived in.
    registerTenantRoute(scope, { pool }, {
      method: 'POST', plane: 'tenant', url: '/pos/probe/order/:id/line',
      lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: 'none', handler: record('order'),
    });
    // Leased on the SESSION.
    registerTenantRoute(scope, { pool }, {
      method: 'POST', plane: 'tenant', url: '/pos/probe/session/:id/thing',
      lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: 'none', handler: record('session'),
    });
    // Echoes a per-call stamp, so a replay can be told apart from a re-run by
    // the RESULT rather than only by a flag this file sets.
    registerTenantRoute(scope, { pool }, {
      method: 'POST', plane: 'tenant', url: '/pos/probe/order/:id/echo',
      lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: 'none',
      handler: async (request) => {
        reached.push('echo');
        seenDeviceId = request.heldLease?.deviceId ?? null;
        return { stamp: randomUUID() };
      },
    });

    // Writes, then throws. The claim must roll back with the write.
    registerTenantRoute(scope, { pool }, {
      method: 'POST', plane: 'tenant', url: '/pos/probe/order/:id/explode',
      lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: 'none',
      handler: async () => {
        reached.push('explode');
        throw new Error('the handler failed after the claim was taken');
      },
    });

    // A READ. Carries no key and must not be gated on one.
    registerTenantRoute(scope, { pool }, {
      method: 'GET', plane: 'tenant', url: '/pos/probe/order/:id/read',
      lease: 'exempt',
      permission: { plane: 'tenant', key: 'order.view' },
      audit: 'none',
      handler: async () => ({ ok: true }),
    });

    // THE SYNTHETIC VIOLATION. Same path shape, same handler, `exempt`. If this
    // one is refused, the gate is measuring the URL rather than the declaration;
    // if the leased ones pass unguarded, the declaration does nothing. Both
    // halves are needed for either to mean anything.
    registerTenantRoute(scope, { pool }, {
      method: 'POST', plane: 'tenant', url: '/pos/probe/exempt/order/:id/line',
      lease: 'exempt',
      permission: { plane: 'tenant', key: 'order.create' },
      audit: 'none', handler: record('exempt'),
    });
  }, { prefix: '/api/t' });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

/* ------------------------------------------------------------------------- */

describe('a leased route does not reach its handler without a live lease', () => {
  it('refuses a missing token before it takes a connection', async () => {
    const { orderId } = await makeSessionWithOrder();
    const result = await send(`/api/t/pos/probe/order/${orderId}/line`);
    expect(result.status).toBe(400);
    expect(result.error).toBe('lease_token_required');
    expect(result.reached, 'the handler must not have run').toBe(false);
  });

  it('refuses a token that names no lease, malformed or merely absent', async () => {
    const { orderId } = await makeSessionWithOrder();
    for (const bogus of ['not-a-uuid-at-all', randomUUID()]) {
      const result = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken: bogus });
      expect(result.status, bogus).toBe(409);
      expect(result.error, bogus).toBe('lease_token_unknown');
      expect(result.reached, bogus).toBe(false);
    }
  });

  it('refuses a live lease held on a DIFFERENT session', async () => {
    const mine = await makeSessionWithOrder();
    const theirs = await makeSessionWithOrder();
    const theirToken = await claim(theirs.sessionId, deviceB);

    const result = await send(`/api/t/pos/probe/order/${mine.orderId}/line`,
      { leaseToken: theirToken });
    expect(result.status).toBe(409);
    expect(result.error).toBe('lease_subject_mismatch');
    expect(result.reached).toBe(false);
  });

  it('admits a live lease on the right session, and hands the handler the ROW', async () => {
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);

    const result = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken });
    expect(result.status).toBe(200);
    expect(result.reached).toBe(true);
    // Not from the body. The device comes from the lease row, so a request
    // cannot borrow another terminal's identity by naming it.
    expect(seenDeviceId).toBe(deviceA);
  });

  it('refuses a released lease', async () => {
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    await tx(() => releaseLease(ctx(), { sessionId, deviceId: deviceA }));

    const result = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken });
    expect(result.status).toBe(409);
    expect(result.error).toBe('lease_token_unknown');
    expect(result.reached).toBe(false);
  });

  it('refuses a FORCE-released lease -- the case the whole mechanism is for', async () => {
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    await tx(() => forceReleaseLease(ctx(), { sessionId, byUserId: userId, reasonId }));

    // The stranded tablet's connection comes back and it replays. Before this
    // was enforced, this request succeeded -- and force release exists on the
    // assumption that it does not.
    const result = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken });
    expect(result.status).toBe(409);
    expect(result.reached, 'a force-released device must not write online').toBe(false);
  });

  it('refuses an expired lease, on SERVER time', async () => {
    const { sessionId, orderId } = await makeSessionWithOrder();
    // Inserted already-expired rather than wound back: claimed_at and
    // expires_at are both immutable by trigger ("a lease cannot be reassigned",
    // "a lease cannot be shortened"), so there is no way to shorten a live
    // lease even as the owner -- which is the design working, and it means an
    // expiry fixture has to be born old.
    const leaseToken = randomUUID();
    await owner.query(
      `INSERT INTO app.table_session_lease
         (id, session_id, tenant_id, branch_id, device_id, token,
          claimed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               now() - interval '2 hours', now() - interval '105 minutes')`,
      [randomUUID(), sessionId, tenantId, branchId, deviceA, leaseToken]);

    const result = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken });
    expect(result.status).toBe(409);
    expect(result.error).toBe('lease_token_unknown');
    expect(result.reached).toBe(false);
  });

  it('resolves the session subject directly too', async () => {
    const { sessionId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    const ok = await send(`/api/t/pos/probe/session/${sessionId}/thing`, { leaseToken });
    expect(ok.reached).toBe(true);

    const wrong = await makeSessionWithOrder();
    const bad = await send(`/api/t/pos/probe/session/${wrong.sessionId}/thing`, { leaseToken });
    expect(bad.error).toBe('lease_subject_mismatch');
    expect(bad.reached).toBe(false);
  });

  it('404s a subject that does not exist, without leaking whether the lease was good',
    async () => {
      const { sessionId } = await makeSessionWithOrder();
      const leaseToken = await claim(sessionId, deviceA);
      const result = await send(`/api/t/pos/probe/order/${randomUUID()}/line`, { leaseToken });
      expect(result.status).toBe(404);
      expect(result.error).toBe('lease_subject_not_found');
      expect(result.reached).toBe(false);
    });

  // ---- the synthetic violation -------------------------------------------
  it('lets the EXEMPT twin through with no token at all', async () => {
    const { orderId } = await makeSessionWithOrder();
    const result = await send(`/api/t/pos/probe/exempt/order/${orderId}/line`);
    expect(result.status, 'the exemption is what makes the refusals meaningful').toBe(200);
    expect(result.reached).toBe(true);
    expect(seenDeviceId, 'an exempt route holds no lease to read a device from').toBeNull();
  });
});

describe('the token is a lease EPOCH, which is what the client queue assumes', () => {
  it('survives renewal unchanged', async () => {
    const { sessionId } = await makeSessionWithOrder();
    const first = await claim(sessionId, deviceA);
    const renewed = await tx(() => renewLease(ctx(), { sessionId, deviceId: deviceA }));
    // A terminal renewing mid-service must not have to re-plumb its queue.
    expect(renewed.token).toBe(first);
  });

  it('changes when the lease is released and re-claimed by the SAME device', async () => {
    const { sessionId } = await makeSessionWithOrder();
    const first = await claim(sessionId, deviceA);
    await tx(() => releaseLease(ctx(), { sessionId, deviceId: deviceA }));
    const second = await claim(sessionId, deviceA);

    // This is the whole reason the device id could not be the credential: it is
    // identical across both claims, so operations queued before the release
    // would look valid after it.
    expect(second).not.toBe(first);
  });

  it('leaves an operation queued under the old epoch refusable after force release',
    async () => {
      const { sessionId, orderId } = await makeSessionWithOrder();
      const stranded = await claim(sessionId, deviceA);
      await tx(() => forceReleaseLease(ctx(), { sessionId, byUserId: userId, reasonId }));
      // The manager hands the table to another terminal.
      const fresh = await claim(sessionId, deviceB);
      expect(fresh).not.toBe(stranded);

      const replay = await send(`/api/t/pos/probe/order/${orderId}/line`,
        { leaseToken: stranded });
      expect(replay.reached, 'the old epoch must stay dead after a re-grant').toBe(false);
      const live = await send(`/api/t/pos/probe/order/${orderId}/line`, { leaseToken: fresh });
      expect(live.reached).toBe(true);
    });
});

describe('every leased production route is reachable by the guard', () => {
  it('declares a subject the registrar can resolve', () => {
    const leased = posRoutes().filter(
      (r) => r.lease !== undefined && r.lease !== 'exempt');
    expect(leased.length).toBeGreaterThanOrEqual(13);
    for (const route of leased) {
      const lease = route.lease as Exclude<typeof route.lease, 'exempt' | undefined>;
      // A param-sourced subject must actually appear in the URL, or the
      // registrar would 400 every request to it -- a refusal so total it would
      // look like the route was never built.
      if (lease.at.in === 'param') {
        expect(route.url, route.url).toContain(`:${lease.at.name}`);
      }
    }
  });
});

/* --------------------------------------------------- the idempotency key --- */

describe('a POS mutation claims its idempotency key, or does not run twice', () => {
  /**
   * ###########################################################################
   * TWELVE ROUTES REQUIRED THE KEY AND ONE CONSUMED IT.
   *
   * `app.request_claim` is hash-partitioned with a retention policy;
   * `claimOrReplay` takes a SAVEPOINT so the loser of a concurrent duplicate can
   * read the winner's answer rather than only roll back; `recordClaimResult`
   * stores the result so a retry replays it verbatim. All of it built, all of it
   * tested, and its callers were `fireOrder` and the offline batch. The other
   * eleven POS mutations validated that the header was present and discarded it.
   *
   * The client is built on the opposite assumption: the pump retries with the
   * SAME key on every offline failure -- the POS's design condition, not an edge
   * case -- and the queue mints the key at enqueue precisely so that is safe.
   *
   * Measured over HTTP before this was wired:
   *   addLine twice under one key      -> two different line ids
   *   a PARTIAL tender under one key   -> two tender rows, and a bill claiming
   *                                       630.00 arrived when 315.00 was handed over
   *
   * The FULL-tender case was caught by `assert_billing_invariants`, because
   * paying past the total violates it. That is luck: a partial tender exceeds
   * nothing, so nothing looked at it. A defence that only works when the amount
   * happens to be large enough is not a defence.
   *
   * The claim now happens in the registrar, driven by the route declaration,
   * next to the header requirement it was always supposed to pair with.
   * ###########################################################################
   */

  async function twice(url: string, payload: Record<string, unknown>, leaseToken: string):
  Promise<{ first: Sent; second: Sent; key: string }> {
    const key = randomUUID();
    const send = async (): Promise<Sent> => {
      reached = [];
      const response = await app.inject({
        method: 'POST', url,
        headers: {
          authorization: `Bearer ${token()}`,
          'idempotency-key': key,
          'x-lease-token': leaseToken,
          'content-type': 'application/json',
        },
        payload,
      });
      const body = response.json() as Record<string, unknown>;
      return {
        status: response.statusCode,
        error: typeof body['error'] === 'string' ? body['error'] : null,
        reached: reached.length > 0,
      };
    };
    return { first: await send(), second: await send(), key };
  }

  it('runs the handler ONCE for two requests carrying the same key', async () => {
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);

    const { first, second } = await twice(
      `/api/t/pos/probe/order/${orderId}/line`, { menuItemId: 'x', quantity: 1 }, leaseToken);

    expect(first.status).toBe(200);
    expect(first.reached, 'the first request runs').toBe(true);
    expect(second.status).toBe(200);
    // The whole point: the second request does NOT reach the handler. A second
    // insert is what produced two line ids from one tap.
    expect(second.reached, 'the second must be replayed, not re-run').toBe(false);
  });

  it('replays the STORED RESULT, not merely a 200', async () => {
    // A retry that gets `{ok:true}` where the original got a line id leaves the
    // client unable to reference what it created.
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    const key = randomUUID();

    const call = async (): Promise<Record<string, unknown>> => {
      const response = await app.inject({
        method: 'POST', url: `/api/t/pos/probe/order/${orderId}/echo`,
        headers: {
          authorization: `Bearer ${token()}`,
          'idempotency-key': key,
          'x-lease-token': leaseToken,
          'content-type': 'application/json',
        },
        payload: { menuItemId: 'x', quantity: 2 },
      });
      return response.json() as Record<string, unknown>;
    };

    const first = await call();
    const second = await call();
    expect(typeof first['stamp']).toBe('string');
    expect(second['stamp'], 'the replay carries the original result').toBe(first['stamp']);
  });

  it('refuses the same key used for a DIFFERENT payload', async () => {
    // Never silently apply the second payload: the client believes two different
    // writes are the same one, and applying either is wrong.
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    const key = randomUUID();

    const send = async (quantity: number): Promise<number> => {
      const response = await app.inject({
        method: 'POST', url: `/api/t/pos/probe/order/${orderId}/line`,
        headers: {
          authorization: `Bearer ${token()}`,
          'idempotency-key': key,
          'x-lease-token': leaseToken,
          'content-type': 'application/json',
        },
        payload: { menuItemId: 'x', quantity },
      });
      return response.statusCode;
    };

    expect(await send(1)).toBe(200);
    expect(await send(9)).toBe(409);
  });

  it('stores the claim only if the mutation commits', async () => {
    // A stored result for a rolled-back write would replay a mutation that never
    // happened -- the worst of the three outcomes, because the client would stop
    // retrying the thing that still needs doing.
    const { sessionId, orderId } = await makeSessionWithOrder();
    const leaseToken = await claim(sessionId, deviceA);
    const key = randomUUID();

    const boom = await app.inject({
      method: 'POST', url: `/api/t/pos/probe/order/${orderId}/explode`,
      headers: {
        authorization: `Bearer ${token()}`,
        'idempotency-key': key,
        'x-lease-token': leaseToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(boom.statusCode).toBeGreaterThanOrEqual(500);

    const stored = await owner.query(
      `SELECT 1 FROM app.request_claim WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key]);
    expect(stored.rowCount, 'the claim rolled back with the mutation').toBe(0);
  });

  it('covers every POS mutation in the REAL route table', () => {
    // The predicate keys on the URL, which is geography -- so the coverage is
    // asserted against the real table rather than trusted. Every mutating POS
    // route must satisfy it, and every read must not.
    const uncovered: string[] = [];
    const overreaching: string[] = [];
    for (const route of posRoutes()) {
      const covered = requiresIdempotency(route.method, `/api/t${route.url}`);
      // A POST that mutates nothing is a read for this rule's purposes, and the
      // exception is read from the SAME constant the predicate uses -- so the
      // two cannot disagree, which is the failure the predicate's own note is
      // about. `/pos/customer/lookup` is the one: a POST only because a diner's
      // phone must not travel in a URL.
      const mutating = MUTATING_METHODS.includes(route.method)
        && !POS_POST_READS.includes(route.url);
      if (mutating && !covered) uncovered.push(`${route.method} ${route.url}`);
      if (!mutating && covered) overreaching.push(`${route.method} ${route.url}`);
    }
    expect(uncovered, 'these POS mutations would not claim their key').toEqual([]);
    expect(overreaching, 'a read must not be gated on a key').toEqual([]);
    // Not vacuous: there really are mutations to cover.
    expect(posRoutes().filter((r) => MUTATING_METHODS.includes(r.method)).length)
      .toBeGreaterThan(12);
  });

  it('does not claim on a route that is not a POS mutation', async () => {
    // The rule is declaration-driven, and the declaration is the URL prefix plus
    // the method. A GET carries no key and must not be gated on one.
    const { orderId } = await makeSessionWithOrder();
    const response = await app.inject({
      method: 'GET', url: `/api/t/pos/probe/order/${orderId}/read`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
