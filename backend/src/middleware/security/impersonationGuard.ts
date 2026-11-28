import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { TokenError, verifyToken, type Claims } from '../../modules/authentication/jwt.js';
import { isWithinImpersonationScope } from '../../modules/authz/impersonationScope.js';
import type { PermissionKey } from '../../modules/authz/permissions.js';
import {
  IMPERSONATION_TOKEN_TYPE,
  impersonationPosture,
  loadLiveSession,
  type LiveSession,
} from '../../modules/platform/impersonation.js';

/**
 * The third guard, on its own prefix.
 *
 * The impersonation token shape is inert against the other two by construction --
 * it carries `act_tenant_id` rather than `tenant_id` and no `platform_role`, so
 * both existing guards already reject it. They also reject `typ` explicitly, so
 * the failure is deliberate rather than incidental.
 */

export interface ImpersonationContext {
  readonly session: LiveSession;
  /** session.write_enabled AND the tenant's ladder rung permits writing. */
  readonly effectiveWrite: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    impersonation?: ImpersonationContext;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export function impersonationGuard(pool: pg.Pool, key: string) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = bearer(request);
    if (!raw) {
      await reply.code(401).send({ error: 'missing_bearer_token' });
      return;
    }

    let claims: Claims;
    try {
      claims = verifyToken(raw, key);
    } catch (error) {
      await reply.code(401).send({ error: error instanceof TokenError ? error.code : 'malformed' });
      return;
    }

    // The discriminator is checked first. A tenant or platform token on this
    // prefix is refused before anything reads a tenant id from it.
    if (claims['typ'] !== IMPERSONATION_TOKEN_TYPE) {
      await reply.code(403).send({ error: 'not_an_impersonation_token' });
      return;
    }

    const sessionId = claims['sid'];
    const actTenantId = claims['act_tenant_id'];
    if (typeof sessionId !== 'string' || typeof actTenantId !== 'string') {
      await reply.code(401).send({ error: 'malformed_impersonation_token' });
      return;
    }

    // Never cached. A signed token cannot be revoked; the row can, and immediate
    // revocation is the whole reason this read happens per request.
    const client = await pool.connect();
    let session: LiveSession | null;
    try {
      session = await loadLiveSession(client, sessionId);
    } finally {
      client.release();
    }

    if (!session) {
      // Revoked, expired, or never existed -- deliberately indistinguishable.
      await reply.code(403).send({ error: 'impersonation_session_not_live' });
      return;
    }

    // The token's tenant and the session's tenant originate separately. A reissue
    // bug that let them diverge would be a cross-tenant impersonation, so it gets
    // its own code rather than being folded into "not live".
    if (session.tenantId !== actTenantId) {
      request.log.error(
        { sessionId, actTenantId, sessionTenantId: session.tenantId },
        'impersonation token tenant does not match its session',
      );
      await reply.code(403).send({ error: 'impersonation_tenant_mismatch' });
      return;
    }

    const posture = impersonationPosture(session.tenantStatus);
    if (!posture.allowed) {
      await reply.code(403).send({ error: 'tenant_not_impersonable' });
      return;
    }

    const effectiveWrite = session.writeEnabled && !posture.forceReadOnly;

    // Bound the session to configuration and operational keys. Financial,
    // escalation and privacy keys are refused regardless of platform role and
    // regardless of the write flag -- an impersonating support user must not end
    // up with more authority inside a tenant than its owner has.
    //
    // Distinct from the read-only rejection on purpose: "you may not write" and
    // "nobody impersonating may ever do this" are different answers.
    const routePermission = (request.routeOptions?.config as { permission?: PermissionKey } | undefined)
      ?.permission;
    if (routePermission !== undefined && !isWithinImpersonationScope(routePermission)) {
      await reply.code(403).send({
        error: 'impersonation_out_of_scope',
        message: `${routePermission} is never available during impersonation`,
      });
      return;
    }

    // Read-only is enforced HERE: before the handler, before a pooled connection
    // is taken for the unit of work. Not a check inside handlers, which would be
    // one forgotten call away from a silent write.
    if (!effectiveWrite && !SAFE_METHODS.has(request.method)) {
      await reply.code(403).send({
        error: 'impersonation_read_only',
        message: session.writeEnabled
          ? 'this tenant is past the retention threshold: impersonation is read-only regardless of the write flag'
          : 'this impersonation session was not granted write access',
      });
      return;
    }

    // Feeds the banner that must be visible for the whole session.
    void reply.header('x-impersonation-session', session.sessionId);
    void reply.header('x-impersonation-actor', session.platformUserEmail);
    void reply.header('x-impersonation-expires-at', session.expiresAt.toISOString());
    void reply.header('x-impersonation-write', String(effectiveWrite));

    request.claims = claims;
    request.impersonation = { session, effectiveWrite };
  };
}
