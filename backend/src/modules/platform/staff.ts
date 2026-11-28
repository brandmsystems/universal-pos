import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { EXPIRING_WITHIN_DAYS } from '@universalpos/shared';
import { hashPlatformPassword } from '../authentication/platformAuth.js';
import {
  PLATFORM_ROLES, checkPlatformSubsetGrant, platformRole, type PlatformRoleKey,
} from '../authz/platformRoles.js';

/**
 * Administering the platform's own staff directory.
 *
 * ###########################################################################
 * THE ONLY CALLER THIS EVER HAD WAS A SCRIPT.
 *
 * `scripts/development/seed-platform-user.mts` bootstraps the FIRST superadmin -- an
 * account created by nobody, run with shell and database access. Every
 * platform user after that one has a creator, and `platform.user.create` has
 * been in the permission catalogue since it was written, but nothing served
 * it: there was no route a Super Admin could reach to add a Salesperson
 * without the same shell access the bootstrap script needs. Same shape as
 * `POST /tenants` before this week -- a permission key and a table with no
 * door.
 * ###########################################################################
 */

export class PlatformRoleUnknownError extends Error {
  readonly statusCode = 422;
  readonly code = 'platform_role_unknown';
  constructor(readonly given: string) {
    super(
      `"${given}" is not a platform role. The fixed set is `
      + `${PLATFORM_ROLES.map((r) => r.key).join(', ')}.`,
    );
    this.name = 'PlatformRoleUnknownError';
  }
}

export class PlatformPasswordTooShortError extends Error {
  readonly statusCode = 400;
  readonly code = 'platform_password_too_short';
  constructor() {
    super('a platform password must be at least 12 characters.');
    this.name = 'PlatformPasswordTooShortError';
  }
}

/**
 * The platform subset rule, applied to a real request: a granter may not hand
 * out a role carrying a permission they do not hold themselves. Seniority is
 * exactly what must not be self-granted -- see `checkPlatformSubsetGrant`.
 */
export class PlatformGrantExceedsAuthorityError extends Error {
  readonly statusCode = 403;
  readonly code = 'platform_grant_exceeds_authority';
  constructor(readonly missing: readonly string[]) {
    super(
      'a platform role may only be granted with permissions the granter already '
      + `holds. Missing: ${missing.join(', ')}.`,
    );
    this.name = 'PlatformGrantExceedsAuthorityError';
  }
}

export interface PlatformStaffSummary {
  readonly platformUserId: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly roleKey: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/** The directory read. No tenant data, same boundary as `directory.ts`. */
export async function listPlatformUsers(
  client: pg.ClientBase,
): Promise<readonly PlatformStaffSummary[]> {
  const rows = await client.query<{
    id: string; email: string; full_name: string; phone: string | null;
    role_key: string; role_name: string;
    status: string; created_at: string; last_login_at: string | null;
  }>(
    `SELECT u.id, u.email, u.full_name, u.phone, r.key AS role_key, r.name AS role_name,
            u.status, u.created_at, u.last_login_at
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
      ORDER BY u.created_at DESC`,
  );
  return rows.rows.map((row) => ({
    platformUserId: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    roleKey: row.role_key,
    roleName: row.role_name,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }));
}

export interface CreatePlatformUserRequest {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly roleKey: string;
  readonly phone?: unknown;
  /** From the verified token, never the body -- see `actingPlatformUserId`. */
  readonly createdByPlatformUserId: string;
  /** The granter's OWN role, from the verified token's `platform_role` claim. */
  readonly granterRoleKey: string;
}

export interface CreatePlatformUserResult {
  readonly platformUserId: string;
  readonly email: string;
  readonly roleKey: string;
}

export async function createPlatformUser(
  client: pg.ClientBase,
  request: CreatePlatformUserRequest,
): Promise<CreatePlatformUserResult> {
  const target = PLATFORM_ROLES.find((r) => r.key === request.roleKey);
  if (!target) throw new PlatformRoleUnknownError(request.roleKey);

  if (request.password.length < 12) throw new PlatformPasswordTooShortError();
  const phone = phoneOf(request.phone);

  // The route already required `platform.user.create` to reach here; this is
  // the SECOND check the tenant side also makes in its grant path -- holding
  // the create key is not holding every role that key can be used to create.
  const granter = platformRole(request.granterRoleKey as PlatformRoleKey);
  const decision = checkPlatformSubsetGrant(granter.permissions, target.permissions);
  if (!decision.ok) throw new PlatformGrantExceedsAuthorityError(decision.missing);

  const role = await client.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = $1`, [target.key]);
  const roleId = role.rows[0]!.id;

  const id = randomUUID();
  const hash = await hashPlatformPassword(request.password);
  await client.query(
    `INSERT INTO platform.platform_user
       (id, email, password_hash, full_name, platform_role_id, created_by_platform_user_id, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, request.email, hash, request.fullName, roleId, request.createdByPlatformUserId, phone],
  );

