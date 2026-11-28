import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { appClient, ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { planeGuard } from '../../src/middleware/security/planeGuards.js';
import { registerPlatformRoute } from '../../src/middleware/platformRoute.js';
import { ERROR_CONTRACT, toErrorResponse } from '../../src/utils/errors/errors.js';
import { platformRoutes } from '../../src/routes/index.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { isUnserved } from '../../src/routes/lookup.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { resolveTenantForAuth, tenantStillAuthenticable } from '../../src/modules/authentication/preAuthTenant.js';
import { recordAttempt } from '../../src/modules/billing/dunning.js';
import { updatePlatformUser, PlatformGrantExceedsAuthorityError } from '../../src/modules/platform/staff.js';
import { ensureStandardPlans, STANDARD_PLANS } from '../../src/modules/platform/planCatalogue.js';
import {
  acceptOwnerInvite, ownerPasswordProblem, type AcceptOwnerInviteResult,
} from '../../src/modules/authentication/ownerInvite.js';
import { authenticatePassword } from '../../src/modules/authentication/passwordAuth.js';
import { authenticatePlatformUser, changePlatformPassword } from '../../src/modules/authentication/platformAuth.js';
import { EXPIRING_WITHIN_DAYS } from '../../src/modules/platform/staff.js';
import { adoptTenantContext } from '../../src/database/unitOfWork.js';
import { ENTITLEMENTS, planTermsFor } from '@universalpos/shared';

/**
 * Restaurant management on the control plane: the Super Admin's hand on a
 * restaurant and on the sales team, and a Salesperson's hand on their own book.
 *
 * Every rule here is asserted against a fixture BUILT to break it -- a second
 * rep's restaurant, a delinquent tenant, a payment landing on a switched-off
 * one -- because seed data that happens to comply proves nothing about the rule.
 */

const KEY = 'restaurant-management-signing-key-long';

let db: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;

let superAdminId: string;
let supportId: string;
let repA: string;
let repB: string;
let basicVersion: string;
let proVersion: string;

interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function token(userId: string, roleKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: userId, platform_role: roleKey, iat: now, exp: now + 600 }, KEY);
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { as?: { id: string; role: string }; payload?: Record<string, unknown>; idem?: boolean } = {},
): Promise<Response> {
  const actor = options.as ?? { id: superAdminId, role: 'super_admin' };
  const response = await app.inject({
    method,
    url: `/api/platform${url}`,
    headers: {
      authorization: `Bearer ${token(actor.id, actor.role)}`,
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idem ? { 'idempotency-key': `idem-${randomUUID()}` } : {}),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as never }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function expectRefusal(result: Response, code: string): void {
  const mapping = ERROR_CONTRACT[code];
  expect(mapping, `${code} is absent from ERROR_CONTRACT`).toBeDefined();
  expect(result.body['error'], JSON.stringify(result.body)).toBe(code);
  expect(result.status).toBe(mapping!.status);
}

async function platformUser(roleKey: string, label: string): Promise<string> {
  const roleId = (await db.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = $1`, [roleKey])).rows[0]!.id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', $3, $4)`,
    [id, `${label.replace(/\s/g, '')}+${id}@platform.test`, label, roleId]);
  return id;
}

/** Provisioned THROUGH THE ROUTE, as the named rep, so the attribution under test is real. */
async function provisionAs(rep: { id: string; role: string }, planVersionId: string): Promise<{
  tenantId: string; slug: string;
}> {
  const slug = `rm${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const made = await call('POST', '/tenants', {
    as: rep, idem: true,
    payload: {
      slug, name: `Probe ${slug}`, currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `${slug}@owner.test`, ownerName: 'Owner', firstBranchName: 'Main',
      planVersionId, taxJurisdiction: 'IN',
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { tenantId: made.body['tenantId'] as string, slug };
}

async function listed(query: string, as?: { id: string; role: string }): Promise<Record<string, unknown>[]> {
  const result = await call('GET', `/tenants?${query}`, as ? { as } : {});
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as unknown as Record<string, unknown>[];
}

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 8 });
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);

  superAdminId = await platformUser('super_admin', 'Root');
  supportId = await platformUser('support', 'Support');
  repA = await platformUser('sales', 'Rep A');
  repB = await platformUser('sales', 'Rep B');

  const versions = await ensureStandardPlans(db, superAdminId);
  basicVersion = versions.get('basic')!;
  proVersion = versions.get('pro')!;

  app = Fastify();
  app.setErrorHandler(async (error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    await reply.code(status).send(body);
  });
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('platform', KEY));
    for (const route of platformRoutes(platformHandlers(KEY))) {
      if (isUnserved(route.handler)) continue;
      registerPlatformRoute(scope, { pool }, route);
    }
  }, { prefix: '/api/platform' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.end();
});

/* ------------------------------------------------------------ the plans --- */

describe('the standard catalogue is Basic, Standard and Pro', () => {
  it('seeds exactly those three, idempotently, with the enforced limit and feature keys', async () => {
    const again = await ensureStandardPlans(db, null);
    expect([...again.keys()]).toEqual(['basic', 'standard', 'pro']);
    const rows = await db.query<{ key: string; price_minor: string; limits: Record<string, number> }>(
      `SELECT p.key, pv.price_minor::text, pv.limits
         FROM platform.plan p JOIN platform.plan_version pv ON pv.plan_id = p.id AND pv.version = 1
        WHERE p.key = ANY($1)`, [STANDARD_PLANS.map((plan) => plan.key)]);
    expect(rows.rows.map((r) => [r.key, Number(r.price_minor)]).sort()).toEqual(
      [['basic', 99_900], ['pro', 249_900], ['standard', 179_900]]);
    for (const row of rows.rows) expect(typeof row.limits['branches']).toBe('number');
  });

  it('publishes a new version without touching the one already sold', async () => {
    // A throwaway plan, never Basic/Pro: a test that published versions of
    // the real catalogue would reprice it on every run of the suite.
    const planId = randomUUID();
    const soldVersion = randomUUID();
    await db.query(`INSERT INTO platform.plan (id, key, name) VALUES ($1, $2, 'Versioning Probe')`,
      [planId, `vprobe_${planId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO platform.plan_version
         (id, plan_id, version, price_minor, currency, billing_period, published_at)
       VALUES ($1, $2, 1, 99900, 'INR', 'monthly', now())`, [soldVersion, planId]);
    // A version that leaves a plan key out is refused: an absent key denies,
    // so publishing one would take the feature away from every restaurant
    // later moved onto it.
    const partial = await call('POST', `/plans/${planId}/versions`, {
      payload: {
        priceMinor: 109_900, currency: 'INR', billingPeriod: 'monthly',
        limits: { branches: 1 }, features: { inventory: false },
      },
    });
    expect(partial.status).toBe(400);
    expect(partial.body['error']).toBe('plan_terms_invalid');
    expect(String(partial.body['detail'])).toContain('limit devices');

    const published = await call('POST', `/plans/${planId}/versions`, {
      payload: {
        priceMinor: 109_900, currency: 'INR', billingPeriod: 'monthly',
        ...planTermsFor(ENTITLEMENTS.basic),
      },
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body['version']).toBe(2);
    const v1 = await db.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM platform.plan_version WHERE id = $1`, [soldVersion]);
    expect(Number(v1.rows[0]!.price_minor)).toBe(99_900);
  });

  it('refuses a limit that is not a whole number, rather than storing a limit that denies', async () => {
    const planId = (await db.query<{ id: string }>(
      `SELECT plan_id AS id FROM platform.plan_version WHERE id = $1`, [proVersion])).rows[0]!.id;
    // Both requests below are refused before any write, so the real plan is untouched.
    const refused = await call('POST', `/plans/${planId}/versions`, {
      payload: { priceMinor: 1000, currency: 'INR', billingPeriod: 'monthly', limits: { branches: 'ten' } },
    });
    expectRefusal(refused, 'plan_terms_invalid');
    const fractional = await call('POST', `/plans/${planId}/versions`, {
      payload: { priceMinor: 99.5, currency: 'INR', billingPeriod: 'monthly' },
    });
    expectRefusal(fractional, 'plan_terms_invalid');
  });

  it('refuses a Salesperson: publishing a price is not selling one', async () => {
    const planId = (await db.query<{ id: string }>(
      `SELECT plan_id AS id FROM platform.plan_version WHERE id = $1`, [proVersion])).rows[0]!.id;
    const refused = await call('POST', `/plans/${planId}/versions`, {
      as: { id: repA, role: 'sales' },
      payload: { priceMinor: 1, currency: 'INR', billingPeriod: 'monthly' },
    });
    expect(refused.status).toBe(403);
  });

  it('splits each version\'s live subscriptions by status', async () => {
    const plans = await call('GET', '/plans');
    const pro = (plans.body as unknown as { key: string; versions: Record<string, unknown>[] }[])
      .find((plan) => plan.key === 'pro')!;
    const v1 = pro.versions.find((v) => v['planVersionId'] === proVersion)!;
    const split = v1['subscriptionsByStatus'] as Record<string, number>;
    expect(split['trialing']! + split['active']! + split['past_due']!).toBe(v1['liveSubscriptions']);
  });
});

