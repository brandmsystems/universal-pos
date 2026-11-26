import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '../../src/modules/authz/permissions.js';
import {
  SEPARATION_RULES,
  separationOfDutiesViolations,
  withheldKeys,
  type SeparationRule,
} from '../../src/modules/authz/separation.js';
import { checkSubsetGrant, delegableKeys, effectiveAuthority } from '../../src/modules/authz/grant.js';
import { OWNER_WITHHELD } from '../../src/modules/authz/systemRoles.js';
import { assertCheckedSet } from '../helpers/db.js';

/**
 * The delegation exemption and the owner exclusions must both be DERIVED from the
 * separation rule set at runtime. If either were an enumerated key list, adding a
 * rule would silently leave owner violating it, or leave the newly separated role
 * unassignable.
 *
 * The proof: introduce a synthetic fourth rule as a fixture and assert the
 * machinery adapts with no edit to the delegation code. If this file ever needs
 * grant.ts changed to pass, the exemption has been enumerated and is wrong.
 */

// Deliberately a pairing that does not exist in the real matrix.
const SYNTHETIC: SeparationRule = {
  name: 'count-vs-transfer',
  trigger: ['inventory.count.perform'],
  conflicts: (key) => key === 'inventory.transfer',
  why: 'counting the stock and moving it are the same fraud in one pair of hands',
};

const WITH_SYNTHETIC: readonly SeparationRule[] = [...SEPARATION_RULES, SYNTHETIC];

function authorityOf(permissions: readonly PermissionKey[]) {
  return effectiveAuthority(
    [
      {
        id: 'm-under-test',
        branchId: null,
        permissions,
        discountPercentCap: 0,
        discountAmountCap: null,
      },
    ],
    { branchId: null },
  );
}

describe('the separation rule set is the single source', () => {
  it('derives the owner exclusions from the rules, not from a list', () => {
    assertCheckedSet({
      label: 'owner-withheld keys',
      checked: [...OWNER_WITHHELD],
      minimum: 4,
      mustInclude: ['payment.collect', 'payment.tender.void', 'supplier.create', 'supplier.edit'],
    });
    expect([...OWNER_WITHHELD].sort()).toEqual([...withheldKeys()].sort());
  });

  it('picks up a fourth rule with no change to the derivation', () => {
    const derived = withheldKeys(WITH_SYNTHETIC);
    expect(derived).toContain('inventory.count.perform');
    expect(derived.length).toBe(OWNER_WITHHELD.length + 1);
  });

  it('flags a role holding both sides of the synthetic rule', () => {
    const violations = separationOfDutiesViolations(
      ['inventory.count.perform', 'inventory.transfer'],
      WITH_SYNTHETIC,
    );
    expect(violations.map((v) => v.rule)).toEqual(['count-vs-transfer']);

    // ...and does not flag it under the real rule set, so the fixture is doing
    // the work rather than the assertion being vacuously true.
    expect(
      separationOfDutiesViolations(['inventory.count.perform', 'inventory.transfer']),
    ).toEqual([]);
  });

  it('extends delegation to the synthetic trigger with no edit to delegableKeys', () => {
    // Holds the oversight half plus the ability to delegate.
    const authority = authorityOf(['membership.grant', 'inventory.transfer']);

    expect(delegableKeys(authority).has('inventory.count.perform')).toBe(false);
    expect(delegableKeys(authority, WITH_SYNTHETIC).has('inventory.count.perform')).toBe(true);
  });

  it('still refuses to widen for anything the rules do not separate', () => {
    const authority = authorityOf(['membership.grant', 'inventory.transfer']);
    // role.create is withheld on seniority, not by a separation rule.
    expect(delegableKeys(authority, WITH_SYNTHETIC).has('role.create')).toBe(false);
  });

  it('still requires membership.grant before widening anything', () => {
    const authority = authorityOf(['inventory.transfer']);
    expect(delegableKeys(authority, WITH_SYNTHETIC).has('inventory.count.perform')).toBe(false);
  });

  it('lets a delegator assign the newly separated role end to end', () => {
    const authority = authorityOf(['membership.grant', 'inventory.transfer']);
    const target = {
      permissions: ['inventory.count.perform'] as readonly PermissionKey[],
      discountPercentCap: 0,
      discountAmountCap: null,
    };
    const decision = checkSubsetGrant(authority, target, WITH_SYNTHETIC);
    expect(decision.ok, decision.ok ? '' : decision.reason).toBe(true);
  });

  it('still refuses to author a role violating the synthetic rule', () => {
    const authority = authorityOf(['membership.grant', 'inventory.transfer', 'inventory.count.perform']);
    const decision = checkSubsetGrant(
      authority,
      {
        permissions: ['inventory.count.perform', 'inventory.transfer'],
        discountPercentCap: 0,
        discountAmountCap: null,
      },
      WITH_SYNTHETIC,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/count-vs-transfer/);
  });
});