  return { platformUserId: id, email: request.email, roleKey: target.key };
}

/* ------------------------------------------------------------ editing --- */

export class PlatformUserUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'platform_user_unknown';
  constructor(id: string) {
    super(`no platform user has the id ${id}`);
    this.name = 'PlatformUserUnknownError';
  }
}

export class PlatformUserEditInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'platform_user_edit_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'PlatformUserEditInvalidError';
  }
}

/** Nobody switches off their own account: the console would lock out the one
 * person who could switch it back on. */
export class PlatformSelfStatusChangeError extends Error {
  readonly statusCode = 409;
  readonly code = 'platform_self_status_change';
  constructor() {
    super('you cannot deactivate, reactivate or reset the password of your own account here.');
    this.name = 'PlatformSelfStatusChangeError';
  }
}

/** Empty clears the number; anything else must look like one. The CHECK
 * `platform_user_phone_format` is the authority -- this only turns its refusal
 * into a sentence before the write. */
function phoneOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PlatformUserEditInvalidError('phone must be text.');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\+?[0-9][0-9 ()-]{5,19}$/.test(trimmed)) {
    throw new PlatformUserEditInvalidError(
      'phone must be digits, with optional spaces, dashes, brackets and a leading +.');
  }
  return trimmed;
}

/**
 * The subset rule, applied to ACTING ON a person rather than creating one: an
 * editor may only touch an account whose role they could have granted. Without
 * it, a role holding `platform.user.edit` could change a Super Admin's email to
 * their own.
 */
async function lockSubordinate(
  client: pg.ClientBase, targetId: string, actorRoleKey: string,
): Promise<{ status: string }> {
  const found = await client.query<{ status: string; role_key: string }>(
    `SELECT u.status, r.key AS role_key
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
      WHERE u.id = $1
      FOR UPDATE OF u`, [targetId]);
  const row = found.rows[0];
  if (!row) throw new PlatformUserUnknownError(targetId);
  const target = PLATFORM_ROLES.find((r) => r.key === row.role_key);
  const actor = platformRole(actorRoleKey as PlatformRoleKey);
  const decision = checkPlatformSubsetGrant(actor.permissions, target?.permissions ?? []);
  if (!decision.ok) throw new PlatformGrantExceedsAuthorityError(decision.missing);
  return { status: row.status };
}

