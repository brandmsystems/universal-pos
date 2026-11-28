import type { FastifyReply, FastifyRequest } from 'fastify';
import { acceptOwnerInvite, ownerPasswordProblem } from '../../modules/authentication/ownerInvite.js';
import { publicRestaurantBySlug, publicRestaurantLogo } from '../../modules/platform/directory.js';
import { posAppManifest } from '../../modules/platform/posApp.js';
import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import type { PublicOutcome, AttemptResolution } from '../../middleware/publicRoute.js';
import { adoptTenantContext } from '../../database/unitOfWork.js';
import { authenticatePin, readTillStaff, registerTillAtSignIn, resolveDevice } from '../../modules/authentication/deviceAuth.js';
import { authenticatePassword } from '../../modules/authentication/passwordAuth.js';
import { landingFor } from '../../modules/users/me.js';
import {
  PLATFORM_PASSWORD_MIN_LENGTH,
  authenticatePlatformUser,
  changePlatformPassword,
  platformUserStillActive,
} from '../../modules/authentication/platformAuth.js';
import {
  AUTHENTICABLE_TENANT_STATUSES,
  resolveTenantForAuth,
  tenantStillAuthenticable,
} from '../../modules/authentication/preAuthTenant.js';
import {
  deviceStillTrusted,
  issueSession,
  issuePlatformSession,
  readPlatformRefreshClaims,
  readRefreshClaims,
} from '../../modules/authentication/session.js';

/**
 * The pre-auth surface, and nothing more.
 *
 * ###########################################################################
 * THE SAME THIN RULE, WITH ONE EXTRA STEP THAT IS NOT A DECISION.
 *
 * Every handler here reads the request, resolves a tenant, calls one domain
 * function, and describes what happened. The tenant resolution is a lookup, not
 * a rule: it decides whose credentials the secret is checked against, and the
 * check itself is unchanged.
 *
 * No handler here verifies a secret, computes a lockout, or decides what a
 * rejection means. `platform.auth_attempt` is written by the registrar, from the
 * `attempt` each handler returns -- so a handler cannot forget to record one and
 * cannot record a method other than the one its route declares.
 * ###########################################################################
 */

type Handler = RouteDefinition['handler'];

function body<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

function slug(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>)['tenantSlug'];
  return typeof value === 'string' ? value : '';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The refusal shape, in one place.
 *
 * 401 for everything a caller could fix by presenting something else, and no
 * variation in status by reason -- a status code that distinguished
 * `tenant_unknown` from `credential_invalid` would answer, for free, the
 * question the uniform reason exists to refuse.
 *
 * `retryAfterSeconds` is the exception and is safe: it is only ever returned to
 * a caller who has already been getting a specific credential wrong.
 */
