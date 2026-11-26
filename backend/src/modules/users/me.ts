import type { TenantContext } from '../../core/database/tenantContext.js';
import { resolveActor } from '../authz/authorityStore.js';
import type { PermissionKey } from '../authz/permissions.js';
import { SCREEN_KEYS } from './staffAccess.js';

/**
 * Who is signed in, for the badge in every screen's header.
 *
 * The subject, branch and tablet all come from the verified token -- there is no
 * parameter, so this can only ever describe the caller. Their own email is
 * returned for the same reason: reading your own address is not a privacy
 * access, and `user.pii.view` exists for reading SOMEONE ELSE's.
 *
 * An impersonated request has a platform user as its subject and no staff row,
 * and says so positively rather than returning an empty person.
 */

export interface Me {
  readonly kind: 'staff' | 'impersonation';
  readonly userId: string;
  readonly fullName: string | null;
  readonly employeeCode: string | null;
  readonly email: string | null;
  /** Every active role held in this restaurant, with where it is held. */
  readonly roles: readonly { roleName: string; branchName: string | null }[];
  /** The branch this sign-in works at; null for a restaurant-wide session. */
  readonly branchName: string | null;
  /** The tablet this sign-in came from; null for a password sign-in. */
  readonly deviceName: string | null;
  /**
   * Which tablet screens THIS sign-in may open, from the union of the person's
   * memberships at this sign-in's branch -- the same keys the Access list shows
   * per person, never a role or plan name. The unified POS reads `billing` to
   * decide whether it has a Billing tab; the server still checks every write.
   */
  readonly screens: Readonly<Record<keyof typeof SCREEN_KEYS, boolean>>;
}

const NO_SCREENS = {
  kot: false, billing: false, kitchen: false, admin: false, takings: false,
  bills: false, billEdit: false, dayEnd: false, billEditAny: false, dayReopen: false,
} as const;

/**
 * Where the restaurant's one login page sends a person, and the branch their
 * sign-in may carry. A person who holds the manager screens' key anywhere lands
 * on them; everyone else on the POS. The branch is the ONE branch every active
 * membership is held at, when there is no tenant-wide one -- a scope they were
 * granted, not one minted at login -- so a staff member's own reads resolve.
 */
export async function landingFor(
  context: TenantContext, userId: string,
): Promise<{ lands: 'admin' | 'pos'; branchId: string | null }> {
  const found = await context.client.query<{ manages: boolean; tenant_wide: boolean; branches: string[] | null }>(
    `SELECT EXISTS (SELECT 1 FROM app.membership m
                     JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                    WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND rp.permission_key = $3) AS manages,
            EXISTS (SELECT 1 FROM app.membership m
                    WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.branch_id IS NULL) AS tenant_wide,
            (SELECT array_agg(DISTINCT m.branch_id) FROM app.membership m
              WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.branch_id IS NOT NULL) AS branches`,
    [context.tenantId, userId, SCREEN_KEYS.admin]);
  const row = found.rows[0]!;
  const one = !row.tenant_wide && row.branches !== null && row.branches.length === 1 ? row.branches[0]! : null;
  return { lands: row.manages ? 'admin' : 'pos', branchId: one };
}

export async function readMe(
  context: TenantContext,
  params: { userId: string; branchId: string | null; deviceId: string | null; viaImpersonation: boolean },
): Promise<Me> {
  const place = await context.client.query<{ branch_name: string | null; device_name: string | null }>(
    `SELECT (SELECT name FROM app.branch WHERE tenant_id = $1 AND id = $2) AS branch_name,
            (SELECT name FROM app.device WHERE tenant_id = $1 AND id = $3) AS device_name`,
    [context.tenantId, params.branchId, params.deviceId],
  );
  const { branch_name: branchName, device_name: deviceName } = place.rows[0]!;

  if (params.viaImpersonation) {
    return {
      kind: 'impersonation', userId: params.userId, fullName: null, employeeCode: null, email: null,
      roles: [], branchName, deviceName, screens: NO_SCREENS,
    };
  }

  const person = await context.client.query<{ full_name: string; employee_code: string | null; email: string | null }>(
    `SELECT full_name, employee_code, email::text AS email FROM app.app_user WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, params.userId],
  );
  const roles = await context.client.query<{ role_name: string; branch_name: string | null }>(
    `SELECT r.name AS role_name, b.name AS branch_name
       FROM app.membership m
       JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
       LEFT JOIN app.branch b ON b.tenant_id = m.tenant_id AND b.id = m.branch_id
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
      ORDER BY (m.branch_id IS NULL) DESC, r.name`,
    [context.tenantId, params.userId],
  );
  const row = person.rows[0];
  const held = (await resolveActor(context, params.userId, params.branchId))?.authority.permissions;
  // The manager screens: held at ANY branch or tenant-wide, because the login
  // page asks before a branch is chosen -- it decides where this person lands.
  const manages = await context.client.query<{ yes: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM app.membership m
         JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND rp.permission_key = $3) AS yes`,
    [context.tenantId, params.userId, SCREEN_KEYS.admin],
  );
  const admin = manages.rows[0]?.yes === true;
  const screens = held === undefined ? { ...NO_SCREENS, admin } : {
    kot: held.has(SCREEN_KEYS.kot as PermissionKey),
    billing: held.has(SCREEN_KEYS.billing as PermissionKey),
    kitchen: held.has(SCREEN_KEYS.kitchen as PermissionKey),
    admin,
    takings: held.has(SCREEN_KEYS.takings as PermissionKey),
    bills: held.has(SCREEN_KEYS.bills as PermissionKey),
    billEdit: held.has(SCREEN_KEYS.billEdit as PermissionKey),
    dayEnd: held.has(SCREEN_KEYS.dayEnd as PermissionKey),
    billEditAny: held.has(SCREEN_KEYS.billEditAny as PermissionKey),
    dayReopen: held.has(SCREEN_KEYS.dayReopen as PermissionKey),
  };
  return {
    kind: 'staff',
    userId: params.userId,
    fullName: row?.full_name ?? null,
    employeeCode: row?.employee_code ?? null,
    email: row?.email ?? null,
    roles: roles.rows.map((r) => ({ roleName: r.role_name, branchName: r.branch_name })),
    branchName,
    deviceName,
    screens,
  };
}