export async function updatePlatformUser(
  client: pg.ClientBase,
  input: {
    platformUserId: string; actorRoleKey: string;
    fullName?: unknown; email?: unknown; phone?: unknown;
  },
): Promise<{ platformUserId: string; fullName: string; email: string; phone: string | null }> {
  await lockSubordinate(client, input.platformUserId, input.actorRoleKey);
  const sets: string[] = [];
  const values: unknown[] = [input.platformUserId];
  if (input.fullName !== undefined) {
    if (typeof input.fullName !== 'string' || input.fullName.trim().length < 2
      || input.fullName.trim().length > 120) {
      throw new PlatformUserEditInvalidError('fullName must be 2 to 120 characters.');
    }
    values.push(input.fullName.trim());
    sets.push(`full_name = $${values.length}`);
  }
  if (input.email !== undefined) {
    if (typeof input.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())) {
      throw new PlatformUserEditInvalidError('email must be an email address.');
    }
    values.push(input.email.trim());
    sets.push(`email = $${values.length}`);
  }
  if (input.phone !== undefined) {
    values.push(phoneOf(input.phone));
    sets.push(`phone = $${values.length}`);
  }
  if (sets.length === 0) {
    throw new PlatformUserEditInvalidError('nothing to change: send fullName, email or phone.');
  }
  const updated = await client.query<{ full_name: string; email: string; phone: string | null }>(
    `UPDATE platform.platform_user SET ${sets.join(', ')} WHERE id = $1
     RETURNING full_name, email, phone`, values);
  const row = updated.rows[0]!;
  return {
    platformUserId: input.platformUserId, fullName: row.full_name, email: row.email, phone: row.phone,
  };
}

/**
 * `active` or `disabled`, and nothing else from this route. `suspended` is the
 * lockout state the login path owns; a console toggle that could set it would
 * be a second writer of a state machine that already has one.
 */
export async function setPlatformUserStatus(
  client: pg.ClientBase,
  input: { platformUserId: string; status: unknown; actorId: string; actorRoleKey: string },
): Promise<{ platformUserId: string; status: 'active' | 'disabled' }> {
  if (input.status !== 'active' && input.status !== 'disabled') {
    throw new PlatformUserEditInvalidError('status must be active or disabled.');
  }
  if (input.platformUserId === input.actorId) throw new PlatformSelfStatusChangeError();
  await lockSubordinate(client, input.platformUserId, input.actorRoleKey);
  await client.query(
    `UPDATE platform.platform_user SET status = $2 WHERE id = $1`,
    [input.platformUserId, input.status]);
  return { platformUserId: input.platformUserId, status: input.status };
}

/* ------------------------------------------------------- sales persons --- */

// "Expiring soon" is one shared rule: the console's status badge and these
// counts import the same constant from @universalpos/shared.
export { EXPIRING_WITHIN_DAYS };

export interface SalesPersonSummary extends PlatformStaffSummary {
  readonly restaurantsSold: number;
  readonly activeRestaurants: number;
  /** Trading, and inside the paid or trial period. Expiring ones included. */
  readonly activeSubscriptions: number;
  readonly expiringSoon: number;
  /** Trading, but past the end of the period. Suspended restaurants are neither. */
  readonly expired: number;
  /** Paid invoices across every restaurant they provisioned, minor units. */
  readonly revenueMinor: number;
}

/**
 * The Salesperson directory with their book. "Sold" is who PROVISIONED the
 * restaurant -- the same `provisioning_request` join `listTenants` scopes a
 * Salesperson by -- so these counts and the rows on their own dashboard come
 * from one definition, not two that could disagree.
 */
