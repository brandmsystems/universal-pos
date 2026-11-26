import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { signToken } from '../../src/modules/auth/jwt.js';
import { planeGuard } from '../../src/core/security/planeGuards.js';
import {
  MissingAuditPostureError,
  registerTenantRoute,
  registeredRoutes,
  resetRegistry,
  type UnattributableDetail,
} from '../../src/core/middleware/routeRegistry.js';
import { preparePayload, redact, PAYLOAD_LIMIT_BYTES } from '../../src/core/middleware/auditPayload.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { BranchRepository } from '../../src/core/database/repositories.js';
import { seedPermissionCatalogue, seedTenantSystemRoles, grantOwnerMemberships } from '../../src/modules/authz/seed.js';
import { productionRouteDeps } from '../../src/core/middleware/deps.js';
import { resolveActor } from '../../src/modules/authz/authorityStore.js';
import {
  assertNoUnattributableActions,
  recordUnattributable,
  resetUnattributableCount,
  unattributableCount,
  UnattributableActionsDetected,
} from '../../src/jobs/unattributable.js';

const KEY = 'audit-suite-signing-key';
const TENANT = '0000eeee-0000-0000-0000-0000000a0d17';
const BRANCH = '0000eeee-0000-0000-0000-0000000b0d17';
const USER = '0000eeee-0000-0000-0000-0000000c0d17';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let unattributable: UnattributableDetail[] = [];

const branches = new BranchRepository();

function token(overrides: Record<string, unknown> = {}): string {
  return signToken(
    {
      sub: USER,
      tenant_id: TENANT,
      branch_id: BRANCH,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...overrides,
    },
    KEY,
  );
}

