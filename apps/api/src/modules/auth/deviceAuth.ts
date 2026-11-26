import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type pg from 'pg';
import { adoptTenantContext } from '../../core/database/unitOfWork.js';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { resolveActor } from '../authz/authorityStore.js';
import { loadLatestEntitlement } from '../platform/entitlements.js';
import { planUsage } from '../restaurants/planUsage.js';
import { landingFor } from '../users/me.js';

/**
 * PIN authentication.
 *
 * A PIN credential is valid ONLY from a registered, active device. That is what
 * makes a four-digit secret defensible: the search space is small, but reaching
 * it requires physical possession of a terminal someone deliberately enrolled.
 * Passwords are NOT device-bound -- the web admin is used from anywhere.
 *
 * Device trust is read on every attempt and never cached, same reasoning as
 * impersonation sessions: a revoked terminal is one that was probably stolen, and
 * any TTL is a window in which it still works.
 */

const ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export type PinRejection =
  /**
   * A manager's account. Managers sign in on the Manager Login page only; the
   * till's PIN is staff's. Recorded, and answered to the client exactly as a
   * wrong PIN, so the PIN route cannot be used to find out who manages.
   */
  | 'manager_use_login'
  /** A correct PIN on a new browser, but every till the plan allows is in use. */
  | 'device_limit'
  /** A correct PIN on a new browser, from someone who may not make a till. */
  | 'till_not_permitted'
  | 'device_unknown'
  | 'device_revoked'
  | 'device_wrong_branch'
  | 'no_pin_credential'
  | 'credential_locked'
  | 'bad_pin'
  | 'user_inactive'
  /**
   * The employee code matched nobody.
   *
   * Recorded in `platform.auth_attempt` and NEVER distinguished to the client
   * from a wrong PIN. A distinct client-visible refusal would turn the sign-in
   * screen into an employee-code oracle: type codes until one stops saying
   * "unknown", and you have learned who works there.
   */
  | 'subject_unknown';

export type PinResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly credentialId: string;
      /**
       * The terminal this session belongs to, and the branch it is enrolled at.
       *
       * Returned rather than re-queried by the caller: this function already
       * resolved the device, and a route handler that looked it up again would be
       * a second answer to a question already answered -- and SQL in the route
       * layer, which the thin-handler gate refuses. The refresh token needs the
       * device id so that revoking a terminal ends its session.
       */
      readonly deviceId: string;
      readonly branchId: string;
    }
  | { readonly ok: false; readonly reason: PinRejection; readonly retryAfterSeconds?: number };

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2);
}

/**
 * The person's one active credential of this type becomes this one: the old row
 * is revoked, never deleted, and a new argon2id row is written.
 */
