import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { PERMISSION_KEYS } from '../../src/modules/authz/permissions.js';
import { PLATFORM_PERMISSION_KEYS, PLATFORM_PERMISSION_MODULES } from '../../src/modules/authz/platformPermissions.js';
import {
  PLATFORM_ROLES,
  checkPlatformSubsetGrant,
  platformRole,
} from '../../src/modules/authz/platformRoles.js';
import { seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { provisionTenant, ProvisioningConflictError } from '../../src/modules/platform/provisioning.js';
import { claimBatch, enqueue, markConsumed, markDelivered } from '../../src/modules/notifications/outbox.js';
import { formatMinor, minorUnitExponent, parseMinor } from '../../src/modules/platform/money.js';
import {
  anonymiseTenant,
  NotReadyForPurgeError,
  ladderThresholds,
  recomputeLadder,
  statusForElapsedDays,
} from '../../src/modules/platform/ladder.js';
import {
  VersionedEntitlementCache,
  assertWithinLimit,
  publishEntitlement, loadLatestEntitlement,
  requireEntitlement,
  EntitlementUnavailableError,
  UpgradeRequiredError,
  type EntitlementDocument,
} from '../../src/modules/platform/entitlements.js';

let owner: pg.Client;
let pool: pg.Pool;

let planVersionId: string;
let superAdminId: string;

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });

  await seedPlatformAuthz(owner);

  superAdminId = randomUUID();
  const roleId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)
  ).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3) ON CONFLICT (id) DO NOTHING`,
    [superAdminId, `root+${superAdminId}@platform.test`, roleId],
  );

  const planId = randomUUID();
  planVersionId = randomUUID();
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'growth', 'Growth')
     ON CONFLICT (key) DO NOTHING`,
    [planId],
  );
  const actualPlanId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.plan WHERE key = 'growth'`)
  ).rows[0]!.id;
  // Idempotent: the suite runs against a database that may already hold the
  // fixture, and plan versions are immutable once published.
  await owner.query(
    `INSERT INTO platform.plan_version
       (id, plan_id, version, price_minor, currency, billing_period, limits, features, published_at)
     VALUES ($1, $2, 1, 499900, 'INR', 'monthly',
             '{"branches": 3, "staff": 25}'::jsonb, '{"kds": true, "inventory": false}'::jsonb, now())
     ON CONFLICT (plan_id, version) DO NOTHING`,
    [planVersionId, actualPlanId],
  );
  planVersionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id = $1 AND version = 1`,
      [actualPlanId],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

/* --------------------------------------------------------------------- A --- */

describe('A. the platform permission model is its own vocabulary', () => {
  it('shares no key with the tenant catalogue', () => {
    assertCheckedSet({
      label: 'platform permission modules',
      checked: PLATFORM_PERMISSION_MODULES,
      minimum: 8,
      mustInclude: ['tenant', 'plan', 'subscription', 'staff', 'impersonation'],
    });

    const tenantKeys = new Set<string>(PERMISSION_KEYS);
    const overlap = PLATFORM_PERMISSION_KEYS.filter((k) => tenantKeys.has(k));
    expect(overlap, 'the two catalogues must not share a key').toEqual([]);
  });

  it('prefixes every key, so the DB CHECK cannot admit a tenant key', async () => {
    expect(PLATFORM_PERMISSION_KEYS.filter((k) => !k.startsWith('platform.'))).toEqual([]);

    await expect(
      owner.query(
        `INSERT INTO platform.platform_permission (key, module, name) VALUES ('order.void', 'x', 'x')`,
      ),
    ).rejects.toThrow(/platform_permission_key_format/);
  });

  it('never grants the control plane a way to read tenant operational data', () => {
    // The control plane never queries orders. Aggregates arrive by rollup.
    const forbidden = PLATFORM_PERMISSION_KEYS.filter((k) =>
      /order|kot|kds|bill\.|table\.|menu\./.test(k),
    );
    expect(forbidden).toEqual([]);
  });

  it('seeds the five fixed roles idempotently', async () => {
    const first = await seedPlatformAuthz(owner);
    assertCheckedSet({
      label: 'seeded platform roles',
      checked: [...first.rolesSeeded],
      minimum: 5,
      mustInclude: ['super_admin', 'sales', 'support', 'billing', 'read_only'],
    });

    const second = await seedPlatformAuthz(owner);
    expect(second.grantsAdded).toBe(0);
    expect(second.grantsRemoved).toBe(0);

    const rows = await owner.query<{ key: string; n: string }>(
      `SELECT r.key, count(*)::text AS n
         FROM platform.platform_role r
         JOIN platform.platform_role_permission rp ON rp.platform_role_id = r.id
        GROUP BY r.key ORDER BY r.key`,
    );
    const byKey = new Map(rows.rows.map((r) => [r.key, Number(r.n)]));
    expect(byKey.get('super_admin')).toBe(PLATFORM_PERMISSION_KEYS.length);
    expect(byKey.get('read_only')).toBeLessThan(byKey.get('super_admin')!);
  });

  it('stops a support user minting a super_admin', () => {
    const decision = checkPlatformSubsetGrant(
      platformRole('support').permissions,
      platformRole('super_admin').permissions,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.missing).toContain('platform.user.create');
  });

  it('lets super_admin grant anything, and read_only grant nothing above itself', () => {
    for (const role of PLATFORM_ROLES) {
      expect(
        checkPlatformSubsetGrant(platformRole('super_admin').permissions, role.permissions).ok,
        role.key,
      ).toBe(true);
    }
    expect(
      checkPlatformSubsetGrant(platformRole('read_only').permissions, platformRole('sales').permissions)
        .ok,
    ).toBe(false);
  });

  it('keeps money and impersonation in different hands', () => {
    const support = platformRole('support').permissions as readonly string[];
    const billing = platformRole('billing').permissions as readonly string[];
    expect(support).toContain('platform.impersonation.start');
    expect(support).not.toContain('platform.refund.issue');
    expect(billing).toContain('platform.refund.issue');
    expect(billing).not.toContain('platform.impersonation.start');
  });
});

