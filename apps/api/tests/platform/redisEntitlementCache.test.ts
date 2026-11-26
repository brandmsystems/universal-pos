import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import {
  RedisEntitlementCache, createRedis, warmUpEntitlements, assertCacheReady,
  WarmUpFailedError, ENTITLEMENT_TTL_SECONDS, type RedisLike,
} from '../../src/modules/platform/redisEntitlementCache.js';
import {
  requireEntitlement, publishEntitlement, EntitlementUnavailableError,
  VersionedEntitlementCache, type EntitlementDocument,
} from '../../src/modules/platform/entitlements.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let redis: Redis;
let cache: RedisEntitlementCache;
let tenantId: string, superAdminId: string, planVersionId: string;

function doc(over: Partial<EntitlementDocument> = {}): EntitlementDocument {
  return {
    tenantId, version: 1, planKey: 'p', planVersion: 1, status: 'active',
    limits: { branches: 5 }, features: { inventory: true },
    publishedAt: new Date().toISOString(), ...over,
  };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  redis = createRedis(process.env['REDIS_URL'] ?? 'redis://localhost:6380');
  await redis.connect();
  cache = new RedisEntitlementCache(redis);

  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);
  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `rds+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'rds_plan','Rds')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='rds_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at,limits)
     VALUES ($1,$2,1,100000,'INR','monthly',now(),'{"branches":5}'::jsonb)
     ON CONFLICT (plan_id,version) DO NOTHING`, [randomUUID(), planId]);
  planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  await owner.query('BEGIN');
  const r = await provisionTenant(owner, {
    idempotencyKey: `rds-${randomUUID()}`, slug: `r${randomUUID().slice(0, 8)}`,
    name: 'Redis Probe', currency: 'INR', timezone: 'Asia/Kolkata',
    ownerEmail: `rds-${randomUUID()}@o.test`, ownerName: 'Owner',
    firstBranchName: 'Main', planVersionId, taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  });
  await owner.query('COMMIT');
  tenantId = r.tenantId;
});

afterAll(async () => { await redis?.quit(); await owner?.end(); });
beforeEach(async () => { await redis.del(`entitlement:v1:${tenantId}`); });

/* -------------------------------------------------- the monotonic rule --- */

describe('D. the monotonic rule holds against real Redis', () => {
  it('accepts a higher version and rejects a lower one', async () => {
    expect(await cache.putReturningHeld(doc({ version: 5 }))).toBe(5);
    expect(await cache.putReturningHeld(doc({ version: 6 }))).toBe(6);

    // A late-arriving lower version is REJECTED, not applied. Otherwise a slow
    // in-flight publish silently restores features the tenant no longer pays for.
    expect(await cache.putReturningHeld(doc({ version: 4 }))).toBe(6);
    expect(await cache.heldVersion(tenantId)).toBe(6);
  });

  it('rejects an EQUAL version too', async () => {
    await cache.putReturningHeld(doc({ version: 5, planKey: 'first' }));
    expect(await cache.putReturningHeld(doc({ version: 5, planKey: 'second' }))).toBe(5);
    // A republish at the same version is a bug or a replay; neither may overwrite.
    expect((await cache.get(tenantId))!.planKey).toBe('first');
  });

  it('holds under CONCURRENT publishers, which is what the stub cannot prove', async () => {
    // The stub enforces the rule in TypeScript inside one process. Across the
    // network it is a read-modify-write, and this is the interleaving that eats a
    // version: both publishers read the same held value and both decide they win.
    await cache.putReturningHeld(doc({ version: 1 }));

    const versions = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    await Promise.all(
      versions.map((v) => cache.putReturningHeld(doc({ version: v, planKey: `v${v}` }))),
    );

    // Whatever order they landed in, the highest must survive.
    expect(await cache.heldVersion(tenantId)).toBe(10);
    expect((await cache.get(tenantId))!.planKey).toBe('v10');
  });

  it('never lets a slow low version overtake a fast high one', async () => {
    await cache.putReturningHeld(doc({ version: 20 }));
    // Nineteen racing writers, every one of them BELOW the held version.
    const results = await Promise.all(
      Array.from({ length: 19 }, (_, i) =>
        cache.putReturningHeld(doc({ version: i + 1 }))),
    );
    expect(results.every((held) => held === 20)).toBe(true);
    expect(await cache.heldVersion(tenantId)).toBe(20);
  });

  it('enforces the rule server-side, not in the caller', async () => {
    // Written straight to Redis, bypassing the class entirely. A caller that
    // forgot the rule is exactly the silent restoration this prevents, so the
    // rule must not live in TypeScript.
    await redis.set(`entitlement:v1:${tenantId}`, JSON.stringify(doc({ version: 9 })));
    expect(await cache.putReturningHeld(doc({ version: 8 }))).toBe(9);
  });

  it('overwrites a corrupt value rather than wedging the tenant', async () => {
    await redis.set(`entitlement:v1:${tenantId}`, 'not json at all');
    // Undecodable is not authoritative. One bad byte must not hold a tenant
    // hostage until the TTL expires.
    expect(await cache.putReturningHeld(doc({ version: 3 }))).toBe(3);
    expect(await cache.heldVersion(tenantId)).toBe(3);
  });

  it('sets a TTL on the winning write, and does not refresh it on a losing one', async () => {
    await cache.putReturningHeld(doc({ version: 5 }));
    const fresh = await redis.ttl(`entitlement:v1:${tenantId}`);
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThanOrEqual(ENTITLEMENT_TTL_SECONDS);

    await redis.expire(`entitlement:v1:${tenantId}`, 30);
    await cache.putReturningHeld(doc({ version: 2 }));
    // A losing write refreshing the TTL would let a stale publisher keep a newer
    // document alive past its own expiry -- a subtler downgrade.
    expect(await redis.ttl(`entitlement:v1:${tenantId}`)).toBeLessThanOrEqual(30);
  });

  it('matches the in-memory reference implementation exactly', async () => {
    const reference = new VersionedEntitlementCache();
    for (const v of [3, 7, 5, 7, 9, 1]) {
      await reference.put(doc({ version: v }));
      await cache.putReturningHeld(doc({ version: v }));
    }
    expect(await cache.heldVersion(tenantId)).toBe(reference.heldVersion(tenantId));
    expect(await cache.heldVersion(tenantId)).toBe(9);
  });
});

