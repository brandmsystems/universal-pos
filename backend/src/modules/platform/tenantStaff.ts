import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { adoptTenantContext } from '../../database/unitOfWork.js';
import type { TenantContext } from '../../database/tenantContext.js';
import { checkPinPolicy, replaceCredential } from '../authentication/deviceAuth.js';
import { planUsage } from '../businesses/planUsage.js';
import { assertIdentifierFree, STAFF_CODE } from '../users/identifiers.js';
import { assertWithinLimit, loadLatestEntitlement } from './entitlements.js';

/**
 * A restaurant's staff, managed by the Sales person (DECIDED, 0077).
 *
 * ###########################################################################
 * STAFF SIGN IN WITH A 4-DIGIT PIN, AND THE SALES PERSON SETS IT.
 *
 * The product is Basic only; staff tap their name on the restaurant's till and
 * type a 4-digit PIN. Staff have no password (DECIDED 2026-10-17). The Sales person who sold the restaurant adds them, sets
 * or resets the PIN, changes what they can use, and switches them off or on.
 * The restaurant's own manager screens no longer manage staff at all.
 *
 * This relaxes "nobody but the person knows their secret" for staff PINs, on the
 * owner's explicit decision. What keeps it accountable: every change is a row in
 * platform_audit_log naming the platform user, the request body (the PIN) is
 * never recorded, the PIN is argon2id like every credential, and trivial PINs
 * (0000, 1234, a run) are refused by the same policy as before.
 *
 * What it never does:
 * - touch an account that MANAGES the restaurant (holds `user.view`: the
 *   Restaurant Manager, Restaurant Admin, a Manager) beyond its username and
 *   password (setTenantCredentials).
 * - reach a restaurant the Sales person did not sell. `platform.tenant.staff`
 *   is scoped to restaurants whose provisioning request names the caller;
 *   `platform.tenant.staff.any` (Super Admin) is estate-wide. A key, never a
 *   role name, decides it.
 * - grant anything outside ACCESS: the control plane holds no tenant
 *   permissions, so the subset rule has nothing to measure a grant against, and
 *   an allowlist of the ordinary staff roles is all it may hand out.
 * - bypass the plan: adding or switching someone on is counted under the same
 *   advisory lock and `users` count as every other add; switching off never is.
 *
 * It runs as the APP role under the tenant's own GUC, so RLS applies exactly as
 * for a tenant request.
 * ###########################################################################
 */

/** What a staff member may use on the POS -> the system roles held at the branch. */
export const ACCESS = {
  pos: ['waiter', 'cashier'],
  orders: ['waiter'],
  billing: ['cashier'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
export type StaffAccess = keyof typeof ACCESS;

/** Whoever reads the staff list manages the restaurant, and is not the Sales person's to change. */
const MANAGES = 'user.view';

export class TenantStaffInvalidError extends Error {
  readonly statusCode = 422;
  readonly code = 'tenant_staff_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'TenantStaffInvalidError';
  }
}

export class TenantStaffUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'tenant_staff_unknown';
  constructor() {
    // One answer for "no such restaurant", "not yours" and "no such person":
    // which of the three tells a prober what exists.
    super('no such staff member at a restaurant you manage');
    this.name = 'TenantStaffUnknownError';
  }
}

export class TenantStaffUsesPinError extends Error {
  readonly statusCode = 409;
  readonly code = 'tenant_staff_uses_pin';
  constructor() {
    super('staff sign in on the till with their PIN; only the manager has a password');
    this.name = 'TenantStaffUsesPinError';
  }
}

export class TenantStaffIsManagerError extends Error {
  readonly statusCode = 409;
  readonly code = 'tenant_staff_is_manager';
  constructor() {
    super('this account manages the restaurant; only its username and password are set here');
    this.name = 'TenantStaffIsManagerError';
  }
}

export interface StaffActor {
  readonly platformUserId: string;
  /** Holds `platform.tenant.staff.any`: every restaurant, not only the ones they sold. */
  readonly anyRestaurant: boolean;
}

export interface TenantStaffMember {
  readonly userId: string;
  readonly fullName: string;
  readonly staffCode: string | null;
  readonly status: string;
  readonly manages: boolean;
  /** Holds an active password: the manager's sign-in. Staff have none. */
  readonly hasPassword: boolean;
  /** Holds an active PIN: shown on the till's staff list, signs in by tapping their name. */
  readonly hasPin: boolean;
  readonly access: StaffAccess | null;
  readonly roles: readonly string[];
}

