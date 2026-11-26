import {
  PLATFORM_PERMISSION_KEYS,
  type PlatformPermissionKey,
} from './platformPermissions.js';

/**
 * The five fixed platform roles. Not user-creatable, not editable, seeded against
 * the platform catalogue on every deploy.
 */

export interface PlatformRoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly PlatformPermissionKey[];
}

const READ_ONLY: readonly PlatformPermissionKey[] = [
  // Every role reads its OWN account; the route keys it on the token's subject.
  'platform.self.view',
  'platform.tenant.view',
  'platform.plan.view',
  'platform.subscription.view',
  'platform.entitlement.view',
  'platform.invoice.view',
  'platform.payment.view',
  'platform.usage.view',
  'platform.settings.view',
  'platform.impersonation.view',
];

export const PLATFORM_ROLES = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Full control-plane authority, including platform staff and settings.',
    permissions: PLATFORM_PERMISSION_KEYS,
  },
  {
    key: 'sales',
    name: 'Salesperson',
    description:
      'Onboards and prices customers: provisions tenants, places and changes subscriptions. No refunds, no staff, no impersonation.',
    permissions: [
      ...READ_ONLY,
      'platform.tenant.provision',
      'platform.tenant.edit',
      'platform.tenant.staff',
      // Only while platform setting country.sales_may_change is on, and only
      // for restaurants they sold (modules/platform/countries.ts).
      'platform.tenant.country',
      'platform.subscription.create',
      'platform.subscription.change',
      'platform.plan.create',
    ],
  },
  {
    key: 'support',
    name: 'Support',
    description:
      'Diagnoses customer problems. May impersonate read-only. Cannot change money, plans or staff.',
    permissions: [
      ...READ_ONLY,
      'platform.tenant.edit',
      'platform.audit.view',
      'platform.impersonation.start',
      'platform.impersonation.revoke',
      'platform.entitlement.republish',
      'platform.dunning.outreach',
    ],
  },
  {
    key: 'billing',
    name: 'Billing',
    description:
      'Runs the money: invoices, refunds, credits, the ladder. Cannot provision, cannot impersonate.',
    permissions: [
      ...READ_ONLY,
      'platform.subscription.change',
      'platform.subscription.cancel',
      'platform.subscription.credit',
      'platform.refund.issue',
      'platform.dunning.outreach',
      'platform.tenant.suspend',
      'platform.tenant.export',
      'platform.plan.version',
      'platform.plan.retire',
      'platform.audit.view',
    ],
  },
  {
    key: 'read_only',
    name: 'Read Only',
    description: 'Sees the control plane and changes nothing.',
    permissions: READ_ONLY,
  },
] as const satisfies readonly PlatformRoleDefinition[];

export type PlatformRoleKey = (typeof PLATFORM_ROLES)[number]['key'];

export function platformRole(key: PlatformRoleKey): PlatformRoleDefinition {
  const found = PLATFORM_ROLES.find((r) => r.key === key);
  if (!found) throw new Error(`unknown platform role ${key}`);
  return found;
}

/**
 * The subset rule applies to platform staff exactly as it does to tenant staff:
 * **a support user cannot mint a super_admin.**
 *
 * There is no delegation widening here, because there is no separation-of-duties
 * rule on the control plane to widen for -- the only reason a platform role lacks
 * a key is seniority, and seniority is precisely what must not be self-granted.
 */
export type PlatformGrantDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly PlatformPermissionKey[] };

export function checkPlatformSubsetGrant(
  granter: readonly PlatformPermissionKey[],
  target: readonly PlatformPermissionKey[],
): PlatformGrantDecision {
  const held = new Set(granter);
  const missing = target.filter((key) => !held.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        'a platform role may only be granted with permissions the granter already holds',
      missing,
    };
  }
  return { ok: true };
}
