import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AttemptMethod } from '../../modules/auth/authAttempt.js';
import type { PermissionKey } from '../../modules/authz/permissions.js';
import type { PlatformPermissionKey } from '../../modules/authz/platformPermissions.js';
import { authorisingMembershipFor } from '../../modules/authz/grant.js';
import { resolveActor } from '../../modules/authz/authorityStore.js';
import type { BaseRepository } from '../database/baseRepository.js';
import { withTenantTransaction } from '../database/unitOfWork.js';
import type { TenantContext } from '../database/tenantContext.js';
import { TenantAuditLogRepository } from '../database/repositories.js';
import { preparePayload } from './auditPayload.js';
import {
  requireIdempotencyKey, requireLeaseToken, requiresIdempotency,
} from './posHeaders.js';
import { claimOrReplay, recordClaimResult } from '../../modules/orders/idempotency.js';
import {
  resolveLeaseSubject, requireLeaseByToken, type HeldLease,
} from '../../modules/offline/leaseGuard.js';
import {
  PLAN_NAMES, entitlementsFromTerms, lowestPlanIncluding, planIncludes, type PlanGate, type PlanFeature, type PlanLimit,
} from '@universalpos/shared';
import {
  PlanExcludesError, assertWithinLimit, resolveEntitlement,
  type EntitlementCache, type EntitlementDocument,
} from '../../modules/platform/entitlements.js';
import { planUsage } from '../../modules/restaurants/planUsage.js';

/**
 * One registrar, one audit middleware, applied globally by construction: the only
 * way to add a route is through here, and this is where the transaction, the
 * permission check, the attribution and the audit write live.
 *
 * The gate is inverted rather than method-scoped -- every route declares its
 * audit posture explicitly, reads included. A missing field fails at
 * registration regardless of HTTP method. `'none'` is greppable and shows up in
 * a diff; silence does not.
 */

export interface AuditDescriptor {
  readonly action: string;
  readonly target: string;
  readonly targetId?: (request: FastifyRequest) => string | null;
  /**
   * CONTROL PLANE ONLY: the handler's return value is written as the audit
   * row's after-image. `registerPlatformRoute` had no after-image at all, so a
   * deactivation's REASON -- the one thing an investigation reads -- was in no
   * log. Opt-in per route rather than blanket, because some platform results
   * carry a secret (the owner invite token) that must never land in an audit
   * row. The tenant registrar refuses the flag at registration: it has its own
   * after-image mechanism (`lock`), and a flag it silently ignored would be a
   * declaration read by nothing.
   */
  readonly afterIsResult?: true;
  /**
   * Where a route mutates an existing row, the before-image is taken through the
   * write path with FOR UPDATE. Omit for creates, which have nothing to lock.
   */
  readonly lock?: {
    readonly repository: BaseRepository<Record<string, unknown>>;
    readonly id: (request: FastifyRequest) => string;
  };
}

/**
 * ###########################################################################
 * THE THIRD POSTURE: A CREDENTIAL EVENT, RECORDED SOMEWHERE ELSE.
 *
 * `platform.auth_attempt` is where login, PIN, refresh and enrolment are
 * recorded, per the decision in CLAUDE.md. The obvious way to express that here
 * is `audit: 'none'` on the auth routes -- and it is wrong, because it is
 * SILENCE. The inverted gate exists so that a posture shows up in a diff, and
 * `'none'` on the most security-relevant routes in the product would read as an
 * omission somebody forgot to fix.
 *
 * So it is a declaration of its own. `audit: { attempt: 'pin' }` says: this is a
 * credential event, it is recorded, and it is recorded in the table that can
 * hold a subject who does not exist. The public registrar REQUIRES one on
 * `/api/auth/*` and every other registrar refuses one -- a credential event on a
 * tenant route would be an authenticated request claiming to be a login.
 * ###########################################################################
 */
export interface AttemptDescriptor {
  readonly attempt: AttemptMethod;
}

export type AuditPosture = AuditDescriptor | AttemptDescriptor | 'none';

