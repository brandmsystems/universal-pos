import type pg from 'pg';
import { TokenError, signToken, verifyToken, type Claims } from './jwt.js';

/**
 * Token issuance.
 *
 * The verifier and the plane guards were built in Phase 0 and are unchanged;
 * this is the other half, and it is the first code in the system that mints a
 * token rather than checking one.
 */

/**
 * ###########################################################################
 * TWO LIFETIMES, AND THE SHORT ONE IS WHAT MAKES REVOCATION MEAN ANYTHING.
 *
 * The access token carries no revocation check -- that is the whole point of a
 * signed token, and adding a per-request lookup would undo it. So the window in
 * which a revoked device still works is exactly the access-token lifetime, and
 * 15 minutes is the number that window is worth.
 *
 * The refresh token is 12 hours: about one shift. A tablet re-authenticates when
 * the shift changes, which is when a human is standing at it anyway, and a PIN
 * takes four keystrokes.
 *
 * Refresh RE-CHECKS THE DEVICE, so revocation bites within 15 minutes rather
 * than 12 hours. `revokeDevice` exists because a revoked terminal is one that was
 * probably stolen; a refresh path that did not look would make that function
 * decorative for half a day.
 * ###########################################################################
 */
export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_SECONDS = 12 * 60 * 60;

/**
 * ###########################################################################
 * A REFRESH TOKEN IS NOT AN ACCESS TOKEN, AND THE TYPE CLAIM SAYS SO.
 *
 * Both are HS256 under the same key, so without a discriminator a refresh token
 * would sail through `planeGuard` as a 12-hour access token -- a long-lived
 * bearer credential handed out on purpose and accepted everywhere by accident.
 *
 * `typ: 'refresh'` is asserted present on refresh and asserted ABSENT on access,
 * both directions, so neither can be used as the other.
 * ###########################################################################
 */
const REFRESH_TYP = 'refresh';

export interface IssuedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly refreshExpiresIn: number;
}

export interface SessionSubject {
  readonly userId: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  /** Present for a PIN session at an enrolled terminal; absent for the web admin. */
  readonly deviceId: string | null;
}

export function issueSession(
  subject: SessionSubject,
  key: string,
  now: number = Date.now(),
): IssuedSession {
  const iat = Math.floor(now / 1000);

  const access: Claims = {
    sub: subject.userId,
    tenant_id: subject.tenantId,
    branch_id: subject.branchId,
    // Which tablet this sign-in is on, for the header badge. Not a credential and
    // not secret (it is in audit rows); authority never reads it from here.
    device_id: subject.deviceId,
    iat,
    exp: iat + ACCESS_TOKEN_SECONDS,
  };

  const refresh: Claims = {
    sub: subject.userId,
    tenant_id: subject.tenantId,
    branch_id: subject.branchId,
    device_id: subject.deviceId,
    typ: REFRESH_TYP,
    iat,
    exp: iat + REFRESH_TOKEN_SECONDS,
  };

  return {
    accessToken: signToken(access, key),
    refreshToken: signToken(refresh, key),
    expiresIn: ACCESS_TOKEN_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_SECONDS,
  };
}

/**
 * A control-plane session.
 *
 * ###########################################################################
 * NO `tenant_id`, AND THAT ABSENCE IS LOAD-BEARING.
 *
 * `planeGuard` routes a token by what it carries: a tenant token names a tenant,
 * a platform token names a platform role. A platform token that also carried a
 * tenant id would be a credential for both planes at once, which is the one
 * thing the two-plane split exists to prevent.
 *
 * `platform_role` is in the token because `platformRoleHolds` resolves the key
 * set from a constant rather than a query -- see `src/middleware/security/platformAuthz.ts`.
 * The role is re-read from the database at every refresh, so a revoked role dies
 * within the access-token window rather than at the end of the refresh window.
 * ###########################################################################
 */
export interface PlatformSessionSubject {
  readonly platformUserId: string;
  readonly roleKey: string;
}

export function issuePlatformSession(
  subject: PlatformSessionSubject,
  key: string,
  now: number = Date.now(),
): IssuedSession {
  const iat = Math.floor(now / 1000);

  const access: Claims = {
    sub: subject.platformUserId,
    platform_role: subject.roleKey,
    iat,
    exp: iat + ACCESS_TOKEN_SECONDS,
  };

  const refresh: Claims = {
    sub: subject.platformUserId,
    platform_role: subject.roleKey,
    typ: REFRESH_TYP,
    iat,
    exp: iat + REFRESH_TOKEN_SECONDS,
  };

  return {
    accessToken: signToken(access, key),
    refreshToken: signToken(refresh, key),
    expiresIn: ACCESS_TOKEN_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_SECONDS,
  };
}

