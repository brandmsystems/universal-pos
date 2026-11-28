import { describe, expect, it } from 'vitest';
import { assertCheckedSet } from '../helpers/db.js';
import { platformRoleHolds } from '../../src/middleware/security/platformAuthz.js';
import { PLATFORM_ROLES } from '../../src/modules/authz/platformRoles.js';
import { PLATFORM_PERMISSION_KEYS } from '../../src/modules/authz/platformPermissions.js';
import { allRoutes } from '../../src/routes/index.js';
import { MUTATING_METHODS } from '../../src/middleware/routeRegistry.js';

/**
 * The escalation this closes: `read_only` reaching POST /api/platform/impersonation.
 *
 * The plane guard proved a token carried SOME platform_role and stopped there,
 * so the weakest role in the catalogue could enter any tenant. The Phase 1
 * catalogue and subset rule both existed; nothing at the route layer read them.
 */

const platformRoutes = allRoutes().filter((r) => r.plane === 'platform');
const mutating = platformRoutes.filter((r) => MUTATING_METHODS.includes(r.method));

describe('read_only cannot mutate the control plane', () => {
  it('is refused on EVERY mutating platform route', () => {
    assertCheckedSet({
      label: 'mutating platform routes',
      checked: mutating.map((r) => `${r.method} ${r.url}`),
      minimum: 6,
      mustInclude: ['POST /impersonation', 'POST /tenants',
                    'POST /subscriptions/:id/change', 'DELETE /impersonation/:id'],
    });

    const reachable = mutating.filter((route) => {
      const permission = route.permission;
      if (permission?.plane !== 'platform') return true; // unguarded is reachable
      return platformRoleHolds('read_only', permission.key);
    });

    expect(
      reachable.map((r) => `${r.method} ${r.url}`),
      'read_only is the weakest role in the catalogue and must reach no mutation',
    ).toEqual([]);
  });

  it('is refused on POST /impersonation specifically', () => {
    const route = platformRoutes.find((r) => r.method === 'POST' && r.url === '/impersonation')!;
    expect(route.permission).toEqual({
      plane: 'platform', key: 'platform.impersonation.start',
    });
    // The live escalation, named.
    expect(platformRoleHolds('read_only', 'platform.impersonation.start')).toBe(false);
    expect(platformRoleHolds('support', 'platform.impersonation.start')).toBe(true);
    expect(platformRoleHolds('super_admin', 'platform.impersonation.start')).toBe(true);
  });

  it('still lets read_only READ, so the role is not merely broken', () => {
    // Non-vacuity: a guard that refused everything would pass the test above and
    // be useless.
    const reads = platformRoutes.filter((r) => !MUTATING_METHODS.includes(r.method));
    const allowed = reads.filter(
      (r) => r.permission?.plane === 'platform' && platformRoleHolds('read_only', r.permission.key));
    expect(allowed.length).toBeGreaterThanOrEqual(4);
  });

  it('denies an unknown or absent role, rather than defaulting open', () => {
    for (const role of [undefined, null, '', 'not_a_role', 'owner']) {
      expect(platformRoleHolds(role, 'platform.tenant.view'), String(role)).toBe(false);
    }
  });

  it('resolves from the SEEDED role definitions, not a copy', () => {
    // Every role in the catalogue resolves, and super_admin holds everything --
    // so a role added later is covered without editing the guard.
    assertCheckedSet({
      label: 'platform roles',
      checked: PLATFORM_ROLES.map((r) => r.key),
      minimum: 5,
      mustInclude: ['super_admin', 'sales', 'support', 'billing', 'read_only'],
    });
    for (const key of PLATFORM_PERMISSION_KEYS) {
      expect(platformRoleHolds('super_admin', key), key).toBe(true);
    }
  });

  it('refuses a tenant key on a platform route at the type AND runtime level', () => {
    // The union makes this a compile error; the registrar is the second gate.
    const mismatched = allRoutes().filter(
      (r) => r.permission !== undefined && r.permission.plane !== r.plane);
    expect(mismatched).toEqual([]);
  });
});