/** True for the tenant/platform audit-log posture, and only that one. */
export function isAuditDescriptor(posture: AuditPosture): posture is AuditDescriptor {
  return posture !== 'none' && 'action' in posture;
}

/** True for the credential-event posture, and only that one. */
export function isAttemptPosture(posture: AuditPosture): posture is AttemptDescriptor {
  return posture !== 'none' && 'attempt' in posture;
}

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const MUTATING_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * ###########################################################################
 * `public` IS A DECLARATION, NOT AN ABSENCE.
 *
 * Login cannot require a token, so the pre-auth surface has no plane guard. That
 * is the one place a route could become unauthenticated by omission -- and login
 * is the route you most want audited, because failed attempts, lockouts and
 * credential use are the record.
 *
 * So it is declared, inside the registrar, and the registrar refuses it anywhere
 * the list below does not name. Two entries today; the risk is the third one
 * somebody adds quietly.
 * ###########################################################################
 */
export type RoutePlane = 'tenant' | 'platform' | 'public' | 'agent';

/**
 * `/api/public/` holds unauthenticated READS that a signed-out page needs --
 * today only a restaurant's name for its own `/{slug}` page. Writes there are
 * refused by the registrar (a public mutation lives under /api/auth/ or nowhere).
 */
export const PUBLIC_PATH_PREFIXES: readonly string[] = ['/api/auth/', '/healthz', '/api/public/'];

/**
 * The lease is required on every POS mutation EXCEPT these.
 *
 * Both exemptions exist because the actor demonstrably does not hold a lease:
 *
 *  - force-release exists precisely because a device DIED holding one, so the
 *    manager has no token by definition. Requiring it would make the recovery
 *    path depend on the thing being recovered from.
 *  - manual settlement is a cashier keying in money taken during an outage,
 *    after the fact and usually on a different device.
 *
 * Declared here rather than discovered at 8pm.
 */
/**
 * ###########################################################################
 * A LEASED ROUTE NAMES WHAT IT IS LEASED ON.
 *
 * `'required'` used to be the whole declaration, and it bought a header-presence
 * check and nothing else: the registrar had no way to know WHICH session a write
 * to `/pos/order/:id/line` belonged to, so it could not resolve the lease, so it
 * checked that the header was non-empty and let the request through. The guard
 * that does the real work had one caller, in a test.
 *
 * The subject is the missing half. `/pos/session/:id/*` is leased on the id
 * itself; `/pos/order/:id/*` on the order's session; `/pos/bill/:id/*` on the
 * bill's. Making it a required field rather than a boolean means the compiler
 * refuses a leased route that does not say how to reach its session -- there is
 * no default to fall back to and nothing to forget.
 * ###########################################################################
 */
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The lease the registrar resolved for this request, present on exactly the
     * routes that declared a subject. A handler reads the DEVICE from here
     * rather than from its own body: the body is a client claim, this is the
     * lease row. `session.open` and the two exemptions carry a device id in the
     * body because there is no lease yet to read it from.
     */
    heldLease?: HeldLease;
    /**
     * The restaurant's entitlement document, present on exactly the routes that
     * declared a `plan`. A handler that needs the plan reads it from here rather
     * than resolving it again.
     */
    entitlement?: EntitlementDocument;
  }
}

/**
 * What a route needs from the restaurant's plan: a feature, a report tier, room
 * under a limit -- or several of those, ALL of which must hold (issuing a staff
 * tablet code needs the `staff_tablets` feature AND room under `devices`) -- or
 * `'document'`, only the document itself, for a route that reads the plan.
 */
export type RoutePlan = PlanGate | readonly PlanGate[] | 'document';

/** The gates a route declares, as a list: one gate, several, or none for `'document'`. */
export function planGates(plan: RoutePlan): readonly PlanGate[] {
  if (plan === 'document') return [];
  return Array.isArray(plan) ? plan : [plan as PlanGate];
}

/** `reports: 'basic'` is every plan: declared so the route is visibly gated, checked by nothing. */
function needsDocument(plan: RoutePlan): boolean {
  return plan === 'document'
    || planGates(plan).some((gate) => !('reports' in gate && gate.reports === 'basic'));
}

