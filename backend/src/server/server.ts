import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { buildServer } from './app.js';
import { allRoutes } from '../routes/index.js';
import { isUnserved, mergeHandlers } from '../routes/lookup.js';
import { posHandlers } from '../routes/handlers/pos.js';
import { syncHandlers } from '../routes/handlers/sync.js';
import { authHandlers } from '../routes/handlers/auth.js';
import { adminHandlers } from '../routes/handlers/admin.js';
import { crmHandlers } from '../routes/handlers/crm.js';
import { planHandlers } from '../routes/handlers/plan.js';
import { setupHandlers } from '../routes/handlers/setup.js';
import { accessHandlers } from '../routes/handlers/access.js';
import { staffHandlers } from '../routes/handlers/staff.js';
import { reportHandlers } from '../routes/handlers/reports.js';
import { platformHandlers } from '../routes/handlers/platform.js';
import { assertDatabaseSafety } from '../database/startupChecks.js';
import {
  RedisEntitlementCache,
  assertCacheReady,

  
  createRedis,
} from '../modules/platform/redisEntitlementCache.js';
import { env } from '../config/env.js';
import type { RouteDefinition } from '../middleware/routeRegistry.js';

/**
 * The process.
 *
 * ###########################################################################
 * THIS IS THE FIRST PRODUCTION CALLER `buildServer` HAS EVER HAD.
 *
 * Until now the assembly ran only from `assembly.test.ts` -- which is how the
 * public branch went to production through the tenant registrar and every login
 * would have answered 401. A server with no entry point is the same defect one
 * level up: correct code, wired to nothing.
 *
 * So this file does exactly one thing, and does it in a fixed order: it turns
 * the environment into a running server, with every step a HARD GATE. Nothing
 * here is a fallback, a default or a retry. A process that cannot satisfy a gate
 * exits non-zero and lets the orchestrator restart it with backoff -- because an
 * orchestrator routes around a process that is DOWN, and routes traffic INTO one
 * that is up and wrong.
 * ###########################################################################
 */

// mergeHandlers, not a spread. A duplicate key between two surfaces refuses at
// boot rather than silently serving the last one -- see lookup.ts for the read
// that spent its whole life answering with the kitchen's data.
const HANDLERS = (jwtKey: string): Record<string, RouteDefinition['handler']> =>
  mergeHandlers(
    posHandlers(), syncHandlers(),
    adminHandlers(), staffHandlers(), reportHandlers(),
    crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(jwtKey),
    authHandlers(jwtKey));

/**
 * ###########################################################################
 * THE SERVER REGISTERS WHAT IS BUILT, AND THE RATCHET RECORDS WHAT IS NOT.
 *
 * `allRoutes` declares the WHOLE surface so the coverage assertion can read it;
 * only some of it has a handler. Registering the rest would put the stub in
 * production, and the audit middleware would then faithfully record
 * `tenant.provisioned` for a request that provisioned nothing -- which is why
 * `assertAllServed` refuses an unserved route outright.
 *
 * So the filter is `isUnserved`, the same predicate the gates use, and the count
 * is logged at boot: "62 declared routes are not built yet" is a fact an operator
 * should be able to read off a startup line rather than infer from a 404.
 * ###########################################################################
 */
function servable(jwtKey: string): {
  readonly routes: readonly RouteDefinition[];
  readonly served: ReadonlySet<string>;
  readonly unservedCount: number;
} {
  const everything = allRoutes(HANDLERS(jwtKey));
  const routes = everything.filter((route) => !isUnserved(route.handler));
  return {
    routes,
    served: new Set(routes.map((r) => `${r.method} ${r.url}`)),
    unservedCount: everything.length - routes.length,
  };
}

export interface StartedServer {
  readonly close: () => Promise<void>;
  readonly port: number;
}

export async function start(): Promise<StartedServer> {
  const jwtKey = env.jwtSigningKey();
  const port = env.port();

  // The request pool is the APP role THROUGH THE POOLER. That is the posture the
  // startup probe exists to verify, so it must be the connection the probe runs on.
  const pool = new pg.Pool({ connectionString: env.appDatabaseUrl(), max: 10 });

  // A SECOND, SMALL pool on the owner role, for the control plane only. See the
  // note on ServerOptions.ownerPool: the platform registrar opens its
  // transaction without a tenant GUC, and provisioning writes app tables, which
  // the app role refuses with SQLSTATE 28000. Deliberately tiny -- the control
  // plane is a handful of humans, and an owner connection is exempt from RLS, so
  // the pool that has that exemption should be as small as it can be.
  const ownerPool = new pg.Pool({ connectionString: env.ownerDatabaseUrl(), max: 3 });

  // An IDLE pooled connection that the server drops (a Postgres restart, a
  // pooler recycle) is reported as an 'error' event on the pool, and an
  // EventEmitter 'error' with no listener kills the process -- the whole API,
  // for every restaurant, over a connection nobody was using. The pool has
  // already discarded that client; the next checkout opens a fresh one.
  pool.on('error', (error) => console.error('app pool: idle connection lost:', error.message));
  ownerPool.on('error', (error) => console.error('owner pool: idle connection lost:', error.message));

  // Gate 1: is this database one where tenant isolation actually applies?
  // SET LOCAL survives its transaction and not past it; the role does not bypass
  // RLS, does not own tenant tables, and holds no UPDATE or DELETE on either
  // audit log. A failure here means RLS is inactive, so nothing may serve.
  const probe = await pool.connect();
  try {
    await assertDatabaseSafety(probe);
  } finally {
    probe.release();
  }
  console.log('startup: database safety probes passed');

  // Gate 2: the entitlement cache. Redis is not durable, and a process that
  // starts serving while the warm-up runs fails closed on every tenant for
  // however long it takes -- correct, and a platform-wide outage.
  const redis = createRedis(env.redisUrl());
  // `createRedis` is deliberately `lazyConnect` with `enableOfflineQueue: false`
  // -- fail fast rather than queue on an unreachable cache. That means the
  // connection must be established HERE: a ping issued before it is rejected
  // with "Stream isn't writeable", which reads like an unreachable Redis and is
  // really a caller that never dialled.
  try {
    await redis.connect();
  } catch (error) {
    await redis.quit().catch(() => undefined);
    throw new Error(
      `could not connect to Redis at ${env.redisUrl()}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const cache = new RedisEntitlementCache(redis);
  const owner = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await owner.connect();
  let warmed;
  try {
    warmed = await assertCacheReady(owner, cache, redis);
  } finally {
    await owner.end().catch(() => undefined);
  }
  console.log(
    `startup: entitlement cache warm (${warmed.tenantsLoaded} tenants, ` +
      `${warmed.skippedNewer} skipped as newer)`,
  );

  const { routes, served, unservedCount } = servable(jwtKey);
  const app = buildServer({ pool, ownerPool, jwtKey, routes, logger: true, entitlements: cache }, served);
  await app.listen({ port, host: '0.0.0.0' });

  console.log(
    `listening on :${port} — ${routes.length} routes served, ` +
      `${unservedCount} declared and not built yet`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Order matters: stop accepting requests, then let the things they depend on
    // go. Closing the pool first would fail requests already in flight.
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await ownerPool.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  };

  return { close, port };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  start()
    .then(({ close }) => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          console.log(`${signal}: draining`);
          void close().then(() => process.exit(0));
        });
      }
    })
    .catch((error: unknown) => {
      // Loud and non-zero. A gate that fails must not degrade into a process
      // that is up and wrong.
      console.error('startup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
