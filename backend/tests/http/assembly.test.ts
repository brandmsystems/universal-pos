import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildServer, UnservedRouteError } from '../../src/app.js';
import {
  AttemptPostureRefusedError,
  isAttemptPosture,
  resetRegistry,
  type RouteDefinition,
} from '../../src/core/middleware/routeRegistry.js';
import {
  CredentialRouteNeedsAttemptPostureError,
  PublicRouteCannotBeAuditedError,
} from '../../src/core/middleware/publicRoute.js';
import { allRoutes, ROUTES_WITHOUT_HANDLERS } from '../../src/routes/index.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { syncHandlers } from '../../src/routes/handlers/sync.js';
import { authHandlers } from '../../src/routes/handlers/auth.js';
import { isUnserved, mergeHandlers, handlerLookup } from '../../src/routes/lookup.js';
import { assertCheckedSet } from '../helpers/db.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { crmHandlers } from '../../src/routes/handlers/crm.js';
import { planHandlers } from '../../src/routes/handlers/plan.js';
import { setupHandlers } from '../../src/routes/handlers/setup.js';
import { accessHandlers } from '../../src/routes/handlers/access.js';
import { staffHandlers } from '../../src/routes/handlers/staff.js';
import { reportHandlers } from '../../src/routes/handlers/reports.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { planCache } from '../helpers/plans.js';

/**
 * ###########################################################################
 * THE ASSEMBLY HAD NEVER RUN.
 *
 * `buildServer` had no caller anywhere -- not in src/, not in tests/. Every
 * existing HTTP test hand-builds a Fastify instance and calls
 * `registerTenantRoute` directly, which exercises the registrar but never the
 * assembly around it: the prefixes, the guard mounting, `assertAllServed`, or
 * the public branch.
 *
 * That is the pattern CLAUDE.md already names three times -- a job with no
 * runner, a check with no caller, a route with no server -- and it hid a live
 * defect: the public branch registered its routes through the TENANT registrar,
 * which 401s on a missing `tenant_id`. Every login would have failed, and the
 * registrar written specifically to refuse an audited public route
 * (`registerPublicRoute`) was never reached.
 *
 * So this file's job is to RUN the thing, in its production posture, rather than
 * to test around it.
 * ###########################################################################
 */

const JWT_KEY = 'assembly-test-key';

let pool: pg.Pool;
/**
 * A REAL pool, for the two assertions that inject a request.
 *
 * `registerPublicRoute` takes a pooled connection for every public route,
 * including one whose handler never touches the database -- so an unreachable
 * pool turns a 200 into a 500 and the assertion would be measuring the pool
 * rather than the registrar.
 */
let livePool: pg.Pool;

/** The handler maps, exactly as a real entry point would assemble them. */
function handlers(): Record<string, RouteDefinition['handler']> {
  return mergeHandlers(
      posHandlers(), syncHandlers(),
      adminHandlers(), staffHandlers(), reportHandlers(),
      crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
      platformHandlers('gate-test-key'), authHandlers('gate-test-key'));
}

/** The routes that actually have a handler, which is what a server may serve. */
function servableRoutes(): readonly RouteDefinition[] {
  return allRoutes(handlers()).filter((route) => !isUnserved(route.handler));
}

function servedKeys(routes: readonly RouteDefinition[]): Set<string> {
  return new Set(routes.map((r) => `${r.method} ${r.url}`));
}

beforeEach(() => {
  resetRegistry();
  // Never connected to. The assembly takes no connection at build time, and
  // asserting that implicitly is the point: if it did, this would hang.
  pool = new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused', max: 1 });
  livePool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 2 });
});

afterEach(async () => {
  await pool.end().catch(() => undefined);
  await livePool.end().catch(() => undefined);
});

