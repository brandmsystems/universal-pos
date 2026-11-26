import { PERMISSION_KEYS, type PermissionKey } from './permissions.js';
import { withheldKeys } from './separation.js';

export { ADJUSTMENT_KEYS, TILL_KEY, TILL_KEYS, VENDOR_MASTER_KEYS } from './capabilities.js';

/**
 * The seeded system role matrix. Re-seeded idempotently per tenant on every
 * deploy: this constant is the source of truth, app.role/app.role_permission is
 * a projection. Custom roles are never touched by that reconciliation.
 *
 * System roles are locked in the database (no rename, no permission edit, no
 * delete). Tenants customise by cloning.
 */

export type AssignableScope = 'tenant_only' | 'branch_only' | 'any';

export interface SystemRoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly assignableScope: AssignableScope;
  /** 0 means no discount authority. This is the authority column. */
  readonly discountPercentCap: number;
  /** null means the percentage is the only ceiling -- NOT unlimited. Minor units. */
  readonly discountAmountCap: number | null;
  readonly permissions: readonly PermissionKey[];
}

/**
 * The clerical side of every separation rule, DERIVED from the rule set rather
 * than enumerated. Owner withholds these and keeps the principal's side; a
 * hardcoded list would leave owner silently violating any rule added later.
 *
 * Owner may still DELEGATE them -- see delegableKeys -- which is what keeps the
 * cashier role assignable.
 */
export const OWNER_WITHHELD: readonly PermissionKey[] = withheldKeys();

const FLOOR: readonly PermissionKey[] = [
  'menu.view',
  'menu.availability.toggle',
  'table.view',
  'table.session.open',
  'table.session.transfer',
  'order.view',
  'order.create',
  'order.line.add',
  'order.line.remove',
  'order.transfer',
  'kot.view',
  'kot.fire',
  // "Print again" after a send. A new print job attributed to the waiter, never
  // a retry of the original -- see requestReprint.
  'kot.reprint',
  // Where there is no kitchen screen, whoever sent the ticket says when the food
  // is ready. Refused by the domain where a kitchen screen runs.
  'kot.ready',
  'order.handover',
];

const KITCHEN: readonly PermissionKey[] = [
  // To pick its own kitchen from a list when the screen is put up, instead of a
  // manager copying a station id onto it. A read of names; it edits nothing.
  'kitchen.station.view',
  'kds.view',
  'kds.item.advance',
  'kds.item.bump',
  'kds.item.recall',
  'kot.view',
  'menu.view',
  'menu.availability.toggle',
];

const TILL: readonly PermissionKey[] = [
  'menu.view',
  'table.view',
  'table.session.close',
  'order.view',
  'bill.view',
  'bill.generate',
  'bill.split',
  'bill.merge',
  'bill.reprint',
  'payment.view',
  'payment.collect',
  'payment.tender.void',
  // The till's own X-read (what this person took). A till key, not a report:
  // it reads nothing anyone else did, so it does not reach the oversight half.
  'till.summary.view',
  // Bill history and day end on the POS (0086): today's bills, corrected before
  // the day is submitted, then submitted. Not adjustments -- see ADJUSTMENT_KEYS.
  'bill.edit',
  'payment.settlement.close',
];

const REPORTS: readonly PermissionKey[] = [
  'report.sales.view',
  'report.staff.view',
  'report.inventory.view',
  'report.exception.view',
];

