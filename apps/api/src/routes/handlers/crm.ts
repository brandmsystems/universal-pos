import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../../core/middleware/routeRegistry.js';
import { revealStaffContact } from '../../modules/privacy/piiAccess.js';

/**
 * Staff contact reveal: one act against `app_user`, not a resource verb --
 * the users resource deliberately does not return the field being revealed,
 * and `tests/http/adminSurface.test.ts` requires every name in the admin map
 * to be `<resource>.<verb>`. So it lives in its own map, and `mergeHandlers`
 * refuses a name collision with any other map at boot.
 */

type Handler = RouteDefinition['handler'];

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw new Error(`missing path parameter ${name}`);
  return value;
}

function branchOnToken(request: FastifyRequest): string | null {
  const value = (request.claims ?? {})['branch_id'];
  return typeof value === 'string' ? value : null;
}

export function crmHandlers(): Record<string, Handler> {
  return {
  revealStaffPii: async (request, _reply, context) => {
    const claims = request.claims ?? {};
    const reason = (request.query as Record<string, unknown> | undefined)?.['reason'];
    return revealStaffContact({
      subjectId: param(request, 'id'),
      actorUserId: context.actor?.userId ?? String(claims['sub']),
      branchId: branchOnToken(request),
      reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    });
  },
  };
}
