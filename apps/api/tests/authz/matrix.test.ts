import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '../../src/modules/authz/permissions.js';
import {
  DANGEROUS_KEYS,
  ESCALATION_KEYS,
  FINANCIAL_KEYS,
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_MODULES,
  PRIVACY_KEYS,
  riskClassOf,
} from '../../src/modules/authz/permissions.js';
import type { SystemRoleDefinition } from '../../src/modules/authz/systemRoles.js';
import { ADJUSTMENT_KEYS, SYSTEM_ROLES, TILL_KEY, systemRole } from '../../src/modules/authz/systemRoles.js';
import {
  accumulatedSeparationConflicts,
  checkSubsetGrant,
  delegableKeys,
  effectiveAuthority,
  separationOfDutiesViolations,
} from '../../src/modules/authz/grant.js';
import { assertCheckedSet } from '../helpers/db.js';

// SYSTEM_ROLES is 'as const satisfies', so each role's permissions is a narrow
// literal tuple. Widen once for the tests that ask generic questions of it.
const ROLES: readonly SystemRoleDefinition[] = SYSTEM_ROLES;

const ROLE_KEYS = ['owner', 'branch_admin', 'manager', 'cashier', 'waiter', 'kds', 'accounts'] as const;

describe('the permission catalogue', () => {
  it('is well formed and covers every module', () => {
    assertCheckedSet({
      label: 'permission modules',
      checked: PERMISSION_MODULES,
      minimum: 18,
      mustInclude: ['tenant', 'user', 'role', 'membership', 'audit', 'order', 'payment', 'report'],
    });
    expect(PERMISSION_KEYS.length).toBeGreaterThanOrEqual(80);
  });

  it('has no duplicate keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('matches the key format the database CHECK enforces', () => {
    const pattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    expect(PERMISSION_KEYS.filter((k) => !pattern.test(k))).toEqual([]);
  });

  it('marks every key the split decisions identified as dangerous', () => {
    for (const key of ['order.void', 'order.discount', 'order.comp', 'payment.refund'] as const) {
      expect(DANGEROUS_KEYS.has(key), `${key} must be dangerous`).toBe(true);
    }
    // order.line.remove touches an unfired line: no money moved, no food cooked.
    // payment.tender.void DID move money, so it is financial-class and carries a
    // reason code -- while still not being an adjustment, because it corrects an
    // open session rather than amending a committed record.
    expect(DANGEROUS_KEYS.has('order.line.remove')).toBe(false);
    expect(riskClassOf('payment.tender.void')).toBe('financial');
    expect(ADJUSTMENT_KEYS).not.toContain('payment.tender.void');
    expect(DANGEROUS_KEYS.has('payment.collect')).toBe(false);
  });

  it('gives every definition a description', () => {
    expect(PERMISSIONS.filter((p) => p.description.trim() === '').map((p) => p.key)).toEqual([]);
  });
});