export interface TenantStaffList {
  readonly members: readonly TenantStaffMember[];
  readonly used: number;
  readonly limit: number;
}

function fullName(given: unknown): string {
  const name = typeof given === 'string' ? given.trim() : '';
  if (name.length < 1 || name.length > 80) throw new TenantStaffInvalidError('a name is 1 to 80 characters');
  return name;
}

function access(given: unknown): StaffAccess {
  if (typeof given === 'string' && Object.hasOwn(ACCESS, given)) return given as StaffAccess;
  throw new TenantStaffInvalidError(`access is one of ${Object.keys(ACCESS).join(', ')}`);
}

/** A username: 1 to 12 letters or digits, stored in capitals (the staff code). */
function username(given: unknown): string {
  const code = typeof given === 'string' ? given.trim().toUpperCase() : '';
  if (!STAFF_CODE.test(code)) throw new TenantStaffInvalidError('a username is 1 to 12 letters or digits');
  return code;
}

/** A password: 8 to 200 characters. Hashed with argon2id like every credential; never stored or logged as typed. */
function password(given: unknown): string {
  if (typeof given !== 'string' || given.length < 8 || given.length > 200) {
    throw new TenantStaffInvalidError('a password is 8 to 200 characters');
  }
  return given;
}

/** Exactly four digits, and not one the PIN policy refuses (0000, 1234, a run, the staff code). */
function pin(given: unknown, staffCode: string | null): string {
  if (typeof given !== 'string' || !/^\d{4}$/.test(given)) {
    throw new TenantStaffInvalidError('a PIN is exactly 4 digits');
  }
  const failure = checkPinPolicy(given, { employeeCode: staffCode });
  if (failure !== null) {
    throw new TenantStaffInvalidError(failure === 'trivial_sequence'
      ? 'that PIN is too easy to guess (no 0000, 1234 or runs); choose another'
      : 'that PIN is not allowed; choose another');
  }
  return given;
}

function accessOf(roles: readonly string[]): StaffAccess | null {
  const held = [...roles].sort().join(',');
  for (const [name, keys] of Object.entries(ACCESS)) {
    if ([...keys].sort().join(',') === held) return name as StaffAccess;
  }
  return null;
}

/** The restaurant, if this actor may manage its staff; the uniform 404 otherwise. */
async function restaurantFor(client: pg.ClientBase, actor: StaffActor, tenantId: unknown): Promise<TenantContext> {
  if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TenantStaffUnknownError();
  const found = await client.query(
    `SELECT 1 FROM platform.tenant t
      WHERE t.id = $1
        AND ($2::boolean OR EXISTS (SELECT 1 FROM platform.provisioning_request pr
                                     WHERE pr.tenant_id = t.id AND pr.requested_by_platform_user_id = $3))`,
    [tenantId, actor.anyRestaurant, actor.platformUserId]);
  if (found.rowCount === 0) throw new TenantStaffUnknownError();
  return adoptTenantContext(client, tenantId);
}

/** A staff member here who does not manage the restaurant, locked for the change. */
async function staffMember(context: TenantContext, userId: unknown): Promise<{ id: string; status: string; staffCode: string | null }> {
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new TenantStaffUnknownError();
  const found = await context.client.query<{ id: string; status: string; employee_code: string | null; manages: boolean }>(
    `SELECT u.id, u.status, u.employee_code,
            EXISTS (SELECT 1 FROM app.membership m
                      JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                     WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                       AND rp.permission_key = $3) AS manages
       FROM app.app_user u WHERE u.tenant_id = $1 AND u.id = $2 FOR UPDATE OF u`,
    [context.tenantId, userId, MANAGES]);
  const row = found.rows[0];
  if (!row) throw new TenantStaffUnknownError();
  if (row.manages) throw new TenantStaffIsManagerError();
  return { id: row.id, status: row.status, staffCode: row.employee_code };
}

/** Anyone at this restaurant, manager included, locked for the change -- for setting credentials only. */
async function anyMember(context: TenantContext, userId: unknown): Promise<{ id: string; staffCode: string | null; manages: boolean }> {
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new TenantStaffUnknownError();
  const found = await context.client.query<{ id: string; employee_code: string | null; manages: boolean }>(
    `SELECT u.id, u.employee_code,
            EXISTS (SELECT 1 FROM app.membership m
                      JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                     WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                       AND rp.permission_key = $3) AS manages
       FROM app.app_user u WHERE u.tenant_id = $1 AND u.id = $2 FOR UPDATE OF u`,
    [context.tenantId, userId, MANAGES]);
  const row = found.rows[0];
  if (!row) throw new TenantStaffUnknownError();
  return { id: row.id, staffCode: row.employee_code, manages: row.manages };
}

