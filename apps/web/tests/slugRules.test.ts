import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, slugProblem, slugify } from '@katkitchen/shared';
import { adminLocationFromPath, tabletSlugFromPath } from '../src/lib/restaurantPath.js';

/**
 * Two rules, deliberately apart. A NEW slug must be clean (single hyphens only
 * between letters or digits); ROUTING accepts every slug a restaurant may
 * already have, so tightening the first never makes a live restaurant
 * unreachable at its own address.
 */
describe('slugs', () => {
  it('a name becomes a clean slug, and the form refuses a dirty one', () => {
    expect(slugify('ABC Family Restaurant')).toBe('abc-family-restaurant');
    expect(slugify(' Spice -- Hub! ')).toBe('spice-hub');
    expect(slugProblem('abc--cafe')).not.toBeNull();
    expect(slugProblem('abc-')).not.toBeNull();
    expect(slugProblem('abc-family-restaurant')).toBeNull();
  });

  it('routing still reaches a restaurant whose existing slug predates the clean rule', () => {
    expect(adminLocationFromPath('/abc--cafe')?.slug).toBe('abc--cafe');
    expect(tabletSlugFromPath('pos', '/abc--cafe/kot')).toBe('abc--cafe');
  });

  it('platform and reserved paths are never a restaurant', () => {
    for (const reserved of ['superadmin', 'api', 'admin', 'pos', 'kds']) {
      expect(RESERVED_SLUGS.has(reserved), reserved).toBe(true);
      expect(adminLocationFromPath(`/${reserved}`), reserved).toBeNull();
    }
    expect(adminLocationFromPath('/superadmin/dashboard')).toBeNull();
  });

  it('a restaurant\'s screens sit under its own slug', () => {
    expect(adminLocationFromPath('/abc-cafe/setup')).toMatchObject({ slug: 'abc-cafe', section: 'setup' });
    expect(tabletSlugFromPath('pos', '/abc-cafe/pos')).toBe('abc-cafe');
    // Earlier addresses keep opening the POS.
    expect(tabletSlugFromPath('pos', '/abc-cafe/kot')).toBe('abc-cafe');
    expect(tabletSlugFromPath('pos', '/abc-cafe/billing')).toBe('abc-cafe');
    expect(tabletSlugFromPath('pos', '/abc-cafe/kds')).toBeNull();
  });
});