/** Every feature named for a person, so a new feature without a label fails to compile. */
const FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = {
  kot: 'KOT (kitchen order tracking)',
  kds: 'The kitchen screen (KDS)',
  staff_tablets: 'Staff tablets with setup codes',
  tables: 'Floors and tables',
};

/** Same reason: a ternary here once read "branch, or else terminal", so `users` would have been a terminal. */
const LIMIT_LABELS: Readonly<Record<PlanLimit, string>> = {
  branches: 'Another branch',
  devices: 'Another terminal',
  users: 'Another restaurant user',
};

function describeGate(gate: PlanGate): string {
  if ('feature' in gate) return FEATURE_LABELS[gate.feature];
  if ('reports' in gate) return `The ${gate.reports} reports`;
  return LIMIT_LABELS[gate.limit];
}

export class PlanGateWithoutCacheError extends Error {
  readonly code = 'plan_gate_without_cache';
  constructor(method: string, url: string) {
    super(
      `${method} ${url} declares a plan gate but the registrar was given no entitlement ` +
        'cache. A gate with nothing to check against would either refuse every request or ' +
        'none, so the process refuses to boot instead.',
    );
    this.name = 'PlanGateWithoutCacheError';
  }
}

export type LeaseSubject = 'session' | 'order' | 'bill';

/**
 * Where the subject's id is.
 *
 * Route parameters only, and that is deliberate. An earlier version had an
 * `in: 'body'` arm for `POST /pos/bill`, which named its session in the body --
 * one route, one branch, and a branch inside a security guard that only one
 * caller exercises. `POST /pos/session/:id/bill` removed the need for it, and
 * the arm went with it: an unreached path in the thing that decides whether a
 * write is allowed is not worth keeping for symmetry.
 *
 * The `name` is still declared rather than assumed to be `id`, because the
 * declaration is what the route-inventory gate checks against the URL.
 */
export type LeaseSubjectSource = { readonly in: 'param'; readonly name: string };

export type LeaseRequirement =
  | 'exempt'
  | { readonly subject: LeaseSubject; readonly at: LeaseSubjectSource };

/** The three shapes the route table uses, named once. */
export const leasedOn = {
  session: { subject: 'session', at: { in: 'param', name: 'id' } },
  order: { subject: 'order', at: { in: 'param', name: 'id' } },
  bill: { subject: 'bill', at: { in: 'param', name: 'id' } },
} as const satisfies Record<string, Exclude<LeaseRequirement, 'exempt'>>;

/**
 * ###########################################################################
 * A PERMISSION CARRIES ITS PLANE. THE TWO CATALOGUES DO NOT MIX.
 *
 * A bare string field let `POST /api/platform/impersonation` register with no
 * key at all, so every `platform_role` reached it -- `read_only` included. That
 * is a live escalation: it undoes the Phase 1 platform catalogue and the subset
 * rule at the route layer, where nothing structural was looking.
 *
 * A discriminated union makes the mismatch a COMPILE error rather than a
 * security-review finding: a tenant key on a platform route no longer type-checks,
 * and the registrar refuses it at boot as a second gate.
 * ###########################################################################
 */
export type RoutePermission =
  | { readonly plane: 'tenant'; readonly key: PermissionKey }
  | { readonly plane: 'platform'; readonly key: PlatformPermissionKey };

