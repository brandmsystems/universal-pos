import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { assertSubscriptionInBook } from '../../modules/platform/salesScope.js';
import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import { requireIdempotencyKey } from '../../middleware/posHeaders.js';
import { env } from '../../config/env.js';
import {
  listPlans, listTenants, parseExpiryFilter, resolveTenantBySlug,
} from '../../modules/platform/directory.js';
import { provisionTenant } from '../../modules/platform/provisioning.js';
import {
  createPlatformUser, listPlatformUsers, listSalesPersons, platformProfile, resetPlatformUserPassword,
  setPlatformUserStatus, updatePlatformUser,
} from '../../modules/platform/staff.js';
import {
  deactivateTenant, editTenant, reactivateTenant, reissueOwnerInvite, removeTenantLogo,
  setTenantLogo,
} from '../../modules/platform/tenantAdmin.js';
import { renameTenantSlug, slugAvailability } from '../../modules/platform/slug.js';
import {
  createTenantStaff, editTenantStaff, listTenantStaff, setTenantCredentials, setTenantStaffActive, setTenantStaffPin,
  type StaffActor,
} from '../../modules/platform/tenantStaff.js';
import { platformRoleHolds } from '../../middleware/security/platformAuthz.js';
import {
  changeTenantCountry, previewCountryChange, readCountrySettings, setCountrySettings,
  type CountryChangeActor,
} from '../../modules/platform/countries.js';
import {
  publishPlanVersion, setPlanStatus, type PlanTerms,
} from '../../modules/platform/planCatalogue.js';
import { renewSubscription } from '../../modules/billing/renewal.js';
import { JURISDICTIONS } from '../../modules/tax/jurisdictions.js';
import { systemHealthReport } from '../../modules/platform/systemHealth.js';
import { ImpersonationSessionNotRevocableError, MAX_SESSION_MINUTES, revokeImpersonation, startImpersonation, type ImpersonationReasonCode } from '../../modules/platform/impersonation.js';
import { dunningQueue, recordOutreach } from '../../modules/billing/dunning.js';
import { listInvoices } from '../../modules/billing/invoiceLedger.js';
import { changeSubscription } from '../../modules/billing/planChange.js';
import {
  pendingChangeFor, revokeScheduledChange,
} from '../../modules/billing/scheduledChange.js';
import { stateTaxPosition } from '../../modules/billing/taxExemption.js';
import { jobHealth } from '../../jobs/runner.js';

/**
 * The CONTROL PLANE's route layer, and nothing more.
 *
 * ###########################################################################
 * THE SAME RULE AS THE POS SURFACE, FOR A DIFFERENT REASON.
 *
 * `handlers/pos.ts` is thin because the offline sync path replays the SAME
 * operations, so a rule implemented in a handler is a rule a synced line never
 * gets. There is no sync path here -- and the reason is stronger, not weaker:
 * every one of these twelve routes is the FIRST caller of a mechanism that was
 * built, tested and reached by nothing. `startImpersonation` had no caller.
 * `outboxHealth` was documented as "what the System health widget reads" and
 * nothing read it. `applyExpansion` and `scheduleContraction` were both built
 * with nothing able to choose between them. The tax-exemption columns, their
 * CHECK and their guard trigger had no writer at all.
 *
 * A handler that re-implemented any of that would leave the original
 * unreachable AND add a second answer. So each handler here reads the request,
 * calls one domain function, and returns what it returned.
 * ###########################################################################
 *
 * WHAT THE HANDLERS DO NOT DO:
 *
 *  - They do not open a transaction. `registerPlatformRoute` opens one with NO
 *    tenant GUC (the control plane has no tenant context by definition) and
 *    writes `platform.platform_audit_log` inside it. A handler that committed
 *    would commit the registrar's unit of work before the audit row exists.
 *  - They do not check the route's permission. The registrar does, per key,
 *    against the role in the token -- with ONE exception, called out on
 *    `startImpersonation` below, because that route needs two keys and the route
 *    table can only declare one.
 *  - They do not touch `context.tenantId`. It is the empty sentinel here, on
 *    purpose: "passing a real one would be a lie the handler could act on".
 *    Every tenant a control-plane route acts on is named in the request and
 *    resolved against `platform.tenant`.
 */

type Handler = RouteDefinition['handler'];

function body<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw new Error(`missing path parameter ${name}`);
  return value;
}

