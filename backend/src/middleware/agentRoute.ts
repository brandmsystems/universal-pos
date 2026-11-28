import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { MissingAuditPostureError, type RouteDefinition } from './routeRegistry.js';
import {
  authenticatePrintAgent, PrintAgentTokenInvalidError, type PrintAgentIdentity,
} from '../modules/business-types/restaurant/kitchen/printAgent.js';

/**
 * The print agent's plane: `/api/agent/*`.
 *
 * ###########################################################################
 * A FOURTH PLANE, BECAUSE AN AGENT IS NONE OF THE OTHER THREE.
 *
 * It is not a person, so it holds no JWT, no membership and no permission: a
 * tenant token for it would pass every `/api/t/*` guard, and the reach of a
 * leaked agent secret would be the whole tenant plane. It is not pre-auth
 * either -- every call carries a secret.
 *
 * So its bearer is the agent token itself, resolved against
 * `app.print_agent` on EVERY request, inside the transaction the handler
 * runs in. Revoking an agent therefore stops it at its next poll; there is no
 * token lifetime to wait out, and the same reasoning as the impersonation
 * session read applies: never cached.
 *
 * Declared shape, refused otherwise at boot:
 *   - the path is under /api/agent/;
 *   - no permission, lease or plan (an agent has no authority to check);
 *   - audit 'none'. What an agent does is recorded on the rows it moves --
 *     `print_job.attempts`, `last_error`, `accepted_at`, `claimed_by` -- exactly
 *     as the server worker's is. It decides nothing a person is accountable for;
 *     issuing and revoking it are audited, on the tenant plane.
 * ###########################################################################
 */

export const AGENT_PATH_PREFIX = '/api/agent/';

declare module 'fastify' {
  interface FastifyRequest {
    printAgent?: PrintAgentIdentity;
  }
}

export class AgentRouteRefusedError extends Error {
  readonly code = 'agent_route_refused';
  constructor(method: string, url: string, why: string) {
    super(`${method} ${url} declares plane 'agent' but ${why}.`);
    this.name = 'AgentRouteRefusedError';
  }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export function registerAgentRoute(
  app: FastifyInstance,
  deps: { pool: pg.Pool },
  definition: RouteDefinition,
): void {
  if (definition.audit === undefined || definition.audit === null) {
    throw new MissingAuditPostureError(definition.method, definition.url);
  }
  if (definition.plane !== 'agent') throw new AgentRouteRefusedError(definition.method, definition.url, `it is a ${definition.plane} route`);
  if (!definition.url.startsWith(AGENT_PATH_PREFIX)) {
    throw new AgentRouteRefusedError(definition.method, definition.url, `its path is not under ${AGENT_PATH_PREFIX}`);
  }
  if (definition.audit !== 'none') {
    throw new AgentRouteRefusedError(definition.method, definition.url,
      'declares an audit posture: an agent holds no membership and names no system job');
  }
  if (definition.permission) throw new AgentRouteRefusedError(definition.method, definition.url, 'declares a permission an agent cannot hold');
  if (definition.lease !== undefined) throw new AgentRouteRefusedError(definition.method, definition.url, 'declares a lease');
  if (definition.plan !== undefined) throw new AgentRouteRefusedError(definition.method, definition.url, 'declares a plan gate');

  app.route({
    method: definition.method,
    url: definition.url,
    handler: async (request, reply) => {
      const token = bearer(request);
      if (token === null) throw new PrintAgentTokenInvalidError();
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const agent = await authenticatePrintAgent(client, token);
          request.printAgent = agent;
          const body = await definition.handler(request, reply, { tenantId: agent.tenantId, client, actor: null });
          await client.query('COMMIT');
          return body;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      } finally {
        client.release();
      }
    },
  });
}