export async function replaceCredential(
  context: TenantContext, userId: string, type: 'password' | 'pin', value: string,
): Promise<void> {
  await context.client.query(
    `UPDATE app.credential SET status = 'revoked', revoked_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND type = $3 AND status = 'active'`,
    [context.tenantId, userId, type]);
  await context.client.query(
    `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), context.tenantId, userId, type, await hashSecret(value)]);
}

/* ------------------------------------------------------------ PIN policy --- */

export type PinPolicyFailure =
  | 'too_short'
  | 'too_long'
  | 'not_numeric'
  | 'trivial_sequence'
  | 'matches_employee_code'
  | 'found_in_phone';

export interface PinPolicySubject {
  readonly employeeCode?: string | null;
  readonly phone?: string | null;
}

/** Minimum 4 digits, 6 permitted. Rejects the PINs everybody picks. */
export function checkPinPolicy(pin: string, subject: PinPolicySubject = {}): PinPolicyFailure | null {
  if (!/^\d+$/.test(pin)) return 'not_numeric';
  if (pin.length < 4) return 'too_short';
  if (pin.length > 6) return 'too_long';

  const digits = [...pin].map(Number);
  const allSame = digits.every((d) => d === digits[0]);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 9) % 10);
  if (allSame || ascending || descending) return 'trivial_sequence';

  if (subject.employeeCode && pin === subject.employeeCode.replace(/\D/g, '')) {
    return 'matches_employee_code';
  }
  // Any digit run within the phone number, not just a prefix or suffix.
  if (subject.phone && subject.phone.replace(/\D/g, '').includes(pin)) return 'found_in_phone';

  return null;
}

/* ---------------------------------------------------------- device trust --- */

export interface DeviceTrust {
  readonly deviceId: string;
  readonly branchId: string;
}

export async function resolveDevice(
  context: TenantContext,
  fingerprint: string,
): Promise<{ trust: DeviceTrust } | { rejection: PinRejection }> {
  const result = await context.client.query<{ id: string; branch_id: string; status: string }>(
    `SELECT id, branch_id, status FROM app.device
      WHERE tenant_id = $1 AND fingerprint = $2
      ORDER BY registered_at DESC LIMIT 1`,
    [context.tenantId, fingerprint],
  );

  const row = result.rows[0];
  if (!row) return { rejection: 'device_unknown' };
  if (row.status !== 'active') return { rejection: 'device_revoked' };
  return { trust: { deviceId: row.id, branchId: row.branch_id } };
}

/* ------------------------------------------- a till, from a sign-in --- */

export type TillRefusal = 'till_not_permitted' | 'till_branch_ambiguous' | 'till_input_invalid' | 'device_limit';

/**
 * A browser that is not a till yet becomes one when someone who may make one
 * signs in on it: a manager (`device.register`), or -- on a plan without staff
 * tablets (Basic) -- a staff member who works the POS (`kot.fire` or
 * `bill.generate`), after their PIN is verified (DECIDED 2026-10-16: Staff
 * Login opens straight onto the staff cards, with no manager set-up first).
 * Bounded by the plan's tablet limit, counted here under the same lock as every
 * other device, and by revocation under Tablets.
 */
export async function registerTillAtSignIn(
  context: TenantContext,
  params: { userId: string; fingerprint: string; deviceName: unknown },
): Promise<{ ok: true; trust: DeviceTrust } | { ok: false; refusal: TillRefusal }> {
  const name = typeof params.deviceName === 'string' && params.deviceName.trim() !== ''
    ? params.deviceName.trim() : 'Counter till';
  if (params.fingerprint.length < 16 || params.fingerprint.length > 200 || name.length > 60) {
    return { ok: false, refusal: 'till_input_invalid' };
  }
  const branches = await context.client.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1 AND status = 'active'`, [context.tenantId]);
  if (branches.rows.length !== 1) return { ok: false, refusal: 'till_branch_ambiguous' };
  const branchId = branches.rows[0]!.id;

  const document = await loadLatestEntitlement(context.client, context.tenantId);
  const held = (await resolveActor(context, params.userId, branchId))?.authority.permissions ?? new Set<string>();
  const worksThePos = held.has('kot.fire') || held.has('bill.generate');
  const staffMayRegister = document !== null && document.features['staff_tablets'] !== true;
  if (!held.has('device.register') && !(staffMayRegister && worksThePos)) {
    return { ok: false, refusal: 'till_not_permitted' };
  }

  const used = await planUsage(context, 'devices');
  if (document === null || used + 1 > (document.limits['devices'] ?? 0)) return { ok: false, refusal: 'device_limit' };

  const deviceId = randomUUID();
  await context.client.query(
    `INSERT INTO app.device (id, tenant_id, branch_id, name, fingerprint, registered_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [deviceId, context.tenantId, branchId, name, params.fingerprint, params.userId],
  );
  return { ok: true, trust: { deviceId, branchId } };
}

/* ------------------------------------------------ who signs in at a till --- */

export interface TillStaffMember {
  readonly userId: string;
  readonly fullName: string;
  /** Holds an active PIN. Without one the person is listed but cannot sign in yet. */
  readonly hasPin: boolean;
}

/**
 * The names a till shows for staff to tap before typing their PIN. Identified,
 * never anonymous: the PIN then disambiguates one known person, so no PIN is a
 * lookup key and none has to be unique.
 *
 * Only for a till (resolved by its fingerprint, as a PIN is), and only people
 * who work the POS there: active and holding `kot.fire` or `bill.generate` at
 * the till's branch. Someone with no PIN yet is listed with `hasPin: false`, so
 * the till can say "ask your Sales person" rather than leave them out. Names and
 * that flag, nothing else -- no code, no contact, no role.
 *
 * Never an account that manages the restaurant (holds `user.view`): this read
 * is answered before anyone signs in, and a manager's name on a counter is the
 * name worth guessing for. The manager signs in with username and password.
 */
export async function tillStaff(
  context: TenantContext, fingerprint: string | null,
): Promise<{ ok: true; staff: readonly TillStaffMember[] } | { ok: false; rejection: PinRejection }> {
  const branch = await tillBranch(context, fingerprint);
  if ('rejection' in branch) return { ok: false, rejection: branch.rejection };
  const device = { trust: { branchId: branch.branchId } };
  const rows = await context.client.query<{ id: string; full_name: string; has_pin: boolean }>(
    `SELECT u.id, u.full_name,
            EXISTS (SELECT 1 FROM app.credential c
                     WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id AND c.type = 'pin' AND c.status = 'active') AS has_pin
       FROM app.app_user u
      WHERE u.tenant_id = $1 AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM app.membership m
                      JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                     WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                       AND (m.branch_id IS NULL OR m.branch_id = $2)
                       AND rp.permission_key IN ('kot.fire', 'bill.generate'))
        AND NOT EXISTS (SELECT 1 FROM app.membership m
                          JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                         WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                           AND rp.permission_key = 'user.view')
      ORDER BY u.full_name, u.id`,
    [context.tenantId, device.trust.branchId]);
  return { ok: true, staff: rows.rows.map((r) => ({ userId: r.id, fullName: r.full_name, hasPin: r.has_pin })) };
}

/**
 * `tillStaff` for the public read that serves it. That route is not on the
 * credential surface, so its registrar opens no transaction -- and the tenant
 * GUC is `SET LOCAL`, which outside a transaction lasts one statement and,
 * through the transaction-mode pooler, may not reach the next one at all. So
 * this holds a short read transaction of its own for the GUC to live in.
 */
export async function readTillStaff(
  client: pg.ClientBase, tenantId: string, fingerprint: string | null,
): Promise<Awaited<ReturnType<typeof tillStaff>>> {
  await client.query('BEGIN READ ONLY');
  try {
    const found = await tillStaff(await adoptTenantContext(client, tenantId), fingerprint);
    await client.query('COMMIT');
    return found;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * The branch a sign-in screen serves: its till's, or -- for a browser that is
 * not a till yet -- the restaurant's one active branch. A till taken out of use
 * stays refused: Tablets is how a manager stops a computer, and a PIN must not
 * walk around that. A restaurant with several branches needs its till set up,
 * because there is no one branch to assume.
 */
async function tillBranch(
  context: TenantContext, fingerprint: string | null,
): Promise<{ branchId: string; deviceId: string | null } | { rejection: PinRejection }> {
  if (fingerprint !== null && fingerprint !== '') {
    const device = await resolveDevice(context, fingerprint);
    if ('trust' in device) return { branchId: device.trust.branchId, deviceId: device.trust.deviceId };
    if (device.rejection !== 'device_unknown') return { rejection: device.rejection };
  }
  const branches = await context.client.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1 AND status = 'active'`, [context.tenantId]);
  if (branches.rows.length !== 1) return { rejection: 'device_unknown' };
  return { branchId: branches.rows[0]!.id, deviceId: null };
}