describe('the seeded system role matrix', () => {
  it('defines exactly the seven system roles', () => {
    assertCheckedSet({
      label: 'system roles',
      checked: SYSTEM_ROLES.map((r) => r.key),
      minimum: 7,
      mustInclude: ROLE_KEYS,
    });
  });

  it('references only keys that exist in the catalogue', () => {
    const unknown = SYSTEM_ROLES.flatMap((role) =>
      role.permissions.filter((k) => !PERMISSION_KEYS.includes(k)).map((k) => `${role.key}:${k}`),
    );
    expect(unknown).toEqual([]);
  });

  it('never seeds an escalation, privacy or adjustment key into a broadly assigned role', () => {
    for (const key of ['waiter', 'cashier', 'kds'] as const) {
      const held = systemRole(key).permissions as readonly PermissionKey[];
      expect(held.filter((k) => ESCALATION_KEYS.has(k)), `${key}: escalation`).toEqual([]);
      expect(held.filter((k) => PRIVACY_KEYS.has(k)), `${key}: privacy`).toEqual([]);
      expect(held.filter((k) => ADJUSTMENT_KEYS.includes(k)), `${key}: adjustment`).toEqual([]);
    }
  });

  it('allows a financial key on a floor role only where the control is named', () => {
    // Three deliberate cases, each safe because of a named control rather than
    // by withholding the key (loyalty.redeem was one until loyalty was retired
    // in 0064):
    //   payment.tender.void      correct a mis-tender before close: the reason
    //                            code and the exception report.
    //   bill.edit                correct TODAY's bill before day end (0086):
    //                            assertMayEditDay refuses a previous or submitted
    //                            day, a paid bill never loses an item, and every
    //                            edit is a revision row with its reason.
    //   payment.settlement.close submit the day (0086): it only LOCKS -- the
    //                            figures are the server's, confirmed, and only a
    //                            manager (payment.settlement.reopen) unlocks.
    const cashier = systemRole('cashier').permissions as readonly PermissionKey[];
    expect(cashier.filter((k) => FINANCIAL_KEYS.has(k)))
      .toEqual(['payment.tender.void', 'bill.edit', 'payment.settlement.close']);
  });

  it('keeps the till out of every role that reports or adjusts', () => {
    const violations = ROLES.flatMap((role) =>
      separationOfDutiesViolations(role.permissions).map(
        (v) => `${role.key}: ${v.rule} -- ${v.triggeredBy} with ${v.conflicting.join(', ')}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('keeps bulk PII export to the owner alone', () => {
    // A compromised manager session must not be able to page the customer table.
    const holders = ROLES.filter((r) => r.permissions.includes('customer.pii.export')).map((r) => r.key);
    expect(holders).toEqual(['owner']);

    // Single-record reveal is broader on purpose: one request, one record, one
    // audit row. Bulk is a different key with a different blast radius.
    const viewers = ROLES.filter((r) => r.permissions.includes('customer.pii.view')).map((r) => r.key);
    expect(viewers).toContain('branch_admin');
    expect(viewers).toContain('manager');
    expect(viewers).not.toContain('waiter');
    expect(viewers).not.toContain('cashier');
  });

  it('lets every built-in role read who it is signed in as, and nothing about anyone else', () => {
    // Derived onto every role in systemRoles.ts rather than listed per role, so
    // this holds for a role added later with no edit there.
    expect(ROLES.filter((r) => !r.permissions.includes('user.self.view')).map((r) => r.key)).toEqual([]);
    expect(ROLES.length).toBeGreaterThanOrEqual(8);
  });

  it('gives payment.collect only to the named till roles, each held at one branch', () => {
    // An allowlist, so a new till role is a decision someone names here.
    // `counter` is Basic's Billing account, which also takes the order because
    // Basic has no KOT; it holds the till and order-taking, nothing that reports
    // or adjusts (asserted just above, by the separation rules themselves).
    const holders = ROLES.filter((r) => r.permissions.includes(TILL_KEY));
    expect(holders.map((r) => r.key).sort()).toEqual(['cashier', 'counter']);
    for (const role of holders) {
      expect(role.assignableScope, `${role.key} is a till at one branch`).toBe('branch_only');
      expect(role.permissions.filter((k) => k.startsWith('report.') || ADJUSTMENT_KEYS.includes(k)),
        `${role.key} holds no report or adjustment key`).toEqual([]);
    }
  });

  it('keeps cancelling an order with shift authority, away from the till', () => {
    expect(ADJUSTMENT_KEYS).toContain('order.cancel');
    expect(ROLES.filter((r) => r.permissions.includes('order.cancel')).map((r) => r.key).sort())
      .toEqual(['branch_admin', 'manager', 'owner']);
  });

  it('splits void by whether the ticket has fired', () => {
    expect(systemRole('waiter').permissions).toContain('order.line.remove');
    expect(systemRole('waiter').permissions).not.toContain('order.void');
    expect(systemRole('manager').permissions).toContain('order.void');
  });

  it('splits refund away from the cashier', () => {
    const cashier = systemRole('cashier').permissions;
    expect(cashier).toContain('payment.collect');
    expect(cashier).toContain('payment.tender.void');
    expect(cashier).not.toContain('payment.refund');
    expect(systemRole('manager').permissions).toContain('payment.refund');
  });

  it('gives discount authority only where a cap backs it', () => {
    for (const role of ROLES) {
      const holdsKey = role.permissions.includes('order.discount');
      if (holdsKey) {
        expect(role.discountPercentCap, `${role.key} holds order.discount with a zero cap`).toBeGreaterThan(0);
      } else {
        expect(role.discountPercentCap, `${role.key} has a cap but no order.discount`).toBe(0);
      }
    }
  });

  it('escalates discount authority monotonically up the ladder', () => {
    expect(systemRole('manager').discountPercentCap).toBeLessThan(
      systemRole('branch_admin').discountPercentCap,
    );
    expect(systemRole('branch_admin').discountPercentCap).toBeLessThan(
      systemRole('owner').discountPercentCap,
    );
    expect(systemRole('owner').discountAmountCap).toBeNull();
  });

  it('gives kds the queue and nothing else', () => {
    const kds = systemRole('kds').permissions;
    expect(kds).toContain('kds.item.bump');
    for (const forbidden of ['order.create', 'payment.collect', 'bill.generate'] as const) {
      expect(kds).not.toContain(forbidden);
    }
  });
});

describe('the subset rule', () => {
  function authorityOf(roleKey: (typeof ROLE_KEYS)[number], branchId: string | null = 'branch-a') {
    const role = systemRole(roleKey);
    return effectiveAuthority(
      [
        {
          id: `membership-${roleKey}`,
          branchId: role.assignableScope === 'tenant_only' ? null : branchId,
          permissions: role.permissions,
          discountPercentCap: role.discountPercentCap,
          discountAmountCap: role.discountAmountCap,
        },
      ],
      { branchId },
    );
  }

  it('rejects a manager inviting a user as owner', () => {
    const decision = checkSubsetGrant(authorityOf('manager'), systemRole('owner'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.missing.length).toBeGreaterThan(0);
      expect(decision.missing).toContain('role.create');
    }
  });

  it('rejects a manager granting branch_admin', () => {
    expect(checkSubsetGrant(authorityOf('manager'), systemRole('branch_admin')).ok).toBe(false);
  });

  it('allows a manager to grant waiter and kds', () => {
    for (const key of ['waiter', 'kds'] as const) {
      expect(checkSubsetGrant(authorityOf('manager'), systemRole(key)).ok, key).toBe(true);
    }
  });

  it('does not let a zero-cap role be blocked by its own null amount ceiling', () => {
    // waiter and kds carry discountAmountCap: null only because they have no
    // discount authority to bound. A bounded granter must still be able to
    // hand them out.
    const decision = checkSubsetGrant(authorityOf('manager'), {
      permissions: ['order.view'],
      discountPercentCap: 0,
      discountAmountCap: null,
    });
    expect(decision.ok).toBe(true);
  });

  it('stops a manager granting the till they do not hold', () => {
    // Manager holds no membership.grant at all, so the delegation widening never
    // applies to it. Onboarding is branch_admin's job, which is what keeps this
    // outcome true for the right reason rather than by accident.
    const decision = checkSubsetGrant(authorityOf('manager'), systemRole('cashier'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.missing).toContain('payment.collect');
  });

  it('lets an owner grant every system role, including the two it withholds', () => {
    // Without the delegation widening this deadlocks: no membership-granting role
    // holds payment.collect, so cashier would be unassignable by anyone, forever.
    for (const key of ROLE_KEYS) {
      const decision = checkSubsetGrant(authorityOf('owner', null), systemRole(key));
      expect(decision.ok, `${key}: ${decision.ok ? '' : decision.reason}`).toBe(true);
    }
  });

  it('lets branch_admin onboard a cashier', () => {
    expect(checkSubsetGrant(authorityOf('branch_admin'), systemRole('cashier')).ok).toBe(true);
  });

  it('widens delegation only for the SoD counterpart, never for seniority', () => {
    // owner may delegate the till it is denied by separation of duties...
    expect(delegableKeys(authorityOf('owner', null)).has('payment.collect')).toBe(true);
    // ...but branch_admin gains nothing it was denied on seniority grounds.
    expect(delegableKeys(authorityOf('branch_admin')).has('role.create')).toBe(false);
  });

  it('refuses to author a role that violates separation of duties, at any seniority', () => {
    const decision = checkSubsetGrant(authorityOf('owner', null), {
      permissions: ['payment.collect', 'report.sales.view'],
      discountPercentCap: 0,
      discountAmountCap: null,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/separation of duties/);
  });

  it('rejects authoring a role with a cap above the granter’s own', () => {
    const decision = checkSubsetGrant(authorityOf('manager'), {
      permissions: ['order.discount'],
      discountPercentCap: 75,
      discountAmountCap: 100,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/discount cap/);
  });

  it('rejects granting an unbounded amount cap from a bounded granter', () => {
    const decision = checkSubsetGrant(authorityOf('manager'), {
      permissions: ['order.discount'],
      discountPercentCap: 10,
      discountAmountCap: null,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/unbounded/);
  });

  it('allows a strictly narrower cap', () => {
    expect(
      checkSubsetGrant(authorityOf('manager'), {
        permissions: ['order.discount'],
        discountPercentCap: 5,
        discountAmountCap: 100,
      }).ok,
    ).toBe(true);
  });
});

describe('effective authority across memberships', () => {
  it('applies tenant-wide memberships at every branch and branch ones only at their own', () => {
    const authority = effectiveAuthority(
      [
        { id: 'm1', branchId: null, permissions: ['report.sales.view'], discountPercentCap: 0, discountAmountCap: 0 },
        { id: 'm2', branchId: 'branch-a', permissions: ['payment.collect'], discountPercentCap: 0, discountAmountCap: 0 },
        { id: 'm3', branchId: 'branch-b', permissions: ['order.void'], discountPercentCap: 0, discountAmountCap: 0 },
      ],
      { branchId: 'branch-a' },
    );
    expect(authority.permissions.has('report.sales.view')).toBe(true);
    expect(authority.permissions.has('payment.collect')).toBe(true);
    expect(authority.permissions.has('order.void'), 'branch-b must not leak into branch-a').toBe(false);
  });

  it('takes the maximum cap, never the minimum', () => {
    const authority = effectiveAuthority(
      [
        { id: 'm1', branchId: null, permissions: [], discountPercentCap: 5, discountAmountCap: 100 },
        { id: 'm2', branchId: 'branch-a', permissions: [], discountPercentCap: 20, discountAmountCap: 50 },
      ],
      { branchId: 'branch-a' },
    );
    // Holding more roles cannot leave someone with less authority than one alone.
    expect(authority.discountPercentCap).toBe(20);
    expect(authority.discountAmountCap).toBe(100);
  });

  it('treats a null amount cap as the weakest ceiling', () => {
    const authority = effectiveAuthority(
      [
        { id: 'm1', branchId: null, permissions: [], discountPercentCap: 10, discountAmountCap: 100 },
        { id: 'm2', branchId: null, permissions: [], discountPercentCap: 10, discountAmountCap: null },
      ],
      { branchId: null },
    );
    expect(authority.discountAmountCap).toBeNull();
  });
});

describe('the vendor-master rule', () => {
  it('keeps supplier authoring away from purchase approval', () => {
    // Inventing a supplier and approving the order that pays it is fake-vendor
    // fraud in one role -- the accounts-side equivalent of the till problem.
    const accounts = systemRole('accounts').permissions as readonly string[];
    expect(accounts).toContain('supplier.create');
    expect(accounts).not.toContain('purchase.order.approve');
    expect(accounts).not.toContain('purchase.receive');

    const approver = systemRole('branch_admin').permissions as readonly string[];
    expect(approver).toContain('purchase.order.approve');
    expect(approver).not.toContain('supplier.create');
    expect(approver).not.toContain('supplier.edit');
  });

  it('flags a role that holds both', () => {
    const violations = separationOfDutiesViolations(['supplier.create', 'purchase.order.approve']);
    expect(violations.map((v) => v.rule)).toEqual(['vendor-master-vs-approval']);
  });
});

describe('accumulated separation-of-duties conflict, reported not blocked', () => {
  it('flags a person holding cashier at one branch and manager tenant-wide', () => {
    const cashier = systemRole('cashier');
    const manager = systemRole('manager');
    const authority = effectiveAuthority(
      [
        { id: 'm-cashier', branchId: 'branch-a', permissions: cashier.permissions, discountPercentCap: cashier.discountPercentCap, discountAmountCap: cashier.discountAmountCap },
        { id: 'm-manager', branchId: null, permissions: manager.permissions, discountPercentCap: manager.discountPercentCap, discountAmountCap: manager.discountAmountCap },
      ],
      { branchId: 'branch-a' },
    );
    const conflicts = accumulatedSeparationConflicts(authority);
    expect(conflicts.map((c) => c.rule)).toContain('till-vs-record');
    // And now it names the two capacities, not just the fact of the overlap.
    const till = conflicts.find((c) => c.rule === 'till-vs-record');
    expect(till?.triggerMembershipId).toBe('m-cashier');
    expect(till?.conflictMembershipId).toBe('m-manager');
  });

  it('does not flag a plain cashier', () => {
    const cashier = systemRole('cashier');
    const authority = effectiveAuthority(
      [{ id: 'm-cashier', branchId: 'branch-a', permissions: cashier.permissions, discountPercentCap: 0, discountAmountCap: null }],
      { branchId: 'branch-a' },
    );
    expect(accumulatedSeparationConflicts(authority)).toEqual([]);
  });

  it('keeps every adjustment key in the catalogue', () => {
    expect(ADJUSTMENT_KEYS.filter((k) => !PERMISSION_KEYS.includes(k))).toEqual([]);
  });
});
