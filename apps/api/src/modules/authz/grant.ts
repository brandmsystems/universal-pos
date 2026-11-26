import type { PermissionKey } from './permissions.js';
import {
  SEPARATION_RULES,
  separationOfDutiesViolations,
  type SeparationRule,
  type SeparationViolation,
} from './separation.js';

export { SEPARATION_RULES, separationOfDutiesViolations } from './separation.js';
export type { SeparationRule, SeparationViolation } from './separation.js';

/**
 * Privilege escalation via user.invite and role.edit is not expressible as a
 * permission key. A manager who can invite staff and assign roles can grant
 * themselves -- or a confederate -- a second membership carrying a superset
 * role. Without the rule below, user.invite is effectively owner.
 *
 *   A user may only grant a role whose permission set is a subset of the union
 *   of their own effective permissions in that scope.
 *
 * The same rule governs authoring: you cannot create or edit a role containing a
 * permission you do not hold. Discount authority is part of the comparison,
 * because a cap is authority that a bare key-subset check would miss entirely.
 */

export interface Scope {
  /** null means tenant-wide. */
  readonly branchId: string | null;
}

export interface EffectiveMembership {
  readonly id: string;
  /** null means the membership is tenant-wide and applies at every branch. */
  readonly branchId: string | null;
  readonly permissions: readonly PermissionKey[];
  readonly discountPercentCap: number;
  readonly discountAmountCap: number | null;
}

export interface Authority {
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly discountPercentCap: number;
  readonly discountAmountCap: number | null;
  /**
   * Which membership authorises each key.
   *
   * Dual capacity is modelled as two memberships, never as one role holding both
   * sides -- so when the owner collects a payment, something has to record which
   * capacity they were acting in. Without this, separation of duties is a
   * comment: the union says the person could do it, and nothing says which hat
   * they were wearing. This map is what makes tenant_audit_log
   * .authorising_membership_id a fact rather than an inference.
   */
  readonly authorisedBy: ReadonlyMap<PermissionKey, string>;
}

export interface GrantTarget {
  readonly permissions: readonly PermissionKey[];
  readonly discountPercentCap: number;
  readonly discountAmountCap: number | null;
}

export type GrantDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly PermissionKey[] };

/**
 * Effective authority is the union across every active membership that applies
 * at the scope in question: tenant-wide memberships apply everywhere, branch
 * memberships only at their own branch.
 *
 * Caps take the maximum rather than the minimum, which is the only choice
 * consistent with permissions being a union -- holding more roles cannot leave
 * someone with less authority than one of them alone.
 *
 * Where several memberships satisfy the same key, the narrowest scope wins:
 * branch over tenant-wide. That is the capacity the person was actually acting
 * in -- an owner ringing a sale at Branch 2 is acting as that branch's cashier,
 * not as the owner.
 */
