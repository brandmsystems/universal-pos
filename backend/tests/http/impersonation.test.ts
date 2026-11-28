import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { checkPlane, planeGuard } from '../../src/middleware/security/planeGuards.js';
import { impersonationGuard } from '../../src/middleware/security/impersonationGuard.js';
import { registerTenantRoute, resetRegistry } from '../../src/middleware/routeRegistry.js';
import { BranchRepository } from '../../src/database/repositories.js';
import {
  impersonationPosture,
  loadLiveSession,
  revokeImpersonation,
  startImpersonation,
  TenantNotImpersonableError,
} from '../../src/modules/platform/impersonation.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz } from '../../src/modules/authz/seed.js';

const KEY = 'impersonation-suite-key';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let handlerReached: string[] = [];

let tenantId: string;
let branchId: string;
let superAdminId: string;
let planVersionId: string;

const branches = new BranchRepository();

async function provisionFresh(): Promise<{ tenantId: string; branchId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `imp-${randomUUID()}`;
    const result = await provisionTenant(client, {
      idempotencyKey: key,
      slug: `i${key.slice(4, 12)}`,
      name: 'Impersonation Probe',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner',
      firstBranchName: 'Main',
      planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    return { tenantId: result.tenantId, branchId: result.firstBranchId };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });

  await seedPlatformAuthz(owner);

  const roleId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`,
    )
  ).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Support Agent', $3)`,
    [superAdminId, `support+${superAdminId}@platform.test`, roleId],
  );

  const planId = randomUUID();
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'imp_plan', 'Imp Plan')
     ON CONFLICT (key) DO NOTHING`,
    [planId],
  );
  const actualPlanId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.plan WHERE key = 'imp_plan'`)
  ).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, 1, 100000, 'INR', 'monthly', now())
     ON CONFLICT (plan_id, version) DO NOTHING`,
    [randomUUID(), actualPlanId],
  );
  planVersionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id = $1 AND version = 1`,
      [actualPlanId],
    )
  ).rows[0]!.id;

  ({ tenantId, branchId } = await provisionFresh());

  resetRegistry();
  app = Fastify();

  app.register(
    async (scope) => {
      scope.addHook('onRequest', planeGuard('tenant', KEY));
      scope.get('/branches', {}, async () => {
        handlerReached.push('direct');
        return { ok: true };
      });
    },
    { prefix: '/api/t' },
  );

  app.register(
    async (scope) => {
      scope.addHook('onRequest', planeGuard('platform', KEY));
      scope.get('/tenants', {}, async () => {
        handlerReached.push('platform');
        return { ok: true };
      });
    },
    { prefix: '/api/platform' },
  );

  app.register(
    async (scope) => {
      scope.addHook('onRequest', impersonationGuard(pool, KEY));

      registerTenantRoute(scope, { pool }, {
        method: 'GET',
        plane: 'tenant' as const,
        url: '/branches',
        audit: { action: 'branch.viewed', target: 'branch' },
        handler: async (_request, _reply, _context) => {
          handlerReached.push('impersonated-read');
          return branches.findMany();
        },
      });

      for (const [url, permission] of [
        ['/collect', 'payment.collect'],
        ['/void', 'order.void'],
        ['/roles', 'role.create'],
      ] as const) {
        registerTenantRoute(scope, { pool }, {
          method: 'POST',
          plane: 'tenant' as const,
          url,
          permission: { plane: 'tenant' as const, key: permission },
          audit: { action: `probe${url.replace('/', '.')}`, target: 'probe' },
          handler: async () => {
            handlerReached.push(`out-of-scope:${permission}`);
            return { ok: true };
          },
        });
      }

      registerTenantRoute(scope, { pool }, {
        method: 'GET',
        plane: 'tenant' as const,
        url: '/customers/:id/contact',
        permission: { plane: 'tenant' as const, key: 'customer.pii.view' as const },
        audit: { action: 'customer.pii.viewed', target: 'customer' },
        handler: async () => {
          handlerReached.push('out-of-scope:customer.pii.view');
          return { phone: 'x' };
        },
      });

      registerTenantRoute(scope, { pool }, {
        method: 'PATCH',
        plane: 'tenant' as const,
        url: '/branches/:id',
        audit: {
          action: 'branch.renamed',
          target: 'branch',
          targetId: (r) => (r.params as { id: string }).id,
          lock: { repository: branches, id: (r) => (r.params as { id: string }).id },
        },
        handler: async (request) => {
          handlerReached.push('impersonated-write');
          const { id } = request.params as { id: string };
          const { name } = request.body as { name: string };
          await branches.update({ id }, { name });
          return { ok: true };
        },
      });
    },
    { prefix: '/api/t/impersonated' },
  );

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

