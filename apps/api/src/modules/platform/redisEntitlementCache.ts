import Redis from 'ioredis';
import type pg from 'pg';
import {
  type EntitlementCache, type EntitlementDocument,
} from './entitlements.js';

/**
 * The entitlement cache, on Redis.
 *
 * ###########################################################################
 * THE MONOTONIC RULE MOVES INTO A LUA SCRIPT, AND THAT IS THE WHOLE POINT.
 *
 * The in-memory implementation enforces "strictly greater" in TypeScript:
 * read the held version, compare, write. That is correct there because a single
 * process runs it and nothing interleaves.
 *
 * Against Redis it is a read-modify-write across the network, and two publishers
 * racing produce the exact failure the version rule exists to prevent:
 *
 *   publisher A reads v5 -> decides v6 wins
 *   publisher B reads v5 -> decides v7 wins
 *   B writes v7
 *   A writes v6            <- the downgrade is now live, silently
 *
 * A WATCH/MULTI transaction would work but retries under contention. A Lua script
 * is atomic by construction: Redis runs it single-threaded to completion, so the
 * compare and the write cannot be separated by another writer. The rule lives in
 * one place, server-side, and no caller can forget it.
 * ###########################################################################
 */

const KEY_PREFIX = 'entitlement:v1:';

/** Five minutes, per the design. Event invalidation is the fast path; this is the floor. */
export const ENTITLEMENT_TTL_SECONDS = 5 * 60;

/**
 * KEYS[1] = the document key
 * ARGV[1] = incoming version
 * ARGV[2] = serialised document
 * ARGV[3] = ttl seconds
 *
 * Returns the version now held, so the caller can tell "mine won" from
 * "something newer was already there" without a second round trip.
 *
 * Note the TTL is refreshed ONLY when the write wins. Refreshing it on a losing
 * write would let a stale publisher keep a newer document alive past its own
 * expiry, which is a subtler version of the same downgrade.
 */
const CAS_SCRIPT = `
local held = redis.call('GET', KEYS[1])
if held then
  local ok, decoded = pcall(cjson.decode, held)
  -- An undecodable value is corrupt, not authoritative: overwrite it rather than
  -- letting one bad byte wedge a tenant until the TTL expires.
  if ok and decoded and decoded.version and tonumber(decoded.version) >= tonumber(ARGV[1]) then
    return tonumber(decoded.version)
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return tonumber(ARGV[1])
`;

export interface RedisLike {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export class RedisEntitlementCache implements EntitlementCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number = ENTITLEMENT_TTL_SECONDS,
  ) {}

  private key(tenantId: string): string {
    return `${KEY_PREFIX}${tenantId}`;
  }

  /**
   * A miss and an error are DIFFERENT facts, and both must reach the caller as
   * "cannot prove entitlement".
   *
   * A miss returns null and `requireEntitlement` refuses. An error is allowed to
   * propagate: swallowing it into null would report a reachable-but-broken Redis
   * as an empty one, and the operator would go looking for a publish bug instead
   * of a broken cache.
   */
  async get(tenantId: string): Promise<EntitlementDocument | null> {
    const raw = await this.redis.get(this.key(tenantId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as EntitlementDocument;
    } catch {
      // Corrupt value: treat as absent. Fail closed, and let the next publish or
      // the warm-up replace it.
      return null;
    }
  }

  /** Atomic compare-and-set. Returns the version held after the attempt. */
  async putReturningHeld(document: EntitlementDocument): Promise<number> {
    const held = await this.redis.eval(
      CAS_SCRIPT, 1,
      this.key(document.tenantId),
      String(document.version),
      JSON.stringify(document),
      String(this.ttlSeconds),
    );
    return Number(held);
  }

  async put(document: EntitlementDocument): Promise<void> {
    await this.putReturningHeld(document);
  }

  /**
   * Drops the entry so the next request reads the newest document from the
   * database. A delete, not a put: the consumer holding the message may be
   * older than a publish that has already landed, and a put could not know it.
   */
  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(this.key(tenantId));
  }

  async heldVersion(tenantId: string): Promise<number | null> {
    const document = await this.get(tenantId);
    return document?.version ?? null;
  }
}

