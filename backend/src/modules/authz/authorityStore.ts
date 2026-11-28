import type { TenantContext } from '../../database/tenantContext.js';
import type { PermissionKey } from './permissions.js';
import { effectiveAuthority, type Authority, type EffectiveMembership } from './grant.js';

/**
 * Reads the acting user's authority from the database.
 *
 * This is a read model joining membership -> role -> role_permission, which is
 * not expressible as a single-table repository call. It is listed in the
 * raw-SQL gate's SQL_LAYER for that reason, and every statement here names
 * tenant_id explicitly -- asserted by the gate.
 */

export interface ResolvedActor {
  readonly userId: string;
  readonly authority: Authority;
  /**
   * Snapshotted here, at authority resolution, NOT when the audit row is written.
   *
   * If a route mutates app_user, a write-time read under READ COMMITTED would see
   * the handler's own write and stamp the *new* name as the actor of the change.
   * Reading before the handler captures the actor as they were when they acted,
   * which is what an audit log is for.
   */
  readonly actorName: string;
  readonly actorEmail: string | null;
}

interface MembershipRow {
  id: string;
  branch_id: string | null;
  discount_percent_cap: number;
  discount_amount_cap: string | null;
  permissions: string[] | null;
}

export async function resolveActor(
  context: TenantContext,
  userId: string,
  branchId: string | null,
): Promise<ResolvedActor | null> {
  const user = await context.client.query<{ full_name: string; email: string | null }>(
    `SELECT full_name, email FROM app.app_user
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [context.tenantId, userId],
  );
  const identity = user.rows[0];
  if (!identity) return null;

  const memberships = await context.client.query<MembershipRow>(
    `SELECT m.id,
            m.branch_id,
            r.discount_percent_cap,
            r.discount_amount_cap::text AS discount_amount_cap,
            array_remove(array_agg(rp.permission_key), NULL) AS permissions
       FROM app.membership m
       JOIN app.role r
         ON r.tenant_id = m.tenant_id AND r.id = m.role_id
       LEFT JOIN app.role_permission rp
         ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
      WHERE m.tenant_id = $1
        AND m.user_id = $2
        AND m.status = 'active'
        AND (m.branch_id IS NULL OR m.branch_id = $3)
      GROUP BY m.id, m.branch_id, r.discount_percent_cap, r.discount_amount_cap`,
    [context.tenantId, userId, branchId],
  );

  const effective: EffectiveMembership[] = memberships.rows.map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    permissions: (row.permissions ?? []) as PermissionKey[],
    discountPercentCap: row.discount_percent_cap,
    discountAmountCap: row.discount_amount_cap === null ? null : Number(row.discount_amount_cap),
  }));

  return {
    userId,
    authority: effectiveAuthority(effective, { branchId }),
    actorName: identity.full_name,
    actorEmail: identity.email,
  };
}
