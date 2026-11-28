import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { TenantContext } from '../../database/tenantContext.js';
import { lockoutSeconds } from './deviceAuth.js';

/**
 * Password authentication, for the web admin.
 *
 * Deliberately NOT device-bound, unlike a PIN: a four-digit secret is defensible
 * only because reaching it needs physical possession of an enrolled terminal,
 * and the admin is used from anywhere. Everything else -- the argon2 parameters,
 * the lockout curve, where the counter lives -- is shared with the PIN path
 * rather than re-decided here.
 *
 * ###########################################################################
 * THIS EXISTS BECAUSE NOTHING ELSE CAN BOOTSTRAP A TABLET.
 *
 * It looked like Phase 10's problem -- the admin UI is Phase 10 -- until the
 * chain was followed backwards: a till is registered by a signed-in person
 * (`registerTillAtSignIn` records who), so a human must be authenticated
 * before a POS exists at all. Since 0077 that person is the manager, with this
 * password, on the computer that becomes the till.
 * ###########################################################################
 */

/** Same parameters as the PIN path. Two sets of argon2 costs is two things to tune. */
const ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/**
 * ###########################################################################
 * ONE REJECTION FOR "NO SUCH EMAIL" AND "WRONG PASSWORD", AND IT IS NOT LAZINESS.
 *
 * `app_user.email` is per-tenant citext, so an address can exist in one tenant
 * and not another. A distinguishable "unknown email" answer turns
 * `/api/auth/<slug>/login` into a membership oracle: anyone could enumerate who
 * works at a named restaurant, one address at a time.
 *
 * So the reason is uniform AND the work is uniform -- an unknown email still
 * pays for one argon2 verification against a decoy hash, or the timing answers
 * the question the status code refused to.
 *
 * `credential_locked` is deliberately NOT folded in: a caller who is locked out
 * needs to be told to wait, and it leaks only about an account whose password
 * the caller has already been getting wrong.
 * ###########################################################################
 */
export type PasswordRejection =
  | 'credential_invalid'
  | 'credential_locked'
  | 'user_inactive';

export type PasswordResult =
  | { readonly ok: true; readonly userId: string; readonly credentialId: string }
  | {
      readonly ok: false;
      readonly reason: PasswordRejection;
      readonly retryAfterSeconds?: number;
    };

/**
 * A hash of nothing anyone knows, computed once per process.
 *
 * Verifying against it costs what a real verification costs, which is the point:
 * returning early on an unknown email would make the response measurably faster
 * and reintroduce the oracle the uniform reason exists to close.
 */
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoy ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2);
  return decoy;
}

export interface PasswordAttempt {
  /**
   * As typed: an email, or a username (the staff code) -- told apart by the
   * "@", which a staff code (`STAFF_CODE`, letters and digits) can never hold.
   * Resolution is this function's job, not the caller's.
   */
  readonly email: string;
  readonly password: string;
}

export async function authenticatePassword(
  context: TenantContext,
  attempt: PasswordAttempt,
): Promise<PasswordResult> {
  const user = await context.client.query<{ id: string; status: string }>(
    `SELECT id, status FROM app.app_user
      WHERE tenant_id = $1
        AND CASE WHEN strpos($2, '@') > 0 THEN email = $2 ELSE employee_code = upper($2) END`,
    [context.tenantId, attempt.email.trim()],
  );

  const found = user.rows[0];
  if (!found) {
    await argon2.verify(await decoyHash(), attempt.password).catch(() => false);
    return { ok: false, reason: 'credential_invalid' };
  }
  // Distinguishable on purpose: an inactive account is a state the person's own
  // manager set, and telling them "ask your manager" beats a silent wrong-password
  // loop. It reveals nothing an ex-colleague does not already know.
  if (found.status !== 'active') return { ok: false, reason: 'user_inactive' };

  const credential = await context.client.query<{
    id: string;
    secret_hash: string;
    failed_attempt_count: number;
    locked_until: Date | null;
  }>(
    `SELECT id, secret_hash, failed_attempt_count, locked_until
       FROM app.credential
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'password' AND status = 'active'`,
    [context.tenantId, found.id],
  );

  const row = credential.rows[0];
  if (!row) {
    // A PIN-only waiter has no password credential. Same answer as a wrong
    // password: which staff have admin access is not a question this route
    // should answer.
    await argon2.verify(await decoyHash(), attempt.password).catch(() => false);
    return { ok: false, reason: 'credential_invalid' };
  }

  if (row.locked_until && row.locked_until > new Date()) {
    return {
      ok: false,
      reason: 'credential_locked',
      retryAfterSeconds: Math.ceil((row.locked_until.getTime() - Date.now()) / 1000),
    };
  }

  const verified = await argon2.verify(row.secret_hash, attempt.password);
  if (!verified) {
    const attempts = row.failed_attempt_count + 1;
    const seconds = lockoutSeconds(attempts);
    await context.client.query(
      `UPDATE app.credential
          SET failed_attempt_count = $3,
              locked_until = CASE WHEN $4::int > 0 THEN now() + make_interval(secs => $4::int) END
        WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, row.id, attempts, seconds],
    );
    return {
      ok: false,
      reason: 'credential_invalid',
      ...(seconds > 0 ? { retryAfterSeconds: seconds } : {}),
    };
  }

  await context.client.query(
    `UPDATE app.credential
        SET failed_attempt_count = 0, locked_until = NULL, last_used_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, row.id],
  );

  return { ok: true, userId: found.id, credentialId: row.id };
}