/** Room for one more sign-in, under the plan's own lock and count. */
async function assertRoomForOne(context: TenantContext): Promise<void> {
  const document = await loadLatestEntitlement(context.client, context.tenantId);
  if (document === null) throw new TenantStaffInvalidError('this restaurant has no published plan yet');
  assertWithinLimit(document, 'users', (await planUsage(context, 'users')) + 1);
}

async function onlyBranch(context: TenantContext): Promise<string> {
  const found = await context.client.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
    [context.tenantId]);
  const id = found.rows[0]?.id;
  if (id === undefined) throw new TenantStaffInvalidError('this restaurant has no active branch');
  return id;
}

async function grantAccess(context: TenantContext, userId: string, level: StaffAccess): Promise<void> {
  const branchId = await onlyBranch(context);
  const roles = await context.client.query<{ id: string; assignable_scope: string }>(
    `SELECT id, assignable_scope FROM app.role WHERE tenant_id = $1 AND is_system AND key = ANY($2::text[])`,
    [context.tenantId, [...ACCESS[level]]]);
  if (roles.rows.length !== ACCESS[level].length) {
    throw new TenantStaffInvalidError('this restaurant is missing one of the standard roles; run the role reconciliation');
  }
  for (const role of roles.rows) {
    await context.client.query(
      `INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), context.tenantId, userId, role.assignable_scope === 'tenant_only' ? null : branchId,
       role.id, role.assignable_scope]);
  }
}

export async function listTenantStaff(client: pg.ClientBase, actor: StaffActor, tenantId: unknown): Promise<TenantStaffList> {
  const context = await restaurantFor(client, actor, tenantId);
  const rows = await context.client.query<{
    id: string; full_name: string; employee_code: string | null; status: string;
    manages: boolean; has_password: boolean; has_pin: boolean; roles: string[] | null;
  }>(
    `SELECT u.id, u.full_name, u.employee_code, u.status,
            EXISTS (SELECT 1 FROM app.membership m
                      JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                     WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                       AND rp.permission_key = $2) AS manages,
            EXISTS (SELECT 1 FROM app.credential c WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id
                     AND c.type = 'password' AND c.status = 'active') AS has_password,
            EXISTS (SELECT 1 FROM app.credential c WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id
                     AND c.type = 'pin' AND c.status = 'active') AS has_pin,
            (SELECT array_agg(DISTINCT r.key ORDER BY r.key) FROM app.membership m
               JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
              WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active') AS roles
       FROM app.app_user u WHERE u.tenant_id = $1
      ORDER BY u.created_at`,
    [context.tenantId, MANAGES]);
  const document = await loadLatestEntitlement(context.client, context.tenantId);
  const used = await context.client.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM app.app_user WHERE tenant_id = $1 AND status IN ('active', 'invited'))
           + (SELECT count(*) FROM app.staff_invite WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now()))::text AS n`,
    [context.tenantId]);
  return {
    members: rows.rows.map((r) => ({
      userId: r.id, fullName: r.full_name, staffCode: r.employee_code, status: r.status,
      manages: r.manages, hasPassword: r.has_password, hasPin: r.has_pin, access: accessOf(r.roles ?? []), roles: r.roles ?? [],
    })),
    used: Number(used.rows[0]!.n),
    limit: document?.limits['users'] ?? 0,
  };
}

export async function createTenantStaff(
  client: pg.ClientBase, actor: StaffActor,
  input: { tenantId: unknown; fullName: unknown; username: unknown; password?: unknown; pin: unknown; access: unknown },
): Promise<{ userId: string; fullName: string; staffCode: string; access: StaffAccess }> {
  // Refused, not ignored: a caller sending one believes it was set.
  if (input.password !== undefined) throw new TenantStaffUsesPinError();
  const name = fullName(input.fullName);
  const level = access(input.access);
  const staffCode = username(input.username);
  // The PIN is staff's only sign-in, so an account is never made without one.
  const tillPin = pin(input.pin, staffCode);
  const context = await restaurantFor(client, actor, input.tenantId);
  await assertRoomForOne(context);
  await assertIdentifierFree(context, 'employee_code', staffCode);

  const userId = randomUUID();
  await context.client.query(
    `INSERT INTO app.app_user (id, tenant_id, employee_code, full_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [userId, context.tenantId, staffCode, name]);
  await replaceCredential(context, userId, 'pin', tillPin);
  await grantAccess(context, userId, level);
  return { userId, fullName: name, staffCode, access: level };
}

export async function editTenantStaff(
  client: pg.ClientBase, actor: StaffActor,
  input: { tenantId: unknown; userId: unknown; fullName?: unknown; username?: unknown; access?: unknown },
): Promise<{ userId: string }> {
  const context = await restaurantFor(client, actor, input.tenantId);
  const person = await staffMember(context, input.userId);
  if (input.username !== undefined) {
    const code = username(input.username);
    if (person.staffCode?.toUpperCase() !== code) {
      await assertIdentifierFree(context, 'employee_code', code);
      await context.client.query(`UPDATE app.app_user SET employee_code = $3 WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, person.id, code]);
    }
  }
  if (input.fullName !== undefined) {
    await context.client.query(`UPDATE app.app_user SET full_name = $3 WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, person.id, fullName(input.fullName)]);
  }
  if (input.access !== undefined) {
    const level = access(input.access);
    // Revoked, never deleted: a membership that has acted is pinned by the audit log.
    await context.client.query(
      `UPDATE app.membership SET status = 'revoked', revoked_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
      [context.tenantId, person.id]);
    await grantAccess(context, person.id, level);
  }
  return { userId: person.id };
}

