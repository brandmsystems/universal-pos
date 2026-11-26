import type { PermissionKey } from './permissions.js';

/**
 * Capability groupings the separation rules are built from. Kept in their own
 * module so separation.ts can consume them without importing the role matrix,
 * which in turn derives its owner exclusions from the rules.
 */

/**
 * Post-commitment changes to a money or stock record. Pre-commitment corrections
 * (order.line.remove, payment.tender.void, bill.edit) are deliberately absent:
 * they belong to the person doing the work, which is the same line the
 * order.void split draws.
 *
 * `bill.edit` is the till's correction of TODAY's bills before the day is
 * submitted, and it is a correction rather than an adjustment because day end
 * is the commitment point: `assertMayEditDay` (payments/dayEnd.ts) refuses it
 * for a previous day and for a submitted one, and it can never take money back
 * off a paid bill. Everything after day end -- any edit of a submitted day,
 * reopening one, a refund -- is a manager's adjustment, below.
 */
export const ADJUSTMENT_KEYS: readonly PermissionKey[] = [
  'order.void',
  'order.comp',
  'order.discount',
  'order.reopen',
  'order.cancel',
  'bill.void',
  'bill.edit.any',
  'payment.refund',
  'payment.settlement.reopen',
  'inventory.adjust',
  'inventory.count.approve',
  'purchase.order.approve',
  // Granting or removing points by hand. Listed here rather than given its own
  // separation rule, and that is the point of the rule set being derived: being
  // an adjustment key is ALL it takes for `till-vs-record` to refuse a role
  // that also holds the till. A cashier who could spend points and also grant
  // them is a till with no counterparty.
  'loyalty.adjust',
];

/**
 * The till capacity is three keys, not one. payment.tender.void is only
 * meaningful to whoever took the tender, in the session they took it, and
 * loyalty.redeem is a tender by another means -- both travel with the till and
 * must be withheld and delegated alongside it, or the cashier role becomes
 * unassignable for want of a part of itself.
 *
 * loyalty.redeem was added here by being needed: with it on cashier and not in
 * this list, `checkSubsetGrant` refused branch_admin the ability to onboard a
 * cashier at all -- branch_admin deliberately does not hold the till, so it
 * could not hand out a key it does not have. That is the exact failure the
 * note above was written for, and the derivation caught it rather than a
 * reviewer.
 *
 * Being a trigger here also means `till-vs-record` refuses loyalty.redeem to
 * any role holding an adjustment key or a report -- so whoever spends points
 * cannot also grant them or reconcile the ledger that records it.
 */
export const TILL_KEYS: readonly PermissionKey[] =
  ['payment.collect', 'payment.tender.void', 'loyalty.redeem', 'till.summary.view'];

export const TILL_KEY: PermissionKey = 'payment.collect';

/** Maintaining the supplier master: the half that must not sit with approval. */
export const VENDOR_MASTER_KEYS: readonly PermissionKey[] = ['supplier.create', 'supplier.edit'];

/**
 * Posting a stock write-off. The operational half of waste-vs-adjustment: the
 * kitchen is the only party who knows a tray went on the floor, so the key sits
 * with them and the principal withholds it like the till.
 */
export const WASTE_KEYS: readonly PermissionKey[] = ['inventory.waste'];
