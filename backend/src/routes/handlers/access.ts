import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import { listAccess } from '../../modules/users/staffAccess.js';
import { readMe } from '../../modules/users/me.js';
import { hasFeature } from '../../modules/platform/entitlements.js';

type Handler = RouteDefinition['handler'];

function actor(request: FastifyRequest): string {
  const sub = (request.claims ?? {})['sub'];
  if (typeof sub !== 'string') throw new Error('no subject on a verified token');
  return sub;
}

function sessionBranch(request: FastifyRequest): string | null {
  const branch = (request.claims ?? {})['branch_id'];
  return typeof branch === 'string' && branch !== '' ? branch : null;
}

export function accessHandlers(): Record<string, Handler> {
  return {
    accessList: async (request, _reply, context) => listAccess(context, sessionBranch(request)),
    // Every input is the verified token's: there is no way to name someone else.
    whoAmI: async (request, _reply, context) => {
      const device = (request.claims ?? {})['device_id'];
      const me = await readMe(context, {
        userId: context.actor?.userId ?? actor(request),
        branchId: sessionBranch(request),
        deviceId: typeof device === 'string' && device !== '' ? device : null,
        viaImpersonation: context.actor?.viaImpersonation ?? false,
      });
      // Where this restaurant seats a dine-in party: the PLAN's answer (Basic has
      // no tables, so dine-in is numbered at the counter), beside the screens,
      // which are the permissions' answer.
      return { ...me, seatsAtTables: hasFeature(request.entitlement!, 'tables') };
    },
  };
}