describe('the server assembly boots', () => {
  it('registers every servable route under its plane prefix', async () => {
    const routes = servableRoutes();
    assertCheckedSet({
      label: 'servable routes',
      checked: routes.map((r) => `${r.method} ${r.url}`),
      minimum: 20,
      mustInclude: [
        'POST /pos/order/:id/line',
        'POST /pos/order/:id/fire',
        'DELETE /pos/session/:id',
        'PATCH /pos/session/:id/table',
        'POST /pos/kot/:id/ready',
        'POST /pos/sync',
      ],
    });

    const app = buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes }, servedKeys(routes));
    await app.ready();

    const printed = app.printRoutes({ commonPrefix: false });

    // The tenant plane and the impersonation mount serve the SAME route set at
    // two prefixes, because an impersonation token is a third shape that must be
    // inert against the tenant guard rather than special-cased inside it.
    expect(printed).toContain('/api/t/pos/order/:id/line');
    expect(printed).toContain('/api/imp/pos/order/:id/line');
    expect(printed).not.toContain('/kds/');

    // Nothing tenant-shaped leaks onto the control-plane prefix.
    expect(printed).not.toContain('/api/platform/pos/');

    await app.close();
  });

  it('refuses to boot when a route has no handler', () => {
    // ###################################################################
    // THIS GATE USED TO DEPEND ON THE PRODUCT BEING UNFINISHED.
    //
    // It asserted `allRoutes(handlers()).length > servableRoutes().length` and
    // then required a refusal -- which worked only while some route in the real
    // table had no handler. The moment the last one was built, both halves went
    // green for the wrong reason: nothing was unserved, so nothing was refused,
    // so the assertion that the assembly REFUSES an unserved route stopped
    // testing anything at all.
    //
    // A gate that quietly retires itself when the work finishes is worse than no
    // gate, because it retires exactly when the next mistake becomes possible.
    // So the violation is synthetic now, and it is independent of how much of
    // the product exists.
    // ###################################################################
    const real = servableRoutes();
    const withHole: RouteDefinition[] = [...real, {
      method: 'GET', url: '/probe/never-built', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.view' },
      audit: 'none',
      handler: handlerLookup({})('neverBuilt'),
    }];

    expect(() =>
      buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes: withHole }, servedKeys(real)),
    ).toThrow(UnservedRouteError);
  });

  it('names the synthetic hole, so a boot failure is actionable', () => {
    const real = servableRoutes();
    const withHole: RouteDefinition[] = [...real, {
      method: 'POST', url: '/probe/also-never-built', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.create' },
      audit: { action: 'probe.attempted', target: 'order' },
      handler: handlerLookup({})('alsoNeverBuilt'),
    }];

    let error: UnservedRouteError | null = null;
    try {
      buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes: withHole }, servedKeys(real));
    } catch (caught) { error = caught as UnservedRouteError; }

    expect(error).toBeInstanceOf(UnservedRouteError);
    expect(error!.routes).toContain('POST /probe/also-never-built');
    // The message has to carry the names: a boot failure listing a count and not
    // the names is a boot failure someone works around.
    expect(error!.message).toContain('POST /probe/also-never-built');
  });

  it('boots the real surface, because nothing in it is unserved any more', () => {
    // The other side of the same coin, and the reason the synthetic hole above
    // is needed: the real table now has a handler for all 95 routes.
    const everything = allRoutes(handlers());
    expect(ROUTES_WITHOUT_HANDLERS).toEqual([]);
    expect(everything.length).toBe(servableRoutes().length);
    expect(() =>
      buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes: everything }, servedKeys(everything)),
    ).not.toThrow();
  });

  it('is not vacuous: the same set boots once its handlers are supplied', async () => {
    // Proves the refusal above is about the missing handlers and nothing else --
    // the "pin WHICH denial" rule. A stub map is legitimate here because what is
    // under test is the assembly's gate, not the handlers.
    const stub: RouteDefinition['handler'] = async () => ({ ok: true });
    const everything = allRoutes(handlers());
    const complete = new Set(everything.map((r) => `${r.method} ${r.url}`));

    // Public routes still cannot be audited, so drop them for this assertion and
    // pin that separately below.
    const guarded = everything.filter((r) => r.plane !== 'public');
    const withStubs = guarded.map((route) => ({ ...route, handler: stub }));

    const app = buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes: withStubs }, complete);
    await app.ready();
    expect(app.printRoutes({ commonPrefix: false })).toContain('/api/platform/impersonation');
    await app.close();
  });
});