export class PermissionPlaneMismatchError extends Error {
  readonly code = 'permission_plane_mismatch';
  constructor(method: string, url: string, routePlane: string, keyPlane: string, key: string) {
    super(
      `${method} ${url} is a ${routePlane}-plane route but is guarded by the ${keyPlane} ` +
        `key '${key}'. The two catalogues are separate: a tenant key on a platform route ` +
        'guards nothing, and a platform key on a tenant route can never be held.',
    );
    this.name = 'PermissionPlaneMismatchError';
  }
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly url: string;
  /** Which guard fronts it. `public` is refused outside PUBLIC_PATH_PREFIXES. */
  readonly plane: RoutePlane;
  /** POS routes only. Absent means the route does not touch a leased session. */
  readonly lease?: LeaseRequirement;
  /**
   * ###########################################################################
   * THE DATABASE ROLE, DECLARED, AND ONLY WHERE THE OWNER IS UNAVOIDABLE.
   *
   * Default: the app role, which is NOBYPASSRLS and owns nothing.
   *
   * `POST /tenants` cannot run on it. `registerPlatformRoute` opens its
   * transaction with no tenant GUC -- correctly, the control plane has no tenant
   * -- and `provisionTenant` then writes app.branch, app.app_user, app.role and
   * app.membership, which every `app` table refuses with SQLSTATE 28000. So
   * provisioning needs the owner.
   *
   * Giving the WHOLE control plane the owner was the first fix and it was too
   * much. The system-health check said so immediately, on its own connection:
   *
   *   failed  rls_applies_to_request_role
   *           katkitchen_owner owns 99 table(s) in schema app,
   *           so no policy applies to it
   *
   * A table owner is outside RLS whatever its NOBYPASSRLS setting, because no
   * policy is evaluated for the owner in the first place. Eleven of the twelve
   * control-plane routes read `platform.*`, which has no RLS to be exempt from,
   * and handing them a connection that is also outside `app`'s RLS buys nothing
   * and widens the blast radius of any future handler that touches an app table.
   *
   * So it is per-route and it is declared. `'owner'` appears once, and the gate
   * in tests/db/ownerPosture.test.ts asserts it appears only where the function
   * it calls is already listed in OWNER_POSTURE with a reason.
   * ###########################################################################
   */
  readonly role?: 'owner';
  /** Mandatory. There is no default and no inference from method. */
  readonly audit: AuditPosture;
  readonly permission?: RoutePermission;
  /**
   * ###########################################################################
   * THE PLAN IS CHECKED HERE, NOT IN THE HANDLER.
   *
   * Same reasoning as the permission key and the lease: a check a handler
   * performs is a check a handler can forget. Checked after the permission --
   * a waiter who may not see stock is told 403 whatever the plan -- and before
   * the handler, inside the request's transaction, so a limit count and the
   * insert it guards commit together. `tests/http/planGates.test.ts` asserts
   * every route in a plan-gated permission namespace declares one.
   * ###########################################################################
   */
  readonly plan?: RoutePlan;
  /**
   * A SECOND key the same route needs when the request asks for more.
   *
   * ###########################################################################
   * A CHECK A HANDLER PERFORMS IS A CHECK A HANDLER CAN FORGET.
   *
   * `POST /impersonation` needs `platform.impersonation.read` to start a
   * read-only session and `platform.impersonation.write` to start one that can
   * change tenant data. That is two keys on one route, and because
   * `RouteDefinition` carried exactly one, the second lived inside the handler
   * as an `if` -- the only authorisation decision in the product that the
   * registrar did not make, and therefore the only one that could be deleted in
   * a refactor without a single gate noticing.
   *
   * Declared here instead: when the named body field is PRESENT, the escalated
   * key is required, and the registrar refuses before the handler runs. The
   * route inventory can see it, which is the whole point.
   * ###########################################################################
   */
  readonly escalation?: {
    readonly key: string;
    /** The body field whose presence means "this request wants more". */
    readonly whenBodyPresent: string;
    /**
     * The error code to refuse with, so moving the check out of the handler
     * does not cost the sentence. A bare `forbidden` would be true and useless:
     * "you may start a read-only session but not a write one" is what the
     * support agent needs to read.
     */
    readonly refusal: string;
  };
  readonly handler: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: TenantContext,
  ) => Promise<unknown>;
}

export interface RouteDeps {
  readonly pool: pg.Pool;
  /** Where `plan` gates read the restaurant's entitlement document. Required if any route declares one. */
  readonly entitlements?: EntitlementCache;
  /** Called when a request passes the permission check but cannot be attributed. */
  readonly onUnattributable?: (detail: UnattributableDetail) => void;
  /**
   * Collaborator seam, not a mock of the thing under test. The unattributable
   * branch is an internal invariant violation that cannot be produced through
   * the HTTP surface -- and a branch that refuses writes must not be the one
   * branch with no test.
   */
  readonly resolveActor?: typeof resolveActor;
}