/* ------------------------------------------------------- the restaurant list --- */

describe('the restaurant list says who sold it, to whom, and until when', () => {
  it('carries the rep, the owner invite, the price sold and the period', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, proVersion);
    const rows = await listed(`search=${made.slug}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['salesPersonId']).toBe(repA);
    expect(row['salesPersonName']).toBe('Rep A');
    expect(row['ownerEmail']).toBe(`${made.slug}@owner.test`);
    expect(row['ownerInviteStatus']).toBe('pending');
    expect(row['planKey']).toBe('pro');
    const sold = await db.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM platform.plan_version WHERE id = $1`, [proVersion]);
    expect(row['priceMinor']).toBe(Number(sold.rows[0]!.price_minor));
    expect(row['currentPeriodStart']).not.toBeNull();
    expect(row['currentPeriodEnd']).not.toBeNull();
    expect(row['revenueMinor']).toBe(0);
  });

  it('filters by plan and by rep, and a rep\'s own scoping survives a filter naming someone else', async () => {
    const a = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const b = await provisionAs({ id: repB, role: 'sales' }, proVersion);

    const byRepB = (await listed(`salesPerson=${repB}&limit=200`)).map((r) => r['slug']);
    expect(byRepB).toContain(b.slug);
    expect(byRepB).not.toContain(a.slug);

    const onBasic = await listed(`plan=basic&search=${a.slug}`);
    expect(onBasic.map((r) => r['slug'])).toEqual([a.slug]);
    expect(await listed(`plan=pro&search=${a.slug}`)).toEqual([]);

    // Rep A asking for Rep B's book gets the intersection of the two -- nothing.
    const leak = await listed(`salesPerson=${repB}&search=${b.slug}`, { id: repA, role: 'sales' });
    expect(leak, 'a rep must not reach another rep\'s book through the filter').toEqual([]);
  });

  it('filters by expiry window against the subscription period', async () => {
    const soon = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const later = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    await db.query(
      `UPDATE platform.subscription SET current_period_end = now() + interval '3 days'
        WHERE tenant_id = $1`, [soon.tenantId]);
    await db.query(
      `UPDATE platform.subscription SET current_period_end = now() + interval '20 days'
        WHERE tenant_id = $1`, [later.tenantId]);

    const week = (await listed('expiry=within_7_days&limit=200')).map((r) => r['slug']);
    expect(week).toContain(soon.slug);
    expect(week).not.toContain(later.slug);
    const month = (await listed('expiry=within_30_days&limit=200')).map((r) => r['slug']);
    expect(month).toEqual(expect.arrayContaining([soon.slug, later.slug]));
  });
});

