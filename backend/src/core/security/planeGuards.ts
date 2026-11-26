import type { FastifyReply, FastifyRequest } from 'fastify';
import { TokenError, verifyToken, type Claims } from '../../modules/auth/jwt.js';

/**
 * The plane boundary, enforced at the edge.
 *
 * These run as `onRequest` hooks: before body parsing, before the handler, and
 * before anything acquires a database connection. A token from the wrong plane
 * must never reach code that could act on it.
 *
 * The check is on the *presence* of the foreign claim, not on its value. A
 * tenant-plane token that carries `platform_role: "read_only"` is not a weak
 * platform token, it is a forged one -- and a platform token carrying a
 * `tenant_id` is the whole boundary being crossed.
 */

export type Plane = 'platform' | 'tenant';

declare module 'fastify' {
  interface FastifyRequest {
    claims?: Claims;
  }
}

export interface PlaneRejection {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function reject(status: number, code: string, message: string): PlaneRejection {
  return { status, code, message };
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/**
 * Pure, so the boundary rule can be tested without an HTTP server and reused by
 * anything else that has to make the same decision.
 */
export function checkPlane(plane: Plane, claims: Claims): PlaneRejection | null {
  // The impersonation shape is already inert here -- it carries act_tenant_id
  // rather than tenant_id, and no platform_role -- so both branches below would
  // reject it for a missing claim. This says so on purpose instead, because
  // "rejected because a field happened to be absent" is the kind of accident that
  // survives a refactor and "rejected because it is the wrong token type" is not.
  if (claims['typ'] === 'impersonation') {
    return reject(
      403,
      'impersonation_token_on_direct_plane',
      'an impersonation token is only valid on /api/t/impersonated/*',
    );
  }

  // ###########################################################################
  // A REFRESH TOKEN IS NOT A BEARER CREDENTIAL.
  //
  // Both are HS256 under the same key and a refresh token carries `tenant_id`,
  // so without this branch it would pass every check below and be accepted as a
  // twelve-hour access token. That is a long-lived credential handed out on
  // purpose and honoured everywhere by accident -- and the 15-minute access
  // lifetime, which is the only thing that makes device revocation bite, would
  // be silently irrelevant.
  //
  // Stated as its own rejection for the same reason as the impersonation branch
  // above: "rejected because a field happened to be absent" survives a refactor,
  // "rejected because it is the wrong token type" does not.
  // ###########################################################################
  if (claims['typ'] === 'refresh') {
    return reject(
      403,
      'refresh_token_on_api_plane',
      'a refresh token is only valid at POST /api/auth/refresh',
    );
  }

  const hasTenant = claims['tenant_id'] !== undefined && claims['tenant_id'] !== null;
  const hasPlatformRole =
    claims['platform_role'] !== undefined && claims['platform_role'] !== null;

  if (plane === 'platform') {
    if (hasTenant) {
      return reject(403, 'tenant_token_on_platform_plane', 'a token carrying tenant_id is not valid on /api/platform/*');
    }
    if (!hasPlatformRole) {
      return reject(401, 'missing_platform_role', 'platform plane requires a platform_role claim');
    }
    return null;
  }

  if (hasPlatformRole) {
    return reject(403, 'platform_token_on_tenant_plane', 'a token carrying platform_role is not valid on /api/t/*');
  }
  if (!hasTenant) {
    return reject(401, 'missing_tenant_id', 'tenant plane requires a tenant_id claim');
  }
  return null;
}

export function planeGuard(plane: Plane, key: string) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearer(request);
    if (!token) {
      await reply.code(401).send({ error: 'missing_bearer_token' });
      return;
    }

    let claims: Claims;
    try {
      claims = verifyToken(token, key);
    } catch (error) {
      const code = error instanceof TokenError ? error.code : 'malformed';
      await reply.code(401).send({ error: code });
      return;
    }

    const rejection = checkPlane(plane, claims);
    if (rejection) {
      await reply.code(rejection.status).send({ error: rejection.code, message: rejection.message });
      return;
    }

    request.claims = claims;
  };
}