export function createRedis(url?: string): Redis {
  return new Redis(url ?? process.env['REDIS_URL'] ?? 'redis://localhost:6380', {
    // Fail fast rather than queueing forever: a request waiting on an unreachable
    // cache is a request that has already failed, it just has not said so.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

/* ------------------------------------------------------------- warm-up --- */

export class WarmUpFailedError extends Error {
  readonly code = 'entitlement_warmup_failed';
  constructor(readonly reason: string) {
    super(
      `entitlement warm-up failed: ${reason}. The process must not start serving: ` +
        'every tenant would miss, every miss fails closed, and the platform would ' +
        'return 402 to everyone until the cache refilled.',
    );
    this.name = 'WarmUpFailedError';
  }
}

export interface WarmUpResult {
  readonly tenantsLoaded: number;
  readonly skippedNewer: number;
}

/**
 * ###########################################################################
 * REDIS IS NOT DURABLE, AND THE WARM-UP IS THE ANSWER TO THAT.
 *
 * A Redis restart comes back with an empty keyspace. Every tenant then misses,
 * every miss fails closed, and the whole platform stops serving write paths --
 * correct, and catastrophic. So the cache is refilled from Postgres, which IS
 * the durable copy: entitlement_document holds every version ever published.
 *
 * IT IS A HARD GATE ON READINESS, NOT A BACKGROUND TASK. A process that starts
 * serving while the warm-up runs fails closed on every tenant for however long
 * it takes. Not-ready is better than serving 402s: an orchestrator routes around
 * not-ready, and routes traffic INTO a process that is up and wrong.
 *
 * Reads Postgres as the OWNER, the same posture as publishEntitlement and forced
 * by the same thing: the document is built from platform.plan, plan_version,
 * subscription and tenant, all control-plane tables the owner already reads to
 * publish. The tenant plane only ever reads the result out of Redis.
 * ###########################################################################
 */
export async function warmUpEntitlements(
  client: pg.ClientBase,
  cache: RedisEntitlementCache,
): Promise<WarmUpResult> {
  let rows: readonly {
    tenant_id: string; version: string; plan_key: string; plan_version: number;
    status: string; limits: Record<string, number>; features: Record<string, boolean>;
    published_at: string;
  }[];

  try {
    const result = await client.query<{
      tenant_id: string; version: string; plan_key: string; plan_version: number;
      status: string; limits: Record<string, number>; features: Record<string, boolean>;
      published_at: string;
    }>(
      // The LATEST document per tenant. Older versions stay in the table as
      // history and must never be the one loaded.
      `SELECT DISTINCT ON (tenant_id)
              tenant_id, version::text, plan_key, plan_version, status, limits, features,
              published_at::text
         FROM platform.entitlement_document
        ORDER BY tenant_id, version DESC`,
    );
    rows = result.rows;
  } catch (error) {
    throw new WarmUpFailedError(
      `could not read entitlement documents: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let loaded = 0;
  let skippedNewer = 0;

  for (const row of rows) {
    const document: EntitlementDocument = {
      tenantId: row.tenant_id,
      version: Number(row.version),
      planKey: row.plan_key,
      planVersion: row.plan_version,
      status: row.status as EntitlementDocument['status'],
      limits: row.limits,
      features: row.features,
      publishedAt: row.published_at,
    };

    let held: number;
    try {
      // ####################################################################
      // THE WARM-UP CANNOT LOWER A VERSION A CONCURRENT PUBLISH ALREADY RAISED.
      //
      // It goes through the SAME Lua CAS as every publish, so it is not a
      // special case that needs its own reasoning -- it is just another writer,
      // and the script rejects anything not strictly greater than what is held.
      //
      // The race is real: a warm-up reading v5 from Postgres while a publish
      // writes v6 to Redis would, with a plain SET, put v5 back. With the CAS it
      // loses and reports that it lost.
      // ####################################################################
      held = await cache.putReturningHeld(document);
    } catch (error) {
      throw new WarmUpFailedError(
        `Redis unreachable while loading tenant ${row.tenant_id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (held > document.version) skippedNewer += 1;
    else loaded += 1;
  }

  return { tenantsLoaded: loaded, skippedNewer };
}

/**
 * Readiness.
 *
 * ###########################################################################
 * WHAT HAPPENS WHEN REDIS IS UNREACHABLE AT BOOT: THE PROCESS CRASHES.
 *
 * Decided, not emergent. The alternatives are worse:
 *
 *   - Start anyway and serve: every write path returns 402 to every tenant. The
 *     platform is up, healthy by every liveness probe, and refusing all traffic.
 *   - Start and retry in the background: the same outage, with the added
 *     property that nothing external can tell it is happening.
 *
 * Crashing is VISIBLE. An orchestrator restarts it with backoff, the restart
 * loop is an alert every platform already has, and no traffic is routed to a
 * process that cannot serve. Redis coming back turns the loop green with no
 * human action.
 *
 * The one thing this must not do is start serving. Everything else is recoverable.
 * ###########################################################################
 */
export async function assertCacheReady(
  client: pg.ClientBase,
  cache: RedisEntitlementCache,
  redis: RedisLike,
): Promise<WarmUpResult> {
  try {
    await redis.ping();
  } catch (error) {
    throw new WarmUpFailedError(
      `Redis is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return warmUpEntitlements(client, cache);
}
