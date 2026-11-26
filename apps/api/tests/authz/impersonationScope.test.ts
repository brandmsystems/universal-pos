import { describe, expect, it } from 'vitest';
import {
  PERMISSION_KEYS,
  riskClassOf,
  type PermissionKey,
  type RiskClass,
} from '../../src/modules/authz/permissions.js';
import { OWNER_WITHHELD, systemRole } from '../../src/modules/authz/systemRoles.js';
import {
  impersonationScope,
  impersonationWriteScope,
  isWithinImpersonationScope,
} from '../../src/modules/authz/impersonationScope.js';
import { assertCheckedSet } from '../helpers/db.js';

/**
 * The bound must be DERIVED from risk_class, not enumerated. A fifth class has to
 * be excluded the moment it exists, with no edit to the impersonation code --
 * same property as the separation-of-duties exemption, proved the same way.
 */

describe('impersonation is bounded by risk class', () => {
  it('excludes every financial, escalation and privacy key', () => {
    const scope = impersonationScope();
    assertCheckedSet({
      label: 'impersonation scope',
      checked: [...scope],
      minimum: 50,
      mustInclude: ['branch.edit', 'menu.item.edit', 'table.edit', 'kitchen.station.edit'],
    });

    const leaked = PERMISSION_KEYS.filter((k) => riskClassOf(k) !== 'none' && scope.has(k));
    expect(leaked, 'a risky key reached the impersonation scope').toEqual([]);
  });

  it('never grants more than the owner holds', () => {
    // The bug this closes: impersonation had payment.collect and the vendor
    // master, both of which the OWNER is denied by separation of duties.
    const ownerKeys = new Set<string>(systemRole('owner').permissions);
    const beyondOwner = [...impersonationScope()].filter((k) => !ownerKeys.has(k));
    expect(beyondOwner).toEqual([]);

    for (const key of OWNER_WITHHELD) {
      expect(isWithinImpersonationScope(key), `${key} must be out of scope`).toBe(false);
    }
  });

  it('refuses the four keys the escalation path went through', () => {
    for (const key of [
      'payment.collect',
      'order.void',
      'role.create',
      'customer.pii.view',
    ] as const) {
      expect(isWithinImpersonationScope(key), key).toBe(false);
    }
  });

  it('still permits configuration and operational work', () => {
    // Support has to be able to diagnose, or the feature is pointless.
    for (const key of [
      'branch.view',
      'menu.view',
      'menu.availability.toggle',
      'printer.job.retry',
      'kot.view',
      'kds.view',
      'audit.view',
    ] as const) {
      expect(isWithinImpersonationScope(key), key).toBe(true);
    }
  });

  it('drops a key the moment a synthetic fifth class is introduced', () => {
    // The proof that the bound is derived. No edit to impersonationScope.ts is
    // needed for this to pass.
    const synthetic = (key: PermissionKey): RiskClass =>
      key === 'branch.edit' ? ('operational_hazard' as unknown as RiskClass) : riskClassOf(key);

    expect(impersonationScope().has('branch.edit')).toBe(true);

    const narrowed = impersonationWriteScope(PERMISSION_KEYS, OWNER_WITHHELD, synthetic);
    expect(narrowed.has('branch.edit'), 'a newly classified key must fall out').toBe(false);
    // Everything else is untouched, so the fixture is doing the work.
    expect(narrowed.has('menu.item.edit')).toBe(true);
  });

  it('collapses to nothing if every key were classified', () => {
    const everythingRisky = () => 'financial' as RiskClass;
    expect(
      impersonationWriteScope(PERMISSION_KEYS, OWNER_WITHHELD, everythingRisky).size,
    ).toBe(0);
  });
});
