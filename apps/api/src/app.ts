import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { planeGuard } from './core/security/planeGuards.js';
import { impersonationGuard } from './core/security/impersonationGuard.js';
import type { EntitlementCache } from './modules/platform/entitlements.js';
import { registerTenantRoute, type RouteDefinition, type LeaseRequirement } from './core/middleware/routeRegistry.js';
import { registerPlatformRoute } from './core/middleware/platformRoute.js';
import { registerPublicRoute } from './core/middleware/publicRoute.js';
import { registerAgentRoute } from './core/middleware/agentRoute.js';
import { toErrorResponse } from './core/errors/errors.js';
import {
  requireIdempotencyKey, requireLeaseToken, requiresIdempotency,
} from './core/middleware/posHeaders.js';

/**
 * The server.
 *
 * ###########################################################################
 * THE PREFIXES ARE THE BOUNDARY, AND THE GUARDS ARE UNCHANGED.
 *
 * `/api/t/*` and `/api/platform/*` each get the plane guard they already had,
 * registered per prefix. Nothing here modifies `checkPlane`: the whole value of
 * that function is that it was written and tested before there were routes to
 * bend it around, and a "just this once" parameter added during assembly is how
 * a boundary becomes a suggestion.
 *
 * Impersonation gets its own prefix rather than a branch inside the tenant
 * guard, for the same reason. Its token is a third shape, inert against both
 * existing guards by construction; giving it a third mount point keeps that
 * true instead of relying on it.
 * ###########################################################################
 */

export interface ServerOptions {
  readonly pool: pg.Pool;
  /**
   * Where a route's `plan` gate reads the restaurant's entitlement document.
   * Production passes the Redis cache; a route table that declares a gate and is
   * built without one refuses to boot (PlanGateWithoutCacheError).
   */
  readonly entitlements?: EntitlementCache;
  /**
   * ###########################################################################
   * THE CONTROL PLANE NEEDS THE OWNER ROLE, AND USING THE APP POOL BROKE IT.
   *
   * `registerPlatformRoute` opens its transaction with NO tenant GUC -- by
   * design, because the control plane has no tenant to scope to. `provisionTenant`
   * then writes `app.branch`, `app.app_user`, `app.role` and `app.membership`,
   * and every `app` table refuses a write with no GUC set. Proven on the app
   * role rather than reasoned about:
   *
   *   ERROR:  app.tenant_id is not set: no tenant context for this query
   *   SQLSTATE 28000
   *
   * So `POST /tenants` could not create a tenant, and 28000 was in neither
   * ERROR_CONTRACT nor CONSTRAINT_PG_CODES -- it would have answered
   * `500 internal_error, retryable: false` in production while every test
   * passed, because every existing test builds its pool from
   * DATABASE_URL_OWNER.
   *
   * The owner is already the declared production role for this work:
   * `OWNER_POSTURE` in tests/db/ownerPosture.test.ts lists `provisionTenant`
   * with the reason "runs in the owner transaction before any tenant session
   * exists". The pool wiring simply did not match the posture the gate records.
   *
   * Handed ONLY to the control-plane routes that declare `role: 'owner'` -- see
   * RouteDefinition.role for why the whole plane having it was too much.
   *
   * Optional, and it falls back to `pool`: a test that only exercises the tenant
   * plane should not have to build two pools. The production entry point passes
   * both.
   * ###########################################################################
   */
  readonly ownerPool?: pg.Pool;
  readonly jwtKey: string;
  readonly routes: readonly RouteDefinition[];
  readonly logger?: boolean;
}

export class UnservedRouteError extends Error {
  constructor(readonly routes: readonly string[]) {
    super(
      `${routes.length} route(s) have no handler and would answer with a stub: ` +
        `${routes.join(', ')}. A route that cannot do its job does not register -- ` +
        'a mutation that returns {ok:true} without mutating writes an audit row ' +
        'for something that never happened.',
    );
    this.name = 'UnservedRouteError';
  }
}

/**
 * Every route the assembly registers must carry a real handler.
 *
 * The route table's default handler exists so the inventory test can reason
 * about the SHAPE of the surface without the domain layer. Letting that default
 * reach a running server would be a placeholder implementation in production:
 * the audit middleware would faithfully record `order.voided` for a request that
 * voided nothing.
 */
function assertAllServed(routes: readonly RouteDefinition[], served: ReadonlySet<string>): void {
  const missing = routes
    .map((r) => `${r.method} ${r.url}`)
    .filter((key) => !served.has(key));
  if (missing.length > 0) throw new UnservedRouteError(missing);
}

export interface BuildResult {
  readonly app: FastifyInstance;
}