/**
 * The manager's username and password, set by the Sales person (DECIDED
 * 2026-10-16). Nobody else sets them -- the manager screens have no credential
 * route, and a pending setup link is revoked here so the password the Sales
 * person set is the one in force. The old password stops working at once.
 * Staff have no password (DECIDED 2026-10-17): they sign in on the till with a
 * PIN (setTenantStaffPin), and their username is changed by editTenantStaff.
 */
export async function setTenantCredentials(
  client: pg.ClientBase, actor: StaffActor,
  input: { tenantId: unknown; userId: unknown; username: unknown; password: unknown },
): Promise<{ userId: string; staffCode: string }> {
  const code = username(input.username);
  const value = password(input.password);
  const context = await restaurantFor(client, actor, input.tenantId);
  const person = await anyMember(context, input.userId);
  if (!person.manages) throw new TenantStaffUsesPinError();
  if (person.staffCode?.toUpperCase() !== code) {
    await assertIdentifierFree(context, 'employee_code', code);
    await context.client.query(`UPDATE app.app_user SET employee_code = $3 WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, person.id, code]);
  }
  await replaceCredential(context, person.id, 'password', value);
  // Provisioning leaves the manager `invited`, and the setup link revoked below was
  // the only other way out of it. `invited` only: a new password does not switch
  // back on a manager someone switched off.
  await context.client.query(
    `UPDATE app.app_user SET status = 'active' WHERE tenant_id = $1 AND id = $2 AND status = 'invited'`,
    [context.tenantId, person.id]);
  await context.client.query(
    `UPDATE platform.tenant_owner_invite SET status = 'revoked' WHERE tenant_id = $1 AND status = 'pending'`,
    [context.tenantId]);
  return { userId: person.id, staffCode: code };
}

export async function setTenantStaffPin(
  client: pg.ClientBase, actor: StaffActor,
  input: { tenantId: unknown; userId: unknown; pin: unknown },
): Promise<{ userId: string }> {
  const context = await restaurantFor(client, actor, input.tenantId);
  const person = await staffMember(context, input.userId);
  await replaceCredential(context, person.id, 'pin', pin(input.pin, person.staffCode));
  return { userId: person.id };
}

/**
 * "Remove" is switching off: staff records are never deleted (their audit rows
 * pin them), and a switched-off account cannot sign in or count against the
 * plan. Switching off is never refused; switching back on needs room.
 */
export async function setTenantStaffActive(
  client: pg.ClientBase, actor: StaffActor,
  input: { tenantId: unknown; userId: unknown; active: unknown },
): Promise<{ userId: string; status: 'active' | 'disabled' }> {
  if (typeof input.active !== 'boolean') throw new TenantStaffInvalidError('active is true or false');
  const context = await restaurantFor(client, actor, input.tenantId);
  const person = await staffMember(context, input.userId);
  const next = input.active ? 'active' : 'disabled';
  if (person.status === next) return { userId: person.id, status: next };
  if (next === 'active') await assertRoomForOne(context);
  await context.client.query(`UPDATE app.app_user SET status = $3 WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, person.id, next]);
  return { userId: person.id, status: next };
}