const DEFINED_ROLES = [
  {
    key: 'owner',
    name: 'Restaurant Manager',
    description: 'The tenant principal. Holds every tenant-plane permission except the till.',
    assignableScope: 'tenant_only',
    discountPercentCap: 100,
    // No absolute ceiling; the percentage still binds against a finite bill.
    discountAmountCap: null,
    // Everything except the clerical half of each separation-of-duties rule.
    // Owner keeps the principal's side -- reading the reports, approving the
    // spend -- and gives up ringing the sale and maintaining the vendor master.
    // An owner who does those personally takes a second membership, which is
    // explicit and auditable rather than baked invisibly into one role, and
    // keeps the rule exception-free. No role is special.
    permissions: PERMISSION_KEYS.filter((k) => !OWNER_WITHHELD.includes(k)),
  },
  {
    key: 'branch_admin',
    name: 'Restaurant Admin',
    description: 'Runs one branch end to end, including staff and exceptions. Not the till.',
    assignableScope: 'branch_only',
    discountPercentCap: 50,
    discountAmountCap: 1_000_00,
    permissions: [
      'tenant.settings.view',
      'branch.view',
      'branch.edit',
      // Held so branch_admin can onboard a manager and a cashier, both of whom
      // need it: `checkSubsetGrant` refuses a grantor a key it does not hold,
      // and that is the failure `loyalty.redeem` caused in phase 14. Reading
      // the rates is also simply necessary to read a menu item.
      'tax.class.view',
      'bill.recipient.set',
      'user.view',
      'user.invite',
      'user.edit',
      'user.suspend',
      'user.credential.reset',
      'user.credential.unlock',
      'role.view',
      'membership.view',
      'membership.grant',
      'membership.revoke',
      'audit.view',
      ...FLOOR,
      ...KITCHEN,
      'tax.class.view',
      // Typing a company's name and GSTIN onto a bill. Clerical, and a manager
      // covering a till has to be able to do it.
      'bill.recipient.set',
      'menu.category.edit',
      'menu.item.create',
      'menu.item.edit',
      'menu.item.archive',
      'menu.price.edit',
      'table.edit',
      'table.session.close',
      'table.session.merge',
      // Escalation-class, and manager is not a broadly assigned role. Taking a
      // session from a dead tablet is a shift-floor problem that cannot wait for
      // an owner to be found.
      'table.session.lease.force_release',
      // Recording that a manual card machine took the money during an outage.
      // Financial-transaction class: the reason code and the exception report are
      // the control, exactly as with payment.tender.void on cashier.
      'payment.settle.manual',
      'kitchen.station.view',
      'kitchen.station.edit',
      'printer.view',
      'printer.edit',
      'printer.job.retry',
      'device.view',
      'device.register',
      'device.revoke',
      'kot.recall',
      'order.void',
      'order.comp',
      'order.discount',
      'order.reopen',
      'order.cancel',
      'bill.view',
      'bill.generate',
      'bill.split',
      'bill.merge',
      'bill.reprint',
      'bill.void',
      'payment.view',
      'payment.refund',
      'payment.settlement.view',
      'payment.settlement.close',
      'payment.settlement.reopen',
      'bill.edit',
      'bill.edit.any',
      'customer.edit',
      'customer.pii.view',
      // Split out of customer.pii.view by migration 0049. Branch Admin already
      // held the staff directory in practice, because until then the customer
      // key was what the reveal route actually checked while reading app_user.
      'user.pii.view',
      // An ADJUSTMENT key, so `till-vs-record` refuses it to any role holding
      // the till. Branch Admin does not hold the till -- which is the whole
      // reason a goodwill grant after a complaint belongs here.
      'loyalty.adjust',
      'inventory.view',
      'inventory.adjust',
      'inventory.count.perform',
      'inventory.count.approve',
      'inventory.transfer',
      'product.view',
      'recipe.view',
      'supplier.view',
      'purchase.order.view',
      'purchase.order.create',
      'purchase.order.approve',
      'purchase.receive',
      ...REPORTS,
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Shift authority: approves exceptions and reads reports. Not the till.',
    assignableScope: 'any',
    discountPercentCap: 20,
    discountAmountCap: 200_00,
    permissions: [
      'branch.view',
      'user.view',
      'user.credential.unlock',
      'membership.view',
      ...FLOOR,
      ...KITCHEN,
      'table.edit',
      'table.session.close',
      'table.session.merge',
      // Escalation-class, and manager is not a broadly assigned role. Taking a
      // session from a dead tablet is a shift-floor problem that cannot wait for
      // an owner to be found.
      'table.session.lease.force_release',
      // Recording that a manual card machine took the money during an outage.
      // Financial-transaction class: the reason code and the exception report are
      // the control, exactly as with payment.tender.void on cashier.
      'payment.settle.manual',
      'printer.view',
      'printer.job.retry',
      'kitchen.station.view',
      // A manager can kill a stolen terminal mid-shift, but enrolling one is an
      // escalation vector and stays with branch_admin.
      'device.view',
      'device.revoke',
      'kot.recall',
      'order.void',
      'order.comp',
      'order.discount',
      'order.reopen',
      'order.cancel',
      'bill.view',
      'bill.generate',
      'bill.split',
      'bill.merge',
      'bill.reprint',
      'bill.void',
      'payment.view',
      'payment.refund',
      'payment.settlement.view',
      'customer.edit',
      'customer.pii.view',
      // Shift authority, no till: the same reason branch_admin has it.
      'loyalty.adjust',
      'inventory.view',
      'inventory.waste',
      'inventory.count.perform',
      'product.view',
      'recipe.view',
      ...REPORTS,
    ],
  },
  {
    key: 'cashier',
    name: 'Billing Staff',
    description: 'Works the Billing screen: bills orders KOT has handed over and takes payment. Takes no orders, holds no report and no adjustment key.',
    assignableScope: 'branch_only',
    discountPercentCap: 0,
    discountAmountCap: null,
    permissions: [...TILL],
  },
  {
    // The Billing account on BASIC, where there is no KOT and nobody else takes
    // the order. A separate role rather than order keys on `cashier`: on Pro,
    // Billing Staff must not open orders past KOT and the kitchen, and a role's
    // keys cannot depend on the plan. The three added keys are the Billing
    // screen's New order and nothing more -- no kitchen send, and none is an
    // adjustment key, so payment.collect beside them keeps separation of duties.
    key: 'counter',
    name: 'Billing & Orders',
    description: 'Basic plan: works the Billing screen alone -- takes the order at the counter or a table, bills it and takes payment. Sends nothing to a kitchen, holds no report and no adjustment key.',
    assignableScope: 'branch_only',
    discountPercentCap: 0,
    discountAmountCap: null,
    permissions: [...TILL, 'table.session.open', 'order.create', 'order.handover'],
  },
  {
    key: 'waiter',
    name: 'KOT Staff',
    description: 'Works the KOT screen: seats tables, takes orders, sends them to the kitchen and hands them to billing. Can correct a line before it is sent.',
    assignableScope: 'branch_only',
    discountPercentCap: 0,
    discountAmountCap: null,
    permissions: [...FLOOR],
  },
  {
    key: 'kds',
    name: 'KDS Staff',
    description: 'Works the kitchen screen (KDS) at one kitchen: sees its tickets and moves dishes from new to preparing to ready.',
    assignableScope: 'branch_only',
    discountPercentCap: 0,
    discountAmountCap: null,
    permissions: [...KITCHEN],
  },
  {
    key: 'accounts',
    name: 'Accounts',
    description:
      'Owns the vendor master and raises purchase orders. Never takes payment, never touches an order, and never approves the orders it raises.',
    assignableScope: 'any',
    discountPercentCap: 0,
    discountAmountCap: null,
    permissions: [
      'tenant.billing.view',
      'branch.view',
      'audit.view',
      // Whoever files the return needs to see the rates the return was struck
      // at. Read only: setting a rate is the principal's act.
      'tax.class.view',
      'bill.view',
      'payment.view',
      'payment.settlement.view',
      'inventory.view',
      'product.view',
      'product.create',
      'product.edit',
      'product.archive',
      'recipe.view',
      'supplier.view',
      'supplier.create',
      'supplier.edit',
      'purchase.order.view',
      'purchase.order.create',
      // Deliberately NOT purchase.order.approve or purchase.receive. Accounts
      // owns the vendor master and raises the order; approving it and confirming
      // the goods arrived belong to someone else. Otherwise one role can invent
      // a supplier, raise a purchase order to it, approve it and receive against
      // it -- the accounts-side equivalent of the till problem.
      'report.sales.view',
      'report.sales.export',
      'report.inventory.view',
      'report.exception.view',
    ],
  },
] as const satisfies readonly SystemRoleDefinition[];

/**
 * Keys every built-in role holds, ADDED here rather than listed in each role, so a
 * role added later cannot be left unable to say who is signed in. Owner already
 * holds them through PERMISSION_KEYS; the Set keeps that from duplicating.
 */
const EVERY_ROLE: readonly PermissionKey[] = ['user.self.view'];

export const SYSTEM_ROLES = DEFINED_ROLES.map((role) => ({
  ...role,
  permissions: [...new Set<PermissionKey>([...role.permissions, ...EVERY_ROLE])],
}));

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number]['key'];

export function systemRole(key: SystemRoleKey): SystemRoleDefinition {
  const found = SYSTEM_ROLES.find((r) => r.key === key);
  if (!found) throw new Error(`unknown system role ${key}`);
  return found;
}