async function start(overrides: Partial<Parameters<typeof startImpersonation>[2]> = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const started = await startImpersonation(client, KEY, {
      tenantId,
      platformUserId: superAdminId,
      reasonCode: 'support_ticket',
      reasonDetail: 'ticket 4711: KDS not showing fired tickets',
      minutes: 30,
      ...overrides,
    });
    await client.query('COMMIT');
    return started;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('the 60-minute cap lives on the row, not the token', () => {
  it('rejects a session longer than an hour at insert', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform.impersonation_session
           (id, tenant_id, platform_user_id, reason_code, reason_detail, expires_at)
         VALUES ($1, $2, $3, 'incident', 'a detail long enough to pass', now() + interval '8 hours')`,
        [randomUUID(), tenantId, superAdminId],
      ),
    ).rejects.toThrow(/impersonation_max_60_minutes/);
  });

  it('clamps a request for longer rather than issuing it', async () => {
    const started = await start({ minutes: 600 });

    // Measured SERVER-SIDE, against the row's own created_at.
    //
    // Comparing expires_at to the client's Date.now() compares a server clock to
    // a host clock, and those differ by tens of milliseconds through a Docker VM
    // -- in whichever direction the VM has drifted. That made this assertion flaky
    // at exactly the 60-minute boundary it was testing. It is also the wrong
    // relationship: the cap lives on the ROW as
    // `expires_at <= created_at + interval '60 minutes'`, so that is what to
    // assert, and the same reason the guard resolves expiry against server time
    // rather than trusting a token.
    const row = await owner.query<{ within_cap: boolean; minutes: string }>(
      `SELECT expires_at <= created_at + interval '60 minutes' AS within_cap,
              (EXTRACT(EPOCH FROM (expires_at - created_at)) / 60)::text AS minutes
         FROM platform.impersonation_session WHERE id = $1`,
      [started.sessionId],
    );
    expect(row.rows[0]!.within_cap, `granted ${row.rows[0]!.minutes} minutes`).toBe(true);
    // And a request for 600 was clamped to the cap, not rejected outright.
    expect(Number(row.rows[0]!.minutes)).toBe(60);
  });

  it('requires a typed reason with substance', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform.impersonation_session
           (id, tenant_id, platform_user_id, reason_code, reason_detail, expires_at)
         VALUES ($1, $2, $3, 'incident', 'too short', now() + interval '10 minutes')`,
        [randomUUID(), tenantId, superAdminId],
      ),
    ).rejects.toThrow(/reason_detail_substantive/);

    await expect(
      owner.query(
        `INSERT INTO platform.impersonation_session
           (id, tenant_id, platform_user_id, reason_code, reason_detail, expires_at)
         VALUES ($1, $2, $3, 'because i said so', 'a detail long enough', now() + interval '10 minutes')`,
        [randomUUID(), tenantId, superAdminId],
      ),
    ).rejects.toThrow(/impersonation_reason_known/);
  });

  it('requires write access to carry its own reason', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform.impersonation_session
           (id, tenant_id, platform_user_id, reason_code, reason_detail, write_enabled, expires_at)
         VALUES ($1, $2, $3, 'incident', 'a detail long enough to pass', true, now() + interval '10 minutes')`,
        [randomUUID(), tenantId, superAdminId],
      ),
    ).rejects.toThrow(/write_needs_its_own_reason/);
  });
});

describe('the token shape is inert against both existing guards', () => {
  it('is rejected on the tenant plane with its own code', async () => {
    handlerReached = [];
    const started = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/branches',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'impersonation_token_on_direct_plane' });
    expect(handlerReached).toEqual([]);
  });

  it('is rejected on the platform plane with its own code', async () => {
    handlerReached = [];
    const started = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'impersonation_token_on_direct_plane' });
    expect(handlerReached).toEqual([]);
  });

  it('would be inert even without the explicit typ rejection', () => {
    // act_tenant_id rather than tenant_id, and no platform_role: nothing for
    // either guard to accept.
    const claims = { sub: 'pu', act_tenant_id: tenantId, sid: 'x' };
    expect(checkPlane('tenant', claims)?.code).toBe('missing_tenant_id');
    expect(checkPlane('platform', claims)?.code).toBe('missing_platform_role');
  });

  it('refuses a tenant or platform token on the impersonation prefix', async () => {
    handlerReached = [];
    const tenantToken = signToken(
      { sub: randomUUID(), tenant_id: tenantId, exp: Math.floor(Date.now() / 1000) + 600 },
      KEY,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'not_an_impersonation_token' });
    expect(handlerReached).toEqual([]);
  });
});

describe('the session row is authoritative', () => {
  it('admits a live read-only session', async () => {
    handlerReached = [];
    const started = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(handlerReached).toEqual(['impersonated-read']);
    // Banner data, present on every impersonated response.
    expect(response.headers['x-impersonation-session']).toBe(started.sessionId);
    expect(response.headers['x-impersonation-write']).toBe('false');
  });

  it('revokes immediately, mid-session, with the token unchanged', async () => {
    const started = await start();
    const before = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(before.statusCode).toBe(200);

    expect(await revokeImpersonation(owner, started.sessionId, superAdminId)).toBe(true);

    // Same token. A self-contained token could not have been stopped.
    const after = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ error: 'impersonation_session_not_live' });
  });

  it('treats an expired session as not live by server time', async () => {
    const started = await start({ minutes: 1 });
    await owner.query(
      `UPDATE platform.impersonation_session SET revoked_at = now(), revoked_by_platform_user_id = $2 WHERE id = $1`,
      [started.sessionId, superAdminId],
    );
    expect(await loadLiveSession(owner, started.sessionId)).toBeNull();
  });

  it('refuses to revoke twice, and refuses to rewrite anything else', async () => {
    const started = await start();
    expect(await revokeImpersonation(owner, started.sessionId, superAdminId)).toBe(true);
    expect(await revokeImpersonation(owner, started.sessionId, superAdminId)).toBe(false);

    await expect(
      owner.query(
        `UPDATE platform.impersonation_session SET expires_at = now() + interval '59 minutes' WHERE id = $1`,
        [started.sessionId],
      ),
    ).rejects.toThrow(/already revoked/);

    await expect(
      owner.query(`DELETE FROM platform.impersonation_session WHERE id = $1`, [started.sessionId]),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a token whose tenant disagrees with its session', async () => {
    handlerReached = [];
    const started = await start();
    const other = await provisionFresh();

    // A reissue bug that let these diverge would be cross-tenant impersonation.
    const forged = signToken(
      {
        typ: 'impersonation',
        sub: superAdminId,
        act_tenant_id: other.tenantId,
        sid: started.sessionId,
        write: false,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      KEY,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'impersonation_tenant_mismatch' });
    expect(handlerReached).toEqual([]);
  });
});

describe('read-only is enforced at the guard', () => {
  it('rejects a mutating method before the handler and before a connection', async () => {
    handlerReached = [];
    const started = await start();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/t/impersonated/branches/${branchId}`,
      headers: { authorization: `Bearer ${started.token}` },
      payload: { name: 'Should Not Happen' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'impersonation_read_only' });
    expect(handlerReached, 'the handler must not run').toEqual([]);

    const branch = await owner.query<{ name: string }>(
      `SELECT name FROM app.branch WHERE id = $1`,
      [branchId],
    );
    expect(branch.rows[0]!.name).toBe('Main');
  });

  it('permits the write when the session carries its own write reason', async () => {
    handlerReached = [];
    const started = await start({
      write: { reasonCode: 'data_correction', reasonDetail: 'ticket 4711: fix mis-keyed branch name' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/t/impersonated/branches/${branchId}`,
      headers: { authorization: `Bearer ${started.token}` },
      payload: { name: 'Corrected Main' },
    });

    expect(response.statusCode).toBe(200);
    expect(handlerReached).toEqual(['impersonated-write']);

    const audit = await owner.query<{
      actor_kind: string;
      impersonation_session_id: string;
      authorising_membership_id: string | null;
      via_impersonation: boolean;
      actor_name: string;
    }>(
      `SELECT actor_kind, impersonation_session_id, authorising_membership_id,
              via_impersonation, actor_name
         FROM app.tenant_audit_log
        WHERE tenant_id = $1 AND action = 'branch.renamed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    const row = audit.rows[0]!;
    expect(row.actor_kind).toBe('impersonation');
    expect(row.impersonation_session_id).toBe(started.sessionId);
    expect(row.authorising_membership_id).toBeNull();
    expect(row.via_impersonation).toBe(true);
    expect(row.actor_name).toBe('Support Agent');

    await owner.query(`UPDATE app.branch SET name = 'Main' WHERE id = $1`, [branchId]);
  });
});

describe('the ladder decides what impersonation is for', () => {
  it('refuses a purged tenant outright', async () => {
    const doomed = await provisionFresh();
    await owner.query(
      `UPDATE platform.tenant
          SET status = 'purge_pending', delinquent_since = now() - interval '140 days',
              status_changed_at = now()
        WHERE id = $1`,
      [doomed.tenantId],
    );
    await owner.query(
      `UPDATE platform.tenant SET status = 'purged' WHERE id = $1`,
      [doomed.tenantId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        startImpersonation(client, KEY, {
          tenantId: doomed.tenantId,
          platformUserId: superAdminId,
          reasonCode: 'incident',
          reasonDetail: 'attempting to look at a purged tenant',
          minutes: 10,
        }),
      ).rejects.toThrow(TenantNotImpersonableError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('permits hard_lock: that is precisely when support is needed', async () => {
    const locked = await provisionFresh();
    await owner.query(
      `UPDATE platform.tenant
          SET status = 'hard_lock', delinquent_since = now() - interval '20 days',
              status_changed_at = now()
        WHERE id = $1`,
      [locked.tenantId],
    );
    expect(impersonationPosture('hard_lock')).toEqual({ allowed: true, forceReadOnly: false });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const started = await startImpersonation(client, KEY, {
        tenantId: locked.tenantId,
        platformUserId: superAdminId,
        reasonCode: 'support_ticket',
        reasonDetail: 'locked out tenant needs their export checked',
        minutes: 15,
      });
      expect(started.sessionId).toBeTruthy();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('forces read-only past retention, regardless of the write flag', async () => {
    handlerReached = [];
    const retiring = await provisionFresh();

    const client = await pool.connect();
    let token: string;
    try {
      await client.query('BEGIN');
      const started = await startImpersonation(client, KEY, {
        tenantId: retiring.tenantId,
        platformUserId: superAdminId,
        reasonCode: 'compliance_request',
        reasonDetail: 'export request during the retention window',
        minutes: 20,
        write: { reasonCode: 'data_correction', reasonDetail: 'granted before the ladder advanced' },
      });
      token = started.token;
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // The ladder advances after the session was granted write access.
    await owner.query(
      `UPDATE platform.tenant
          SET status = 'retention', delinquent_since = now() - interval '50 days',
              status_changed_at = now()
        WHERE id = $1`,
      [retiring.tenantId],
    );
    expect(impersonationPosture('retention')).toEqual({ allowed: true, forceReadOnly: true });

    const branch = await owner.query<{ id: string }>(
      `SELECT id FROM app.branch WHERE tenant_id = $1 LIMIT 1`,
      [retiring.tenantId],
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/t/impersonated/branches/${branch.rows[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Should Not Happen' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'impersonation_read_only' });
    expect(handlerReached).toEqual([]);

    // Reads still work: the session is live, only writing is withdrawn.
    const read = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
  });
});

describe('impersonation is bounded by risk class, at the guard', () => {
  it('refuses financial, escalation and privacy keys even with write access', async () => {
    const started = await start({
      write: { reasonCode: 'data_correction', reasonDetail: 'write granted for this session' },
    });

    for (const [method, url] of [
      ['POST', '/api/t/impersonated/collect'],
      ['POST', '/api/t/impersonated/void'],
      ['POST', '/api/t/impersonated/roles'],
      ['GET', `/api/t/impersonated/customers/${randomUUID()}/contact`],
    ] as const) {
      handlerReached = [];
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${started.token}` },
        ...(method === 'POST' ? { payload: {} } : {}),
      });

      expect(response.statusCode, url).toBe(403);
      // A distinct code from the read-only rejection: "you may not write" and
      // "nobody impersonating may ever do this" are different answers.
      expect(response.json(), url).toMatchObject({ error: 'impersonation_out_of_scope' });
      expect(handlerReached, url).toEqual([]);
    }
  });

  it('still admits an in-scope route on the same session', async () => {
    handlerReached = [];
    const started = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/impersonated/branches',
      headers: { authorization: `Bearer ${started.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(handlerReached).toEqual(['impersonated-read']);
  });

  it('separates out-of-scope from read-only', async () => {
    // A read-only session hitting an IN-scope write gets the read-only code...
    const readOnly = await start();
    const a = await app.inject({
      method: 'PATCH',
      url: `/api/t/impersonated/branches/${branchId}`,
      headers: { authorization: `Bearer ${readOnly.token}` },
      payload: { name: 'x' },
    });
    expect(a.json()).toMatchObject({ error: 'impersonation_read_only' });

    // ...while a write-enabled session hitting an OUT-of-scope route gets the
    // other one. The two rejections must never be conflated.
    const writable = await start({
      write: { reasonCode: 'data_correction', reasonDetail: 'write granted for this session' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/api/t/impersonated/collect',
      headers: { authorization: `Bearer ${writable.token}` },
      payload: {},
    });
    expect(b.json()).toMatchObject({ error: 'impersonation_out_of_scope' });
  });
});

describe('attribution stays total', () => {
  it('rejects an audit row that names neither a membership nor a session', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.tenant_audit_log
           (id, tenant_id, actor_kind, actor_name, action, target_type, request_id)
         VALUES (gen_random_uuid(), $1, 'user', 'x', 'a', 't', 'r')`,
        [tenantId],
      ),
    ).rejects.toThrow(/attribution_exact/);
  });

  it('rejects a system row that does not name its job', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.tenant_audit_log
           (id, tenant_id, actor_kind, actor_name, action, target_type, request_id)
         VALUES (gen_random_uuid(), $1, 'system', 'cron', 'a', 't', 'r')`,
        [tenantId],
      ),
    ).rejects.toThrow(/attribution_exact/);
  });

  it('accepts a system row that does', async () => {
    const inserted = await owner.query<{ actor_kind: string }>(
      `INSERT INTO app.tenant_audit_log
         (id, tenant_id, actor_kind, actor_system_job, actor_name, action, target_type, request_id)
       VALUES (gen_random_uuid(), $1, 'system', 'daily_rollup', 'system', 'usage.rolled_up', 'usage', 'job-1')
       RETURNING actor_kind`,
      [tenantId],
    );
    expect(inserted.rows[0]!.actor_kind).toBe('system');
  });

  it('rejects a row claiming both a membership and a session', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.tenant_audit_log
           (id, tenant_id, actor_kind, actor_name, action, target_type, request_id,
            authorising_membership_id, impersonation_session_id)
         VALUES (gen_random_uuid(), $1, 'impersonation', 'x', 'a', 't', 'r',
                 gen_random_uuid(), gen_random_uuid())`,
        [tenantId],
      ),
    ).rejects.toThrow(/attribution_exact/);
  });

  it('leaves no row outside the three kinds', async () => {
    const stray = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.tenant_audit_log
        WHERE actor_kind NOT IN ('user', 'impersonation', 'system')`,
    );
    expect(Number(stray.rows[0]!.n)).toBe(0);

    const kinds = await owner.query<{ actor_kind: string; n: string }>(
      `SELECT actor_kind, count(*)::text AS n FROM app.tenant_audit_log GROUP BY 1`,
    );
    expect(kinds.rows.length).toBeGreaterThan(0);
  });
});
