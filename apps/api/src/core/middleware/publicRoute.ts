import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  MissingAuditPostureError,
  PermissionPlaneMismatchError,
  PUBLIC_PATH_PREFIXES,
  PublicRouteRefusedError,
  MUTATING_METHODS,
  isAttemptPosture,
  isAuditDescriptor,
  type RouteDefinition,
} from './routeRegistry.js';
import {
  recordAuthAttempt,
  type AttemptOutcome,
} from '../../modules/auth/authAttempt.js';

/**
 * The pre-auth surface.
 *
 * ###########################################################################
 * A CREDENTIAL EVENT IS NOT AN AUDIT ROW, AND THIS REGISTRAR IS WHERE THAT IS
 * ENFORCED RATHER THAN REMEMBERED.
 *
 * `tenant_audit_log_attribution_exact` requires, for `actor_kind = 'user'`, a
 * non-null `authorising_membership_id`. A login holds no membership -- and a
 * FAILED login holds no user at all. The other two kinds are worse fits:
 * `'impersonation'` needs a session, and `'system'` must name a job, which
 * "somebody typed a password" is not.
 *
 * DECIDED (CLAUDE.md): credential events live in `platform.auth_attempt`. The
 * audit log is not extended and `actor_kind` gains no fourth value, because a
 * new enum value is a value every existing attribution query must remember to
 * exclude.
 *
 * So there are exactly three shapes this registrar accepts, and the third is why
 * `audit: 'none'` was not good enough:
 *
 *   - `audit: { attempt: <method> }` -- a credential event. REQUIRED on
 *     `/api/auth/*`, and the row is written HERE rather than in the handler.
 *   - `audit: 'none'` -- permitted only OUTSIDE `/api/auth/`, which today means
 *     the health check.
 *   - `audit: { action, target }` -- REFUSED, still, and for the original
 *     reason: writing `actor_kind = 'system'` with a made-up job name would
 *     satisfy the CHECK and quietly corrupt the one column that makes
 *     separation of duties auditable.
 *
 * The METHOD comes from the route declaration, never from the handler's return.
 * A handler that could name its own method could record a password attempt as a
 * refresh, and the brute-force index would stop seeing what it exists to see.
 * ###########################################################################
 */

export class PublicRouteCannotBeAuditedError extends Error {
  readonly code = 'public_route_cannot_be_audited';
  constructor(method: string, url: string, action: string) {
    super(
      `${method} ${url} declares audit '${action}', but an unauthenticated request ` +
        'has no membership, no impersonation session and no system job -- the three ' +
        'shapes tenant_audit_log_attribution_exact permits. Credential events are ' +
        "recorded in platform.auth_attempt: declare audit: { attempt: '...' }.",
    );
    this.name = 'PublicRouteCannotBeAuditedError';
  }
}

export class CredentialRouteNeedsAttemptPostureError extends Error {
  readonly code = 'credential_route_needs_attempt_posture';
  constructor(method: string, url: string) {
    super(
      `${method} ${url} is on the pre-auth credential surface and declares no attempt ` +
        "posture. Add audit: { attempt: 'password' | 'pin' | 'refresh' | 'device_enrol' }. " +
        "audit: 'none' is not available here: an unrecorded credential event is exactly " +
        'what platform.auth_attempt exists to prevent, and silence would read as an ' +
        'omission rather than a decision.',
    );
    this.name = 'CredentialRouteNeedsAttemptPostureError';
  }
}

/**
 * What the handler resolved. The method is NOT here -- the route declares it.
 *
 * A rejection carries its reason verbatim from the domain's own union
 * (`PinRejection`, `EnrolmentFailure`, `TokenError.code`), because whoever reads
 * this table needs to know which of the failures happened.
 */
export interface AttemptResolution {
  readonly outcome: AttemptOutcome;
  readonly reason: string | null;
  readonly tenantId: string | null;
  /** As typed. Never resolved, never validated. */
  readonly claimedSubject: string | null;
  readonly resolvedUserId: string | null;
  /**
   * The control-plane subject a platform login resolved to. Optional rather than
   * `| null` on every caller: four of the five public routes are tenant routes
   * that can never produce one, and widening their shape would invite a reader
   * to think they might.
   */
  readonly platformUserId?: string | null;
  readonly branchId: string | null;
  readonly deviceFingerprint: string | null;
}

