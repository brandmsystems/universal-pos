import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Who can sign in and how, for the manager's access page -- read only. Built on
 * app_user, credential and membership; there is no separate access table to
 * drift from them. Resetting a PIN, switching an account off or on, and adding
 * staff are the Sales person's (modules/platform/tenantStaff.ts).
 */

export interface AccessAccount {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly employeeCode: string | null;
  readonly status: string;
  readonly hasPin: boolean;
  readonly hasPassword: boolean;
  readonly lastSignInAt: string | null;
  readonly pendingReset: readonly ('pin' | 'password')[];
  readonly roles: readonly { roleKey: string; roleName: string; branchName: string | null }[];
  readonly kotAccess: boolean;
  readonly billingAccess: boolean;
  readonly kitchenAccess: boolean;
}

/**
 * Which tablet screen each key opens: taking orders (KOT), making the bill
 * (Billing), and the kitchen screen. Read from the keys a person's roles hold,
 * never from role names.
 */
// KOT is the screen that sends orders to the kitchen, so it is keyed on the send:
// a Basic `counter` account takes orders (order.create) but has no kitchen.
/**
 * `admin` is the manager screens: whoever reads the staff list manages the
 * restaurant (owner, Restaurant Admin, Manager); no KOT, Billing or kitchen role
 * holds it. The one login page sends them there and everyone else to the POS.
 */
export const SCREEN_KEYS = {
  kot: 'kot.fire', billing: 'bill.generate', kitchen: 'kds.view', admin: 'user.view', takings: 'till.summary.view',
  // Bill history, editing today's bills, and Submit Day Bills on the POS (0086).
  bills: 'bill.view', billEdit: 'bill.edit', dayEnd: 'payment.settlement.close',
  // The manager screens' half: editing any day's bill, and reopening a submitted day.
  billEditAny: 'bill.edit.any', dayReopen: 'payment.settlement.reopen',
} as const;

export async function listAccess(context: TenantContext, sessionBranchId: string | null): Promise<readonly AccessAccount[]> {
  const result = await context.client.query<{
    id: string; full_name: string; email: string | null; employee_code: string | null; status: string;
    has_pin: boolean; has_password: boolean; last_sign_in_at: string | null;
    pending: ('pin' | 'password')[] | null; roles: AccessAccount['roles'] | null;
    keys: string[] | null;
  }>(
    `SELECT u.id, u.full_name, u.email::text AS email, u.employee_code, u.status,
            EXISTS (SELECT 1 FROM app.credential c WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id
                      AND c.type = 'pin' AND c.status = 'active') AS has_pin,
            EXISTS (SELECT 1 FROM app.credential c WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id
                      AND c.type = 'password' AND c.status = 'active') AS has_password,
            (SELECT max(c.last_used_at)::text FROM app.credential c
              WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id) AS last_sign_in_at,
            (SELECT array_agg(s.credential_type ORDER BY s.credential_type) FROM app.credential_setup s
              WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.status = 'pending'
                AND s.expires_at > now()) AS pending,
            (SELECT json_agg(json_build_object('roleKey', r.key, 'roleName', r.name, 'branchName', b.name)
                    ORDER BY r.name, b.name)
               FROM app.membership m
               JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
               LEFT JOIN app.branch b ON b.tenant_id = m.tenant_id AND b.id = m.branch_id
              WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active') AS roles,
            -- Which screens the person can work, from the keys their roles
            -- actually hold rather than from role names.
            (SELECT array_agg(DISTINCT rp.permission_key)
               FROM app.membership m
               JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
              WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
                AND rp.permission_key = ANY($3::text[])) AS keys
       FROM app.app_user u
      WHERE u.tenant_id = $1
        AND u.status IN ('active', 'suspended')
        AND ($2::uuid IS NULL OR EXISTS (
              SELECT 1 FROM app.membership m
               WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.branch_id = $2 AND m.status = 'active'))
      ORDER BY u.full_name, u.id`,
    [context.tenantId, sessionBranchId, Object.values(SCREEN_KEYS)]);
  return result.rows.map((row) => ({
    userId: row.id, fullName: row.full_name, email: row.email, employeeCode: row.employee_code,
    status: row.status, hasPin: row.has_pin, hasPassword: row.has_password, lastSignInAt: row.last_sign_in_at,
    pendingReset: row.pending ?? [], roles: row.roles ?? [],
    kotAccess: row.keys?.includes(SCREEN_KEYS.kot) ?? false,
    billingAccess: row.keys?.includes(SCREEN_KEYS.billing) ?? false,
    kitchenAccess: row.keys?.includes(SCREEN_KEYS.kitchen) ?? false,
  }));
}
