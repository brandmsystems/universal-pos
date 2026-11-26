import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Three areas, three navigations. Superadmin and Sales Person share the
 * platform document and are told apart by the signed-in role; neither carries a
 * restaurant slug. Superadmin has its own address, one per section
 * (`/superadmin/{section}`); Sales Person stays at `/platform.html`. The
 * restaurant admin is the only area addressed by a restaurant slug.
 * Screens are stubbed: what is under test is which sidebar each area gets and
 * what the address bar does, not what a screen reads.
 */

vi.mock('../src/features/dashboard/platform/Dashboard.js', () => ({ Dashboard: () => <p data-screen="">Estate dashboard</p> }));
vi.mock('../src/features/dashboard/platform/SalesDashboard.js', () => ({ SalesDashboard: () => <p data-screen="">Sales dashboard</p> }));
vi.mock('../src/features/restaurants/platform/Restaurants.js', () => ({ Restaurants: () => <p data-screen="">Restaurants</p> }));
vi.mock('../src/features/billing/platform/Plans.js', () => ({ Plans: () => <p data-screen="">Plans</p> }));
vi.mock('../src/features/billing/platform/Billing.js', () => ({ Billing: () => <p data-screen="">Billing</p> }));
vi.mock('../src/features/users/platform/Staff.js', () => ({ Staff: () => <p data-screen="">Platform staff</p> }));
vi.mock('../src/features/users/platform/SalesPersons.js', () => ({ SalesPersons: () => <p data-screen="">Sales persons</p> }));
vi.mock('../src/features/settings/platform/Countries.js', () => ({ Countries: () => <p data-screen="">Countries</p> }));

const { App: PlatformApp } = await import('../src/app/platform/App.js');
const { App: AdminApp } = await import('../src/app/admin/App.js');

/** Every restaurant-admin sidebar entry: none may appear on the platform. */
const ADMIN_ENTRIES = ['POS Access', 'Open orders', 'Setup', 'Sale', 'Menu items', 'Tax rates', 'Printed bill', 'Branches', 'Staff', 'KOT, KDS & Billing Access',
  'Roles', 'Kitchens', 'Printers', 'Tablets'];

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).endsWith('/api/public/restaurants/spice-garden-blr')) {
      return Response.json({ slug: 'spice-garden-blr', name: 'Spice Garden', signInAvailable: true, themeColor: null, logoUrl: null });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

function platformSession(role: string): void {
  window.localStorage.setItem('kk.platform.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', platformUserId: 'p1', role,
  }));
}

async function render(app: 'platform' | 'admin', path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const App = app === 'platform' ? PlatformApp : AdminApp;
  await act(async () => { root!.render(<App />); });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The desktop sidebar's entries, by title. */
const entries = (): string[] => [...host.querySelectorAll('aside nav button')]
  .map((b) => b.querySelector('span')?.textContent ?? '');

const screen = (): string => host.querySelector('[data-screen]')?.textContent ?? '';

/** Clicks every sidebar entry; the screen each showed and the address it left. */
async function clickEach(): Promise<{ screen: string; path: string }[]> {
  const shown: { screen: string; path: string }[] = [];
  for (const button of [...host.querySelectorAll('aside nav button')]) {
    await act(async () => { (button as HTMLButtonElement).click(); });
    shown.push({ screen: screen(), path: window.location.pathname });
  }
  return shown;
}

const SUPERADMIN_SECTIONS = [
  { screen: 'Estate dashboard', path: '/superadmin/dashboard' },
  { screen: 'Restaurants', path: '/superadmin/restaurants' },
  { screen: 'Sales persons', path: '/superadmin/sales-persons' },
  { screen: 'Plans', path: '/superadmin/plans' },
  { screen: 'Billing', path: '/superadmin/billing' },
  { screen: 'Platform staff', path: '/superadmin/staff' },
  { screen: 'Countries', path: '/superadmin/countries' },
];

describe('Superadmin', () => {
  it('has the control-plane sidebar, a /superadmin address per section, and never a restaurant screen', async () => {
    platformSession('super_admin');
    await render('platform', '/superadmin');
    expect(window.location.pathname).toBe('/superadmin/dashboard');
    expect(host.textContent).toContain('control plane');
    expect(entries()).toEqual(['Dashboard', 'Restaurants', 'Sales persons', 'Plans', 'Billing', 'Platform staff', 'Countries']);
    for (const entry of ADMIN_ENTRIES) expect(entries()).not.toContain(entry);
    expect(await clickEach()).toEqual(SUPERADMIN_SECTIONS);
  });

  it('is never left at /platform.html: the shared entry becomes /superadmin/dashboard', async () => {
    platformSession('super_admin');
    await render('platform', '/platform.html');
    expect(window.location.pathname).toBe('/superadmin/dashboard');
    expect(screen()).toBe('Estate dashboard');
  });

  it('opens every section from its own address, as a reload or a shared link would', async () => {
    platformSession('super_admin');
    for (const { screen: expected, path } of SUPERADMIN_SECTIONS) {
      await render('platform', path);
      expect(screen()).toBe(expected);
      expect(window.location.pathname).toBe(path);
      act(() => root?.unmount());
      host.remove();
    }
    root = null;
  });

  it('corrects an unknown section to the dashboard it shows', async () => {
    platformSession('super_admin');
    await render('platform', '/superadmin/no-such-page');
    expect(screen()).toBe('Estate dashboard');
    expect(window.location.pathname).toBe('/superadmin/dashboard');
  });

  it('Back returns to the previous section', async () => {
    platformSession('super_admin');
    await render('platform', '/superadmin/restaurants');
    const billing = [...host.querySelectorAll('aside nav button')].find((b) => b.textContent?.startsWith('Billing'))!;
    await act(async () => { (billing as HTMLButtonElement).click(); });
    expect(window.location.pathname).toBe('/superadmin/billing');
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      window.history.back();
      await popped;
    });
    expect(window.location.pathname).toBe('/superadmin/restaurants');
    expect(screen()).toBe('Restaurants');
  });
});

describe('Sales Person', () => {
  it('has the sales console, not the estate and not a restaurant, and adds no slug to the address', async () => {
    platformSession('sales');
    await render('platform', '/platform.html');
    expect(host.textContent).toContain('sales console');
    expect(entries()).toEqual(['My dashboard', 'Plans']);
    for (const entry of [...ADMIN_ENTRIES, 'Restaurants', 'Sales persons', 'Platform staff']) {
      expect(entries()).not.toContain(entry);
    }
    expect(await clickEach()).toEqual([
      { screen: 'Sales dashboard', path: '/platform.html' },
      { screen: 'Plans', path: '/platform.html' },
    ]);
  });

  it('is never shown a /superadmin address: signed in there, the address becomes /platform.html', async () => {
    platformSession('sales');
    await render('platform', '/superadmin/plans');
    expect(window.location.pathname).toBe('/platform.html');
    expect(host.textContent).toContain('sales console');
  });
});

describe('KatKitchen customer (restaurant)', () => {
  it('a platform sign-in opens nothing at a restaurant address: that restaurant asks for its own sign-in', async () => {
    platformSession('super_admin');
    await render('admin', '/spice-garden-blr/menu');
    expect(host.querySelector('nav')).toBeNull();
    expect(host.textContent).toContain('Spice Garden');
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(window.location.pathname).toBe('/spice-garden-blr/menu');
  });
});