function queryString(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function queryFlag(request: FastifyRequest, name: string): boolean {
  const value = queryString(request, name);
  return value === 'true' || value === '1';
}

/**
 * A limit is a hint, never an instruction. The domain functions cap it; this
 * only has to turn a string into a number without throwing on rubbish.
 */
function queryLimit(request: FastifyRequest): number | undefined {
  const raw = queryString(request, 'limit');
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The acting platform user, from the VERIFIED token. Never from the body.
 *
 * The registrar has already resolved this subject against
 * `platform.platform_user` and refused the request if it named nobody, and it
 * snapshots the actor's email and role BEFORE the handler runs. So `sub` here is
 * an id that exists; taking one from the body would be a second, unchecked
 * opinion about who is doing this -- and on this plane the actor is the whole
 * audit trail.
 */
/** Who manages staff, and how far: every restaurant, or only the ones they sold. */
function staffActor(request: FastifyRequest): StaffActor {
  return {
    platformUserId: actingPlatformUserId(request),
    anyRestaurant: platformRoleHolds((request.claims ?? {})['platform_role'], 'platform.tenant.staff.any'),
  };
}

/** Who moves a restaurant's country, and how far: any restaurant, or only theirs while Sales is allowed. */
function countryActor(request: FastifyRequest): CountryChangeActor {
  return {
    platformUserId: actingPlatformUserId(request),
    anyRestaurant: platformRoleHolds((request.claims ?? {})['platform_role'], 'platform.tenant.country.any'),
  };
}

function actingPlatformUserId(request: FastifyRequest): string {
  const sub = (request.claims ?? {})['sub'];
  if (typeof sub !== 'string') throw new Error('no platform subject on the request');
  return sub;
}

/**
 * The acting user's id when the token is a Salesperson's -- the value every
 * book-scoped read filters on -- and undefined for every other role.
 */
function salesScope(request: FastifyRequest): string | undefined {
  return actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined;
}

/** A subscription route addressed by id: a Salesperson may only reach their own book. */
async function guardBook(request: FastifyRequest, client: pg.ClientBase, subscriptionId: string): Promise<void> {
  const rep = salesScope(request);
  if (rep !== undefined) await assertSubscriptionInBook(client, subscriptionId, rep);
}

/** The role in the token, as a string. Absence is not a role. */
function actingRoleKey(request: FastifyRequest): string {
  const role = (request.claims ?? {})['platform_role'];
  return typeof role === 'string' ? role : '';
}

export class NoPendingChangeError extends Error {
  readonly statusCode = 404;
  readonly code = 'no_pending_change';
  constructor(subscriptionId: string) {
    super(
      `subscription ${subscriptionId} has no scheduled change to call off. It may ` +
        'already have applied at the period end, or somebody else revoked it -- ' +
        'either way nothing was changed by this request.',
    );
    this.name = 'NoPendingChangeError';
  }
}

/**
 * `POST /tenants` arrived without a jurisdiction.
 *
 * Its own error rather than the not-null mapping, because the useful part of
 * the answer is the LIST -- and because "which regime does this restaurant
 * trade under" is a question the integrator has to go and ask somebody, not a
 * field they forgot to type.
 */
export class TaxJurisdictionRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_jurisdiction_required';
  constructor() {
    const catalogue = JURISDICTIONS
      .map((j) => `${j.code} (${j.name}, ${j.status})`)
      .join('; ');
    super(
      'taxJurisdiction is required and has no default: it decides the tax on '
      + 'every bill this restaurant will raise, and the answer that is usually '
      + 'right is exactly the one that must not fill itself in. Catalogue: '
      + `${catalogue}. A tenant may be created under a "declared" jurisdiction `
      + 'and will be able to build a menu, but no bill can be raised until its '
      + 'rules are implemented.',
    );
    this.name = 'TaxJurisdictionRequiredError';
  }
}

export function platformHandlers(
  // Defaulted rather than required, so the exported signature is
  // `platformHandlers()` as the route table's assembly expects, while a test can
  // inject the key it signs its own tokens with. There is no fallback VALUE: an
  // unset JWT_SIGNING_KEY throws here exactly as it does at boot.
  jwtKey: string = env.jwtSigningKey(),
): Record<string, Handler> {
  return {
    /* ------------------------------------------------------------ tenants --- */

    tenants: async (request, _reply, context) =>
      listTenants(context.client, {
        status: queryString(request, 'status'),
        search: queryString(request, 'search'),
        limit: queryLimit(request),
        planKey: queryString(request, 'plan'),
        salesPersonId: queryString(request, 'salesPerson'),
        expiry: parseExpiryFilter(queryString(request, 'expiry')),
        // A Salesperson's own book, not the whole estate -- see
        // ListTenantsParams.provisionedByPlatformUserId. Every other role
        // holding platform.tenant.view keeps the unscoped read.
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      }),

    /**
     * Provisioning, idempotent on the HEADER key.
     *
     * The key is a header rather than a body field for the same reason it is on
     * the POS: it identifies the ATTEMPT, not the tenant being created, so it
     * belongs beside the request and not inside it. `provisionTenant` hashes the
     * whole request alongside it, so a retry returns the original result and a
     * key reused with different parameters is refused
     * (`provisioning_key_reused`) instead of handing back someone else's tenant.
     */
    provision: async (request, _reply, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      const input = body<{
        slug: string;
        name: string;
        currency: string;
        timezone: string;
        ownerEmail: string;
        ownerName: string;
        ownerPhone?: string | null;
        startMode?: 'trial' | 'paid';
        legalName?: string | null;
        address?: string | null;
        themeColor?: string | null;
        themeColorSecondary?: string | null;
        businessType?: string;
        firstBranchName: string;
        planVersionId: string;
        taxJurisdiction?: string;
      }>(request);

      // #####################################################################
      // NAMED HERE RATHER THAN LEFT TO THE NOT-NULL CONSTRAINT.
      //
      // Omitting it would reach `provisionTenant`, then the INSERT, and come
      // back as `23502 field_required` naming a control-plane column -- which
      // tells whoever is integrating nothing about WHICH two-letter code to
      // send or which ones this product can actually tax. So the refusal
      // carries the catalogue, and says which entries have rules.
      // #####################################################################
      const { taxJurisdiction, ...rest } = input;
      if (!taxJurisdiction) throw new TaxJurisdictionRequiredError();

      return provisionTenant(context.client, {
        ...rest,
        taxJurisdiction,
        idempotencyKey,
        // From the token. The provisioning row, the tenant row and the owner
        // invite all record who asked, and all three take it from here.
        requestedByPlatformUserId: actingPlatformUserId(request),
      });
    },

    /**
     * Name and legal name. A Salesperson holds `platform.tenant.edit` and may
     * use it on their own book only -- the same scoping `tenants` applies to the
     * read, applied to the write.
     */
    renameTenantSlug: async (request, _reply, context) =>
      renameTenantSlug(context.client, {
        tenantId: param(request, 'id'),
        slug: ((request.body ?? {}) as Record<string, unknown>)['slug'],
        renamedByPlatformUserId: actingPlatformUserId(request),
      }),

    countrySettings: async (_request, _reply, context) => readCountrySettings(context.client),
    setCountrySettings: async (request, _reply, context) => {
      const input = body<{ offered?: unknown; defaultCountry?: unknown; salesMayChangeCountry?: unknown }>(request);
      return setCountrySettings(context.client, {
        offered: input.offered, defaultCountry: input.defaultCountry, salesMayChangeCountry: input.salesMayChangeCountry,
      });
    },
    previewCountryChange: async (request, _reply, context) =>
      previewCountryChange(context.client, countryActor(request), param(request, 'id'), {
        country: queryString(request, 'country'),
        currency: queryString(request, 'currency'),
        timezone: queryString(request, 'timezone'),
        rate: queryString(request, 'rate'),
      }),
    changeTenantCountry: async (request, _reply, context) => {
      const input = body<{ country?: unknown; currency?: unknown; timezone?: unknown; rate?: unknown; confirm?: unknown }>(request);
      return changeTenantCountry(context.client, countryActor(request), param(request, 'id'), {
        country: input.country, currency: input.currency, timezone: input.timezone,
        rate: input.rate, confirm: input.confirm,
      });
    },

    tenantStaff: async (request, _reply, context) =>
      listTenantStaff(context.client, staffActor(request), param(request, 'id')),

    createTenantStaff: async (request, _reply, context) => {
      const input = body<Record<string, unknown>>(request);
      return createTenantStaff(context.client, staffActor(request), {
        tenantId: param(request, 'id'), fullName: input['fullName'], username: input['username'],
        password: input['password'], pin: input['pin'], access: input['access'],
      });
    },

    editTenantStaff: async (request, _reply, context) => {
      const input = body<Record<string, unknown>>(request);
      return editTenantStaff(context.client, staffActor(request), {
        tenantId: param(request, 'id'), userId: param(request, 'userId'),
        fullName: input['fullName'], username: input['username'], access: input['access'],
      });
    },

    setTenantCredentials: async (request, _reply, context) => {
      const input = body<Record<string, unknown>>(request);
      return setTenantCredentials(context.client, staffActor(request), {
        tenantId: param(request, 'id'), userId: param(request, 'userId'),
        username: input['username'], password: input['password'],
      });
    },

    setTenantStaffPin: async (request, _reply, context) =>
      setTenantStaffPin(context.client, staffActor(request), {
        tenantId: param(request, 'id'), userId: param(request, 'userId'),
        pin: body<Record<string, unknown>>(request)['pin'],
      }),

    setTenantStaffActive: async (request, _reply, context) =>
      setTenantStaffActive(context.client, staffActor(request), {
        tenantId: param(request, 'id'), userId: param(request, 'userId'),
        active: body<Record<string, unknown>>(request)['active'],
      }),

    editTenant: async (request, _reply, context) => {
      const input = body<{
        name?: unknown; legalName?: unknown; address?: unknown; themeColor?: unknown; themeColorSecondary?: unknown;
        businessType?: unknown;
      }>(request);
      return editTenant(context.client, {
        tenantId: param(request, 'id'),
        name: input.name,
        legalName: input.legalName,
        address: input.address,
        themeColor: input.themeColor,
        themeColorSecondary: input.themeColorSecondary,
        businessType: input.businessType,
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      });
    },

    /**
     * A fresh setup link for the Restaurant Manager. The token is in the
     * response and nowhere else -- the route records no after-image.
     */
    /**
     * The logo, as base64 JSON rather than multipart: one small bounded image,
     * no upload plugin, and the same body parsing every other route uses.
     */
    setTenantLogo: async (request, _reply, context) => {
      const input = body<{ contentType?: unknown; dataBase64?: unknown }>(request);
      return setTenantLogo(context.client, {
        tenantId: param(request, 'id'),
        contentType: input.contentType,
        dataBase64: input.dataBase64,
        byPlatformUserId: actingPlatformUserId(request),
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      });
    },

    removeTenantLogo: async (request, _reply, context) =>
      removeTenantLogo(context.client, {
        tenantId: param(request, 'id'),
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      }),

    slugAvailability: async (request, _reply, context) =>
      slugAvailability(context.client, queryString(request, 'slug') ?? ''),

    reissueOwnerInvite: async (request, _reply, context) =>
      reissueOwnerInvite(context.client, {
        reason: body<{ reason?: unknown }>(request).reason,
        tenantId: param(request, 'id'),
        invitedByPlatformUserId: actingPlatformUserId(request),
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      }),

    deactivateTenant: async (request, _reply, context) =>
      deactivateTenant(context.client, {
        tenantId: param(request, 'id'),
        reason: body<{ reason?: unknown }>(request).reason,
        deactivatedByPlatformUserId: actingPlatformUserId(request),
      }),

    reactivateTenant: async (request, _reply, context) =>
      reactivateTenant(context.client, {
        tenantId: param(request, 'id'),
        reason: body<{ reason?: unknown }>(request).reason,
      }),

    /* ---------------------------------------------------------- staff ----- */

    platformUsers: async (_request, _reply, context) => listPlatformUsers(context.client),

    /**
     * A platform staff account, password set directly by the granter rather
     * than by invite token: unlike a tenant owner, there is no accept-invite
     * surface on this plane and no outbox topic for it, and inventing one to
     * avoid a shared secret would be new unbuilt UI standing between this
     * route and the one thing it needs to do today. The password is shown
     * once in the response so the granter can hand it to the new hire the
     * same way `seed-platform-user.mts` always has.
     */
    createPlatformUser: async (request, _reply, context) => {
      const input = body<{
        email: string; fullName: string; password: string; roleKey: string; phone?: unknown;
      }>(request);
      return createPlatformUser(context.client, {
        email: input.email, fullName: input.fullName, password: input.password,
        roleKey: input.roleKey, phone: input.phone,
        createdByPlatformUserId: actingPlatformUserId(request),
        granterRoleKey: actingRoleKey(request),
      });
    },

    updatePlatformUser: async (request, _reply, context) => {
      const input = body<{ fullName?: unknown; email?: unknown; phone?: unknown }>(request);
      return updatePlatformUser(context.client, {
        platformUserId: param(request, 'id'),
        actorRoleKey: actingRoleKey(request),
        fullName: input.fullName, email: input.email, phone: input.phone,
      });
    },

    setPlatformUserStatus: async (request, _reply, context) =>
      setPlatformUserStatus(context.client, {
        platformUserId: param(request, 'id'),
        status: body<{ status?: unknown }>(request).status,
        actorId: actingPlatformUserId(request),
        actorRoleKey: actingRoleKey(request),
      }),

    salesPersons: async (_request, _reply, context) => listSalesPersons(context.client),

    me: async (request, _reply, context) =>
      platformProfile(context.client, actingPlatformUserId(request)),

    resetPlatformUserPassword: async (request, _reply, context) =>
      resetPlatformUserPassword(context.client, {
        platformUserId: param(request, 'id'),
        actorId: actingPlatformUserId(request),
        actorRoleKey: actingRoleKey(request),
      }),

    /* -------------------------------------------------------------- plans --- */

    plans: async (_request, _reply, context) => listPlans(context.client),

    setPlanStatus: async (request, _reply, context) =>
      setPlanStatus(context.client, {
        planId: param(request, 'id'),
        status: body<{ status?: unknown }>(request).status,
      }),

    renewSubscription: async (request, _reply, context) =>
      renewSubscription(context.client, {
        subscriptionId: param(request, 'id'),
        periods: body<{ periods?: unknown }>(request).periods,
        provisionedByPlatformUserId:
          actingRoleKey(request) === 'sales' ? actingPlatformUserId(request) : undefined,
      }),

    publishPlanVersion: async (request, _reply, context) =>
      publishPlanVersion(context.client, {
        planId: param(request, 'id'),
        terms: body<Partial<PlanTerms>>(request),
        publishedByPlatformUserId: actingPlatformUserId(request),
      }),

    /**
     * A plan or seat change, routed to the arm the asymmetry demands.
     *
     * The direction is NOT decided here. `changeSubscription` reads the current
     * plan price and the open segment's quantity and picks: expansions take
     * effect immediately, contractions are scheduled to the period boundary. A
     * handler that computed that would be a handler holding the only copy of the
     * rule -- and it would need the live price to do it, which is the route-layer
     * snapshot the thin-handler gate refuses.
     */
    changePlan: async (request, _reply, context) => {
      await guardBook(request, context.client, param(request, 'id'));
      const input = body<{ planVersionId?: string; quantity?: number }>(request);
      return changeSubscription(context.client, {
        subscriptionId: param(request, 'id'),
        targetPlanVersionId: input.planVersionId,
        targetQuantity: input.quantity,
        requestedByPlatformUserId: actingPlatformUserId(request),
      });
    },

    /**
     * What is queued against this subscription, and how to call it off.
     *
     * Both domain functions existed with a test as their only caller, so a
     * support agent could schedule a downgrade and then neither see nor undo it.
     */
    pendingChange: async (request, _reply, context) => {
      await guardBook(request, context.client, param(request, 'id'));
      const change = await pendingChangeFor(context.client, param(request, 'id'));
      // Null is the answer "nothing is queued", stated rather than implied by an
      // empty object -- the client renders the two differently.
      return { subscriptionId: param(request, 'id'), pending: change };
    },

    revokePendingChange: async (request, _reply, context) => {
      await guardBook(request, context.client, param(request, 'id'));
      const change = await pendingChangeFor(context.client, param(request, 'id'));
      // 404 rather than a silent success: "there was nothing to cancel" and "I
      // cancelled it" must not look the same to whoever is on the phone.
      if (change === null) throw new NoPendingChangeError(param(request, 'id'));
      const revoked = await revokeScheduledChange(context.client, { changeId: change.id });
      if (!revoked) throw new NoPendingChangeError(param(request, 'id'));
      return { subscriptionId: param(request, 'id'), revokedChangeId: change.id };
    },

    /* ------------------------------------------------------------ billing --- */

    invoices: async (request, _reply, context) =>
      listInvoices(context.client, {
        provisionedByPlatformUserId: salesScope(request),
        tenantId: queryString(request, 'tenantId'),
        status: queryString(request, 'status'),
        overdueOnly: queryFlag(request, 'overdue'),
        limit: queryLimit(request),
      }),

    /**
     * The dunning queue.
     *
     * `now` is the server's clock, passed in rather than read inside the query,
     * because `dunningQueue` computes `daysUntilSoftLock` against the SAME
     * instant it selected the rows at -- and it reads the ladder thresholds from
     * `platform_setting` to do it, so the screen cannot disagree with the job.
     */
    dunning: async (request, _reply, context) =>
      dunningQueue(context.client, { now: new Date(), provisionedByPlatformUserId: salesScope(request) }),

    /**
     * One-click contact-owner, which is a WRITE and keyed as one.
     *
     * The route is guarded by `platform.dunning.outreach`, not
     * `platform.payment.view`: read_only holds the view key, and this logs a
     * call about a delinquent tenant. The log is the point -- "an outreach
     * nobody recorded is one the next person repeats, and a tenant chased four
     * times in a day leaves".
     */
    outreach: async (request, _reply, context) => {
      const input = body<{
        channel: 'email' | 'phone' | 'in_app';
        invoiceId?: string | null;
        note?: string | null;
      }>(request);
      return recordOutreach(context.client, {
        // The path, not the body: the registrar reads `:tenantId` from the same
        // place for the audit row's `target_tenant_id`, so a body-supplied id
        // would let the request steer the record of itself.
        tenantId: param(request, 'tenantId'),
        channel: input.channel,
        invoiceId: input.invoiceId ?? null,
        note: input.note ?? null,
        byPlatformUserId: actingPlatformUserId(request),
      });
    },

    /* ------------------------------------------------------ impersonation --- */

    /**
     * ###################################################################
     * THE ONE SANCTIONED CROSSING OF THE PLANE BOUNDARY, AND ITS FIRST CALLER.
     *
     * Everything that makes impersonation safe was already built: the guard that
     * re-reads the session row on EVERY request, the read-only enforcement in
     * front of the handler, the 60-minute cap as a CHECK on the row rather than
     * on the token, the append-only trigger that permits nothing but the
     * revocation stamp, and the outbox notice to the tenant's owner. None of it
     * had a caller, so no session could exist and the entire mechanism was
     * inert.
     *
     * THE TENANT IS NAMED BY SLUG, IN THE BODY. Three things force that and it
     * is worth being explicit about all of them:
     *
     *   1. The route is `POST /impersonation`, with no path segment for a
     *      tenant. It cannot come from the URL.
     *   2. There is no verified tenant to take it from. `context.tenantId` is
     *      the empty sentinel on this plane, which is the boundary working.
     *   3. `requestProvenance.test.ts` refuses `tenantId` in a handler's body
     *      type, and rightly: on the tenant plane that field names a fact the
     *      token already establishes.
     *
     * A slug is the spelling this codebase already chose for "a tenant named
     * where no token can supply one" -- see `/api/auth/:tenantSlug/login` and
     * the reasoning in `preAuthTenant.ts`: public, unique, already format-checked
     * by `tenant_slug_format`, and typeable by the person on the phone. It is
     * resolved against `platform.tenant` here, so an unknown slug is a 404 and
     * not an oracle.
     *
     * It is NOT resolved by `resolveTenantForAuth`: that applies the LOGIN
     * allowlist, which refuses `hard_lock` -- and `impersonationPosture` permits
     * hard_lock deliberately, because that is precisely when support is needed.
     * ###################################################################
     */
    startImpersonation: async (request, _reply, context) => {
      const input = body<{
        tenantSlug: string;
        reasonCode: ImpersonationReasonCode;
        reasonDetail: string;
        minutes?: number;
        write?: { reasonCode: ImpersonationReasonCode; reasonDetail: string };
      }>(request);

      // The second key is now DECLARED on the route (`escalation`) and checked
      // by the platform registrar before this handler runs. It used to be an
      // `if` here -- the only authorisation decision in the product a registrar
      // did not make, and so the only one a refactor could delete silently.

      // The slug resolves to an id and a STATUS, and the status is not ruled on
      // here: `startImpersonation` applies `impersonationPosture` itself, which
      // is the one place the ladder ruling lives (purged refused, hard_lock
      // permitted, retention read-only whatever the write flag says). A second
      // copy of that list in a handler is how the two would come to disagree.
      const tenant = await resolveTenantBySlug(context.client, input.tenantSlug);

      const started = await startImpersonation(context.client, jwtKey, {
        tenantId: tenant.tenantId,
        platformUserId: actingPlatformUserId(request),
        reasonCode: input.reasonCode,
        reasonDetail: input.reasonDetail,
        // The cap is clamped by `startImpersonation` and enforced again by
        // `impersonation_max_60_minutes` on the row. Defaulting to the maximum
        // is deliberate: the product's stated behaviour is "max 60 minutes", and
        // a shorter secret default would expire sessions mid-call for no stated
        // reason.
        minutes: input.minutes ?? MAX_SESSION_MINUTES,
        ...(input.write === undefined ? {} : { write: input.write }),
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        sessionId: started.sessionId,
        // Shown once. The row is authoritative for everything else, so there is
        // nothing to re-fetch a token from and no way to extend one.
        token: started.token,
        expiresAt: started.expiresAt.toISOString(),
        writeEnabled: started.writeEnabled,
        tenant: { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name },
        /**
         * The prefix the token is valid on, returned rather than assumed by the
         * console. The impersonation guard is mounted on its own prefix so the
         * third token shape stays inert against the other two guards; a client
         * that guessed `/api/t` would get `impersonation_token_on_direct_plane`.
         */
        useAt: '/api/imp',
      };
    },

    /**
     * Revocation: immediate, and immediately effective.
     *
     * There is nothing to invalidate beyond this row. The guard resolves `sid`
     * against `platform.impersonation_session` on every single request and never
     * caches it, so the UPDATE below ends the session on the next request rather
     * than at the end of some TTL.
     */
    revoke: async (request, _reply, context) => {
      const sessionId = param(request, 'id');
      const revoked = await revokeImpersonation(
        context.client, sessionId, actingPlatformUserId(request));
      if (!revoked) throw new ImpersonationSessionNotRevocableError(sessionId);
      return { sessionId, revoked: true };
    },

    /* ---------------------------------------------------------- tax ------- */

    /**
     * The zero-rating grant, whose columns and constraints had no writer.
     *
     * `tenant_exemption_attributed` makes the claim impossible without the
     * granting platform user, the timestamp and the evidence; the guard trigger
     * forces all three to be RE-STATED whenever the claim changes. The platform
     * user comes from the token and can come from nowhere else -- which is the
     * structural half of "a tenant ticking a box must not be able to exempt
     * itself".
     */
    grantExemption: async (request, _reply, context) => {
      const input = body<{
        isSez?: boolean;
        countryCode?: string;
        lutNumber?: string | null;
        sezLoaNumber?: string | null;
        evidence: string;
      }>(request);

      return stateTaxPosition(context.client, {
        tenantId: param(request, 'id'),
        isSez: input.isSez === true,
        // 'IN' is the taxable default. An absent country is not a claim.
        countryCode: input.countryCode ?? 'IN',
        lutNumber: input.lutNumber ?? null,
        sezLoaNumber: input.sezLoaNumber ?? null,
        evidence: input.evidence,
        grantedByPlatformUserId: actingPlatformUserId(request),
      });
    },

    /* ------------------------------------------------------------- system --- */

    /**
     * Job health, computed from the REGISTRY against the ledger.
     *
     * Starting from `JOBS` rather than from `platform.job_run` is the whole
     * point: a job that was never scheduled writes no rows, so a query over the
     * ledger cannot see it -- and "never ran" is the case that matters, because
     * the failure is silent and what these jobs protect degrades slowly.
     */
    jobHealth: async (_request, _reply, context) => {
      const jobs = await jobHealth(context.client);
      return {
        jobs,
        // Summarised for the widget, so a screen does not have to re-derive
        // "is anything wrong" and get the definition of overdue subtly different.
        overdue: jobs.filter((job) => job.overdue).map((job) => job.job),
        failing: jobs.filter((job) => job.consecutiveFailures > 0).map((job) => job.job),
      };
    },

    /**
     * System health, honest about what it did not probe.
     *
     * It does NOT call `assertDatabaseSafety`: that runs its own BEGIN/COMMIT and
     * would commit the registrar's transaction from inside the request. The
     * probes that a SELECT can answer are answered; the one that cannot is
     * reported as `not_probed` with the reason. See `platform/systemHealth.ts`.
     */
    systemHealth: async (_request, _reply, context) =>
      systemHealthReport(context.client, { monthsAhead: env.auditPartitionMonthsAhead() }),
  };
}