async function auditRows(action?: string) {
  const result = await owner.query(
    `SELECT * FROM app.tenant_audit_log
      WHERE tenant_id = $1 ${action ? 'AND action = $2' : ''}
      ORDER BY occurred_at`,
    action ? [TENANT, action] : [TENANT],
  );
  return result.rows;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });

  // Upserts, not deletes. A membership that has ever acted CANNOT be deleted:
  // tenant_audit_log.authorising_membership_id is ON DELETE RESTRICT and audit
  // rows are append-only, so the history pins the membership in place. That is
  // the design working -- a fixture that tears down memberships is asking the
  // database to forget who did something.
  await seedPermissionCatalogue(owner);
  await owner.query(
    `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
     VALUES ($1, 'audit-middleware', 'Audit Middleware', 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
  await owner.query(
    `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
     VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', 'unstated')
     ON CONFLICT (id) DO NOTHING`,
    [BRANCH, TENANT],
  );
  await owner.query(
    `INSERT INTO app.app_user (id, tenant_id, full_name, email, status)
     VALUES ($1, $2, 'Audit Actor', 'actor@audit.probe', 'active')
     ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, status = 'active'`,
    [USER, TENANT],
  );
  await seedTenantSystemRoles(owner, TENANT);
  await grantOwnerMemberships(owner, {
    tenantId: TENANT,
    ownerUserId: USER,
    firstBranchId: BRANCH,
  });

  resetRegistry();
  app = Fastify();
  app.register(
    async (scope) => {
      scope.addHook('onRequest', planeGuard('tenant', KEY));

      registerTenantRoute(scope, { pool, onUnattributable: (d) => unattributable.push(d) }, {
        method: 'PATCH',
        plane: 'tenant' as const,
        url: '/branches/:id',
        permission: { plane: 'tenant' as const, key: 'branch.edit' as const },
        audit: {
          action: 'branch.renamed',
          target: 'branch',
          targetId: (request) => (request.params as { id: string }).id,
          lock: { repository: branches, id: (request) => (request.params as { id: string }).id },
        },
        handler: async (request) => {
          const { id } = request.params as { id: string };
          const { name } = request.body as { name: string };
          await branches.update({ id }, { name });
          return { ok: true };
        },
      });

      registerTenantRoute(scope, { pool, onUnattributable: (d) => unattributable.push(d) }, {
        method: 'POST',
        plane: 'tenant' as const,
        url: '/branches/:id/explode',
        permission: { plane: 'tenant' as const, key: 'branch.edit' as const },
        audit: { action: 'branch.exploded', target: 'branch', targetId: (r) => (r.params as { id: string }).id },
        handler: async (request) => {
          const { id } = request.params as { id: string };
          await branches.update({ id }, { name: 'written before the failure' });
          throw new Error('handler failed after writing');
        },
      });

      registerTenantRoute(scope, { pool, onUnattributable: (d) => unattributable.push(d) }, {
        method: 'GET',
        plane: 'tenant' as const,
        url: '/branches',
        permission: { plane: 'tenant' as const, key: 'branch.view' as const },
        audit: 'none',
        handler: async () => branches.findMany(),
      });

      registerTenantRoute(scope, { pool, onUnattributable: (d) => unattributable.push(d) }, {
        method: 'GET',
        plane: 'tenant' as const,
        url: '/customers/:id/contact',
        permission: { plane: 'tenant' as const, key: 'customer.pii.view' as const },
        audit: { action: 'customer.pii.viewed', target: 'customer', targetId: (r) => (r.params as { id: string }).id },
        handler: async () => ({ phone: '+91-99999-00000' }),
      });

      registerTenantRoute(scope, { pool, onUnattributable: (d) => unattributable.push(d) }, {
        method: 'POST',
        plane: 'tenant' as const,
        url: '/bulky',
        permission: { plane: 'tenant' as const, key: 'branch.edit' as const },
        audit: { action: 'branch.bulky', target: 'branch' },
        handler: async (_request, _reply, context) => {
          // A payload large enough to exercise the cap, via the after-image.
          void context;
          return { ok: true };
        },
      });
    },
    { prefix: '/api/t' },
  );

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

beforeEach(async () => {
  unattributable = [];
  await owner.query(`UPDATE app.branch SET name = 'Main' WHERE tenant_id = $1`, [TENANT]);
});

describe('the boot gate: every route declares its audit posture', () => {
  it('refuses to register a mutating route with no posture', () => {
    const bare = Fastify();
    expect(() =>
      registerTenantRoute(bare, { pool }, {
        method: 'POST',
        plane: 'tenant' as const,
        url: '/x',
        audit: undefined as never,
        handler: async () => ({}),
      }),
    ).toThrow(MissingAuditPostureError);
  });

  it('refuses a READ with no posture too, so the gate is not method-scoped', () => {
    const bare = Fastify();
    expect(() =>
      registerTenantRoute(bare, { pool }, {
        method: 'GET',
        plane: 'tenant' as const,
        url: '/y',
        audit: undefined as never,
        handler: async () => ({}),
      }),
    ).toThrow(/declares no audit posture/);
  });

  it('refuses a descriptor missing action or target', () => {
    const bare = Fastify();
    expect(() =>
      registerTenantRoute(bare, { pool }, {
        method: 'POST',
        plane: 'tenant' as const,
        url: '/z',
        audit: { action: '', target: 'branch' },
        handler: async () => ({}),
      }),
    ).toThrow(MissingAuditPostureError);
  });

  it('accepts audit: none on a POST, so the opt-out is real in both directions', () => {
    const bare = Fastify();
    expect(() =>
      registerTenantRoute(bare, { pool }, {
        method: 'POST',
        plane: 'tenant' as const,
        url: '/opted-out',
        audit: 'none',
        handler: async () => ({}),
      }),
    ).not.toThrow();
    expect(registeredRoutes().some((r) => r.url === '/opted-out' && r.audit === 'none')).toBe(true);
  });

  it('accepts the explicit opt-out', () => {
    const registered = registeredRoutes();
    assertCheckedSet({
      label: 'registered routes',
      checked: registered.map((r) => `${r.method} ${r.url}`),
      minimum: 5,
      mustInclude: ['PATCH /branches/:id', 'GET /branches', 'GET /customers/:id/contact'],
    });
    expect(registered.find((r) => r.url === '/branches')?.audit).toBe('none');
  });

  it('leaves no registered route without a posture', () => {
    const naked = registeredRoutes().filter((r) => r.audit === undefined || r.audit === null);
    expect(naked).toEqual([]);
  });
});

describe('every mutating route produces an audit row', () => {
  it('writes exactly one row, attributed to the authorising membership', async () => {
    const before = (await auditRows('branch.renamed')).length;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/t/branches/${BRANCH}`,
      headers: { authorization: `Bearer ${token()}`, 'x-request-id': 'req-rename-1' },
      payload: { name: 'Renamed Main' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRows('branch.renamed');
    expect(rows.length).toBe(before + 1);

    const row = rows[rows.length - 1]!;
    expect(row['action']).toBe('branch.renamed');
    expect(row['target_type']).toBe('branch');
    expect(row['target_id']).toBe(BRANCH);
    expect(row['actor_user_id']).toBe(USER);
    expect(row['actor_name']).toBe('Audit Actor');
    expect(row['request_id']).toBe('req-rename-1');
    expect(row['authorising_membership_id']).not.toBeNull();
    expect(row['payload_truncated']).toBe(false);

    // before/after are a true adjacency, not two unrelated snapshots.
    expect((row['before'] as { name: string }).name).toBe('Main');
    expect((row['after'] as { name: string }).name).toBe('Renamed Main');
  });

  it('attributes to the membership that actually supplies the permission', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/t/branches/${BRANCH}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: 'Attribution Check' },
    });

    const rows = await auditRows('branch.renamed');
    const row = rows[rows.length - 1]!;

    const membership = await owner.query<{ key: string }>(
      `SELECT r.key FROM app.membership m
         JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
        WHERE m.tenant_id = $1 AND m.id = $2`,
      [TENANT, row['authorising_membership_id']],
    );
    // branch.edit comes from the owner membership, not the cashier one.
    expect(membership.rows[0]?.key).toBe('owner');
  });

  it('writes no row for a route that opted out', async () => {
    const before = (await auditRows()).length;
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/branches',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect((await auditRows()).length).toBe(before);
  });

  it('audits a privacy-class READ, because posture is declared not inferred', async () => {
    const before = (await auditRows('customer.pii.viewed')).length;
    const response = await app.inject({
      method: 'GET',
      url: `/api/t/customers/${randomUUID()}/contact`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect((await auditRows('customer.pii.viewed')).length).toBe(before + 1);
  });
});