/* ------------------------------------------------------- failing closed --- */

describe('D. fails closed on a miss AND on an error, which are different cases', () => {
  it('refuses on a MISS', async () => {
    await expect(requireEntitlement(cache, tenantId)).rejects.toThrow(EntitlementUnavailableError);
  });

  it('refuses when Redis is REACHABLE BUT ERRORING', async () => {
    // Not the same as unreachable: the socket is fine and the command fails.
    // A cache that answers with an error must not be read as an empty one.
    const erroring: RedisLike = {
      async get() { throw new Error('READONLY You can\'t write against a read only replica.'); },
      async eval() { throw new Error('READONLY'); },
      async del() { throw new Error('READONLY'); },
      async ping() { return 'PONG'; },
      async quit() { return 'OK'; },
    };
    const broken = new RedisEntitlementCache(erroring);
    await expect(requireEntitlement(broken, tenantId)).rejects.toThrow(EntitlementUnavailableError);

    // And the raw error is NOT swallowed into a null by the cache itself: an
    // operator seeing "empty" would hunt a publish bug instead of a broken cache.
    await expect(broken.get(tenantId)).rejects.toThrow(/READONLY/);
  });

  it('refuses when Redis is UNREACHABLE', async () => {
    const dead = new Redis('redis://127.0.0.1:6399', {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true,
      retryStrategy: () => null,
    });
    dead.on('error', () => { /* expected */ });
    const unreachable = new RedisEntitlementCache(dead);

    await expect(requireEntitlement(unreachable, tenantId))
      .rejects.toThrow(EntitlementUnavailableError);
    dead.disconnect();
  });

  it('does not treat an unreachable cache as unlimited', async () => {
    // The whole reason it fails closed: an unreachable cache does not mean
    // unlimited, it means the tenant plane cannot PROVE entitlement.
    const erroring: RedisLike = {
      async get() { throw new Error('connection lost'); },
      async eval() { throw new Error('connection lost'); },
      async del() { throw new Error('connection lost'); },
      async ping() { throw new Error('connection lost'); },
      async quit() { return 'OK'; },
    };
    let refused = false;
    try {
      await requireEntitlement(new RedisEntitlementCache(erroring), tenantId);
    } catch { refused = true; }
    expect(refused).toBe(true);
  });
});