export interface UnattributableDetail {
  readonly tenantId: string;
  readonly userId: string;
  readonly branchId: string | null;
  readonly permission: PermissionKey;
  readonly action: string;
  readonly heldPermissions: readonly string[];
  readonly authorisedBy: Readonly<Record<string, string>>;
}

export class PublicRouteRefusedError extends Error {
  readonly code = 'public_route_refused';
  constructor(method: string, url: string, why: string) {
    super(
      `${method} ${url} declares plane 'public' but ${why}. The pre-auth surface is ` +
        `limited to ${PUBLIC_PATH_PREFIXES.join(', ')}, and nothing there may mutate ` +
        'outside /api/auth/.',
    );
    this.name = 'PublicRouteRefusedError';
  }
}

export class AttemptPostureRefusedError extends Error {
  readonly code = 'attempt_posture_refused';
  constructor(method: string, url: string, plane: string) {
    super(
      `${method} ${url} declares a credential-event posture on the ${plane} plane. ` +
        'An attempt posture belongs to the pre-auth surface only: a request that ' +
        'already carries a verified token is not a login, and recording it as one ' +
        'would put authenticated activity in platform.auth_attempt where nothing ' +
        'reads it as such.',
    );
    this.name = 'AttemptPostureRefusedError';
  }
}

export class MissingAuditPostureError extends Error {
  constructor(method: string, url: string) {
    super(
      `${method} ${url} declares no audit posture. ` +
        `Add audit: { action, target } or the explicit opt-out audit: 'none'.`,
    );
    this.name = 'MissingAuditPostureError';
  }
}

const registry: {
  method: HttpMethod;
  url: string;
  plane: RoutePlane;
  audit: AuditPosture;
  permission?: RoutePermission;
  lease?: LeaseRequirement;
  plan?: RoutePlan;
}[] = [];

/** For the boot gate's own test: what was actually registered. */
export function registeredRoutes(): readonly {
  method: HttpMethod;
  url: string;
  plane: RoutePlane;
  audit: AuditPosture;
  permission?: RoutePermission;
  lease?: LeaseRequirement;
  plan?: RoutePlan;
}[] {
  return registry;
}

export function resetRegistry(): void {
  registry.length = 0;
}

const auditLog = new TenantAuditLogRepository();

class LeaseSubjectUnreadableError extends Error {
  readonly statusCode = 400;
  readonly code = 'lease_subject_unreadable';
  constructor(source: LeaseSubjectSource) {
    super(`this route is leased on :${source.name}, which is absent`);
    this.name = 'LeaseSubjectUnreadableError';
  }
}

function leaseSubjectId(request: FastifyRequest, source: LeaseSubjectSource): string {
  const params = request.params as Record<string, unknown> | undefined;
  const value = params?.[source.name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new LeaseSubjectUnreadableError(source);
  }
  return value;
}

function requestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : String(request.id);
}