/* --------------------------------------------------------------------- B --- */

function request(key: string, slug: string) {
  return {
    idempotencyKey: key,
    slug,
    name: slug,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    ownerEmail: `${slug}@owner.test`,
    ownerName: 'Owner',
    firstBranchName: 'Main',
    planVersionId,
    taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  };
}

async function provision(key: string, slug: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await provisionTenant(client, request(key, slug));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('B. provisioning is one transaction and truly idempotent', () => {
  it('creates the whole tenant in one go', async () => {
    const key = `prov-${randomUUID()}`;
    const result = await provision(key, `t${key.slice(5, 13)}`);
    expect(result.created).toBe(true);
    expect(result.inviteToken).not.toBeNull();

    const counts = await owner.query<{ roles: string; memberships: string; invites: string }>(
      `SELECT (SELECT count(*)::text FROM app.role WHERE tenant_id = $1) AS roles,
              (SELECT count(*)::text FROM app.membership WHERE tenant_id = $1) AS memberships,
              (SELECT count(*)::text FROM platform.tenant_owner_invite WHERE tenant_id = $1) AS invites`,
      [result.tenantId],
    );
    // Eight system roles: owner, branch_admin, manager, cashier, counter, waiter, kds, accounts
    // (chef retired in 0065 -- it duplicated kds).
    expect(Number(counts.rows[0]!.roles)).toBe(8);
    // owner tenant-wide AND cashier at the first branch.
    expect(Number(counts.rows[0]!.memberships)).toBe(2);
    expect(Number(counts.rows[0]!.invites)).toBe(1);

    // Side effects queued, never sent inline.
    const outbox = await owner.query<{ topic: string }>(
      `SELECT topic FROM platform.outbox WHERE dedupe_key LIKE $1 ORDER BY topic`,
      [`${result.tenantId}:%`],
    );
    // The first entitlement document is published in the same transaction, and
    // the tenant plane's cache is told through the outbox like any other change.
    expect(outbox.rows.map((r) => r.topic)).toEqual(
      ['entitlement.invalidate', 'tenant.owner_invite', 'tenant.provisioned']);
  });

  it('returns the SAME tenant on a sequential retry', async () => {
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;
    const first = await provision(key, slug);
    const second = await provision(key, slug);

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.created).toBe(false);
    expect(second.inviteToken, 'a retry cannot resurrect the one-time token').toBeNull();
  });

  it('returns the SAME tenant under a concurrent duplicate', async () => {
    // The case a check-then-insert cannot handle: both callers see "no prior
    // request" and both proceed. Only the unique constraint can arbitrate.
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;

    const [a, b] = await Promise.all([provision(key, slug), provision(key, slug)]);
    expect(a.tenantId).toBe(b.tenantId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const tenants = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.tenant WHERE slug = $1`,
      [slug],
    );
    expect(Number(tenants.rows[0]!.n), 'exactly one tenant').toBe(1);
  });

  it('refuses a reused key with changed parameters', async () => {
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;
    await provision(key, slug);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        provisionTenant(client, { ...request(key, slug), ownerEmail: 'different@owner.test' }),
      ).rejects.toThrow(ProvisioningConflictError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('creates nothing when the transaction fails partway', async () => {
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await provisionTenant(client, request(key, slug));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const tenants = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.tenant WHERE slug = $1`,
      [slug],
    );
    expect(Number(tenants.rows[0]!.n)).toBe(0);
  });
});