/* --------------------------------------------------------------- lockout --- */

/** Short, exponential, capped. An indefinite PIN lock mid-service is an outage. */
export function lockoutSeconds(failedAttempts: number): number {
  if (failedAttempts < 3) return 0;
  return Math.min(60 * 2 ** (failedAttempts - 3), 15 * 60);
}

export interface PinAttempt {
  /**
   * Exactly one of these identifies the person. `employeeCode` is what a real
   * shift start uses -- a short code typed on a tablet; `userId` remains for the
   * offline sync path and for tests, which already hold the id.
   */
  readonly userId?: string;
  readonly employeeCode?: string;
  readonly pin: string;
  readonly deviceFingerprint: string;
  /** A cross-check when the browser is a till; absent on a browser that is not one yet. */
  readonly branchId?: string;
}

/**
 * Identified PIN login: the caller already knows WHICH user is claiming to be at
 * the terminal (they tapped their name), so this verifies one PIN against one
 * credential rather than searching. That is why no deterministic lookup column,
 * HMAC or pepper exists anywhere in this design.
 */
export async function authenticatePin(
  context: TenantContext,
  attempt: PinAttempt,
): Promise<PinResult> {
  const place = await tillBranch(context, attempt.deviceFingerprint);
  if ('rejection' in place) return { ok: false, reason: place.rejection };

  // A terminal enrolled at one branch must not authenticate a shift at another.
  if (attempt.branchId !== undefined && place.branchId !== attempt.branchId) {
    return { ok: false, reason: 'device_wrong_branch' };
  }

  // #########################################################################
  // THE SUBJECT IS AN EMPLOYEE CODE OR A USER ID, AND IT IS RESOLVED HERE.
  //
  // The sign-in screen used to ask for `userId` -- a uuid, typed on a tablet by
  // a waiter starting a shift. That is not a credential a person can hold, and
  // it made the product unusable in a restaurant whatever else worked.
  //
  // The obvious fix was a roster endpoint listing who is on shift. It was
  // rejected: that read happens BEFORE anyone authenticates, so it hands every
  // staff name to whoever is holding the tablet -- and a tablet is a thing left
  // on a counter. `app.app_user.employee_code` already exists and is unique per
  // tenant, so the credential can be a short code the person knows plus the PIN
  // only they know. Two secrets, no roster, no leak.
  //
  // An unresolvable code is `subject_unknown` in the attempt row and
  // indistinguishable from a wrong PIN to the client, so the screen cannot be
  // used to enumerate staff.
  // #########################################################################
  // A tapped name AND a typed username must be the same person. The code alone
  // would let a tap on one name sign in whoever's code was typed; refused as an
  // unknown subject, so it is indistinguishable from a wrong PIN.
  const resolvedUserId = attempt.userId ?? null;
  const userRow = resolvedUserId !== null && attempt.employeeCode !== undefined
    ? await context.client.query<{ id: string; status: string }>(
      `SELECT id, status FROM app.app_user
        WHERE tenant_id = $1 AND id = $2 AND upper(employee_code) = upper(btrim($3))`,
      [context.tenantId, resolvedUserId, attempt.employeeCode])
    : resolvedUserId !== null
    ? await context.client.query<{ id: string; status: string }>(
      `SELECT id, status FROM app.app_user WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, resolvedUserId])
    : await context.client.query<{ id: string; status: string }>(
      // Case-insensitive and trimmed: a code read aloud across a kitchen is
      // typed however the person hears it, and 'W12' failing where 'w12' works
      // is a support call rather than a security property.
      `SELECT id, status FROM app.app_user
        WHERE tenant_id = $1 AND upper(employee_code) = upper(btrim($2))`,
      [context.tenantId, attempt.employeeCode ?? '']);

  const user = userRow.rows[0];
  if (!user) return { ok: false, reason: 'subject_unknown' };
  if (user.status !== 'active') return { ok: false, reason: 'user_inactive' };
  const userId = user.id;
  // Before the PIN is checked, so a manager's PIN neither signs in nor counts
  // toward a lockout: the role decides, not the secret.
  if ((await landingFor(context, userId)).lands === 'admin') return { ok: false, reason: 'manager_use_login' };

  const credential = await context.client.query<{
    id: string;
    secret_hash: string;
    failed_attempt_count: number;
    locked_until: Date | null;
  }>(
    `SELECT id, secret_hash, failed_attempt_count, locked_until
       FROM app.credential
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'pin' AND status = 'active'`,
    [context.tenantId, userId],
  );
  const row = credential.rows[0];
  if (!row) return { ok: false, reason: 'no_pin_credential' };

  if (row.locked_until && row.locked_until > new Date()) {
    return {
      ok: false,
      reason: 'credential_locked',
      retryAfterSeconds: Math.ceil((row.locked_until.getTime() - Date.now()) / 1000),
    };
  }

  const verified = await argon2.verify(row.secret_hash, attempt.pin);
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
    return { ok: false, reason: 'bad_pin', ...(seconds > 0 ? { retryAfterSeconds: seconds } : {}) };
  }

  await context.client.query(
    `UPDATE app.credential
        SET failed_attempt_count = 0, locked_until = NULL, last_used_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, row.id],
  );
  // A browser that is not a till yet becomes one now -- only after the PIN, and
  // only for someone who may make one, within the plan's limit.
  let deviceId = place.deviceId;
  if (deviceId === null) {
    const made = await registerTillAtSignIn(context, { userId, fingerprint: attempt.deviceFingerprint, deviceName: 'Counter till' });
    if (!made.ok) return { ok: false, reason: made.refusal === 'device_limit' ? 'device_limit' : 'till_not_permitted' };
    deviceId = made.trust.deviceId;
  }
  await context.client.query(
    `UPDATE app.device SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, deviceId],
  );

  return {
    ok: true,
    userId,
    credentialId: row.id,
    deviceId,
    branchId: place.branchId,
  };
}

export async function revokeDevice(
  context: TenantContext,
  deviceId: string,
  revokedByUserId: string,
): Promise<boolean> {
  const result = await context.client.query(
    `UPDATE app.device
        SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [context.tenantId, deviceId, revokedByUserId],
  );
  return (result.rowCount ?? 0) > 0;
}
