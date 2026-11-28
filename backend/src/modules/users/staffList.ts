import type { TenantContext } from '../../database/tenantContext.js';

/**
 * Who works here, for the manager screens -- read only. Staff accounts are
 * created and managed by the Sales person (modules/platform/tenantStaff.ts);
 * the restaurant's own invite flow was removed with the Basic-only product.
 * Pending invites are still listed, so any left from before are visible.
 */

export interface StaffMember {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly employeeCode: string | null;
  readonly status: string;
  readonly roles: readonly { roleKey: string; roleName: string; branchName: string | null }[];
}

export interface PendingStaffInvite {
  readonly inviteId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly employeeCode: string | null;
  readonly roleName: string;
  readonly branchName: string | null;
  readonly credentialType: 'password' | 'pin';
  readonly expiresAt: string;
  readonly expired: boolean;
}

/**
 * Who works here, in which capacity, and who has been invited and not yet set
 * a password. The contact columns shown are the ones a manager already typed;
 * phone numbers stay behind `user.pii.view`.
 */
export async function listStaff(
  context: TenantContext,
): Promise<{ people: readonly StaffMember[]; invites: readonly PendingStaffInvite[] }> {
  const people = await context.client.query<{
    id: string; full_name: string; email: string | null; employee_code: string | null;
    status: string; roles: StaffMember['roles'] | null;
  }>(
    `SELECT u.id, u.full_name, u.email::text AS email, u.employee_code, u.status,
            (SELECT json_agg(json_build_object(
                      'roleKey', r.key, 'roleName', r.name, 'branchName', b.name)
                    ORDER BY r.name, b.name)
               FROM app.membership m
               JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
               LEFT JOIN app.branch b ON b.tenant_id = m.tenant_id AND b.id = m.branch_id
              WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active') AS roles
       FROM app.app_user u
      WHERE u.tenant_id = $1
      ORDER BY u.full_name, u.id`,
    [context.tenantId]);
  const invites = await context.client.query<{
    id: string; full_name: string; email: string | null; employee_code: string | null;
    role_name: string; branch_name: string | null; credential_type: 'password' | 'pin';
    expires_at: string; expired: boolean;
  }>(
    `SELECT i.id, i.full_name, i.email::text AS email, i.employee_code, r.name AS role_name,
            b.name AS branch_name, i.credential_type, i.expires_at::text, i.expires_at <= now() AS expired
       FROM app.staff_invite i
       JOIN app.role r ON r.tenant_id = i.tenant_id AND r.id = i.role_id
       LEFT JOIN app.branch b ON b.tenant_id = i.tenant_id AND b.id = i.branch_id
      WHERE i.tenant_id = $1 AND i.status = 'pending'
      ORDER BY i.created_at DESC`,
    [context.tenantId]);
  return {
    people: people.rows.map((row) => ({
      userId: row.id, fullName: row.full_name, email: row.email, employeeCode: row.employee_code,
      status: row.status, roles: row.roles ?? [],
    })),
    invites: invites.rows.map((row) => ({
      inviteId: row.id, fullName: row.full_name, email: row.email, employeeCode: row.employee_code,
      roleName: row.role_name, branchName: row.branch_name, credentialType: row.credential_type,
      expiresAt: row.expires_at, expired: row.expired,
    })),
  };
}
