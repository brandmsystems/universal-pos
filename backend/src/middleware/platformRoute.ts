import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  AttemptPostureRefusedError,
  MissingAuditPostureError,
  PermissionPlaneMismatchError,
  isAttemptPosture,
  isAuditDescriptor,
  type RouteDefinition,
} from './routeRegistry.js';
import { platformRoleHolds } from './security/platformAuthz.js';
import { preparePayload } from './auditPayload.js';
import type { PlatformPermissionKey } from '../modules/authz/platformPermissions.js';

/**
 * The control-plane registrar.
 *
 * ###########################################################################
 * A SEPARATE REGISTRAR, NOT A FLAG ON THE TENANT ONE.
 *
 * The tenant registrar's first act is `withTenantTransaction`, which sets
 * `app.tenant_id` and refuses without a tenant id in the token. A control-plane
 * request has no tenant context by definition -- that is the boundary, not an
 * inconvenience -- so routing platform routes through it would mean either
 * inventing a tenant id or adding a "skip the GUC" branch to the one place that
 * guarantees RLS is armed.
 *
 * The audit destination differs for the same reason: a platform action is
 * recorded in `platform.platform_audit_log`, and a tenant action in the tenant's
 * own log. Two planes, two ledgers, no shared row.
 * ###########################################################################
 */

export interface PlatformRouteDeps {
  readonly pool: pg.Pool;
}


function requestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : String(request.id);
}

export function registerPlatformRoute(
  app: FastifyInstance,
  deps: PlatformRouteDeps,
  definition: RouteDefinition,
): void {
  if (definition.audit === undefined || definition.audit === null) {
    throw new MissingAuditPostureError(definition.method, definition.url);
  }
  if (isAttemptPosture(definition.audit)) {
    throw new AttemptPostureRefusedError(definition.method, definition.url, 'platform');
  }
  if (isAuditDescriptor(definition.audit)) {
    const { action, target } = definition.audit;
    if (!action || !target) throw new MissingAuditPostureError(definition.method, definition.url);
  }
  if (definition.permission && definition.permission.plane !== 'platform') {
    throw new PermissionPlaneMismatchError(
      definition.method, definition.url, 'platform',
      definition.permission.plane, definition.permission.key);
  }
  // Narrowed once, here, and closed over. Re-reading `definition.permission`
  // inside the handler would widen it back to the union and lose the guarantee
  // the check above just established.
  const permission: PlatformPermissionKey | null =
    definition.permission?.plane === 'platform' ? definition.permission.key : null;

  app.route({
    method: definition.method,
    url: definition.url,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const claims = request.claims ?? {};
      const platformUserId = typeof claims['sub'] === 'string' ? claims['sub'] : null;
      if (!platformUserId) return reply.code(401).send({ error: 'missing_subject' });

      // ------------------------------------------------------------------
      // Holding *a* platform role is not authorisation. The plane guard proved
      // the token carries `platform_role`; this is where the key is checked,
      // and it is what stops `read_only` reaching POST /impersonation.
      // ------------------------------------------------------------------
      if (permission !== null) {
        if (!platformRoleHolds(claims['platform_role'], permission)) {
          return reply.code(403).send({ error: 'forbidden', retryable: false });
        }
      }

      // The ESCALATED key, when the request asks for more than the base one
      // covers. Declared on the route, checked here, before the handler --
      // because a check a handler performs is a check a handler can forget, and
      // this was the last authorisation decision in the product not made by a
      // registrar.
      if (definition.escalation !== undefined) {
        const asked = (request.body ?? {}) as Record<string, unknown>;
        if (asked[definition.escalation.whenBodyPresent] !== undefined
            && !platformRoleHolds(
              claims['platform_role'], definition.escalation.key as PlatformPermissionKey)) {
          return reply.code(403).send({
            error: definition.escalation.refusal, retryable: false,
          });
        }
      }

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');

        // The actor is snapshotted BEFORE the handler runs. A route that mutates
        // platform_user would otherwise read its own write back under READ
        // COMMITTED and stamp the NEW name as the actor of the change.
        //
        // Only an ACTIVE account may act. Refresh already re-checks this, but an
        // access token outlives a deactivation by its whole lifetime -- so a
        // Salesperson switched off mid-afternoon could keep provisioning
        // restaurants until it expired. Checked here, per request, it ends at
        // the next click.
        const actor = await client.query<{ email: string; role_key: string }>(
          `SELECT u.email, r.key AS role_key
             FROM platform.platform_user u
             JOIN platform.platform_role r ON r.id = u.platform_role_id
            WHERE u.id = $1 AND u.status = 'active'`,
          [platformUserId],
        );
        const actorRow = actor.rows[0];
        if (!actorRow) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'forbidden' });
        }

        const result = await definition.handler(
          request, reply,
          // The control plane has no tenant context. Passing a real one would be
          // a lie the handler could act on, so the tenant id is the empty
          // sentinel and any repository call through it fails loudly.
          { tenantId: '', client, actor: null },
        );

        if (isAuditDescriptor(definition.audit)) {
          const descriptor = definition.audit;
          // Same 64KB cap as the tenant log: a pathological result degrades to
          // a marked row, never a bloated write.
          const after = descriptor.afterIsResult
            ? preparePayload(null, result).after : null;
          await client.query(
            `INSERT INTO platform.platform_audit_log
               (id, actor_platform_user_id, actor_email, actor_role_key, action,
                target_type, target_id, target_tenant_id, before, after,
                ip, user_agent, request_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
            [
              randomUUID(), platformUserId, actorRow.email,
              // The role is snapshotted from the DATABASE, not the token: a
              // long-lived token carries the role the user had when it was
              // issued, and the audit row must say what they actually held.
              actorRow.role_key,
              descriptor.action, descriptor.target,
              descriptor.targetId ? descriptor.targetId(request) : null,
              targetTenantId(request),
              null, after === null ? null : JSON.stringify(after),
              request.ip, request.headers['user-agent'] ?? null, requestId(request),
            ],
          );
        }

        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

/**
 * Which tenant a control-plane action was ABOUT.
 *
 * Read from the route params, not from a body: every control-plane route that
 * concerns one tenant names it in the path, and a body-supplied id would make
 * the audit trail steerable by the request it is auditing.
 */
function targetTenantId(request: FastifyRequest): string | null {
  const params = request.params as Record<string, unknown> | undefined;
  const value = params?.['tenantId'];
  return typeof value === 'string' ? value : null;
}
