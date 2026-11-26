import argon2 from 'argon2';
import type pg from 'pg';
import { lockoutSeconds } from './deviceAuth.js';

/**
 * Password authentication for the CONTROL PLANE.
 *
 * ###########################################################################
 * A SEPARATE FILE FROM `passwordAuth.ts`, AND THE SEPARATION IS THE POINT.
 *
 * The two look alike and must not be merged. `authenticatePassword` runs inside
 * a TenantContext and reads `app.credential` under RLS; this one runs on a bare
 * connection with no tenant GUC and reads `platform.platform_user`, whose
 * lockout state lives on the user row rather than in a credential table. A
 * single function taking "which table" as an argument would be one function
 * holding both planes' rules, which is the boundary this product enforces
 * everywhere else.
 *
 * What IS shared is shared deliberately and by import, not by copy: the argon2
 * verification and `lockoutSeconds`. The lockout curve is a security decision,
 * and two curves that drift apart is how one plane quietly becomes easier to
 * brute-force than the other.
 * ###########################################################################
 */

const ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/**
 * The one place this plane's password hash is minted, so `createPlatformUser`
 * and this file's own decoy hash cannot drift apart on parameters.
 */
export async function hashPlatformPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2);
}

export type PlatformAuthRejection =
  | 'credential_missing'
  | 'credential_invalid'
  | 'user_inactive'
  | 'credential_locked';

export type PlatformAuthResult =
  | { readonly ok: true; readonly platformUserId: string; readonly roleKey: string }
  | {
      readonly ok: false;
      readonly reason: PlatformAuthRejection;
      readonly retryAfterSeconds?: number;
    };

/**
 * A hash to verify against when no user matched, so a wrong email and a wrong
 * password cost the same wall-clock time.
 *
 * Without it the two are separable by a stopwatch: argon2 at these parameters
 * takes tens of milliseconds and a missing row returns in one. That turns this
 * route into an oracle for "which addresses are platform staff" -- a list worth
 * having if you intend to phish one of them, and a list this route has no reason
 * to answer.
 */
let decoy: string | null = null;
async function decoyHash(): Promise<string> {
  decoy ??= await hashPlatformPassword('platform-decoy-never-matches');
  return decoy;
}

export interface PlatformAttempt {
  readonly email: string;
  readonly password: string;
}

export async function authenticatePlatformUser(
  client: pg.ClientBase,
  attempt: PlatformAttempt,
): Promise<PlatformAuthResult> {
  const found = await client.query<{
    id: string;
    status: string;
    password_hash: string;
    failed_login_count: number;
    locked_until: Date | null;
    role_key: string;
  }>(
    `SELECT u.id, u.status, u.password_hash, u.failed_login_count, u.locked_until,
            r.key AS role_key
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
      WHERE u.email = $1`,
    [attempt.email],
  );

  const user = found.rows[0];
  if (!user) {
    await argon2.verify(await decoyHash(), attempt.password).catch(() => false);
    return { ok: false, reason: 'credential_invalid' };
  }

  // Distinguishable on purpose, on the same argument as the tenant path: a
  // suspended control-plane account is a state another administrator set, and
  // "ask whoever suspended you" beats a silent wrong-password loop. It reveals
  // nothing to someone who did not already hold the account.
  if (user.status !== 'active') return { ok: false, reason: 'user_inactive' };

  if (user.locked_until && user.locked_until > new Date()) {
    return {
      ok: false,
      reason: 'credential_locked',
      retryAfterSeconds: Math.ceil((user.locked_until.getTime() - Date.now()) / 1000),
    };
  }

  const verified = await argon2.verify(user.password_hash, attempt.password).catch(() => false);
  if (!verified) {
    const attempts = user.failed_login_count + 1;
    const seconds = lockoutSeconds(attempts);
    await client.query(
      `UPDATE platform.platform_user
          SET failed_login_count = $2,
              locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(secs => $3::int) END,
              updated_at = now()
        WHERE id = $1`,
      [user.id, attempts, seconds],
    );
    return {
      ok: false,
      reason: 'credential_invalid',
      ...(seconds > 0 ? { retryAfterSeconds: seconds } : {}),
    };
  }

  await client.query(
    `UPDATE platform.platform_user
        SET failed_login_count = 0, locked_until = NULL, last_login_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [user.id],
  );

  return { ok: true, platformUserId: user.id, roleKey: user.role_key };
}

/**
 * Re-read a platform user at refresh time.
 *
 * ###########################################################################
 * THE ROLE IS A QUERY, NOT A CLAIM -- THE SAME ARGUMENT AS `deviceStillTrusted`.
 *
 * The refresh token asserts a role the user held up to twelve hours ago.
 * Trusting it means revoking a Super Admin's authority takes effect twelve hours
 * later, and suspending an account leaves it working for the rest of the day.
 * Re-reading costs one indexed lookup and makes both take effect within the
 * fifteen-minute access-token window.
 * ###########################################################################
 */
export async function platformUserStillActive(
  client: pg.ClientBase,
  platformUserId: string,
): Promise<{ readonly ok: true; readonly roleKey: string }
  | { readonly ok: false; readonly reason: PlatformAuthRejection }> {
  const found = await client.query<{ status: string; role_key: string }>(
    `SELECT u.status, r.key AS role_key
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
      WHERE u.id = $1`,
    [platformUserId],
  );
  const user = found.rows[0];
  if (!user) return { ok: false, reason: 'credential_invalid' };
  if (user.status !== 'active') return { ok: false, reason: 'user_inactive' };
  return { ok: true, roleKey: user.role_key };
}

/* ------------------------------------------------------ change own password --- */

export const PLATFORM_PASSWORD_MIN_LENGTH = 12;

/**
 * A platform user replacing their own password.
 *
 * It is a LOGIN first: the current password is verified through
 * `authenticatePlatformUser`, so the same lockout curve and failure counter
 * apply -- a stolen session cannot be used to walk the current password, and
 * cannot change it without knowing it. Only then is the new hash written.
 * The new password's length is checked before any of that, so a too-short
 * answer says nothing about whether the current password was right.
 */
export async function changePlatformPassword(
  client: pg.ClientBase,
  input: { email: string; currentPassword: string; newPassword: string },
): Promise<PlatformAuthResult> {
  const verified = await authenticatePlatformUser(client, {
    email: input.email, password: input.currentPassword,
  });
  if (!verified.ok) return verified;
  await client.query(
    `UPDATE platform.platform_user
        SET password_hash = $2, password_changed_at = now(), updated_at = now()
      WHERE id = $1`,
    [verified.platformUserId, await hashPlatformPassword(input.newPassword)]);
  return verified;
}