export interface PublicOutcome {
  /**
   * Required on a credential route, and must be absent on an unaudited one. The
   * registrar checks both directions: a handler that forgot to describe its
   * attempt fails loudly rather than logging nothing.
   */
  readonly attempt: AttemptResolution | null;
  readonly body: unknown;
}

export class MissingAttemptResolutionError extends Error {
  readonly code = 'missing_attempt_resolution';
  constructor(method: string, url: string) {
    super(
      `${method} ${url} declares an attempt posture but its handler returned no ` +
        'attempt resolution. The row is written by the registrar from what the ' +
        'handler resolved; with nothing to write, the credential event would be lost.',
    );
    this.name = 'MissingAttemptResolutionError';
  }
}

export class UnexpectedAttemptResolutionError extends Error {
  readonly code = 'unexpected_attempt_resolution';
  constructor(method: string, url: string) {
    super(
      `${method} ${url} declares audit: 'none' but its handler returned an attempt ` +
        'resolution. Either it is a credential route and should declare an attempt ' +
        'posture, or it is not and must not be recording credential events.',
    );
    this.name = 'UnexpectedAttemptResolutionError';
  }
}

/**
 * ###########################################################################
 * THE HANDLER MAY SET A STATUS. IT MAY NOT SEND.
 *
 * The attempt row is written AFTER the handler returns and inside the same
 * transaction, so a handler that called `reply.send()` would answer the tablet
 * before the credential event was committed -- and on a rollback the client
 * would hold a token for a login the database never recorded.
 *
 * `reply.code(...)` is fine and expected: a rejection answers 401 and still
 * commits its row.
 * ###########################################################################
 *
 * ###########################################################################
 * ONE HANDLER MAP FOR THE WHOLE ROUTE TABLE.
 *
 * This registrar used to take its handler as a separate `publicHandlers` record
 * keyed by URL, while the route table separately asked `h('login')` for a
 * handler it would never call. Two maps for one route is five-copies-of-a-marker
 * again: the gates read servedness from one of them and the server ran the
 * other, so a route could be "served" and unreachable, or reachable and reported
 * missing.
 *
 * So a public handler is an ordinary `RouteDefinition['handler']` and comes from
 * the same map as every other handler. It receives the pre-auth context --
 * `tenantId: ''`, the client, no actor -- exactly as a control-plane handler
 * does, and for the same reason: there is no tenant yet, so passing a real one
 * would be a lie the handler could act on.
 * ###########################################################################
 */
export type PublicHandler = RouteDefinition['handler'];

export class MalformedPublicOutcomeError extends Error {
  readonly code = 'malformed_public_outcome';
  constructor(method: string, url: string) {
    super(
      `${method} ${url} did not return a PublicOutcome. A public handler returns ` +
        '{ attempt, body }: the registrar needs `attempt` to write the credential ' +
        'event and `body` to answer with. The shape is checked because the handler ' +
        'map is typed as returning unknown.',
    );
    this.name = 'MalformedPublicOutcomeError';
  }
}

function asOutcome(value: unknown, method: string, url: string): PublicOutcome {
  if (typeof value !== 'object' || value === null || !('attempt' in value) || !('body' in value)) {
    throw new MalformedPublicOutcomeError(method, url);
  }
  return value as PublicOutcome;
}

function requestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : String(request.id);
}

