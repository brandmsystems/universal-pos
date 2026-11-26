import { PLATFORM_ROLES } from '../../modules/authz/platformRoles.js';
import type { PlatformPermissionKey } from '../../modules/authz/platformPermissions.js';

/**
 * Per-key authorisation on the control plane.
 *
 * ###########################################################################
 * HOLDING *A* PLATFORM ROLE IS NOT AUTHORISATION.
 *
 * The plane guard proves a token carries `platform_role` and nothing more. That
 * was the whole check for the control plane, which meant `read_only` --
 * deliberately the weakest role in the catalogue -- reached
 * `POST /api/platform/impersonation` and could enter any tenant.
 *
 * The Phase 1 platform catalogue and the subset rule both existed; nothing at the
 * route layer was reading them. This is the piece that does: `registerPlatformRoute`
 * calls it for every route that declares a platform permission, so there is one
 * check and no per-route hook to forget.
 * ###########################################################################
 *
 * Pure resolution from the seeded role definitions: a role's permission set is a
 * constant, so the check needs no database round trip on the hot path and no
 * cache that could go stale.
 */
const PERMISSIONS_BY_ROLE = new Map<string, ReadonlySet<PlatformPermissionKey>>(
  PLATFORM_ROLES.map((role) => [role.key, new Set(role.permissions)]),
);

export function platformRoleHolds(
  roleKey: unknown,
  permission: PlatformPermissionKey,
): boolean {
  if (typeof roleKey !== 'string') return false;
  const held = PERMISSIONS_BY_ROLE.get(roleKey);
  // An unknown role holds nothing. Absence denies, as everywhere else.
  return held?.has(permission) ?? false;
}