export function buildServer(options: ServerOptions, served: ReadonlySet<string>): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  assertAllServed(options.routes, served);

  // One error handler. Domain errors carry a `code`; the contract maps it to a
  // status, a retryable flag and what the client should do. An unmapped error is
  // a 500 and NOT retryable -- the safe direction, since a retryable default on
  // an unknown failure is how a POS hammers a failing endpoint during service.
  app.setErrorHandler(async (error, _request, reply) => {
    const response = toErrorResponse(error);
    await reply.code(response.status).send(response.body);
  });

  const tenant = options.routes.filter((r) => r.plane === 'tenant');
  const platform = options.routes.filter((r) => r.plane === 'platform');
  const publicRoutes = options.routes.filter((r) => r.plane === 'public');
  const agentRoutes = options.routes.filter((r) => r.plane === 'agent');

  // ---- tenant plane -------------------------------------------------------
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', options.jwtKey));

    // Idempotency and the lease are enforced BEFORE the handler and before a
    // pooled connection is taken. A check inside a handler is one forgotten call
    // away from a double fire.
    scope.addHook('onRequest', async (request) => {
      const route = request.routeOptions.config as
        { posLease?: LeaseRequirement } | undefined;
      // The SAME predicate the registrar claims on. Two spellings of one rule
      // is how the hook demanded a key that eleven handlers then discarded.
      if (requiresIdempotency(request.method, request.url)) {
        requireIdempotencyKey(request);
      }
      if (route?.posLease !== undefined && route.posLease !== 'exempt') {
        requireLeaseToken(request, request.url);
      }
    });

    for (const route of tenant) {
      registerTenantRoute(scope, {
        pool: options.pool,
        ...(options.entitlements ? { entitlements: options.entitlements } : {}),
      }, route);
    }
  }, { prefix: '/api/t' });

  // ---- control plane ------------------------------------------------------
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('platform', options.jwtKey));
    for (const route of platform) {
      // Per route. Only a route that DECLARES the owner gets the owner
      // connection; everything else stays on the app role, which owns nothing
      // and is outside no policy.
      registerPlatformRoute(scope, {
        pool: route.role === 'owner' ? (options.ownerPool ?? options.pool) : options.pool,
      }, route);
    }
  }, { prefix: '/api/platform' });

  // ---- impersonation ------------------------------------------------------
  // Tenant-plane routes, reached with a third token shape. The guard resolves
  // the SESSION ROW on every request -- never cached, because any TTL is a
  // window in which a revoked superadmin is still inside a tenant -- and
  // enforces read-only before the handler.
  app.register(async (scope) => {
    scope.addHook('onRequest', impersonationGuard(options.pool, options.jwtKey));
    for (const route of tenant) {
      registerTenantRoute(scope, {
        pool: options.pool,
        ...(options.entitlements ? { entitlements: options.entitlements } : {}),
      }, route);
    }
  }, { prefix: '/api/imp' });

  // ---- public -------------------------------------------------------------
  // No plane guard, by declaration rather than by omission.
  //
  // ###########################################################################
  // THROUGH `registerPublicRoute`, NOT THE TENANT REGISTRAR.
  //
  // This used to call `registerTenantRoute`, which is wrong in two ways at once
  // and was invisible because `buildServer` had no caller:
  //
  //   1. The tenant registrar takes `tenant_id` from the verified JWT and 401s
  //      when it is absent. A pre-auth login request has no JWT, so EVERY login
  //      would have answered `401 missing_tenant_id` -- the auth surface could
  //      not work at all.
  //   2. It would have accepted the audited auth routes, then tried to write a
  //      tenant audit row with `actor_kind='user'` and no membership, violating
  //      `tenant_audit_log_attribution_exact` at request time.
  //
  // `registerPublicRoute` requires a credential-event posture on /api/auth/*
  // instead and writes platform.auth_attempt itself, which is the decision
  // recorded in CLAUDE.md: credential events have no shape in the attribution
  // CHECK, and inventing one inside a registrar would corrupt the column
  // separation of duties depends on.
  //
  // The public handlers come from the SAME map as every other handler -- there
  // is no second `publicHandlers` record any more. Two maps for one route meant
  // the gates could read servedness from one while the server ran the other.
  // ###########################################################################
  app.register(async (scope) => {
    for (const route of publicRoutes) {
      registerPublicRoute(scope, { pool: options.pool }, route);
    }
  });

  // ---- print agent --------------------------------------------------------
  // No JWT and no plane guard: the bearer is the agent's own secret, resolved
  // against app.print_agent on every request (agentRoute.ts).
  app.register(async (scope) => {
    for (const route of agentRoutes) {
      registerAgentRoute(scope, { pool: options.pool }, route);
    }
  });

  return app;
}
