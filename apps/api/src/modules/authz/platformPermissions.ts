/**
 * The CONTROL-PLANE permission catalogue. Entirely separate from the tenant one:
 * no shared keys, no shared table, no shared type. A platform key granting
 * anything on the tenant plane would be the boundary crossing the whole design
 * exists to prevent, and sharing the vocabulary is how that starts.
 *
 * Deferred from Phase 0 on purpose -- nothing then specified what `sales` may do
 * that `support` may not, and guessing would have been worse than waiting for the
 * routes to exist. They exist now.
 *
 * Note what is absent: there is no key here that reads tenant operational data.
 * The control plane never queries orders. Aggregates arrive by rollup.
 */

export type PlatformRiskClass = 'none' | 'financial' | 'escalation' | 'privacy';

export interface PlatformPermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly name: string;
  readonly description: string;
  readonly riskClass?: Exclude<PlatformRiskClass, 'none'>;
}

export const PLATFORM_PERMISSIONS = [
  // --------------------------------------------------------------- tenants
  { key: 'platform.tenant.view', module: 'tenant', name: 'View tenants', description: 'List and read tenant records and their lifecycle status.' },
  { key: 'platform.tenant.provision', module: 'tenant', name: 'Provision a tenant', description: 'Create a tenant, its first branch, its seeded roles and its owner invite.', riskClass: 'escalation' },
  { key: 'platform.tenant.edit', module: 'tenant', name: 'Edit a tenant', description: 'Change tenant name, legal name, address, theme colour or logo.' },
  { key: 'platform.tenant.staff', module: 'tenant', name: 'Manage the staff of restaurants you sold', description: 'Add staff with a 4-digit PIN, reset a PIN, change what they can use, and switch them off or on -- at restaurants this person provisioned. Never a manager account. Counted against the plan\'s user limit.', riskClass: 'escalation' },
  { key: 'platform.tenant.staff.any', module: 'tenant', name: 'Manage the staff of any restaurant', description: 'The same, at every restaurant on the estate.', riskClass: 'escalation' },
  { key: 'platform.tenant.country', module: 'tenant', name: 'Change a restaurant\'s country and currency', description: 'Before its first bill only, with an optional exchange-rate conversion of its prices that must be confirmed. A Sales person may do it only for restaurants they sold, and only while a Super Admin allows it in platform settings.', riskClass: 'financial' },
  { key: 'platform.tenant.country.any', module: 'tenant', name: 'Change the country of any restaurant', description: 'The same, at every restaurant on the estate, whatever the Sales setting says.', riskClass: 'financial' },
  { key: 'platform.tenant.rename', module: 'tenant', name: 'Change a restaurant\'s address', description: 'Give a restaurant a new slug. The old one keeps resolving and can never be taken by another restaurant.' },
  { key: 'platform.tenant.suspend', module: 'tenant', name: 'Move a tenant along the ladder', description: 'Advance or clear a suspension state manually. Requires a reason.', riskClass: 'financial' },
  { key: 'platform.tenant.purge', module: 'tenant', name: 'Purge a tenant', description: 'Anonymise and drop at the end of the retention window. Irreversible.', riskClass: 'privacy' },
  { key: 'platform.tenant.export', module: 'tenant', name: 'Export a tenant', description: 'Produce a data export during the retention window.', riskClass: 'privacy' },

  // ----------------------------------------------------------------- plans
  { key: 'platform.plan.view', module: 'plan', name: 'View plans', description: 'Read plans and their versions.' },
  { key: 'platform.plan.create', module: 'plan', name: 'Create a plan', description: 'Define a new plan.' },
  { key: 'platform.plan.version', module: 'plan', name: 'Publish a plan version', description: 'Publish a new version. Live subscriptions stay on their version until migrated.', riskClass: 'financial' },
  { key: 'platform.plan.retire', module: 'plan', name: 'Retire a plan', description: 'Stop offering a plan. Existing subscriptions continue.' },

  // --------------------------------------------------------- subscriptions
  { key: 'platform.subscription.view', module: 'subscription', name: 'View subscriptions', description: 'Read a tenant’s subscription and its history.' },
  { key: 'platform.subscription.create', module: 'subscription', name: 'Create a subscription', description: 'Place a tenant on a plan version.', riskClass: 'financial' },
  { key: 'platform.subscription.change', module: 'subscription', name: 'Change a subscription', description: 'Upgrade, downgrade or migrate to another plan version.', riskClass: 'financial' },
  { key: 'platform.subscription.cancel', module: 'subscription', name: 'Cancel a subscription', description: 'End a subscription. Starts the ladder.', riskClass: 'financial' },
  { key: 'platform.subscription.credit', module: 'subscription', name: 'Apply a credit', description: 'Credit a tenant’s account. Requires a reason code.', riskClass: 'financial' },

  // ---------------------------------------------------------- entitlements
  { key: 'platform.entitlement.view', module: 'entitlement', name: 'View entitlements', description: 'Read the published entitlement document for a tenant.' },
  { key: 'platform.entitlement.republish', module: 'entitlement', name: 'Republish entitlements', description: 'Force a new entitlement version. Used to repair a stuck cache.', riskClass: 'escalation' },

  // ---------------------------------------------------------------- billing
  { key: 'platform.invoice.view', module: 'billing', name: 'View invoices', description: 'Read invoices and payment status.' },
  { key: 'platform.payment.view', module: 'billing', name: 'View platform payments', description: 'Read payments received from tenants.' },
  { key: 'platform.dunning.outreach', module: 'billing', name: 'Record dunning outreach', description: 'Log that a delinquent tenant’s owner was contacted. A write: the record is what stops the next person repeating the call.' },
  { key: 'platform.refund.issue', module: 'billing', name: 'Refund a tenant', description: 'Refund a platform payment. Requires a reason code and the original reference.', riskClass: 'financial' },

  // ------------------------------------------------------------ platform staff
  { key: 'platform.self.view', module: 'staff', name: 'View your own account', description: 'Read your own name, email, phone, role and status. Every platform role holds it; it answers only for the signed-in user.' },
  { key: 'platform.user.view', module: 'staff', name: 'View platform staff', description: 'List platform users and their roles.' },
  { key: 'platform.user.create', module: 'staff', name: 'Create a platform user', description: 'Add platform staff. Governed by the platform subset rule.', riskClass: 'escalation' },
  { key: 'platform.user.edit', module: 'staff', name: 'Edit platform staff', description: 'Change a platform user’s name, email or phone. Not their role, and not their password.' },
  { key: 'platform.user.suspend', module: 'staff', name: 'Suspend platform staff', description: 'Disable a platform account.', riskClass: 'escalation' },
  { key: 'platform.role.assign', module: 'staff', name: 'Assign a platform role', description: 'Change a platform user’s role. Governed by the platform subset rule.', riskClass: 'escalation' },

  // --------------------------------------------------------- impersonation
  { key: 'platform.impersonation.start', module: 'impersonation', name: 'Start an impersonation session', description: 'Read-only by default. Max 60 minutes. Mandatory typed reason.', riskClass: 'escalation' },
  { key: 'platform.impersonation.write', module: 'impersonation', name: 'Impersonate with write access', description: 'Separate flag with its own reason. Every write is tagged in the tenant’s own audit log.', riskClass: 'escalation' },
  { key: 'platform.impersonation.revoke', module: 'impersonation', name: 'Revoke an impersonation session', description: 'End any live session immediately.' },
  { key: 'platform.impersonation.view', module: 'impersonation', name: 'View impersonation history', description: 'Read the impersonation session log.' },

  // ----------------------------------------------------------------- audit
  { key: 'platform.audit.view', module: 'audit', name: 'View the platform audit log', description: 'Read control-plane audit history.' },

  // -------------------------------------------------------------- metering
  { key: 'platform.usage.view', module: 'usage', name: 'View usage aggregates', description: 'Read daily rollups. Aggregates only: never individual orders or customers.' },

  // -------------------------------------------------------------- settings
  { key: 'platform.settings.view', module: 'settings', name: 'View platform settings', description: 'Read the suspension ladder thresholds and other platform configuration.' },
  { key: 'platform.settings.edit', module: 'settings', name: 'Edit platform settings', description: 'Change ladder thresholds, the countries offered and the default country, and whether Sales may change a restaurant\'s country. Affects every tenant.', riskClass: 'escalation' },
] as const satisfies readonly PlatformPermissionDefinition[];

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[number]['key'];

export const PLATFORM_PERMISSION_KEYS: readonly PlatformPermissionKey[] =
  PLATFORM_PERMISSIONS.map((p) => p.key);

export function platformRiskClassOf(key: PlatformPermissionKey): PlatformRiskClass {
  const found = PLATFORM_PERMISSIONS.find((p) => p.key === key);
  if (!found) throw new Error(`unknown platform permission ${key}`);
  return 'riskClass' in found ? found.riskClass : 'none';
}

export const PLATFORM_PERMISSION_MODULES: readonly string[] = [
  ...new Set(PLATFORM_PERMISSIONS.map((p) => p.module)),
];