export function registerPublicRoute(
  app: FastifyInstance,
  deps: { pool: pg.Pool },
  definition: RouteDefinition,
): void {
  if (definition.audit === undefined || definition.audit === null) {
    throw new MissingAuditPostureError(definition.method, definition.url);
  }
  if (definition.permission) {
    throw new PermissionPlaneMismatchError(
      definition.method, definition.url, 'public',
      definition.permission.plane, definition.permission.key);
  }
  if (!PUBLIC_PATH_PREFIXES.some((p) => definition.url.startsWith(p))) {
    throw new PublicRouteRefusedError(
      definition.method, definition.url, 'its path is not a declared public prefix');
  }
  if (MUTATING_METHODS.includes(definition.method) &&
      !definition.url.startsWith('/api/auth/')) {
    throw new PublicRouteRefusedError(
      definition.method, definition.url, 'it mutates outside /api/auth/');
  }

  if (isAuditDescriptor(definition.audit)) {
    throw new PublicRouteCannotBeAuditedError(
      definition.method, definition.url, definition.audit.action);
  }

  const posture = definition.audit;
  const isCredentialRoute = definition.url.startsWith('/api/auth/');

  // Both directions. A credential route with no attempt posture would record
  // nothing; an attempt posture off the credential surface would record
  // something nobody reads as a login.
  if (isCredentialRoute && !isAttemptPosture(posture)) {
    throw new CredentialRouteNeedsAttemptPostureError(definition.method, definition.url);
  }
  if (!isCredentialRoute && isAttemptPosture(posture)) {
    throw new PublicRouteRefusedError(
      definition.method, definition.url,
      'it declares a credential-event posture outside /api/auth/');
  }

  // ---- the credential surface -----------------------------------------------
  // ONE transaction. The credential verify already writes -- the lockout counter
  // on the credential row -- so the attempt row and the state change it describes
  // must commit or roll back together. Two statements on an autocommit connection
  // would let a lockout increment survive a failure to record why.
  if (isAttemptPosture(posture)) {
    app.route({
      method: definition.method,
      url: definition.url,
      handler: async (request, reply) => {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          try {
            const outcome = asOutcome(
              // The pre-auth context: no tenant, because there is not one yet.
              // `adoptTenantContext` is how a handler gets a real one once it has
              // resolved a slug or verified a refresh token.
              await definition.handler(request, reply, { tenantId: '', client, actor: null }),
              definition.method,
              definition.url,
            );
            if (!outcome.attempt) {
              throw new MissingAttemptResolutionError(definition.method, definition.url);
            }
            await recordAuthAttempt(client, {
              method: posture.attempt,
              outcome: outcome.attempt.outcome,
              reason: outcome.attempt.reason,
              tenantId: outcome.attempt.tenantId,
              claimedSubject: outcome.attempt.claimedSubject,
              resolvedUserId: outcome.attempt.resolvedUserId,
              platformUserId: outcome.attempt.platformUserId ?? null,
              branchId: outcome.attempt.branchId,
              deviceFingerprint: outcome.attempt.deviceFingerprint,
              ip: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
              requestId: requestId(request),
            });
            await client.query('COMMIT');
            return outcome.body;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        } finally {
          client.release();
        }
      },
    });
    return;
  }

  // ---- audit: 'none' --------------------------------------------------------
  // ###########################################################################
  // NO TRANSACTION, AND NO CONNECTION UNTIL ONE IS ASKED FOR.
  //
  // The transaction above exists to bind the attempt row to the credential state
  // change it describes. With no attempt row there is nothing to bind, so the
  // BEGIN/COMMIT bought nothing -- and the `pool.connect()` in front of it bought
  // something worse than nothing on the only route that lands here.
  //
  // `GET /healthz` touches no database. Taking a pooled connection for it meant
  // that when Postgres was unreachable the health check answered 500: an
  // orchestrator reading it as liveness would then kill a process that was fine,
  // during exactly the incident when killing it makes recovery slower. The
  // liveness of this process and the reachability of the database are two facts
  // and this route reports the first.
  //
  // The connection is not withdrawn, only deferred: a future unaudited public
  // read (a public menu, say) still gets one, on its first `query`, without a
  // transaction it does not need. What it cannot do is make an unrelated route
  // fail by being unreachable.
  // ###########################################################################
  app.route({
    method: definition.method,
    url: definition.url,
    handler: async (request, reply) => {
      const lazy = lazyClient(deps.pool);
      try {
        const outcome = asOutcome(
          await definition.handler(request, reply, { tenantId: '', client: lazy.client, actor: null }),
          definition.method,
          definition.url,
        );
        if (outcome.attempt) {
          throw new UnexpectedAttemptResolutionError(definition.method, definition.url);
        }
        return outcome.body;
      } finally {
        lazy.release();
      }
    },
  });
}

/**
 * A `ClientBase` that holds no connection until something queries through it,
 * and at most one after that. Deliberately not a Proxy over the whole pg
 * surface: `query` is what a handler on this surface may do, and a handler that
 * reached for `on('notification')` or `release()` should fail to compile rather
 * than acquire a connection nothing releases.
 */
function lazyClient(pool: pg.Pool): { client: pg.ClientBase; release: () => void } {
  let held: pg.PoolClient | null = null;
  const client = {
    query: async (...args: readonly unknown[]): Promise<unknown> => {
      held ??= await pool.connect();
      return (held.query as unknown as (...a: readonly unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as pg.ClientBase;
  return {
    client,
    release: () => {
      held?.release();
      held = null;
    },
  };
}