export function registerTenantRoute(
  app: FastifyInstance,
  deps: RouteDeps,
  definition: RouteDefinition,
): void {
  // Throws at registration, not on first request. A route that cannot be audited
  // does not ship, and "does not ship" means the process refuses to boot.
  if (definition.audit === undefined || definition.audit === null) {
    throw new MissingAuditPostureError(definition.method, definition.url);
  }
  if (isAttemptPosture(definition.audit)) {
    throw new AttemptPostureRefusedError(definition.method, definition.url, definition.plane);
  }
  if (isAuditDescriptor(definition.audit)) {
    const { action, target } = definition.audit;
    if (!action || !target) {
      throw new MissingAuditPostureError(definition.method, definition.url);
    }
    if (definition.audit.afterIsResult) {
      throw new Error(
        `${definition.method} ${definition.url}: afterIsResult is a control-plane audit `
        + 'option; the tenant registrar records its after-image through `lock`.');
    }
  }

  if (definition.plane === 'agent') {
    throw new Error(`${definition.method} ${definition.url} is an agent route: registerAgentRoute serves it, never the tenant registrar`);
  }

  if (definition.plane === 'public') {
    const allowed = PUBLIC_PATH_PREFIXES.some((p) => definition.url.startsWith(p));
    if (!allowed) {
      throw new PublicRouteRefusedError(
        definition.method, definition.url, 'its path is not a declared public prefix');
    }
    // A public READ is a health check. A public WRITE outside /api/auth/ is an
    // unauthenticated mutation, which is never what anyone meant.
    if (MUTATING_METHODS.includes(definition.method) && !definition.url.startsWith('/api/auth/')) {
      throw new PublicRouteRefusedError(
        definition.method, definition.url, 'it mutates outside /api/auth/');
    }
  }

  // Second gate, at boot. The type system already refuses the mismatch; this
  // catches a cast, a generated route, or anything that reached here as `any`.
  if (definition.permission) {
    if (definition.plane === 'public') {
      throw new PermissionPlaneMismatchError(
        definition.method, definition.url, 'public', definition.permission.plane,
        definition.permission.key);
    }
    if (definition.permission.plane !== definition.plane) {
      throw new PermissionPlaneMismatchError(
        definition.method, definition.url, definition.plane,
        definition.permission.plane, definition.permission.key);
    }
  }

  if (definition.plan !== undefined && needsDocument(definition.plan) && !deps.entitlements) {
    throw new PlanGateWithoutCacheError(definition.method, definition.url);
  }

  registry.push({
    method: definition.method,
    url: definition.url,
    plane: definition.plane,
    audit: definition.audit,
    ...(definition.permission ? { permission: definition.permission } : {}),
    ...(definition.lease ? { lease: definition.lease } : {}),
    ...(definition.plan ? { plan: definition.plan } : {}),
  });

  app.route({
    method: definition.method,
    url: definition.url,
    // Exposed on the route so the impersonation guard can bound the request
    // BEFORE the handler and before a pooled connection is taken. onRequest runs
    // after routing, so request.routeOptions.config is populated by then.
    config: {
      permission: definition.permission,
      auditAction: isAuditDescriptor(definition.audit) ? definition.audit.action : null,
      // Was absent, and its absence is why the header-presence check in app.ts
      // never fired once: the hook read `config.posLease`, nothing ever set it,
      // and `undefined !== 'required'` is silently false. The declaration was
      // read by nothing that ran. Set here so the cheap check happens before a
      // pooled connection is taken; the authoritative resolution is below.
      posLease: definition.lease ?? 'exempt',
    },
    handler: async (request, reply) => {
      const claims = request.claims ?? {};
      const impersonation = request.impersonation;

      // For an impersonated request the tenant comes from the SESSION ROW, never
      // from the token. The guard has already asserted the two agree; taking it
      // from the row means a token that somehow diverged still cannot steer the
      // transaction at a tenant the session does not name.
      const tenantId = impersonation ? impersonation.session.tenantId : claims['tenant_id'];
      if (typeof tenantId !== 'string') {
        return reply.code(401).send({ error: 'missing_tenant_id' });
      }

      const userId = typeof claims['sub'] === 'string' ? claims['sub'] : null;
      if (!userId) return reply.code(401).send({ error: 'missing_subject' });
      const branchId = typeof claims['branch_id'] === 'string' ? claims['branch_id'] : null;
      const viaImpersonation = claims['via_impersonation'] === true;

      return withTenantTransaction(deps.pool, tenantId, async (context) => {
        // An impersonating superadmin holds no membership, so there is nothing to
        // resolve and nothing to check a tenant permission against. The controls
        // are elsewhere and they are stronger: the platform permission that
        // started the session, the read-only enforcement at the guard, the
        // 60-minute cap on the row, and every write tagged to the session in the
        // tenant's own audit log.
        const actor = impersonation
          ? {
              userId: impersonation.session.platformUserId,
              actorName: impersonation.session.platformUserName,
              actorEmail: impersonation.session.platformUserEmail,
              authority: null,
            }
          : await (deps.resolveActor ?? resolveActor)(context, userId, branchId);

        if (!actor) {
          await reply.code(403).send({ error: 'forbidden' });
          return reply;
        }

        let authorisingMembershipId: string | null = null;

        if (definition.permission?.plane === 'tenant' && actor.authority) {
          if (!actor.authority.permissions.has(definition.permission.key)) {
            await reply.code(403).send({ error: 'forbidden' });
            return reply;
          }

          authorisingMembershipId = authorisingMembershipFor(
            actor.authority,
            definition.permission.key,
          );

          if (authorisingMembershipId === null) {
            // The check passed on a union no single membership supplies. That is
            // an internal invariant violation, so it pages someone -- and the
            // caller is told nothing beyond 403. A distinct status here would be
            // a probing signal.
            deps.onUnattributable?.({
              tenantId,
              userId,
              branchId,
              permission: definition.permission.key,
              action: isAuditDescriptor(definition.audit) ? definition.audit.action : '(unaudited)',
              heldPermissions: [...actor.authority.permissions],
              authorisedBy: Object.fromEntries(actor.authority.authorisedBy),
            });
            request.log.error(
              { tenantId, userId, branchId, permission: definition.permission.key },
              'unattributable action: permission check passed but no membership authorises it',
            );
            await reply.code(403).send({ error: 'forbidden' });
            return reply;
          }
        }

        if (definition.plan !== undefined && needsDocument(definition.plan)) {
          const document = await resolveEntitlement(
            deps.entitlements!, context.client, tenantId,
            (error) => request.log.warn({ tenantId, error }, 'entitlement cache unavailable; read the document table'),
          );
          request.entitlement = document;
          // Features and tiers first: a plan that excludes the thing outright
          // says so, rather than reporting a limit nobody could ever be under.
          const gates = planGates(definition.plan);
          for (const gate of gates) {
            if ('limit' in gate) continue;
            if (!planIncludes(entitlementsFromTerms(document), gate)) {
              const on = lowestPlanIncluding(gate);
              throw new PlanExcludesError(describeGate(gate), on === null ? null : PLAN_NAMES[on]);
            }
          }
          for (const gate of gates) {
            if ('limit' in gate) assertWithinLimit(document, gate.limit, (await planUsage(context, gate.limit)) + 1);
          }
        }

        // ###################################################################
        // THE LEASE, RESOLVED HERE AND NOWHERE ELSE.
        //
        // Inside the transaction, after authorisation, before the handler. Not
        // in the handler: a check a handler performs is a check a handler can
        // omit, and 14 routes declare `lease` today. Not in the onRequest hook
        // either -- that runs before a pooled connection is taken, deliberately,
        // and the lease lives in the database.
        //
        // The token arrives in the header; `requireLeaseByToken` resolves the
        // session and the device from the ROW and refuses a mismatch, so the
        // client cannot name the session it is writing to.
        // ###################################################################
        if (definition.lease !== undefined && definition.lease !== 'exempt') {
          const token = requireLeaseToken(request, definition.url);
          const subjectId = leaseSubjectId(request, definition.lease.at);
          const targetSessionId = await resolveLeaseSubject(
            context, definition.lease.subject, subjectId);
          request.heldLease = await requireLeaseByToken(
            context, { token, targetSessionId });
        }

        // ###################################################################
        // THE IDEMPOTENCY KEY IS CLAIMED HERE, OR IT IS NOT CLAIMED AT ALL.
        //
        // `app.request_claim` and `claimOrReplay` were built, hash-partitioned,
        // given a retention policy and tested -- and had exactly two callers:
        // `fireOrder` and the offline batch. The other ELEVEN POS mutations
        // required the header, validated that it was present, and threw it away.
        //
        // The client is built around the opposite assumption. The pump retries
        // with the SAME key on every offline failure, which is the POS's design
        // condition rather than an edge case, and the queue mints the key at
        // enqueue precisely so a retry is safe. Measured before this was wired:
        //
        //   addLine  twice under one key -> two different line ids
        //   a PARTIAL tender under one key -> two tender rows, and a bill that
        //   says 630.00 arrived when the customer handed over 315.00
        //
        // The full-tender case happened to be caught by
        // `assert_billing_invariants` (paying past the total violates it), which
        // is luck, not design: a partial tender exceeds nothing and there was
        // nothing to catch it.
        //
        // So the claim goes where the header requirement already is -- driven by
        // the route declaration, in the registrar, before the handler and inside
        // the same transaction. A claim a handler performs is a claim a handler
        // can omit, and eleven of twelve did.
        //
        // Replay returns the STORED RESULT rather than re-running: the second tap
        // must get the same fire number, the same line id and the same tender id
        // back, not merely a 200.
        // ###################################################################
        const claiming = requiresIdempotency(definition.method, definition.url);

        let idempotencyKey: string | null = null;
        if (claiming) {
          idempotencyKey = requireIdempotencyKey(request);
          const branchId = typeof claims['branch_id'] === 'string' ? claims['branch_id'] : null;
          const claim = await claimOrReplay<unknown>(context, {
            idempotencyKey,
            // The route, not a hand-written label: two routes sharing an
            // operation name would let one replay the other's result.
            operation: `${definition.method} ${definition.url}`,
            // A branchless token cannot reach a leased POS route, so a null
            // branch only occurs on the exempt ones. It was the empty string,
            // which `request_claim.branch_id` (uuid) refused as 22P02 -- an
            // owner reprinting a bill got "field malformed".
            branchId,
            payload: request.body ?? null,
          });
          if (claim.replayed) return claim.result;
        }

        if (!isAuditDescriptor(definition.audit)) {
          const fresh = await definition.handler(request, reply, context);
          if (idempotencyKey !== null) {
            await recordClaimResult(context, idempotencyKey, fresh);
          }
          return fresh;
        }

        const descriptor = definition.audit;

        // Before-image first, and locked. The handler's write and this read must
        // be adjacent, or the audit row describes a state the mutation never saw.
        let before: unknown = null;
        if (descriptor.lock) {
          before = await descriptor.lock.repository.findOneForUpdate({
            id: descriptor.lock.id(request),
          });
        }

        const result = await definition.handler(request, reply, context);

        let after: unknown = null;
        if (descriptor.lock) {
          after = await descriptor.lock.repository.findOne({ id: descriptor.lock.id(request) });
        }

        if (idempotencyKey !== null) {
          // Stored inside the same transaction as the mutation AND the audit
          // row. All three commit together or none of them do -- a stored result
          // for a rolled-back write would replay a mutation that never happened.
          await recordClaimResult(context, idempotencyKey, result);
        }

        const payload = preparePayload(before, after);

        // Same transaction, same connection. An audit failure rolls the mutation
        // back; a rolled-back mutation cannot leave a phantom audit row.
        // Attribution is total and keyed on an explicit discriminator, never on
        // which column happens to be null.
        await auditLog.insert({
          id: randomUUID(),
          branch_id: branchId,
          actor_kind: impersonation ? 'impersonation' : 'user',
          impersonation_session_id: impersonation ? impersonation.session.sessionId : null,
          actor_system_job: null,
          actor_user_id: impersonation ? null : actor.userId,
          actor_name: actor.actorName,
          actor_email: actor.actorEmail,
          action: descriptor.action,
          target_type: descriptor.target,
          target_id: descriptor.targetId ? descriptor.targetId(request) : null,
          before: payload.before === null ? null : JSON.stringify(payload.before),
          after: payload.after === null ? null : JSON.stringify(payload.after),
          payload_truncated: payload.truncated,
          ip: request.ip,
          user_agent: request.headers['user-agent'] ?? null,
          request_id: requestId(request),
          via_impersonation: impersonation !== undefined || viaImpersonation,
          authorising_membership_id: impersonation ? null : authorisingMembershipId,
        });

        return result;
      });
    },
  });
}