describe('the public branch goes through its own registrar', () => {
  /**
   * A ROUTE WRITTEN THE WRONG WAY ON PURPOSE.
   *
   * This assertion used to borrow `/api/auth/login`, which declared an audit
   * posture the registrar had to refuse. That made the test hostage to a
   * production route's declaration: the moment login was corrected to an attempt
   * posture -- which is the whole point of the auth_attempt decision -- the test
   * would have stopped exercising the refusal and kept passing.
   *
   * So the violation is synthetic and lives here, in the same direction as the
   * synthetic handler the thin-handler gate runs.
   */
  const auditedPublicRoute = (): RouteDefinition => ({
    method: 'POST', url: '/api/auth/login', plane: 'public',
    audit: { action: 'auth.password.attempted', target: 'credential' },
    handler: async () => ({ ok: true }),
  });

  it('refuses an audited public route rather than inventing an attribution', async () => {
    // There is no actor_kind that fits an unauthenticated request, so the
    // registrar must refuse at REGISTRATION -- not write actor_kind='system'
    // with a made-up job name, which would satisfy the CHECK and corrupt the one
    // column separation of duties is auditable through.
    const routes = [auditedPublicRoute()];
    const app = buildServer(
      {
        pool, jwtKey: JWT_KEY, entitlements: planCache(), routes,
      },
      servedKeys(routes),
    );

    // Fastify surfaces a plugin's throw at ready(), not at register().
    await expect(app.ready()).rejects.toThrow(PublicRouteCannotBeAuditedError);
    await app.close().catch(() => undefined);
  });

  it('refuses a credential route that declares no attempt posture', async () => {
    // The other direction, and the reason `audit: 'none'` is not available on
    // /api/auth/: an unrecorded credential event is exactly what
    // platform.auth_attempt exists to prevent, and silence would read as an
    // omission rather than a decision.
    const routes: RouteDefinition[] = [{
      ...auditedPublicRoute(), audit: 'none',
    }];
    const app = buildServer(
      {
        pool, jwtKey: JWT_KEY, entitlements: planCache(), routes,
      },
      servedKeys(routes),
    );
    await expect(app.ready()).rejects.toThrow(CredentialRouteNeedsAttemptPostureError);
    await app.close().catch(() => undefined);
  });

  it('accepts the attempt posture the auth surface actually declares', async () => {
    // Pins that the refusals above are about the POSTURE and not about the path.
    const declared = allRoutes(handlers()).filter((r) => r.url.startsWith('/api/auth/'));
    // Seven: the four tenant-plane credential routes, the control plane's own
    // login and refresh, and the Restaurant Manager's setup-link redemption.
    // Counted rather than sampled so that adding an eighth is a deliberate act --
    // a credential route that slipped in without an attempt posture is a login
    // nothing records.
    // Eight with a platform user's own password change, which verifies the
    // current password exactly as login does. Nine with a staff member setting
    // their own password or PIN from a setup code. Ten with a username and
    // password at the restaurant's till (POST /api/auth/:tenantSlug/till).
    // Eight again with Basic only (0077): tablet enrolment and staff setup-code
    // redemption are gone.
    expect(declared).toHaveLength(8);
    expect(declared.map((r) => r.url)).toContain('/api/auth/:tenantSlug/till');
    expect(declared.map((r) => r.url)).toContain('/api/auth/invite/accept');
    expect(declared.map((r) => r.url)).toContain('/api/auth/platform/login');
    for (const route of declared) {
      expect(isAttemptPosture(route.audit), `${route.url} must declare an attempt`).toBe(true);
    }

    // The REAL route and the REAL handler. Substituting a stub here is how the
    // previous version of this assertion ended up finding no route at all: it
    // looked up a URL that had been renamed, spread `undefined`, and registered
    // a route with no method or url while still reporting success.
    const routes = [declared.find((r) => r.url === '/api/auth/:tenantSlug/login')!];
    expect(routes[0], 'the login route must be found by its real url').toBeDefined();
    const app = buildServer(
      {
        pool: livePool, jwtKey: JWT_KEY, entitlements: planCache(), routes,
      },
      servedKeys(routes),
    );
    await app.ready();
    expect(app.printRoutes({ commonPrefix: false })).toContain('login');
    await app.close();
  });

  it('refuses a credential-event posture on the tenant plane', async () => {
    // A request carrying a verified token is not a login. Recording one as a
    // credential event would put authenticated activity in a table nothing reads
    // as such -- and would leave it out of the audit log that should hold it.
    const routes: RouteDefinition[] = [{
      method: 'POST', url: '/pos/session', plane: 'tenant',
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { attempt: 'pin' },
      handler: async () => ({ ok: true }),
    }];
    const app = buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes }, servedKeys(routes));
    await expect(app.ready()).rejects.toThrow(AttemptPostureRefusedError);
    await app.close().catch(() => undefined);
  });

  it('accepts an unaudited public route, so the refusal is about the AUDIT', async () => {
    // Pins which denial fired above. /healthz is public with audit: 'none'.
    const healthz = allRoutes(handlers()).find((r) => r.url === '/healthz');
    expect(healthz!.audit).toBe('none');

    const routes = [healthz!];
    const app = buildServer(
      {
        pool: livePool, jwtKey: JWT_KEY, entitlements: planCache(), routes,
      },
      servedKeys(routes),
    );
    await app.ready();
    expect(app.printRoutes({ commonPrefix: false })).toContain('healthz');

    // And it answers without a token, which is the point of the public plane.
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('answers /healthz with the database unreachable, because liveness is not readiness', async () => {
    // `pool` here points at 127.0.0.1:1 and is never connectable. This test used
    // to be impossible: registerPublicRoute took a pooled connection and opened a
    // transaction for EVERY public route, including the one handler that touches
    // no database, so an unreachable Postgres turned this 200 into a 500.
    //
    // That is not a cosmetic difference. An orchestrator reads /healthz as
    // liveness and kills what answers 500 -- so a database blip would have
    // restarted every healthy API container, during precisely the incident when
    // restarting them makes recovery slower. The process being alive and the
    // database being reachable are two facts; this route reports the first.
    const healthz = allRoutes(handlers()).find((r) => r.url === '/healthz')!;
    const routes = [healthz];
    const app = buildServer({ pool, jwtKey: JWT_KEY, entitlements: planCache(), routes }, servedKeys(routes));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('does not route public traffic through the tenant registrar', async () => {
    // The regression. Through registerTenantRoute this returned 401
    // missing_tenant_id, because that registrar reads tenant_id from a verified
    // JWT that a pre-auth request does not have.
    const healthz = allRoutes(handlers()).find((r) => r.url === '/healthz')!;
    const routes = [healthz];
    const app = buildServer(
      {
        pool: livePool, jwtKey: JWT_KEY, entitlements: planCache(), routes,
      },
      servedKeys(routes),
    );
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).not.toBe(401);
    expect(response.json()).not.toMatchObject({ error: 'missing_tenant_id' });

    await app.close();
  });
});