/* ------------------------------------------------------------- editing --- */

describe('editing a restaurant', () => {
  it('renames it, and never the slug every tablet signs in by', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const edited = await call('PATCH', `/tenants/${made.tenantId}`, {
      payload: { name: 'Renamed Kitchen', legalName: 'Renamed Kitchen LLP', slug: 'hijack' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const row = (await db.query<{ name: string; legal_name: string; slug: string }>(
      `SELECT name, legal_name, slug::text FROM platform.tenant WHERE id = $1`, [made.tenantId])).rows[0]!;
    expect(row).toEqual({ name: 'Renamed Kitchen', legal_name: 'Renamed Kitchen LLP', slug: made.slug });
  });

  it('lets a rep edit their own restaurant and answers another rep\'s as unknown', async () => {
    const mine = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const theirs = await provisionAs({ id: repB, role: 'sales' }, basicVersion);
    const own = await call('PATCH', `/tenants/${mine.tenantId}`,
      { as: { id: repA, role: 'sales' }, payload: { name: 'Mine Now' } });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const other = await call('PATCH', `/tenants/${theirs.tenantId}`,
      { as: { id: repA, role: 'sales' }, payload: { name: 'Taken Over' } });
    expectRefusal(other, 'restaurant_unknown');
  });

  it('refuses an empty name and a request that changes nothing', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    expectRefusal(await call('PATCH', `/tenants/${made.tenantId}`, { payload: { name: ' ' } }),
      'tenant_edit_invalid');
    expectRefusal(await call('PATCH', `/tenants/${made.tenantId}`, { payload: {} }),
      'tenant_edit_invalid');
  });

  it('records the change in the platform audit log, with the after-image', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    await call('PATCH', `/tenants/${made.tenantId}`, { payload: { name: 'Audited Name' } });
    const audit = await db.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM platform.platform_audit_log
        WHERE action = 'tenant.edited' AND target_id = $1`, [made.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after['name']).toBe('Audited Name');
  });
});

/* ------------------------------------------------- deactivate / reactivate --- */

describe('deactivation switches a restaurant off, with a reason, and back on', () => {
  it('blocks login and refresh, suspends entitlements, and tells the tablets', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const off = await call('POST', `/tenants/${made.tenantId}/deactivate`,
      { payload: { reason: 'contract ended by the owner' } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    const row = (await db.query<{
      status: string; delinquent_since: string | null; deactivation_reason: string;
      deactivated_by_platform_user_id: string;
    }>(`SELECT status, delinquent_since, deactivation_reason, deactivated_by_platform_user_id
          FROM platform.tenant WHERE id = $1`, [made.tenantId])).rows[0]!;
    expect(row.status).toBe('deactivated');
    expect(row.delinquent_since, 'deactivation must not forge a day 0').toBeNull();
    expect(row.deactivation_reason).toBe('contract ended by the owner');
    expect(row.deactivated_by_platform_user_id).toBe(superAdminId);

    const login = await resolveTenantForAuth(db, made.slug);
    expect(login).toEqual({ refusal: 'tenant_login_blocked' });
    expect(await tenantStillAuthenticable(db, made.tenantId)).toBe(false);

    const doc = await db.query<{ status: string }>(
      `SELECT status FROM platform.entitlement_document WHERE tenant_id = $1
        ORDER BY version DESC LIMIT 1`, [made.tenantId]);
    expect(doc.rows[0]!.status).toBe('suspended');
    const outbox = await db.query(
      `SELECT 1 FROM platform.outbox WHERE topic = 'entitlement.invalidate'
        AND payload->>'tenantId' = $1`, [made.tenantId]);
    expect(outbox.rowCount).toBeGreaterThanOrEqual(1);

    const audit = await db.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM platform.platform_audit_log
        WHERE action = 'tenant.deactivated' AND target_id = $1`, [made.tenantId]);
    expect(audit.rows[0]!.after['reason'], 'the reason must reach the audit log').toBe(
      'contract ended by the owner');

    const on = await call('POST', `/tenants/${made.tenantId}/reactivate`,
      { payload: { reason: 'owner signed a new contract' } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await tenantStillAuthenticable(db, made.tenantId)).toBe(true);
    const back = (await db.query<{ status: string; deactivated_at: string | null }>(
      `SELECT status, deactivated_at FROM platform.tenant WHERE id = $1`, [made.tenantId])).rows[0]!;
    expect(back).toEqual({ status: 'active', deactivated_at: null });
  });

  it('requires a reason', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    expectRefusal(await call('POST', `/tenants/${made.tenantId}/deactivate`, { payload: {} }),
      'reason_required');
  });

  it('refuses a delinquent restaurant, whose debt deactivation would erase', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    await db.query(
      `UPDATE platform.tenant SET status = 'past_due', delinquent_since = now(),
              status_changed_at = now() WHERE id = $1`, [made.tenantId]);
    expectRefusal(await call('POST', `/tenants/${made.tenantId}/deactivate`,
      { payload: { reason: 'trying to hide it' } }), 'tenant_not_deactivatable');
  });

  it('refuses reactivating a restaurant that is not deactivated', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    expectRefusal(await call('POST', `/tenants/${made.tenantId}/reactivate`,
      { payload: { reason: 'nothing to undo' } }), 'tenant_not_deactivated');
  });

  it('is refused to a Salesperson and to Support, neither of whom holds platform.tenant.suspend', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    for (const as of [{ id: repA, role: 'sales' }, { id: supportId, role: 'support' }]) {
      const refused = await call('POST', `/tenants/${made.tenantId}/deactivate`,
        { as, payload: { reason: 'not mine to decide' } });
      expect(refused.status, as.role).toBe(403);
    }
  });

  it('is not reversed by a payment landing, and not turned into a ladder by a decline', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    await call('POST', `/tenants/${made.tenantId}/deactivate`, { payload: { reason: 'switched off' } });
    for (const outcome of ['succeeded', 'declined'] as const) {
      await db.query('BEGIN');
      try {
        await recordAttempt(db, {
          // Past the retry limit, so no next attempt is scheduled against an
          // invoice this fixture does not have; the status write under test
          // runs before that point either way.
          tenantId: made.tenantId, invoiceId: randomUUID(), attemptNo: 99,
          outcome, at: new Date(),
        });
        const status = (await db.query<{ status: string }>(
          `SELECT status FROM platform.tenant WHERE id = $1`, [made.tenantId])).rows[0]!.status;
        expect(status, `a ${outcome} payment changed a deactivated restaurant`).toBe('deactivated');
      } finally {
        await db.query('ROLLBACK');
      }
    }
  });

  it('is enforced by the schema: no deactivated row without a reason and an author', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    await expect(db.query(
      `UPDATE platform.tenant SET status = 'deactivated', deactivated_at = now()
        WHERE id = $1`, [made.tenantId])).rejects.toMatchObject({
      constraint: 'tenant_deactivation_consistent',
    });
  });
});