export async function listSalesPersons(
  client: pg.ClientBase,
): Promise<readonly SalesPersonSummary[]> {
  const rows = await client.query<{
    id: string; email: string; full_name: string; phone: string | null;
    role_key: string; role_name: string; status: string; created_at: string;
    last_login_at: string | null;
    sold: string; active: string; revenue: string;
    live: string; expiring: string; expired: string;
  }>(
    `SELECT u.id, u.email, u.full_name, u.phone, r.key AS role_key, r.name AS role_name,
            u.status, u.created_at, u.last_login_at,
            count(t.id)::text AS sold,
            count(t.id) FILTER (WHERE t.status = 'active')::text AS active,
            -- The same rule the console's status badge applies: only a
            -- restaurant still trading (active or past due) can be active,
            -- expiring or expired; anything else is suspended and counts in none.
            count(t.id) FILTER (WHERE t.status IN ('active', 'past_due')
                                  AND s.current_period_end >= now())::text AS live,
            count(t.id) FILTER (WHERE t.status IN ('active', 'past_due')
                                  AND s.current_period_end >= now()
                                  AND s.current_period_end < now() + make_interval(days => $1))::text AS expiring,
            count(t.id) FILTER (WHERE t.status IN ('active', 'past_due')
                                  AND s.current_period_end < now())::text AS expired,
            COALESCE(sum(paid.total), 0)::text AS revenue
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
       LEFT JOIN platform.provisioning_request pr ON pr.requested_by_platform_user_id = u.id
       LEFT JOIN platform.tenant t ON t.id = pr.tenant_id
       LEFT JOIN platform.subscription s
              ON s.tenant_id = t.id AND s.status IN ('trialing', 'active', 'past_due')
       LEFT JOIN LATERAL (
              SELECT sum(v.total_minor) AS total FROM platform.invoice v
               WHERE v.tenant_id = t.id AND v.status = 'paid') paid ON true
      WHERE r.key = 'sales'
      GROUP BY u.id, r.key, r.name
      ORDER BY u.created_at DESC`,
    [EXPIRING_WITHIN_DAYS],
  );
  return rows.rows.map((row) => ({
    platformUserId: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    roleKey: row.role_key,
    roleName: row.role_name,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    restaurantsSold: Number(row.sold),
    activeRestaurants: Number(row.active),
    activeSubscriptions: Number(row.live),
    expiringSoon: Number(row.expiring),
    expired: Number(row.expired),
    revenueMinor: Number(row.revenue),
  }));
}

/* ---------------------------------------------------------- password reset --- */

/**
 * A new password for a platform user, generated here and returned ONCE.
 *
 * Platform staff have no invite flow (see createPlatformUser), so the granter
 * hands the password over directly; a reset is the same act again. Only the
 * argon2id hash is stored -- nobody, including the Super Admin, can read a
 * password back later, so "show me their password" is answered by issuing a
 * new one. The lockout is cleared with it, and the route declares no
 * after-image so the password never lands in the audit log.
 */
export async function resetPlatformUserPassword(
  client: pg.ClientBase,
  input: { platformUserId: string; actorId: string; actorRoleKey: string },
): Promise<{ platformUserId: string; email: string; password: string }> {
  if (input.platformUserId === input.actorId) throw new PlatformSelfStatusChangeError();
  await lockSubordinate(client, input.platformUserId, input.actorRoleKey);
  const password = randomBytes(12).toString('base64url');
  const updated = await client.query<{ email: string }>(
    `UPDATE platform.platform_user
        SET password_hash = $2, password_changed_at = now(),
            failed_login_count = 0, locked_until = NULL
      WHERE id = $1 RETURNING email::text AS email`,
    [input.platformUserId, await hashPlatformPassword(password)]);
  return { platformUserId: input.platformUserId, email: updated.rows[0]!.email, password };
}

/* ----------------------------------------------------------- own profile --- */

export interface PlatformProfile {
  readonly platformUserId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly roleKey: string;
  readonly roleName: string;
  readonly status: string;
  readonly lastLoginAt: string | null;
}

/**
 * The signed-in user's own account, for the console's header and profile
 * menu. Keyed on the token's subject and nothing else, so it can only ever
 * answer "who am I" -- which is why it needs no permission key: every role may
 * know its own name.
 */
export async function platformProfile(
  client: pg.ClientBase,
  platformUserId: string,
): Promise<PlatformProfile> {
  const found = await client.query<{
    id: string; full_name: string; email: string; phone: string | null;
    role_key: string; role_name: string; status: string; last_login_at: string | null;
  }>(
    `SELECT u.id, u.full_name, u.email::text AS email, u.phone, r.key AS role_key,
            r.name AS role_name, u.status, u.last_login_at::text
       FROM platform.platform_user u
       JOIN platform.platform_role r ON r.id = u.platform_role_id
      WHERE u.id = $1`, [platformUserId]);
  const row = found.rows[0];
  if (!row) throw new PlatformUserUnknownError(platformUserId);
  return {
    platformUserId: row.id, fullName: row.full_name, email: row.email, phone: row.phone,
    roleKey: row.role_key, roleName: row.role_name, status: row.status, lastLoginAt: row.last_login_at,
  };
}