export function effectiveAuthority(
  memberships: readonly EffectiveMembership[],
  scope: Scope,
): Authority {
  const applicable = memberships.filter(
    (m) => m.branchId === null || m.branchId === scope.branchId,
  );

  // Branch-scoped first, then by id so the choice is stable across runs.
  const ordered = [...applicable].sort((a, b) => {
    const aWide = a.branchId === null ? 1 : 0;
    const bWide = b.branchId === null ? 1 : 0;
    if (aWide !== bWide) return aWide - bWide;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const permissions = new Set<PermissionKey>();
  const authorisedBy = new Map<PermissionKey, string>();
  let percentCap = 0;
  let amountCap: number | null = 0;

  for (const membership of ordered) {
    for (const key of membership.permissions) {
      permissions.add(key);
      if (!authorisedBy.has(key)) authorisedBy.set(key, membership.id);
    }
    percentCap = Math.max(percentCap, membership.discountPercentCap);
    // null is the weakest ceiling (percentage-only), so it wins the maximum.
    if (amountCap !== null) {
      amountCap =
        membership.discountAmountCap === null
          ? null
          : Math.max(amountCap, membership.discountAmountCap);
    }
  }

  return { permissions, discountPercentCap: percentCap, discountAmountCap: amountCap, authorisedBy };
}

/**
 * The membership to stamp on the audit row for an action permitted by `key`.
 * Null means no membership authorises it -- the caller must refuse, not fall
 * back to an unattributed write.
 */
export function authorisingMembershipFor(
  authority: Authority,
  key: PermissionKey,
): string | null {
  return authority.authorisedBy.get(key) ?? null;
}

/**
 * Delegation authority is not the same as exercise authority.
 *
 * Separation of duties denies every membership-granting role the till, and the
 * subset rule says you may only grant what you hold -- so together they made the
 * cashier role unassignable by anyone, forever. The system could not onboard a
 * cashier at all.
 *
 * The fix is structural rather than an exemption for a favoured role: a delegator
 * may also delegate the keys it is denied *purely because it holds the other side
 * of a separation-of-duties rule*. Owner is denied `payment.collect` only because
 * it holds reports and adjustments, so it may still delegate it. It is not denied
 * `role.create` on those grounds, so nothing is widened there.
 *
 * Gated on actually holding `membership.grant`, which is what keeps "manager
 * cannot grant cashier" true -- and true for the right reason. Manager has no
 * delegation authority at all; branch_admin and owner do, which is how onboarding
 * works.
 */
export function delegableKeys(
  authority: Authority,
  rules: readonly SeparationRule[] = SEPARATION_RULES,
): ReadonlySet<PermissionKey> {
  const keys = new Set(authority.permissions);
  if (!authority.permissions.has('membership.grant')) return keys;

  for (const rule of rules) {
    const holdsOtherSide = [...authority.permissions].some(rule.conflicts);
    if (holdsOtherSide) {
      for (const key of rule.trigger) keys.add(key);
    }
  }
  return keys;
}

/**
 * The subset rule. Used identically for granting a role to someone and for
 * authoring or editing a role -- they are the same escalation with different
 * spelling.
 */
export function checkSubsetGrant(
  granter: Authority,
  target: GrantTarget,
  rules: readonly SeparationRule[] = SEPARATION_RULES,
): GrantDecision {
  // A role that violates separation of duties may not be authored or assigned by
  // anyone, at any seniority. This is what makes the delegation widening above
  // safe: it lets owner hand out `cashier`, never author a till-plus-reports role.
  const selfConflicting = separationOfDutiesViolations(target.permissions, rules);
  if (selfConflicting.length > 0) {
    const first = selfConflicting[0]!;
    return {
      ok: false,
      reason: `the role violates separation of duties (${first.rule}): ${first.triggeredBy} with ${first.conflicting.join(', ')}`,
      missing: [],
    };
  }

  const delegable = delegableKeys(granter, rules);
  const missing = target.permissions.filter((key) => !delegable.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        'a role may only be granted or authored with permissions the granter already holds in this scope',
      missing,
    };
  }

  // The percentage cap is the authority. At zero the role cannot discount at all,
  // so its amount ceiling describes nothing and must not block the grant --
  // otherwise a bounded manager could not hand out `waiter`, whose amount cap is
  // null only because it has no discount authority to bound.
  if (target.discountPercentCap > 0) {
    if (target.discountPercentCap > granter.discountPercentCap) {
      return {
        ok: false,
        reason: `discount cap ${target.discountPercentCap}% exceeds the granter's ${granter.discountPercentCap}%`,
        missing: [],
      };
    }

    // A null ceiling means "percentage only", which is weaker than any absolute
    // ceiling -- so it may only be granted by someone themselves unbounded.
    if (target.discountAmountCap === null && granter.discountAmountCap !== null) {
      return {
        ok: false,
        reason: 'an unbounded discount amount cannot be granted by a granter who is bounded',
        missing: [],
      };
    }
    if (
      target.discountAmountCap !== null &&
      granter.discountAmountCap !== null &&
      target.discountAmountCap > granter.discountAmountCap
    ) {
      return {
        ok: false,
        reason: `discount amount cap ${target.discountAmountCap} exceeds the granter's ${granter.discountAmountCap}`,
        missing: [],
      };
    }
  }

  return { ok: true };
}

export interface AccumulatedConflict extends SeparationViolation {
  /** The membership that supplies the trigger key, and the one supplying the conflict. */
  readonly triggerMembershipId: string | null;
  readonly conflictMembershipId: string | null;
}

/**
 * The people-level counterpart. Not blocked -- a small restaurant legitimately
 * has one person doing both -- but reported, because in a large one it is how
 * the till walks out of the door.
 *
 * This reports who *could* exercise both capacities. Who actually did is a query
 * over tenant_audit_log.authorising_membership_id, which is the stronger signal.
 */
export function accumulatedSeparationConflicts(
  authority: Authority,
  rules: readonly SeparationRule[] = SEPARATION_RULES,
): readonly AccumulatedConflict[] {
  const held = [...authority.permissions];
  return separationOfDutiesViolations(held, rules).map((violation) => ({
    ...violation,
    triggerMembershipId: authority.authorisedBy.get(violation.triggeredBy) ?? null,
    conflictMembershipId: violation.conflicting[0]
      ? (authority.authorisedBy.get(violation.conflicting[0]) ?? null)
      : null,
  }));
}