/**
 * Reads a PLATFORM refresh token. Pure, like `readRefreshClaims`.
 *
 * It refuses a token carrying a `tenant_id` rather than ignoring the field. A
 * tenant refresh token presented here would otherwise mint a control-plane
 * session for whatever `platform_role` an attacker could get into a tenant
 * token -- and `readRefreshClaims` refuses THIS token for the mirror-image
 * reason, so neither route accepts the other's credential.
 */
export function readPlatformRefreshClaims(
  token: unknown,
  key: string,
): { subject: PlatformSessionSubject } | { refusal: RefreshRejection } {
  if (typeof token !== 'string' || token.length === 0) {
    return { refusal: 'refresh_malformed' };
  }

  let claims: Claims;
  try {
    claims = verifyToken(token, key);
  } catch (error) {
    if (error instanceof TokenError) {
      if (error.code === 'expired') return { refusal: 'refresh_expired' };
      if (error.code === 'bad_signature') return { refusal: 'refresh_bad_signature' };
      return { refusal: 'refresh_malformed' };
    }
    throw error;
  }

  if (claims['typ'] !== REFRESH_TYP) return { refusal: 'refresh_not_a_refresh_token' };
  if (claims['tenant_id'] !== undefined && claims['tenant_id'] !== null) {
    return { refusal: 'refresh_malformed' };
  }

  const platformUserId = claims['sub'];
  const roleKey = claims['platform_role'];
  if (typeof platformUserId !== 'string' || typeof roleKey !== 'string') {
    return { refusal: 'refresh_malformed' };
  }

  return { subject: { platformUserId, roleKey } };
}

export type RefreshRejection =
  | 'refresh_malformed'
  | 'refresh_not_a_refresh_token'
  | 'refresh_expired'
  | 'refresh_bad_signature'
  | 'device_revoked';

export type RefreshSubject = SessionSubject;

/**
 * Reads a refresh token. Pure: signature, expiry, type and shape, nothing else.
 *
 * ###########################################################################
 * SPLIT FROM THE DEVICE CHECK, BECAUSE THE TENANT COMES OUT OF THIS STEP.
 *
 * The device check reads `app.device`, which is under RLS and needs the tenant
 * GUC set -- and the tenant is inside the token being read here. One function
 * doing both would have to set the GUC from a claim it had not finished
 * validating, on a connection the caller believed had no tenant on it.
 *
 * So: read the token, adopt the tenant it names, then check the device. Three
 * steps in that order, visible in the handler.
 * ###########################################################################
 */
export function readRefreshClaims(
  token: unknown,
  key: string,
): { subject: RefreshSubject } | { refusal: RefreshRejection } {
  if (typeof token !== 'string' || token.length === 0) {
    return { refusal: 'refresh_malformed' };
  }

  let claims: Claims;
  try {
    claims = verifyToken(token, key);
  } catch (error) {
    if (error instanceof TokenError) {
      if (error.code === 'expired') return { refusal: 'refresh_expired' };
      if (error.code === 'bad_signature') return { refusal: 'refresh_bad_signature' };
      return { refusal: 'refresh_malformed' };
    }
    throw error;
  }

  if (claims['typ'] !== REFRESH_TYP) return { refusal: 'refresh_not_a_refresh_token' };

  const userId = claims['sub'];
  const tenantId = claims['tenant_id'];
  if (typeof userId !== 'string' || typeof tenantId !== 'string') {
    return { refusal: 'refresh_malformed' };
  }
  const branchId = typeof claims['branch_id'] === 'string' ? claims['branch_id'] : null;
  const deviceId = typeof claims['device_id'] === 'string' ? claims['device_id'] : null;

  return { subject: { userId, tenantId, branchId, deviceId } };
}

/**
 * The device re-check, on a connection whose tenant GUC is already set.
 *
 * A query rather than a claim, deliberately: the claim is what the token
 * asserted up to twelve hours ago, and `app.device.status` is what is true now.
 * Without this, `revokeDevice` would be decorative for half a day.
 *
 * A session with no device (the web admin) has nothing to re-check and passes.
 */
export async function deviceStillTrusted(
  client: pg.ClientBase,
  tenantId: string,
  deviceId: string | null,
): Promise<boolean> {
  if (deviceId === null) return true;
  const device = await client.query<{ status: string }>(
    `SELECT status FROM app.device WHERE tenant_id = $1 AND id = $2`,
    [tenantId, deviceId],
  );
  return device.rows[0]?.status === 'active';
}