describe('an audit failure rolls the mutation back', () => {
  it('leaves neither the write nor a phantom audit row', async () => {
    const auditBefore = (await auditRows('branch.exploded')).length;

    const response = await app.inject({
      method: 'POST',
      url: `/api/t/branches/${BRANCH}/explode`,
      headers: { authorization: `Bearer ${token()}` },
      payload: {},
    });
    expect(response.statusCode).toBe(500);

    const branch = await owner.query<{ name: string }>(
      `SELECT name FROM app.branch WHERE tenant_id = $1 AND id = $2`,
      [TENANT, BRANCH],
    );
    expect(branch.rows[0]?.name, 'the handler write must be rolled back').toBe('Main');
    expect((await auditRows('branch.exploded')).length, 'no phantom audit row').toBe(auditBefore);
  });
});

describe('an audit-write failure rolls the mutation back', () => {
  it('loses the write when the audit table cannot be written', async () => {
    // The real production failure: the audit table is unwritable. Revoking INSERT
    // is visible to the app's sessions immediately, so this exercises the actual
    // path rather than a simulated one.
    //
    // This is the property that JUSTIFIES same-transaction auditing. Without the
    // test it was only a design claim.
    await owner.query(`REVOKE INSERT ON app.tenant_audit_log FROM katkitchen_app`);
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/t/branches/${BRANCH}`,
        headers: { authorization: `Bearer ${token()}` },
        payload: { name: 'Unauditable Rename' },
      });
      expect(response.statusCode).toBe(500);

      const branch = await owner.query<{ name: string }>(
        `SELECT name FROM app.branch WHERE tenant_id = $1 AND id = $2`,
        [TENANT, BRANCH],
      );
      expect(
        branch.rows[0]?.name,
        'an unauditable mutation must not land: no write without a record of it',
      ).toBe('Main');
    } finally {
      await owner.query(`GRANT INSERT ON app.tenant_audit_log TO katkitchen_app`);
    }
  });

  it('still writes normally once the audit table is writable again', async () => {
    const before = (await auditRows('branch.renamed')).length;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/t/branches/${BRANCH}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: 'Recovered' },
    });
    expect(response.statusCode).toBe(200);
    expect((await auditRows('branch.renamed')).length).toBe(before + 1);
  });
});

describe('the attribution seam is not a configurable hole', () => {
  it('production wiring never overrides the resolver', () => {
    const deps = productionRouteDeps(pool);
    expect(
      Object.hasOwn(deps, 'resolveActor'),
      'production deps must not carry a resolveActor override',
    ).toBe(false);
    expect(deps.resolveActor).toBeUndefined();
    // And the fallback the registry uses is the real one.
    expect(typeof resolveActor).toBe('function');
  });

  it('counts refusals so a nightly check can assert zero', () => {
    resetUnattributableCount();
    expect(unattributableCount()).toBe(0);
    expect(() => assertNoUnattributableActions()).not.toThrow();

    recordUnattributable({
      tenantId: TENANT,
      userId: USER,
      branchId: BRANCH,
      permission: 'branch.edit' as const,
      action: 'branch.renamed',
      heldPermissions: ['branch.edit'],
      authorisedBy: {},
    });

    expect(unattributableCount()).toBe(1);
    // A one-time alert is not detection; the nightly assertion is.
    expect(() => assertNoUnattributableActions()).toThrow(UnattributableActionsDetected);
    resetUnattributableCount();
  });
});

describe('an unattributable action is refused, not logged unattributed', () => {
  it('returns 403, writes no audit row, and mutates nothing', async () => {
    // Revoke every membership: the permission check cannot pass, and if the
    // resolution ever did pass without a membership this is the path it takes.
    await owner.query(
      `UPDATE app.membership SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1`,
      [TENANT],
    );
    try {
      const auditBefore = (await auditRows('branch.renamed')).length;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/t/branches/${BRANCH}`,
        headers: { authorization: `Bearer ${token()}` },
        payload: { name: 'Should Not Happen' },
      });

      expect(response.statusCode).toBe(403);
      // Nothing more specific than "forbidden": a distinct code would be a
      // probing signal for an internal invariant.
      expect(response.json()).toEqual({ error: 'forbidden' });

      expect((await auditRows('branch.renamed')).length).toBe(auditBefore);
      const branch = await owner.query<{ name: string }>(
        `SELECT name FROM app.branch WHERE tenant_id = $1 AND id = $2`,
        [TENANT, BRANCH],
      );
      expect(branch.rows[0]?.name).toBe('Main');
    } finally {
      await owner.query(
        `UPDATE app.membership SET status = 'active', revoked_at = NULL WHERE tenant_id = $1`,
        [TENANT],
      );
    }
  });

  it('refuses when the permission is held but no membership supplies it', async () => {
    // The real invariant violation: authority.permissions contains the key, but
    // authorisedBy has no membership for it. Unreachable through HTTP, which is
    // exactly why it needs a test -- this branch refuses writes.
    const pathological = Fastify();
    const seen: UnattributableDetail[] = [];
    pathological.register(
      async (scope) => {
        scope.addHook('onRequest', planeGuard('tenant', KEY));
        registerTenantRoute(
          scope,
          {
            pool,
            onUnattributable: (detail) => seen.push(detail),
            resolveActor: async () => ({
              userId: USER,
              actorName: 'Audit Actor',
              actorEmail: null,
              authority: {
                permissions: new Set(['branch.edit'] as const),
                discountPercentCap: 0,
                discountAmountCap: null,
                authorisedBy: new Map(),
              },
            }),
          },
          {
            method: 'PATCH',
            plane: 'tenant' as const,
            url: '/branches/:id',
            permission: { plane: 'tenant' as const, key: 'branch.edit' as const },
            audit: {
              action: 'branch.renamed.pathological',
              target: 'branch',
              targetId: (r) => (r.params as { id: string }).id,
              lock: { repository: branches, id: (r) => (r.params as { id: string }).id },
            },
            handler: async (request) => {
              const { id } = request.params as { id: string };
              await branches.update({ id }, { name: 'MUST NOT PERSIST' });
              return { ok: true };
            },
          },
        );
      },
      { prefix: '/api/t' },
    );
    await pathological.ready();

    try {
      const auditBefore = (await auditRows('branch.renamed.pathological')).length;

      const response = await pathological.inject({
        method: 'PATCH',
        url: `/api/t/branches/${BRANCH}`,
        headers: { authorization: `Bearer ${token()}` },
        payload: { name: 'MUST NOT PERSIST' },
      });

      expect(response.statusCode).toBe(403);
      // Indistinguishable from a plain denial: a distinct code would be a
      // probing signal for an internal invariant.
      expect(response.json()).toEqual({ error: 'forbidden' });

      expect((await auditRows('branch.renamed.pathological')).length).toBe(auditBefore);
      const branch = await owner.query<{ name: string }>(
        `SELECT name FROM app.branch WHERE tenant_id = $1 AND id = $2`,
        [TENANT, BRANCH],
      );
      expect(branch.rows[0]?.name, 'the handler must never have run').toBe('Main');

      // The alert carries the full resolution the response withheld.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ permission: 'branch.edit', userId: USER });
      expect(seen[0]?.heldPermissions).toContain('branch.edit');
    } finally {
      await pathological.close();
    }
  });
});

