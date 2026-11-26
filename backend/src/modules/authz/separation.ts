import type { PermissionKey } from './permissions.js';
import { ADJUSTMENT_KEYS, TILL_KEYS, VENDOR_MASTER_KEYS, WASTE_KEYS } from './capabilities.js';

/**
 * Separation of duties, as a rule set rather than a list of keys.
 *
 * Everything downstream is derived from this array at runtime -- which keys owner
 * withholds, and which keys a delegator may hand out despite not holding them.
 * Adding a rule here must require no edit anywhere else; there is a test that
 * introduces a synthetic fourth rule and asserts exactly that.
 */

export interface SeparationRule {
  readonly name: string;
  /**
   * The operational half. Holding any of these triggers the rule.
   *
   * By convention this is also the half a principal withholds and delegates: the
   * clerical act (ringing the sale, maintaining the vendor master) rather than
   * the oversight of it (reading the reports, approving the spend).
   */
  readonly trigger: readonly PermissionKey[];
  /** Having triggered, holding any key matching this is a violation. */
  readonly conflicts: (key: PermissionKey) => boolean;
  readonly why: string;
}

export const SEPARATION_RULES: readonly SeparationRule[] = [
  {
    name: 'till-vs-record',
    trigger: TILL_KEYS,
    conflicts: (key) => key.startsWith('report.') || ADJUSTMENT_KEYS.includes(key),
    why: 'the person taking money is not the person who can reconcile or amend the record of it',
  },
  {
    name: 'vendor-master-vs-approval',
    trigger: VENDOR_MASTER_KEYS,
    // BOTH halves of "the goods and the money arrived". Approval authorises the
    // payment; receipt attests the goods turned up. A role holding the vendor
    // master and either one can complete a fake-vendor cycle on its own, so the
    // rule covers both -- it previously named only `approve`, which the seeded
    // matrix happened to satisfy, so the assertion greened while testing less
    // than CLAUDE.md claimed.
    conflicts: (key) => key === 'purchase.order.approve' || key === 'purchase.receive',
    why: 'inventing a supplier and then approving or receiving against it is fake-vendor fraud in one role',
  },
  {
    name: 'waste-vs-adjustment',
    trigger: WASTE_KEYS,
    // Writing stock off and then reconciling the balance to a shape nobody
    // queries is the stock-side equivalent of the till problem: the same person
    // both removes the goods and repairs the number that would have shown it.
    // Separately each is visible -- waste is a line a chef explains, adjustment
    // is a correction with a name on it.
    conflicts: (key) => key === 'inventory.adjust' || key === 'inventory.count.approve',
    why: 'writing stock off and then adjusting the balance to match hides the loss in one role',
  },
];

export interface SeparationViolation {
  readonly rule: string;
  readonly triggeredBy: PermissionKey;
  readonly conflicting: readonly PermissionKey[];
}

/**
 * Evaluated over a single role's permission set, and asserted against the seeded
 * matrix so it cannot rot as roles are edited.
 */
export function separationOfDutiesViolations(
  permissions: readonly PermissionKey[],
  rules: readonly SeparationRule[] = SEPARATION_RULES,
): readonly SeparationViolation[] {
  const violations: SeparationViolation[] = [];

  for (const rule of rules) {
    const triggeredBy = rule.trigger.find((key) => permissions.includes(key));
    if (!triggeredBy) continue;
    const conflicting = permissions.filter(rule.conflicts);
    if (conflicting.length > 0) {
      violations.push({ rule: rule.name, triggeredBy, conflicting });
    }
  }

  return violations;
}

/**
 * The keys a principal withholds: the trigger half of every rule, derived rather
 * than enumerated. A hardcoded list here would leave owner silently violating any
 * rule added later.
 */
export function withheldKeys(
  rules: readonly SeparationRule[] = SEPARATION_RULES,
): readonly PermissionKey[] {
  return [...new Set(rules.flatMap((rule) => rule.trigger))];
}
