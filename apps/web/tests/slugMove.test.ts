import { afterEach, describe, expect, it } from 'vitest';
import { createStore, moveRestaurantStorage, scopedStore } from '../src/services/storage.js';
import { addressMovedTo } from '../src/features/restaurants/admin/RestaurantPage.js';

/**
 * A restaurant renamed by a Super Admin: what this browser keeps under the old
 * slug moves to the new one, so a tablet stays set up and a signed-in manager
 * stays signed in -- and nothing belonging to another restaurant moves.
 */

afterEach(() => localStorage.clear());

describe('moving a renamed restaurant\'s storage', () => {
  it('moves every tablet namespace, nested scopes included, and rewrites the slug inside records', () => {
    const base = createStore();
    const pos = scopedStore(base, 'pos:old-cafe');
    pos.set('device.v1', { tenantSlug: 'old-cafe', deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) });
    pos.set('session.v1', { tenantSlug: 'old-cafe', accessToken: 'a', refreshToken: 'r', branchId: 'b1', userId: 'u' });
    scopedStore(pos, 'billing').set('leases', { s1: 'token' });
    scopedStore(base, 'kds:old-cafe').set('station', 'st1');
    // Another restaurant on the same browser, and the admin's sign-in.
    scopedStore(base, 'pos:other').set('device.v1', { tenantSlug: 'other', deviceId: 'd2' });
    base.set('session.v1', { tenantSlug: 'old-cafe', accessToken: 'admin' });

    moveRestaurantStorage('old-cafe', 'new-cafe');

    const moved = scopedStore(base, 'pos:new-cafe');
    expect(moved.get('device.v1')).toMatchObject({ tenantSlug: 'new-cafe', deviceId: 'd1' });
    expect(moved.get('session.v1')).toMatchObject({ tenantSlug: 'new-cafe', accessToken: 'a' });
    expect(scopedStore(moved, 'billing').get('leases')).toEqual({ s1: 'token' });
    expect(scopedStore(base, 'kds:new-cafe').get('station')).toBe('st1');
    expect(base.get('session.v1')).toMatchObject({ tenantSlug: 'new-cafe', accessToken: 'admin' });
    // Nothing left behind, and nobody else touched.
    expect(base.keys().filter((k) => k.includes('old-cafe'))).toEqual([]);
    expect(scopedStore(base, 'pos:other').get('device.v1')).toMatchObject({ tenantSlug: 'other', deviceId: 'd2' });
  });

  it('is safe to run twice, and a restaurant whose name merely starts the same is not moved', () => {
    const base = createStore();
    scopedStore(base, 'pos:cafe').set('device.v1', { tenantSlug: 'cafe' });
    scopedStore(base, 'pos:cafe-two').set('device.v1', { tenantSlug: 'cafe-two' });
    moveRestaurantStorage('cafe', 'bistro');
    moveRestaurantStorage('cafe', 'bistro');
    expect(scopedStore(base, 'pos:bistro').get('device.v1')).toEqual({ tenantSlug: 'bistro' });
    expect(scopedStore(base, 'pos:cafe-two').get('device.v1')).toEqual({ tenantSlug: 'cafe-two' });
  });
});

describe('the same screen at the new address', () => {
  it('replaces only the slug, keeping the rest of the path, the query and the hash', () => {
    expect(addressMovedTo({ pathname: '/old-cafe/kot', search: '', hash: '#billing' }, 'old-cafe', 'new-cafe'))
      .toBe('/new-cafe/kot#billing');
    expect(addressMovedTo({ pathname: '/old-cafe', search: '?x=1', hash: '' }, 'old-cafe', 'new-cafe'))
      .toBe('/new-cafe?x=1');
    // A longer slug that starts with the old one is a different restaurant.
    expect(addressMovedTo({ pathname: '/old-cafe-two/kot', search: '', hash: '' }, 'old-cafe', 'new-cafe'))
      .toBe('/old-cafe-two/kot');
  });
});