describe('B. the outbox is at-least-once, so consumers must be idempotent', () => {
  it('deduplicates a re-enqueue of the same logical event', async () => {
    const dedupe = `evt-${randomUUID()}`;
    const first = await enqueue(owner, { topic: 'test.topic', dedupeKey: dedupe, payload: { a: 1 } });
    const second = await enqueue(owner, { topic: 'test.topic', dedupeKey: dedupe, payload: { a: 1 } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('makes a duplicate delivery a no-op at the consumer', async () => {
    const dedupe = `evt-${randomUUID()}`;
    await enqueue(owner, { topic: 'test.topic', dedupeKey: dedupe, payload: {} });

    // The worker crashed after the downstream accepted it but before marking
    // delivered, so the same message arrives twice. That is normal operation.
    const firstDelivery = await markConsumed(owner, 'emailer', 'test.topic', dedupe);
    const secondDelivery = await markConsumed(owner, 'emailer', 'test.topic', dedupe);

    expect(firstDelivery, 'first delivery must act').toBe(true);
    expect(secondDelivery, 'redelivery must be a no-op').toBe(false);

    // A different consumer is unaffected: dedupe is per consumer.
    expect(await markConsumed(owner, 'indexer', 'test.topic', dedupe)).toBe(true);
  });

  it('hands a claimed message to only one worker', async () => {
    const dedupe = `evt-${randomUUID()}`;
    await enqueue(owner, { topic: 'claim.topic', dedupeKey: dedupe, payload: {} });

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const claimedByA = await claimBatch(a, 10);
      const claimedByB = await claimBatch(b, 10);

      const idsA = new Set(claimedByA.map((r) => r.id));
      const overlap = claimedByB.filter((r) => idsA.has(r.id));
      expect(overlap, 'SKIP LOCKED must prevent double handling').toEqual([]);

      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  it('stops redelivering once marked delivered', async () => {
    const dedupe = `evt-${randomUUID()}`;
    const { id } = await enqueue(owner, { topic: 'done.topic', dedupeKey: dedupe, payload: {} });
    await markDelivered(owner, id);

    const pending = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.outbox
        WHERE topic = 'done.topic' AND dedupe_key = $1 AND delivered_at IS NULL`,
      [dedupe],
    );
    expect(Number(pending.rows[0]!.n)).toBe(0);
  });
});

/* --------------------------------------------------------------------- C --- */

describe('C. money is integer minor units with a resolved exponent', () => {
  it('knows the exponent is not always 2', () => {
    expect(minorUnitExponent('INR')).toBe(2);
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
  });

  it('formats correctly for a zero-decimal currency', () => {
    // A hardcoded /100 renders this as 10.00 and looks entirely plausible.
    expect(formatMinor(1000, 'JPY')).toBe('1000 JPY');
    expect(formatMinor(1000, 'INR')).toBe('10.00 INR');
    expect(formatMinor(1000, 'KWD')).toBe('1.000 KWD');
  });

  it('parses without ever touching a float', () => {
    expect(parseMinor('10.50', 'INR')).toBe(1050n);
    expect(parseMinor('1000', 'JPY')).toBe(1000n);
    expect(parseMinor('1.005', 'KWD')).toBe(1005n);
    expect(() => parseMinor('10.5', 'JPY')).toThrow(/0 decimal/);
  });

  it('stores plan prices as bigint minor units', async () => {
    const row = await owner.query<{ price_minor: string; currency: string }>(
      `SELECT price_minor::text, currency FROM platform.plan_version WHERE id = $1`,
      [planVersionId],
    );
    expect(row.rows[0]!.price_minor).toBe('499900');
    expect(formatMinor(BigInt(row.rows[0]!.price_minor), row.rows[0]!.currency)).toBe('4999.00 INR');
  });
});

describe('C. the ladder recompute job', () => {
  it('reads thresholds from settings, not constants', async () => {
    const thresholds = await ladderThresholds(owner);
    expect(thresholds).toEqual({
      softLockDays: 7,
      hardLockDays: 15,
      retentionDays: 45,
      purgeDays: 135,
    });
  });

  it('maps elapsed days to the right rung', () => {
    const t = { softLockDays: 7, hardLockDays: 15, retentionDays: 45, purgeDays: 135 };
    expect(statusForElapsedDays(0, t)).toBe('past_due');
    expect(statusForElapsedDays(6, t)).toBe('past_due');
    expect(statusForElapsedDays(7, t)).toBe('soft_lock');
    expect(statusForElapsedDays(15, t)).toBe('hard_lock');
    expect(statusForElapsedDays(45, t)).toBe('retention');
    expect(statusForElapsedDays(135, t)).toBe('purge_pending');
  });

  it('advances a stale tenant and then asserts its own postcondition', async () => {
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;
    const { tenantId } = await provision(key, slug);

    // Day 0 twenty days ago: the status says past_due, the truth says hard_lock.
    await owner.query(
      `UPDATE platform.tenant
          SET status = 'past_due', delinquent_since = now() - interval '20 days',
              status_changed_at = now() - interval '20 days'
        WHERE id = $1`,
      [tenantId],
    );

    const run = await recomputeLadder(owner);
    expect(run.advanced.some((a) => a.tenantId === tenantId && a.to === 'hard_lock')).toBe(true);
    // Positive postcondition: nothing left disagreeing with its own day 0.
    expect(run.stillDisagreeing).toEqual([]);

    const after = await owner.query<{ status: string }>(
      `SELECT status FROM platform.tenant WHERE id = $1`,
      [tenantId],
    );
    expect(after.rows[0]!.status).toBe('hard_lock');
  });

  it('is idempotent: a second run advances nothing', async () => {
    const second = await recomputeLadder(owner);
    expect(second.advanced).toEqual([]);
    expect(second.stillDisagreeing).toEqual([]);
  });

  it('anonymises in place at purge, keeping memberships and audit intact', async () => {
    const key = `prov-${randomUUID()}`;
    const slug = `t${key.slice(5, 13)}`;
    const { tenantId, ownerUserId } = await provision(key, slug);

    const membershipsBefore = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.membership WHERE tenant_id = $1`,
      [tenantId],
    );

    // Purge is the END of the ladder. A tenant that was never delinquent cannot
    // be purged -- the Phase 0 biconditional on tenant already guarantees that,
    // and anonymiseTenant refuses before it gets there.
    await expect(anonymiseTenant(owner, tenantId)).rejects.toThrow(NotReadyForPurgeError);

    await owner.query(
      `UPDATE platform.tenant
          SET status = 'past_due', delinquent_since = now() - interval '140 days',
              status_changed_at = now() - interval '140 days'
        WHERE id = $1`,
      [tenantId],
    );
    await recomputeLadder(owner);
    const rung = await owner.query<{ status: string }>(
      `SELECT status FROM platform.tenant WHERE id = $1`,
      [tenantId],
    );
    expect(rung.rows[0]!.status).toBe('purge_pending');

    const result = await anonymiseTenant(owner, tenantId);
    expect(result.usersAnonymised).toBeGreaterThanOrEqual(1);

    // Idempotent: purging an already-purged tenant is a no-op, not an error.
    expect((await anonymiseTenant(owner, tenantId)).usersAnonymised).toBe(0);

    const user = await owner.query<{ full_name: string; email: string | null; phone: string | null }>(
      `SELECT full_name, email, phone FROM app.app_user WHERE id = $1`,
      [ownerUserId],
    );
    // The row survives. Deletion was never available.
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]!.full_name).toBe('Anonymised user');
    expect(user.rows[0]!.email).toBeNull();
    expect(user.rows[0]!.phone).toBeNull();

    const membershipsAfter = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.membership WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(membershipsAfter.rows[0]!.n).toBe(membershipsBefore.rows[0]!.n);

    const tenant = await owner.query<{ status: string }>(
      `SELECT status FROM platform.tenant WHERE id = $1`,
      [tenantId],
    );
    expect(tenant.rows[0]!.status).toBe('purged');
  });
});

/* --------------------------------------------------------------------- D --- */

describe('D. entitlements carry a monotonic version', () => {
  async function freshTenant(): Promise<string> {
    const key = `prov-${randomUUID()}`;
    const { tenantId } = await provision(key, `t${key.slice(5, 13)}`);
    return tenantId;
  }

  it('allocates strictly increasing versions', async () => {
    const tenantId = await freshTenant();
    // Provisioning published version 1 itself.
    const provisioned = await loadLatestEntitlement(owner, tenantId);
    expect(provisioned?.version).toBe(1);
    const v2 = await publishEntitlement(owner, tenantId, 'renewed');
    const v3 = await publishEntitlement(owner, tenantId, 'plan changed');
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(v2.planKey).toBe('growth');
    expect(v2.limits).toMatchObject({ branches: 3 });
  });

  it('rejects an out-of-order delivery instead of restoring a downgraded plan', async () => {
    const cache = new VersionedEntitlementCache();
    const tenantId = await freshTenant();

    const upgraded: EntitlementDocument = {
      tenantId,
      version: 4,
      planKey: 'growth',
      planVersion: 1,
      status: 'active',
      limits: { branches: 10 },
      features: { inventory: true },
      publishedAt: new Date().toISOString(),
    };
    const downgraded: EntitlementDocument = { ...upgraded, version: 5, limits: { branches: 1 }, features: { inventory: false } };

    await cache.put(downgraded);
    // The late-arriving v4 write. Without the version rule this silently restores
    // the features the tenant no longer pays for.
    await cache.put(upgraded);

    const held = await requireEntitlement(cache, tenantId);
    expect(held.version).toBe(5);
    expect(held.limits['branches']).toBe(1);
    expect(held.features['inventory']).toBe(false);
    expect(cache.heldVersion(tenantId)).toBe(5);
  });

  it('rejects a republish at the same version', async () => {
    const cache = new VersionedEntitlementCache();
    const tenantId = await freshTenant();
    const base: EntitlementDocument = {
      tenantId, version: 3, planKey: 'growth', planVersion: 1, status: 'active',
      limits: { branches: 3 }, features: {}, publishedAt: new Date().toISOString(),
    };
    await cache.put(base);
    await cache.put({ ...base, limits: { branches: 99 } });
    expect((await requireEntitlement(cache, tenantId)).limits['branches']).toBe(3);
  });

  it('fails CLOSED on a cache miss', async () => {
    const cache = new VersionedEntitlementCache();
    // An unreachable cache does not mean unlimited.
    await expect(requireEntitlement(cache, randomUUID())).rejects.toThrow(
      EntitlementUnavailableError,
    );
  });

  it('fails closed when the cache itself throws', async () => {
    const broken = {
      get: async () => {
        throw new Error('redis unreachable');
      },
      put: async () => undefined,
    };
    await expect(requireEntitlement(broken, randomUUID())).rejects.toThrow(
      EntitlementUnavailableError,
    );
  });

  it('returns 402 upgrade_required on a limit breach', async () => {
    const document: EntitlementDocument = {
      tenantId: randomUUID(), version: 1, planKey: 'growth', planVersion: 1, status: 'active',
      limits: { branches: 3 }, features: {}, publishedAt: new Date().toISOString(),
    };

    expect(() => assertWithinLimit(document, 'branches', 3)).not.toThrow();
    try {
      assertWithinLimit(document, 'branches', 4);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeRequiredError);
      expect((error as UpgradeRequiredError).statusCode).toBe(402);
      expect((error as UpgradeRequiredError).code).toBe('upgrade_required');
    }
  });

  it('treats an absent limit as deny, not unlimited', () => {
    const document: EntitlementDocument = {
      tenantId: randomUUID(), version: 1, planKey: 'growth', planVersion: 1, status: 'active',
      limits: {}, features: {}, publishedAt: new Date().toISOString(),
    };
    expect(() => assertWithinLimit(document, 'branches', 1)).toThrow(UpgradeRequiredError);
  });

  it('does not duplicate the ladder: a suspended tenant publishes as suspended', async () => {
    const tenantId = await freshTenant();
    await owner.query(
      `UPDATE platform.tenant SET status = 'retention', delinquent_since = now() - interval '50 days',
              status_changed_at = now() WHERE id = $1`,
      [tenantId],
    );
    const document = await publishEntitlement(owner, tenantId, 'ladder advanced');
    expect(document.status).toBe('suspended');
  });
});
