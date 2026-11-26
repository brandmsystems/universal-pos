import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ENTITLEMENTS, entitlementsFromTerms, planTermsFor } from '@katkitchen/shared';
import { restaurantLinks } from '../src/lib/restaurantPath.js';
import { createStore } from '../src/services/storage.js';
import { chooseRestaurantAddress } from '../src/features/restaurants/pos/RestaurantGate.js';
import { createApi } from '../src/services/api.js';
import { PosKdsAccessPage } from '../src/features/access/admin/pos-kds-access/PosKdsAccessPage.js';
import { SignIn as RestaurantSignIn } from '../src/features/auth/admin/SignIn.js';

/**
 * Basic only: a restaurant opens one link, the POS, derived from its
 * entitlements; the kitchen screen and the separate KOT and Billing apps are
 * gone. The restaurant's login page is the manager's alone -- staff sign in on
 * the till by name and PIN.
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('the links a restaurant opens', () => {
  it('Basic: the POS, with KOT named, and nothing else', () => {
    const links = restaurantLinks('cafe', entitlementsFromTerms(planTermsFor(ENTITLEMENTS.basic)));
    expect(links.map((l) => [l.key, l.path])).toEqual([['pos', '/cafe/pos']]);
    expect(links[0]!.label).toBe('POS · Dine-in, Parcel, KOT, Billing');
  });

  it('the manager\'s access page: the POS link and no other', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    await mount(<PosKdsAccessPage api={createApi(createStore())} tenantSlug="cafe" kot />);
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/cafe/pos']);
    expect(host.textContent).not.toMatch(/KDS|kitchen screen|setup code/i);
  });
});

describe('the restaurant\'s login page', () => {
  it('is the manager\'s: no Staff tab, and says who sets the username and password', async () => {
    await mount(<RestaurantSignIn api={createApi(createStore())} onSignedIn={() => undefined}
      restaurant={{ slug: 'cafe', name: 'Cafe' }} />);
    expect(host.textContent).toContain('Run your restaurant');
    expect([...host.querySelectorAll('[role="tab"]')]).toHaveLength(0);
    expect(host.textContent).toContain('Your username and password are set by your Sales person.');
  });

  it('has a Staff Login button that opens THIS restaurant\'s POS, and shows no address', async () => {
    await mount(<RestaurantSignIn api={createApi(createStore())} onSignedIn={() => undefined}
      restaurant={{ slug: 'dosa-corner', name: 'Dosa Corner' }} />);
    const staff = [...host.querySelectorAll('a')].find((x) => x.textContent === 'Staff Login');
    expect(staff?.getAttribute('href')).toBe('/dosa-corner/pos');
    expect(host.textContent).not.toContain('/dosa-corner');
    expect(host.textContent).not.toContain('POS link');
  });
});

describe('Open restaurant on the "Which restaurant?" box', () => {
  it('goes straight to that restaurant\'s manager login, not the POS', () => {
    expect(chooseRestaurantAddress('cafe')).toBe('/cafe');
    expect(chooseRestaurantAddress('spice-garden')).toBe('/spice-garden');
  });
});