describe('the before-image is locked, so before/after are adjacent', () => {
  it('blocks a concurrent mutation of the same row rather than interleaving', async () => {
    let released = false;
    let signalReady!: () => void;
    let signalGo!: () => void;
    const holderReady = new Promise<void>((resolve) => (signalReady = resolve));
    const letGo = new Promise<void>((resolve) => (signalGo = resolve));

    const holder = withTenantTransaction(pool, TENANT, async () => {
      await branches.findOneForUpdate({ id: BRANCH });
      signalReady();
      await letGo;
      released = true;
    });

    await holderReady;

    let contenderFinished = false;
    const contender = withTenantTransaction(pool, TENANT, async () => {
      await branches.update({ id: BRANCH }, { name: 'Contender' });
      contenderFinished = true;
    });

    // Give the contender real time to interleave if the lock were not held.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(contenderFinished, 'the contender must be blocked by FOR UPDATE').toBe(false);
    expect(released).toBe(false);

    signalGo();
    await holder;
    await contender;
    expect(contenderFinished).toBe(true);
  });
});

describe('payload preparation', () => {
  it('redacts secrets before measuring, never truncating into one', () => {
    const redacted = redact({
      id: 'x',
      password_hash: 'argon2id$secret',
      nested: { secret_hash: 'another', token_hash: 'third', keep: 'visible' },
    }) as Record<string, unknown>;

    expect(redacted['password_hash']).toBe('[redacted]');
    expect((redacted['nested'] as Record<string, unknown>)['secret_hash']).toBe('[redacted]');
    expect((redacted['nested'] as Record<string, unknown>)['keep']).toBe('visible');
    expect(JSON.stringify(redacted)).not.toContain('argon2id');
  });

  it('caps each side independently so a big after does not discard a small before', () => {
    const big = { blob: 'x'.repeat(PAYLOAD_LIMIT_BYTES + 100), other: 1 };
    const small = { name: 'Main' };

    const prepared = preparePayload(small, big);
    expect(prepared.truncated).toBe(true);
    expect(prepared.before).toEqual({ name: 'Main' });
    expect(prepared.after).toMatchObject({ _truncated: true });
    // Keys survive: which fields changed is most of the value.
    expect((prepared.after as { keys: string[] }).keys).toEqual(['blob', 'other']);
  });

  it('leaves an under-cap payload untouched and unflagged', () => {
    const prepared = preparePayload({ a: 1 }, { a: 2 });
    expect(prepared.truncated).toBe(false);
    expect(prepared.after).toEqual({ a: 2 });
  });

  it('truncates a 100KB before-image with the secret already gone', () => {
    // If redaction ran AFTER measurement, the secret would survive into the
    // truncated marker -- and you would not find out until it appeared in a row.
    const prepared = preparePayload(
      { password_hash: 'argon2id$verysecretvalue', blob: 'x'.repeat(100 * 1024) },
      null,
    );

    expect(prepared.truncated).toBe(true);
    const serialised = JSON.stringify(prepared.before);
    expect(serialised).not.toContain('verysecretvalue');
    expect(serialised).not.toContain('argon2id');
    // Which fields were involved still survives, which is most of the value.
    expect((prepared.before as { keys: string[] }).keys).toEqual(['password_hash', 'blob']);
  });

  it('measures after redaction, not before', () => {
    // A payload that only exceeds the cap because of a secret must come back
    // untruncated once the secret is gone.
    const prepared = preparePayload(null, {
      secret_hash: 'y'.repeat(PAYLOAD_LIMIT_BYTES + 100),
      name: 'small',
    });
    expect(prepared.truncated).toBe(false);
    expect(prepared.after).toEqual({ secret_hash: '[redacted]', name: 'small' });
  });
});
