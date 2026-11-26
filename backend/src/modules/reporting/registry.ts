import type { PermissionKey } from '../authz/permissions.js';

/**
 * Every report, and the key that guards it.
 *
 * Declared in one place so the coverage assertion can run BOTH directions: no
 * report without a key, and no `report.*` key without a report. An orphan key is
 * a permission an admin can grant that does nothing, which is worse than a
 * missing one -- it reads as a capability the tenant does not have.
 */

export interface ReportDefinition {
  readonly name: string;
  readonly permission: PermissionKey;
  /** Branch-scoped roles see their own branch only; tenant-wide roles see all. */
  readonly branchScoped: boolean;
  readonly summary: string;
}

export const REPORTS: readonly ReportDefinition[] = [
  {
    name: 'exception.transaction',
    permission: 'report.exception.view',
    branchScoped: true,
    summary: 'Voids, comps, discounts, recalls, tender voids, refunds, manual settlements and over-receipts, ranked against each actor\'s own baseline.',
  },
  {
    name: 'exception.configuration',
    permission: 'report.exception.view',
    branchScoped: true,
    summary: 'Price edits, recipe edits, role changes, credential resets and zero-rating grants.',
  },
  {
    name: 'sales.summary',
    permission: 'report.sales.view',
    branchScoped: true,
    summary: 'Sales by item, category, station, hour, staff and branch, on business date.',
  },
  {
    name: 'sales.export',
    permission: 'report.sales.export',
    branchScoped: true,
    summary: 'The same figures, extracted.',
  },
  {
    name: 'staff.activity',
    permission: 'report.staff.view',
    branchScoped: true,
    summary: 'Per-staff activity, attributed through authorising_membership_id.',
  },
  {
    name: 'tax.outward_supply',
    permission: 'report.sales.view',
    branchScoped: false,
    summary: 'GSTR-1 shaped outward supply: per-rate taxable value and components, B2B and B2C split, credit notes separately.',
  },
  {
    name: 'privacy.access_log',
    // NOT an exception-report key, deliberately. The audience is the DPO.
    permission: 'customer.pii.export',
    branchScoped: false,
    summary: 'Per-record PII reveals and bulk exports. Never joined into loss prevention.',
  },
];

export function reportsFor(permissions: readonly PermissionKey[]): readonly ReportDefinition[] {
  return REPORTS.filter((r) => permissions.includes(r.permission));
}