/* ------------------------------------------------------- the sales team --- */

describe('Sales Persons', () => {
  it('lists each rep with what they sold and what is still active', async () => {
    const rep = await platformUser('sales', 'Counted Rep');
    const one = await provisionAs({ id: rep, role: 'sales' }, basicVersion);
    await provisionAs({ id: rep, role: 'sales' }, proVersion);
    await call('POST', `/tenants/${one.tenantId}/deactivate`, { payload: { reason: 'counted off' } });

    const people = await call('GET', '/sales-persons');
    expect(people.status).toBe(200);
    const row = (people.body as unknown as Record<string, unknown>[])
      .find((p) => p['platformUserId'] === rep)!;
    expect(row['restaurantsSold']).toBe(2);
    expect(row['activeRestaurants']).toBe(1);
    expect(row['revenueMinor']).toBe(0);
    expect((people.body as unknown as Record<string, unknown>[])
      .every((p) => p['roleKey'] === 'sales')).toBe(true);
  });

  it('creates a rep with a phone, edits them, and switches them off and on', async () => {
    const email = `rep+${randomUUID()}@platform.test`;
    const made = await call('POST', '/users', {
      payload: { email, fullName: 'New Rep', password: 'a-long-password-1', roleKey: 'sales',
        phone: '+91 98450 12345' },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const id = made.body['platformUserId'] as string;

    const edited = await call('PATCH', `/users/${id}`, { payload: { fullName: 'Renamed Rep', phone: '' } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ fullName: 'Renamed Rep', phone: null });

    expectRefusal(await call('PATCH', `/users/${id}`, { payload: { phone: 'call me' } }),
      'platform_user_edit_invalid');

    const off = await call('POST', `/users/${id}/status`, { payload: { status: 'disabled' } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await db.query<{ status: string }>(
      `SELECT status FROM platform.platform_user WHERE id = $1`, [id])).rows[0]!.status).toBe('disabled');
    expectRefusal(await call('POST', `/users/${id}/status`, { payload: { status: 'suspended' } }),
      'platform_user_edit_invalid');
    expect((await call('POST', `/users/${id}/status`, { payload: { status: 'active' } })).status).toBe(200);
  });

  it('shows a Salesperson only their own row, not a colleague’s revenue', async () => {
    // `sales` does not hold platform.user.view, so the directory -- and every
    // colleague's revenue on it -- is closed to them at the route.
    const seen = await call('GET', '/sales-persons', { as: { id: repA, role: 'sales' } });
    expect(seen.status).toBe(403);
  });

  it('stops a deactivated rep at their very next request, not when their token expires', async () => {
    const rep = await platformUser('sales', 'Soon Gone');
    expect((await call('GET', '/tenants', { as: { id: rep, role: 'sales' } })).status).toBe(200);
    expect((await call('POST', `/users/${rep}/status`, { payload: { status: 'disabled' } })).status).toBe(200);
    const after = await call('GET', '/tenants', { as: { id: rep, role: 'sales' } });
    expect(after.status, 'the same still-valid token must now be refused').toBe(403);
  });

  it('refuses switching off your own account', async () => {
    expectRefusal(await call('POST', `/users/${superAdminId}/status`, { payload: { status: 'disabled' } }),
      'platform_self_status_change');
  });

  it('refuses editing someone more senior than the editor could have granted', async () => {
    await db.query('BEGIN');
    try {
      await expect(updatePlatformUser(db, {
        platformUserId: superAdminId, actorRoleKey: 'support', email: 'taken@over.test',
      })).rejects.toBeInstanceOf(PlatformGrantExceedsAuthorityError);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('is refused to a Salesperson, who holds neither staff key', async () => {
    const refused = await call('PATCH', `/users/${repB}`,
      { as: { id: repA, role: 'sales' }, payload: { fullName: 'Rep B Renamed' } });
    expect(refused.status).toBe(403);
  });
});

/* ------------------------------------------------ restaurant manager login --- */

/**
 * Redeemed as the APP role, through RLS, never as the owner: an owner client
 * is exempt from RLS by table ownership, and a redemption test run that way
 * would pass while the real route -- which holds a katkitchen_app connection --
 * failed on its first write to app.credential.
 */
async function redeem(token: string, password: string): Promise<AcceptOwnerInviteResult> {
  const app = appClient();
  await app.connect();
  try {
    await app.query('BEGIN');
    const result = await acceptOwnerInvite(app, { token, password });
    await app.query('COMMIT');
    return result;
  } catch (error) {
    await app.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await app.end();
  }
}

describe('the Restaurant Manager sets their own password from a setup link', () => {
  it('redeems the link from provisioning, once, and the manager can then sign in', async () => {
    const slug = `inv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const made = await call('POST', '/tenants', {
      as: { id: repA, role: 'sales' }, idem: true,
      payload: {
        slug, name: 'Invite Probe', currency: 'INR', timezone: 'Asia/Kolkata',
        ownerEmail: `${slug}@owner.test`, ownerName: 'Owner', firstBranchName: 'Main',
        planVersionId: basicVersion, taxJurisdiction: 'IN',
      },
    });
    const token = made.body['inviteToken'] as string;
    expect(typeof token).toBe('string');

    const accepted = await redeem(token, 'a-manager-password');
    expect(accepted).toMatchObject({ ok: true, tenantSlug: slug, email: `${slug}@owner.test` });

    const app = appClient();
    await app.connect();
    try {
      await app.query('BEGIN');
      const context = await adoptTenantContext(app, accepted.ok ? accepted.tenantId : '');
      const signIn = await authenticatePassword(context, {
        email: `${slug}@owner.test`, password: 'a-manager-password',
      });
      expect((signIn as { ok?: boolean }).ok, JSON.stringify(signIn)).toBe(true);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }

    expect(await redeem(token, 'another-password-1')).toMatchObject({ ok: false, reason: 'invite_used' });
    const listedRow = (await listed(`search=${slug}`))[0]!;
    expect(listedRow['ownerInviteStatus']).toBe('accepted');

    // After sign-up a new link is a password RESET: refused without a reason...
    const tenantId = made.body['tenantId'] as string;
    expectRefusal(await call('POST', `/tenants/${tenantId}/owner-invite`, { payload: {} }),
      'owner_reset_reason_required');

    // ...issued with one (kept on the invite row), and redeeming it replaces the
    // password: the old one stops working, the new one signs in.
    const reset = await call('POST', `/tenants/${tenantId}/owner-invite`,
      { as: { id: repA, role: 'sales' }, payload: { reason: 'manager forgot password' } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body['isReset']).toBe(true);
    const stored = await db.query<{ reissue_reason: string }>(
      `SELECT reissue_reason FROM platform.tenant_owner_invite
        WHERE tenant_id = $1 AND status = 'pending'`, [tenantId]);
    expect(stored.rows[0]!.reissue_reason).toBe('manager forgot password');
    expect(await redeem(reset.body['inviteToken'] as string, 'a-brand-new-password')).toMatchObject({ ok: true });

    const check = appClient();
    await check.connect();
    try {
      await check.query('BEGIN');
      const context = await adoptTenantContext(check, tenantId);
      expect((await authenticatePassword(context, {
        email: `${slug}@owner.test`, password: 'a-manager-password' })).ok, 'old password still works').toBe(false);
      expect((await authenticatePassword(context, {
        email: `${slug}@owner.test`, password: 'a-brand-new-password' })).ok).toBe(true);
      await check.query('ROLLBACK');
    } finally {
      await check.end();
    }
  });

  it('re-issues a link, revoking the old one, and never writes the token to the audit log', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const first = await call('POST', `/tenants/${made.tenantId}/owner-invite`, { as: { id: repA, role: 'sales' } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await call('POST', `/tenants/${made.tenantId}/owner-invite`);
    expect(second.status).toBe(200);

    expect(await redeem(first.body['inviteToken'] as string, 'a-manager-password'))
      .toMatchObject({ ok: false, reason: 'invite_invalid' });

    const audit = await db.query<{ after: unknown }>(
      `SELECT after FROM platform.platform_audit_log
        WHERE action = 'tenant.owner_invite.reissued' AND target_id = $1`, [made.tenantId]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((row) => row.after === null), 'a bearer secret reached the audit log').toBe(true);

    expect(await redeem(second.body['inviteToken'] as string, 'a-manager-password'))
      .toMatchObject({ ok: true });
  });

  it('refuses an expired link, and a rep re-issuing for another rep\'s restaurant', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const link = await call('POST', `/tenants/${made.tenantId}/owner-invite`);
    await db.query(
      `UPDATE platform.tenant_owner_invite SET expires_at = now() - interval '1 minute'
        WHERE tenant_id = $1 AND status = 'pending'`, [made.tenantId]);
    expect(await redeem(link.body['inviteToken'] as string, 'a-manager-password'))
      .toMatchObject({ ok: false, reason: 'invite_expired' });
    expect((await listed(`search=${made.slug}`))[0]!['ownerInviteStatus']).toBe('expired');

    expectRefusal(await call('POST', `/tenants/${made.tenantId}/owner-invite`,
      { as: { id: repB, role: 'sales' } }), 'restaurant_unknown');
  });

  it('refuses a switched-off restaurant, and a password under ten characters before looking at the token', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const link = await call('POST', `/tenants/${made.tenantId}/owner-invite`);
    await call('POST', `/tenants/${made.tenantId}/deactivate`, { payload: { reason: 'switched off' } });
    expect(await redeem(link.body['inviteToken'] as string, 'a-manager-password'))
      .toMatchObject({ ok: false, reason: 'tenant_login_blocked' });
    expect(ownerPasswordProblem('short')).not.toBeNull();
    expect(ownerPasswordProblem('long-enough-1')).toBeNull();
  });
});

/* ------------------------------------------------------------ renewal --- */

describe('renewing a subscription', () => {
  it('extends from the current end, never from today, and a renewed trial is active', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const before = (await db.query<{ id: string; e: string }>(
      `SELECT id, current_period_end::text AS e FROM platform.subscription WHERE tenant_id = $1`,
      [made.tenantId])).rows[0]!;
    const renewed = await call('POST', `/subscriptions/${before.id}/renew`,
      { as: { id: repA, role: 'sales' }, payload: { periods: 2 } });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const after = (await db.query<{ status: string; s: string; months: number }>(
      `SELECT status, current_period_start::text AS s,
              (extract(year from age(current_period_end, current_period_start)) * 12
               + extract(month from age(current_period_end, current_period_start)))::int AS months
         FROM platform.subscription WHERE id = $1`, [before.id])).rows[0]!;
    expect(after.status).toBe('active');
    expect(after.s).toBe(before.e);
    expect(after.months).toBe(2);
  });

  it('refuses another rep\'s subscription, a cancelled one, and a period count out of range', async () => {
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const subId = (await db.query<{ id: string }>(
      `SELECT id FROM platform.subscription WHERE tenant_id = $1`, [made.tenantId])).rows[0]!.id;
    expectRefusal(await call('POST', `/subscriptions/${subId}/renew`,
      { as: { id: repB, role: 'sales' }, payload: { periods: 1 } }), 'subscription_unknown');
    expectRefusal(await call('POST', `/subscriptions/${subId}/renew`, { payload: { periods: 13 } }),
      'renewal_periods_invalid');
    await db.query(
      `UPDATE platform.subscription SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [subId]);
    expectRefusal(await call('POST', `/subscriptions/${subId}/renew`, { payload: { periods: 1 } }),
      'subscription_not_renewable');
  });
});

/* ------------------------------------------------------- plan status --- */

describe('an inactive plan is no longer sold', () => {
  it('refuses provisioning on a retired plan, and sells it again once reactivated', async () => {
    const planId = randomUUID();
    const versionId = randomUUID();
    await db.query(`INSERT INTO platform.plan (id, key, name) VALUES ($1, $2, 'Retiring Probe')`,
      [planId, `rprobe_${planId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO platform.plan_version
         (id, plan_id, version, price_minor, currency, billing_period, published_at)
       VALUES ($1, $2, 1, 1000, 'INR', 'monthly', now())`, [versionId, planId]);

    expect((await call('POST', `/plans/${planId}/status`, { payload: { status: 'retired' } })).status).toBe(200);
    const refused = await call('POST', '/tenants', {
      idem: true,
      payload: {
        slug: `ret${randomUUID().replace(/-/g, '').slice(0, 10)}`, name: 'Retired Probe',
        currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: 'o@retired.test', ownerName: 'O',
        firstBranchName: 'Main', planVersionId: versionId, taxJurisdiction: 'IN',
      },
    });
    expectRefusal(refused, 'plan_retired');

    expect((await call('POST', `/plans/${planId}/status`, { payload: { status: 'active' } })).status).toBe(200);
    await provisionAs({ id: superAdminId, role: 'super_admin' }, versionId);
    expectRefusal(await call('POST', `/plans/${planId}/status`, { payload: { status: 'gone' } }),
      'plan_status_invalid');
    expect((await call('POST', `/plans/${planId}/status`,
      { as: { id: repA, role: 'sales' }, payload: { status: 'retired' } })).status).toBe(403);
  });
});

/* ---------------------------------------------------- password reset --- */

describe('resetting a Sales Person\'s password', () => {
  it('returns a new password once, which signs in, and keeps it out of the audit log', async () => {
    const rep = await platformUser('sales', 'Reset Me');
    const reset = await call('POST', `/users/${rep}/password`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const password = reset.body['password'] as string;
    expect(password.length).toBeGreaterThanOrEqual(12);
    const email = reset.body['email'] as string;
    const login = await authenticatePlatformUser(db, { email, password });
    expect(login.ok).toBe(true);
    const audit = await db.query<{ after: unknown }>(
      `SELECT after FROM platform.platform_audit_log
        WHERE action = 'platform_user.password_reset' AND target_id = $1`, [rep]);
    expect(audit.rows[0]!.after).toBeNull();
  });

  it('is refused to a Salesperson, and on your own account', async () => {
    expect((await call('POST', `/users/${repB}/password`, { as: { id: repA, role: 'sales' } })).status).toBe(403);
    expectRefusal(await call('POST', `/users/${superAdminId}/password`), 'platform_self_status_change');
  });
});

/* ------------------------------------------- a rep's book, on every route --- */

describe('a Salesperson reaches only their own book, on every route that takes an id', () => {
  it('cannot change, read or revoke a plan change on another rep\'s restaurant', async () => {
    const theirs = await provisionAs({ id: repB, role: 'sales' }, basicVersion);
    const subId = (await db.query<{ id: string }>(
      `SELECT id FROM platform.subscription WHERE tenant_id = $1`, [theirs.tenantId])).rows[0]!.id;
    const asA = { id: repA, role: 'sales' };
    expectRefusal(await call('POST', `/subscriptions/${subId}/change`,
      { as: asA, payload: { planVersionId: proVersion } }), 'restaurant_unknown');
    expectRefusal(await call('GET', `/subscriptions/${subId}/pending-change`, { as: asA }),
      'restaurant_unknown');
    const unchanged = await db.query<{ plan_version_id: string }>(
      `SELECT plan_version_id FROM platform.subscription WHERE id = $1`, [subId]);
    expect(unchanged.rows[0]!.plan_version_id, 'the colleague\'s customer was repriced').toBe(basicVersion);

    // Their own rep can.
    const own = await call('POST', `/subscriptions/${subId}/change`,
      { as: { id: repB, role: 'sales' }, payload: { planVersionId: proVersion } });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
  });

  it('sees only their own invoices and dunning rows', async () => {
    const invoices = await call('GET', '/invoices?limit=200', { as: { id: repA, role: 'sales' } });
    expect(invoices.status).toBe(200);
    const tenantIds = (invoices.body as unknown as { tenantId: string }[]).map((i) => i.tenantId);
    if (tenantIds.length > 0) {
      const inBook = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform.provisioning_request
          WHERE tenant_id = ANY($1) AND requested_by_platform_user_id = $2`, [tenantIds, repA]);
      expect(Number(inBook.rows[0]!.n)).toBe(new Set(tenantIds).size);
    }
    const dunning = await call('GET', '/dunning', { as: { id: repA, role: 'sales' } });
    expect(dunning.status).toBe(200);
  });
});

describe('creating a restaurant records the sale in full', () => {
  it('stores the manager\'s name and phone, and a paid start bills from today', async () => {
    const slug = `paid${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const made = await call('POST', '/tenants', {
      as: { id: repA, role: 'sales' }, idem: true,
      payload: {
        slug, name: 'Paid Start Probe', currency: 'INR', timezone: 'Asia/Kolkata',
        ownerEmail: `${slug}@owner.test`, ownerName: 'Farah Khan', ownerPhone: '+91 98450 00000',
        firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN', startMode: 'paid',
      },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const row = (await listed(`search=${slug}`))[0]!;
    expect(row).toMatchObject({
      ownerName: 'Farah Khan', ownerPhone: '+91 98450 00000',
      subscriptionStatus: 'active', billingStatus: 'none',
    });
    const segment = await db.query<{ same: boolean }>(
      `SELECT g.starts_at = s.current_period_start AS same
         FROM platform.subscription s
         JOIN platform.subscription_segment g ON g.subscription_id = s.id
        WHERE s.tenant_id = $1`, [made.body['tenantId']]);
    expect(segment.rows[0]!.same, 'billing must start where the shown period starts').toBe(true);
  });

  it('refuses an unknown start mode and a malformed phone', async () => {
    const base = {
      name: 'Bad Input', currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: 'x@bad.test',
      ownerName: 'X', firstBranchName: 'Main', planVersionId: basicVersion, taxJurisdiction: 'IN',
    };
    expectRefusal(await call('POST', '/tenants', { idem: true,
      payload: { ...base, slug: `bad${randomUUID().slice(0, 8)}`, startMode: 'free' } }), 'provision_input_invalid');
    expectRefusal(await call('POST', '/tenants', { idem: true,
      payload: { ...base, slug: `bad${randomUUID().slice(0, 8)}`, ownerPhone: 'call me' } }), 'provision_input_invalid');
  });
});

/* ------------------------------------------------ names and own account --- */

describe('the Sales Person is named from their account, everywhere', () => {
  it('answers GET /me with the caller\'s own account and nobody else\'s', async () => {
    const me = await call('GET', '/me', { as: { id: repA, role: 'sales' } });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({ platformUserId: repA, fullName: 'Rep A', roleKey: 'sales', status: 'active' });
  });

  it('puts the rep\'s name, email and phone on every restaurant they sold', async () => {
    await db.query(`UPDATE platform.platform_user SET phone = '+91 90000 00001' WHERE id = $1`, [repA]);
    const made = await provisionAs({ id: repA, role: 'sales' }, basicVersion);
    const row = (await listed(`search=${made.slug}`))[0]!;
    expect(row).toMatchObject({ salesPersonName: 'Rep A', salesPersonPhone: '+91 90000 00001' });
    expect(String(row['salesPersonEmail'])).toContain('RepA+');
  });

  it('counts each rep\'s active, expiring and expired subscriptions by the badge\'s own rule', async () => {
    const rep = await platformUser('sales', 'Counting Rep');
    const live = await provisionAs({ id: rep, role: 'sales' }, basicVersion);
    const soon = await provisionAs({ id: rep, role: 'sales' }, basicVersion);
    const gone = await provisionAs({ id: rep, role: 'sales' }, basicVersion);
    const off = await provisionAs({ id: rep, role: 'sales' }, basicVersion);
    await db.query(`UPDATE platform.subscription SET current_period_end = now() + interval '30 days' WHERE tenant_id = $1`, [live.tenantId]);
    await db.query(`UPDATE platform.subscription SET current_period_end = now() + interval '2 days' WHERE tenant_id = $1`, [soon.tenantId]);
    await db.query(`UPDATE platform.subscription SET current_period_start = now() - interval '40 days',
                      current_period_end = now() - interval '1 day' WHERE tenant_id = $1`, [gone.tenantId]);
    await call('POST', `/tenants/${off.tenantId}/deactivate`, { payload: { reason: 'counted as suspended' } });

    const people = await call('GET', '/sales-persons');
    const row = (people.body as unknown as Record<string, unknown>[]).find((p) => p['platformUserId'] === rep)!;
    expect(row).toMatchObject({ restaurantsSold: 4, activeSubscriptions: 2, expiringSoon: 1, expired: 1 });
  });

  it('has ONE "expiring soon" rule: the console imports it rather than declaring a copy', async () => {
    const { readFileSync } = await import('node:fs');
    const client = readFileSync('../frontend/src/features/restaurants/platform/subscription.ts', 'utf8');
    expect(client, 'the console must take the rule from @universalpos/shared')
      .toMatch(/import \{ EXPIRING_WITHIN_DAYS \} from '@universalpos\/shared';/);
    expect(client, 'a second copy of the rule has appeared in the console')
      .not.toMatch(/const EXPIRING_WITHIN_DAYS\s*=/);
    expect(EXPIRING_WITHIN_DAYS).toBe(7);
  });
});

describe('a platform user changes their own password', () => {
  it('only with the current one, which then stops working', async () => {
    const email = `self+${randomUUID()}@platform.test`;
    const made = await call('POST', '/users', {
      payload: { email, fullName: 'Self Service', password: 'the-first-password', roleKey: 'sales' },
    });
    expect(made.status).toBe(200);

    expect((await changePlatformPassword(db, {
      email, currentPassword: 'a-wrong-password', newPassword: 'the-second-password',
    })).ok).toBe(false);
    expect((await changePlatformPassword(db, {
      email, currentPassword: 'the-first-password', newPassword: 'the-second-password',
    })).ok).toBe(true);
    expect((await authenticatePlatformUser(db, { email, password: 'the-first-password' })).ok).toBe(false);
    expect((await authenticatePlatformUser(db, { email, password: 'the-second-password' })).ok).toBe(true);
  });
});