/* ------------------------------------------------------------ warm-up --- */

describe('D. the warm-up is the answer to an empty keyspace', () => {
  beforeEach(async () => {
    await publishEntitlement(owner, tenantId, 'warm-up probe');
  });

  it('refills from Postgres after a total flush', async () => {
    await redis.flushdb();
    expect(await cache.heldVersion(tenantId)).toBeNull();

    const result = await warmUpEntitlements(owner, cache);
    expect(result.tenantsLoaded).toBeGreaterThan(0);

    const held = await cache.heldVersion(tenantId);
    expect(held, 'Postgres is the durable copy; Redis is not').not.toBeNull();
  });

  it('loads the LATEST version per tenant, never an older one', async () => {
    await publishEntitlement(owner, tenantId, 'second');
    await publishEntitlement(owner, tenantId, 'third');
    const latest = Number((await owner.query<{ v: string }>(
      `SELECT max(version)::text AS v FROM platform.entitlement_document WHERE tenant_id=$1`,
      [tenantId])).rows[0]!.v);

    await redis.flushdb();
    await warmUpEntitlements(owner, cache);
    // Older versions stay in the table as history and must never be the one loaded.
    expect(await cache.heldVersion(tenantId)).toBe(latest);
  });

  it('CANNOT lower a version a concurrent publish already raised', async () => {
    const current = Number((await owner.query<{ v: string }>(
      `SELECT max(version)::text AS v FROM platform.entitlement_document WHERE tenant_id=$1`,
      [tenantId])).rows[0]!.v);

    // The race: the warm-up has read version N from Postgres, and before it
    // writes, a publish lands N+10 in Redis.
    await cache.putReturningHeld(doc({ version: current + 10, planKey: 'raced-ahead' }));

    const result = await warmUpEntitlements(owner, cache);

    // It goes through the SAME CAS as every publish, so it is just another
    // writer and loses. This is not a special case with its own reasoning.
    expect(await cache.heldVersion(tenantId)).toBe(current + 10);
    expect((await cache.get(tenantId))!.planKey).toBe('raced-ahead');
    expect(result.skippedNewer).toBeGreaterThan(0);
  });

  it('reports what it loaded and what it skipped, rather than exiting quietly', async () => {
    await redis.flushdb();
    const result = await warmUpEntitlements(owner, cache);
    assertCheckedSet({
      label: 'warm-up result fields',
      checked: Object.keys(result),
      minimum: 2,
      mustInclude: ['tenantsLoaded', 'skippedNewer'],
    });
    expect(result.tenantsLoaded).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------- readiness --- */

describe('D. readiness is a hard gate', () => {
  it('CRASHES rather than serving when Redis is unreachable at boot', async () => {
    const dead = new Redis('redis://127.0.0.1:6399', {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true,
      retryStrategy: () => null,
    });
    dead.on('error', () => { /* expected */ });

    // Decided, not emergent. Starting anyway would serve 402 to every tenant
    // while looking healthy to every liveness probe; not-ready is better than up
    // and wrong, and an orchestrator restart loop is an alert everyone has.
    await expect(assertCacheReady(owner, new RedisEntitlementCache(dead), dead))
      .rejects.toThrow(WarmUpFailedError);

    try {
      await assertCacheReady(owner, new RedisEntitlementCache(dead), dead);
    } catch (error) {
      expect((error as Error).message).toMatch(/must not start serving/);
      expect((error as Error).message).toMatch(/402/);
    }
    dead.disconnect();
  });

  it('fails the gate when Postgres cannot be read, too', async () => {
    const broken = {
      async query() { throw new Error('connection terminated'); },
    } as unknown as pg.ClientBase;
    await expect(warmUpEntitlements(broken, cache)).rejects.toThrow(WarmUpFailedError);
    await expect(warmUpEntitlements(broken, cache))
      .rejects.toThrow(/could not read entitlement documents/);
  });

  it('passes the gate on a healthy stack, and serves immediately after', async () => {
    await redis.flushdb();
    const result = await assertCacheReady(owner, cache, redis);
    expect(result.tenantsLoaded).toBeGreaterThan(0);

    // The point of the gate: by the time the process is ready, the very first
    // request already resolves rather than failing closed.
    await expect(requireEntitlement(cache, tenantId)).resolves.toBeTruthy();
  });
});