function rejected(
  reply: FastifyReply,
  attempt: Omit<AttemptResolution, 'outcome' | 'reason'> & { reason: string },
  retryAfterSeconds?: number,
): PublicOutcome {
  reply.code(401);
  return {
    attempt: { ...attempt, outcome: 'rejected', reason: attempt.reason },
    body: {
      error: 'authentication_failed',
      retryable: false,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  };
}

const NO_SUBJECT = {
  tenantId: null,
  claimedSubject: null,
  resolvedUserId: null,
  branchId: null,
  deviceFingerprint: null,
} as const;

/**
 * ###########################################################################
 * THE KEY IS CLOSED OVER, NOT READ FROM THE ENVIRONMENT PER REQUEST.
 *
 * A handler that reached for `process.env` would be a second place the signing
 * key comes from, and the composition root would stop being the answer to
 * "which key is this process using".
 * ###########################################################################
 */
export function authHandlers(jwtKey: string): Record<string, Handler> {
  return {
    /**
     * Password login, for the web admin. Not device-bound.
     *
     * The tenant is in the path because an email does not identify a user:
     * `app_user.email` is per-tenant citext, so the same address can exist in two
     * tenants. A global email lookup would have to span tenants to disambiguate,
     * which is a cross-tenant read path added for the convenience of a login form.
     */
    login: async (request, reply, context): Promise<PublicOutcome> => {
      // `login` is an email or a username; `email` is the older field, still read.
      const input = body<{ login?: unknown; email?: unknown; password?: unknown; audience?: unknown }>(request);
      const email = str(input.login) || str(input.email);
      const password = str(input.password);

      const resolved = await resolveTenantForAuth(context.client, slug(request));
      if ('refusal' in resolved) {
        return rejected(reply, { ...NO_SUBJECT, claimedSubject: email, reason: resolved.refusal });
      }
      if (!email || !password) {
        return rejected(reply, {
          ...NO_SUBJECT,
          tenantId: resolved.tenant.tenantId,
          claimedSubject: email,
          reason: 'credential_missing',
        });
      }

      const tenant = await adoptTenantContext(context.client, resolved.tenant.tenantId);
      const result = await authenticatePassword(tenant, { email, password });

      if (!result.ok) {
        return rejected(
          reply,
          {
            ...NO_SUBJECT,
            tenantId: tenant.tenantId,
            claimedSubject: email,
            reason: result.reason,
          },
          result.retryAfterSeconds,
        );
      }

      // No device: the admin is used from anywhere. No branch either -- unless
      // every role the person holds is at ONE branch and none is tenant-wide,
      // in which case that branch is a scope they were granted, and without it
      // their own reads would resolve nothing. `lands` tells the one login
      // page where to send them: the manager screens, or the POS.
      const landing = await landingFor(tenant, result.userId);
      // The Restaurant Manager sign-in is for managers ONLY. A staff account
      // signing in there is refused here, with no session issued -- not merely
      // redirected by the page -- so a staff password can never open the
      // manager screens, whatever the client does.
      // Staff sign in on the POS (`/{slug}/pos`, the till route below) with the
      // username and password their Sales person set -- never here.
      if (landing.lands !== 'admin') {
        reply.code(403);
        return {
          attempt: {
            ...NO_SUBJECT, tenantId: tenant.tenantId, claimedSubject: email, resolvedUserId: result.userId,
            outcome: 'rejected', reason: 'staff_use_pos',
          },
          body: { error: 'staff_use_pos', retryable: false },
        };
      }
      const session = issueSession(
        { userId: result.userId, tenantId: tenant.tenantId, branchId: landing.branchId, deviceId: null },
        jwtKey,
      );

      return {
        attempt: {
          outcome: 'success',
          reason: null,
          tenantId: tenant.tenantId,
          claimedSubject: email,
          resolvedUserId: result.userId,
          branchId: landing.branchId,
          deviceFingerprint: null,
        },
        body: { ...session, lands: landing.lands },
      };
    },

    /**
     * The POS half of the restaurant's one login page: username (or email) and
     * password, and this browser's fingerprint. The answer is a session narrowed
     * to the till's branch and device, as a PIN sign-in's is. A browser that is
     * not a till yet becomes one here, for whoever may make it one -- see
     * `registerTillAtSignIn`. This replaced /admin/till and its sign-back-in
     * route: one authentication flow, not two.
     */
    tillPassword: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ login?: unknown; password?: unknown; deviceFingerprint?: unknown; deviceName?: unknown }>(request);
      const login = str(input.login);
      const password = str(input.password);
      const fingerprint = str(input.deviceFingerprint);

      const resolved = await resolveTenantForAuth(context.client, slug(request));
      if ('refusal' in resolved) {
        return rejected(reply, {
          ...NO_SUBJECT, claimedSubject: login, deviceFingerprint: fingerprint, reason: resolved.refusal,
        });
      }
      if (!login || !password || !fingerprint) {
        return rejected(reply, {
          ...NO_SUBJECT, tenantId: resolved.tenant.tenantId, claimedSubject: login,
          deviceFingerprint: fingerprint, reason: 'credential_missing',
        });
      }

      const tenant = await adoptTenantContext(context.client, resolved.tenant.tenantId);
      // The password first: nothing about the browser is decided for someone
      // whose password has not been checked.
      const result = await authenticatePassword(tenant, { email: login, password });
      if (!result.ok) {
        return rejected(
          reply,
          {
            ...NO_SUBJECT, tenantId: tenant.tenantId, claimedSubject: login,
            deviceFingerprint: fingerprint, reason: result.reason,
          },
          result.retryAfterSeconds,
        );
      }

      // ###################################################################
      // A MANAGER SETS THE TILL UP; A MANAGER GETS NO POS SESSION HERE.
      //
      // Managers sign in on the Manager Login page only (2026-10-16). This
      // route is how a computer becomes the restaurant's till, and only a
      // manager may make one -- so a manager's credentials still register or
      // confirm the till, but the answer carries the device and NO tokens.
      // Staff then sign in on it by name and PIN. Staff credentials (the
      // username and password their Sales person set) still open a session on
      // a till that exists.
      // ###################################################################
      const manager = (await landingFor(tenant, result.userId)).lands === 'admin';
      // An existing till, or this browser made one (registerTillAtSignIn says who may).
      const found = await resolveDevice(tenant, fingerprint);
      let trust = 'trust' in found ? found.trust : null;
      if (trust === null) {
        const made = await registerTillAtSignIn(tenant, { userId: result.userId, fingerprint, deviceName: input.deviceName });
        if (!made.ok) {
          const status = made.refusal === 'device_limit' ? 402 : made.refusal === 'till_not_permitted' ? 403 : 422;
          reply.code(status);
          return {
            attempt: {
              ...NO_SUBJECT, tenantId: tenant.tenantId, claimedSubject: login, resolvedUserId: result.userId,
              deviceFingerprint: fingerprint, outcome: 'rejected', reason: made.refusal,
            },
            body: { error: made.refusal === 'device_limit' ? 'upgrade_required' : made.refusal, retryable: false },
          };
        }
        trust = made.trust;
      }

      const attempt = {
        outcome: 'success' as const, reason: null, tenantId: tenant.tenantId, claimedSubject: login,
        resolvedUserId: result.userId, branchId: trust.branchId, deviceFingerprint: fingerprint,
      };
      if (manager) {
        return { attempt, body: { tillOnly: true, deviceId: trust.deviceId, branchId: trust.branchId } };
      }
      const session = issueSession(
        { userId: result.userId, tenantId: tenant.tenantId, branchId: trust.branchId, deviceId: trust.deviceId },
        jwtKey,
      );
      return {
        attempt,
        body: { ...session, userId: result.userId, deviceId: trust.deviceId, branchId: trust.branchId },
      };
    },

    /**
     * The staff names a till shows, for the PIN keypad: tap your name, then the
     * PIN. Answered only to a till (its fingerprint); a browser that is not one
     * is told so, exactly as a PIN from it would be.
     */
    tillStaff: async (request, reply, context): Promise<PublicOutcome> => {
      const fingerprint = str(request.headers['x-device-fingerprint']);
      const resolved = await resolveTenantForAuth(context.client, slug(request));
      if ('refusal' in resolved) {
        reply.code(401);
        return { attempt: null, body: { error: 'tablet_not_set_up', retryable: false } };
      }
      const found = await readTillStaff(context.client, resolved.tenant.tenantId, fingerprint || null);
      if (!found.ok) {
        reply.code(401);
        return { attempt: null, body: { error: 'tablet_not_set_up', retryable: false } };
      }
      return { attempt: null, body: { staff: found.staff } };
    },

    /**
     * Identified PIN login at an enrolled terminal.
     *
     * The caller names the user because they tapped their own name on a list --
     * which is why no deterministic lookup column, HMAC or pepper exists anywhere
     * in the PIN design. `branchId` is sent as a CROSS-CHECK, not as a scope:
     * `authenticatePin` refuses it if the device is enrolled elsewhere.
     */
    pin: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{
        userId?: unknown;
        employeeCode?: unknown;
        pin?: unknown;
        deviceFingerprint?: unknown;
        branchId?: unknown;
      }>(request);
      const userId = str(input.userId);
      const employeeCode = str(input.employeeCode);
      const pin = str(input.pin);
      const fingerprint = str(input.deviceFingerprint);
      const branchId = str(input.branchId);
      // What was TYPED, recorded verbatim on the attempt row and never resolved
      // for the log: an investigation needs to see what somebody entered, not
      // what it turned out to mean.
      const subject = employeeCode || userId;

      const resolved = await resolveTenantForAuth(context.client, slug(request));
      if ('refusal' in resolved) {
        return rejected(reply, {
          ...NO_SUBJECT,
          claimedSubject: subject,
          deviceFingerprint: fingerprint,
          reason: resolved.refusal,
        });
      }
      if (!subject || !pin || !fingerprint) {
        return rejected(reply, {
          ...NO_SUBJECT,
          tenantId: resolved.tenant.tenantId,
          claimedSubject: subject,
          deviceFingerprint: fingerprint,
          reason: 'credential_missing',
        });
      }

      const tenant = await adoptTenantContext(context.client, resolved.tenant.tenantId);
      const result = await authenticatePin(tenant, {
        // Both present (a tapped name and a typed username): they must name the
        // same person, which `authenticatePin` checks.
        ...(employeeCode ? { employeeCode } : {}),
        ...(userId ? { userId } : employeeCode ? {} : { userId: '' }),
        pin,
        deviceFingerprint: fingerprint,
        ...(branchId ? { branchId } : {}),
      });

      if (!result.ok && (result.reason === 'device_unknown' || result.reason === 'device_revoked')) {
        // Said out loud, unlike every other PIN refusal. The tablet is checked
        // BEFORE the staff code or PIN is looked at, and on nothing but the
        // fingerprint the caller itself sent -- so this tells the tablet a fact
        // about itself and nothing about who works here. Folded into
        // `authentication_failed`, a tablet taken out of use kept its PIN screen
        // and refused every PIN as "not accepted", with no way back to setup.
        // Unknown and revoked stay one answer: the recovery is the same.
        reply.code(401);
        return {
          attempt: {
            ...NO_SUBJECT, tenantId: tenant.tenantId, claimedSubject: subject,
            deviceFingerprint: fingerprint, outcome: 'rejected', reason: result.reason,
          },
          body: { error: 'tablet_not_set_up', retryable: false },
        };
      }
      if (!result.ok && (result.reason === 'device_limit' || result.reason === 'till_not_permitted')) {
        // The PIN was right; the browser cannot become a till. Said out loud, as the
        // till route says it: the person's recovery is a manager freeing a till.
        const limit = result.reason === 'device_limit';
        reply.code(limit ? 402 : 403);
        return {
          attempt: {
            ...NO_SUBJECT, tenantId: tenant.tenantId, claimedSubject: subject,
            deviceFingerprint: fingerprint, outcome: 'rejected', reason: result.reason,
          },
          body: { error: limit ? 'upgrade_required' : 'till_not_permitted', retryable: false },
        };
      }
      if (!result.ok) {
        return rejected(
          reply,
          {
            ...NO_SUBJECT,
            tenantId: tenant.tenantId,
            claimedSubject: subject,
            deviceFingerprint: fingerprint,
            reason: result.reason,
          },
          result.retryAfterSeconds,
        );
      }

      // Branch and device come from the DEVICE ROW, via the domain function --
      // never from the request body, even though the body named a branch. The
      // body's copy was a cross-check; this one is the fact.
      const session = issueSession(
        {
          userId: result.userId,
          tenantId: tenant.tenantId,
          branchId: result.branchId,
          deviceId: result.deviceId,
        },
        jwtKey,
      );

      return {
        attempt: {
          outcome: 'success',
          reason: null,
          tenantId: tenant.tenantId,
          claimedSubject: subject,
          resolvedUserId: result.userId,
          branchId: result.branchId,
          deviceFingerprint: fingerprint,
        },
        // The RESOLVED user id travels with the session, because the client no
        // longer knows it: it sent a staff code. Returning it means the tablet
        // shows who is on shift from what the SERVER decided rather than from
        // what somebody typed -- which was always the better source and is now
        // the only one.
        // The till too: a browser that just became one learns which till it is.
        body: { ...session, userId: result.userId, deviceId: result.deviceId, branchId: result.branchId },
      };
    },

    /**
     * Exchange a refresh token for a new session.
     *
     * The ONLY route on this surface with no tenant slug, and that is the point:
     * its tenant comes from a token this process signed and has just verified, so
     * it stays on the original rule rather than needing the pre-auth exception.
     */
    /**
     * Control-plane sign-in.
     *
     * #####################################################################
     * NO TENANT SLUG, AND THAT IS THE WHOLE DIFFERENCE.
     *
     * Every other credential route in this file resolves a tenant first and
     * authenticates inside it. This one authenticates against
     * `platform.platform_user`, which has no tenant and must not acquire one:
     * a control-plane session scoped to a tenant would be a support engineer
     * silently confined to one customer, and the impersonation routes exist
     * precisely so that entering a tenant is a separate, audited act.
     *
     * So the connection stays bare -- `adoptTenantContext` is NOT called, and
     * `app.current_tenant_id()` is never set. The platform tables carry no RLS,
     * which is what makes that safe and is also why the read below is spelled
     * out rather than going through a repository that assumes a tenant.
     * #####################################################################
     */
    /**
     * A platform user changing their own password. Public, like login, because
     * it IS a login: the current password is verified with the same lockout.
     * On the control plane it would be a mutation `read_only` could reach,
     * which that plane refuses by construction -- and rightly, since this
     * changes a credential, not the control plane's business data.
     */
    platformPassword: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ email?: unknown; currentPassword?: unknown; newPassword?: unknown }>(request);
      const email = str(input.email);
      const current = str(input.currentPassword);
      const next = str(input.newPassword);
      if (next === null || next.length < PLATFORM_PASSWORD_MIN_LENGTH || next.length > 200) {
        reply.code(400);
        return {
          attempt: { ...NO_SUBJECT, claimedSubject: email, outcome: 'rejected', reason: 'password_policy' },
          body: {
            error: 'password_policy', retryable: false,
            detail: `the new password must be at least ${PLATFORM_PASSWORD_MIN_LENGTH} characters`,
          },
        };
      }
      if (!email || !current) {
        return rejected(reply, { ...NO_SUBJECT, claimedSubject: email, reason: 'credential_missing' });
      }
      const result = await changePlatformPassword(context.client, {
        email, currentPassword: current, newPassword: next,
      });
      if (!result.ok) {
        return rejected(reply, { ...NO_SUBJECT, claimedSubject: email, reason: result.reason },
          result.retryAfterSeconds);
      }
      return {
        attempt: {
          outcome: 'success', reason: null, tenantId: null, claimedSubject: email,
          resolvedUserId: null, platformUserId: result.platformUserId,
          branchId: null, deviceFingerprint: null,
        },
        body: { changed: true },
      };
    },

    platformLogin: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ email?: unknown; password?: unknown }>(request);
      const email = str(input.email);
      const password = str(input.password);

      if (!email || !password) {
        return rejected(reply, {
          ...NO_SUBJECT,
          claimedSubject: email,
          reason: 'credential_missing',
        });
      }

      const result = await authenticatePlatformUser(context.client, { email, password });

      if (!result.ok) {
        return rejected(
          reply,
          { ...NO_SUBJECT, claimedSubject: email, reason: result.reason },
          result.retryAfterSeconds,
        );
      }

      const session = issuePlatformSession(
        { platformUserId: result.platformUserId, roleKey: result.roleKey },
        jwtKey,
      );

      return {
        attempt: {
          outcome: 'success',
          reason: null,
          // No tenant and no resolved app user: `auth_attempt_one_plane` refuses
          // a row that names both, and the subject goes in its own column.
          tenantId: null,
          claimedSubject: email,
          resolvedUserId: null,
          platformUserId: result.platformUserId,
          branchId: null,
          deviceFingerprint: null,
        },
        body: { ...session, role: result.roleKey },
      };
    },

    /**
     * Control-plane refresh.
     *
     * The role is RE-READ rather than carried over from the token, so revoking a
     * platform role or suspending an account takes effect within the
     * fifteen-minute access window instead of at the end of the twelve-hour
     * refresh window. `deviceStillTrusted` makes the same argument on the tenant
     * side, for the same reason.
     */
    platformRefresh: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ refreshToken?: unknown }>(request);
      const read = readPlatformRefreshClaims(input.refreshToken, jwtKey);
      if ('refusal' in read) {
        return rejected(reply, { ...NO_SUBJECT, reason: read.refusal });
      }

      const still = await platformUserStillActive(context.client, read.subject.platformUserId);
      if (!still.ok) {
        return rejected(reply, {
          ...NO_SUBJECT,
          claimedSubject: read.subject.platformUserId,
          reason: still.reason,
        });
      }

      const session = issuePlatformSession(
        { platformUserId: read.subject.platformUserId, roleKey: still.roleKey },
        jwtKey,
      );

      return {
        attempt: {
          outcome: 'success',
          reason: null,
          tenantId: null,
          claimedSubject: read.subject.platformUserId,
          resolvedUserId: null,
          platformUserId: read.subject.platformUserId,
          branchId: null,
          deviceFingerprint: null,
        },
        body: { ...session, role: still.roleKey },
      };
    },

    /**
     * A Restaurant Manager setting their own password from a setup link.
     *
     * The password policy is answered specifically (400) and BEFORE the token
     * is looked at, so the specific answer says nothing about the token. Every
     * token problem -- unknown, used, expired, restaurant switched off -- is the
     * same uniform 401 as a failed login; the attempt log keeps which it was.
     */
    acceptInvite: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ token?: unknown; password?: unknown }>(request);
      const token = str(input.token);
      const problem = ownerPasswordProblem(input.password);
      if (problem !== null) {
        reply.code(400);
        return {
          attempt: { ...NO_SUBJECT, outcome: 'rejected', reason: 'password_policy' },
          body: { error: 'password_policy', retryable: false, detail: problem },
        };
      }
      if (token === null) {
        return rejected(reply, { ...NO_SUBJECT, reason: 'invite_invalid' });
      }

      const result = await acceptOwnerInvite(context.client, {
        token, password: input.password as string,
      });
      if (!result.ok) {
        return rejected(reply, { ...NO_SUBJECT, tenantId: result.tenantId, reason: result.reason });
      }
      return {
        attempt: {
          outcome: 'success',
          reason: null,
          tenantId: result.tenantId,
          claimedSubject: result.email,
          resolvedUserId: result.userId,
          branchId: null,
          deviceFingerprint: null,
        },
        // Where to sign in next. Both are already known to whoever holds the
        // link: the restaurant is theirs and the address is the one invited.
        body: { tenantSlug: result.tenantSlug, email: result.email },
      };
    },

    refresh: async (request, reply, context): Promise<PublicOutcome> => {
      const input = body<{ refreshToken?: unknown }>(request);
      const read = readRefreshClaims(input.refreshToken, jwtKey);
      if ('refusal' in read) {
        return rejected(reply, { ...NO_SUBJECT, reason: read.refusal });
      }

      const subject = read.subject;
      const tenant = await adoptTenantContext(context.client, subject.tenantId);

      if (!(await deviceStillTrusted(tenant.client, tenant.tenantId, subject.deviceId))) {
        return rejected(reply, {
          ...NO_SUBJECT,
          tenantId: subject.tenantId,
          claimedSubject: subject.userId,
          resolvedUserId: subject.userId,
          branchId: subject.branchId,
          reason: 'device_revoked',
        });
      }

      // ###################################################################
      // THE RESTAURANT IS RE-READ TOO, NOT ONLY THE DEVICE.
      //
      // Login refuses a tenant outside AUTHENTICABLE_TENANT_STATUSES; refresh
      // did not look, so a restaurant that was deactivated -- or reached
      // hard_lock -- kept every signed-in tablet working for the rest of the
      // twelve-hour refresh window. Same allowlist as login, so there is one
      // ruling on which statuses may hold a session, not two.
      // ###################################################################
      if (!(await tenantStillAuthenticable(tenant.client, subject.tenantId))) {
        return rejected(reply, {
          ...NO_SUBJECT,
          tenantId: subject.tenantId,
          claimedSubject: subject.userId,
          resolvedUserId: subject.userId,
          branchId: subject.branchId,
          reason: 'tenant_login_blocked',
        });
      }

      // A till session is staff's. A manager holding one from before 2026-10-16
      // is not renewed: they sign in on the Manager Login page, which issues no
      // device. Checked here because an access token is not re-read per request.
      if (subject.deviceId !== null && (await landingFor(tenant, subject.userId)).lands === 'admin') {
        return rejected(reply, {
          ...NO_SUBJECT,
          tenantId: subject.tenantId,
          claimedSubject: subject.userId,
          resolvedUserId: subject.userId,
          branchId: subject.branchId,
          reason: 'manager_use_login',
        });
      }

      // Sliding, not rotating: a new refresh token every time, with no server-side
      // record of the old one. The residual risk is recorded in CLAUDE.md -- a
      // stolen refresh token stays usable until the device is revoked or twelve
      // hours pass, and a rotation table is the fix if that becomes unacceptable.
      const session = issueSession(subject, jwtKey);

      return {
        attempt: {
          outcome: 'success',
          reason: null,
          tenantId: subject.tenantId,
          claimedSubject: subject.userId,
          resolvedUserId: subject.userId,
          branchId: subject.branchId,
          deviceFingerprint: null,
        },
        body: session,
      };
    },

    restaurantBySlug: async (request, _reply, context): Promise<PublicOutcome> => ({
      attempt: null,
      body: await publicRestaurantBySlug(context.client, slug(request), AUTHENTICABLE_TENANT_STATUSES),
    }),

    restaurantLogo: async (request, reply, context): Promise<PublicOutcome> => {
      const logo = await publicRestaurantLogo(context.client, slug(request));
      void reply
        .header('content-type', logo.contentType)
        .header('cache-control', 'public, max-age=86400')
        .header('etag', logo.etag)
        .header('x-content-type-options', 'nosniff');
      return { attempt: null, body: logo.bytes };
    },

    // Re-checked on every launch check (no-cache), so a renamed restaurant or a new
    // logo reaches installed apps; the body is already JSON for its own media type.
    posAppManifest: async (request, reply, context): Promise<PublicOutcome> => {
      const manifest = await posAppManifest(context.client, slug(request), AUTHENTICABLE_TENANT_STATUSES);
      void reply
        .header('content-type', 'application/manifest+json; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff');
      return { attempt: null, body: JSON.stringify(manifest) };
    },

    healthz: async (): Promise<PublicOutcome> => ({
      attempt: null,
      body: { status: 'ok' },
    }),
  };
}

