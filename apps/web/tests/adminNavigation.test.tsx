import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { adminLocationFromPath, adminPath, tabletSlugFromPath } from '../src/lib/restaurantPath.js';
import { slugFromPath } from '../src/features/restaurants/admin/RestaurantPage.js';

/**
 * The restaurant admin's address follows its sidebar and the sidebar follows
 * its address. The screens are stubbed: what is under test is which one the
 * shell chooses and what the address bar says, not what a screen fetches.
 */

vi.mock('../src/features/dashboard/admin/Dashboard.js', () => ({ Dashboard: () => <p data-screen="">Dashboard</p> }));
vi.mock('../src/features/settings/admin/TaxRates.js', () => ({ TaxRates: () => <p data-screen="">Tax rates</p> }));
vi.mock('../src/features/settings/admin/setup/Setup.js', () => ({
  Setup: () => <p data-screen="">Setup</p>,
  StepScreen: (props: { step: string }) => <p data-screen="">{`Step ${props.step}`}</p>,
}));
vi.mock('../src/features/settings/admin/Table.js', () => ({
  Table: (props: { resource: string }) => <p data-screen="">{`Table ${props.resource}`}</p>,
}));
vi.mock('../src/features/access/admin/pos-kds-access/PosKdsAccessPage.js', () => ({
  PosKdsAccessPage: () => <p data-screen="">Access</p>,
}));
vi.mock('../src/features/auth/admin/SignIn.js', () => ({
  SignIn: (props: { restaurant?: { slug: string } }) => <p data-screen="">{`Sign in ${props.restaurant?.slug ?? ''}`}</p>,
}));
vi.mock('../src/components/UserBadge.js', () => ({ UserBadge: () => null }));

const { App } = await import('../src/app/admin/App.js');

const SLUG = 'spice-garden-blr';
const OTHER = 'another-restaurant';
const PRO_MENU = { branches: true, kot: true, devices: true, reports: true, tables: true };
const BASIC_MENU = { branches: false, kot: false, devices: true, reports: false, tables: false };

let root: Root | null = null;
let host: HTMLElement;
let menu = PRO_MENU;

function signedInAs(slug: string | null): void {
  if (slug === null) window.localStorage.removeItem('kk.session.v1');
  else window.localStorage.setItem('kk.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', tenantSlug: slug, branchId: null, userId: 'u',
  }));
}

beforeEach(() => {
  menu = PRO_MENU;
  signedInAs(SLUG);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    const known = /\/api\/public\/restaurants\/(spice-garden-blr|another-restaurant)$/.exec(url);
    if (known) {
      return Response.json({ slug: known[1], name: known[1], signInAvailable: true, themeColor: null, logoUrl: null });
    }
    if (url.includes('/api/public/restaurants/')) return new Response(null, { status: 404 });
    if (url.includes('/admin/entitlements')) {
      return Response.json({ planKey: 'pro', entitlements: { reports: 'basic' }, menu });
    }
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

async function openAt(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const screen = (): string => host.querySelector('[data-screen]')?.textContent ?? '';
const selected = (): string => host.querySelector('nav button.font-bold')?.textContent ?? '';
const links = (): string[] => [...host.querySelectorAll('nav button')].map((b) => b.textContent ?? '');

async function click(title: string): Promise<void> {
  const button = [...host.querySelectorAll('nav button')].find((b) => b.textContent === title);
  if (button === undefined) throw new Error(`no sidebar entry "${title}" among ${links().join(', ')}`);
  await act(async () => { (button as HTMLButtonElement).click(); });
}

describe('admin address', () => {
  it('reads the slug and the section', () => {
    expect(adminLocationFromPath(`/${SLUG}`)).toEqual({ slug: SLUG, section: '' });
    expect(adminLocationFromPath(`/${SLUG}/`)).toEqual({ slug: SLUG, section: '' });
    expect(adminLocationFromPath(`/${SLUG}/menu`)).toEqual({ slug: SLUG, section: 'menu' });
    expect(slugFromPath(`/${SLUG}/menu`)).toBe(SLUG);
    expect(adminPath(SLUG, 'menu')).toBe(`/${SLUG}/menu`);
    expect(adminPath(SLUG, '')).toBe(`/${SLUG}`);
  });

  it('never reads a tablet app, a reserved name or a file as an admin screen', () => {
    for (const app of ['kot', 'pos', 'billing']) expect(adminLocationFromPath(`/${SLUG}/${app}`)).toBeNull();
    // The POS, and its earlier addresses, which open the same document.
    for (const app of ['pos', 'kot', 'billing']) expect(tabletSlugFromPath('pos', `/${SLUG}/${app}`)).toBe(SLUG);
    // The kitchen screen was removed: /kds is no longer a POS address.
    expect(tabletSlugFromPath('pos', `/${SLUG}/kds`)).toBeNull();
    for (const path of ['/', '/admin.html', '/platform.html', '/superadmin', '/superadmin/restaurants', '/api/public', '/admin/menu', `/${SLUG}/menu/items`, `/${SLUG}/x.js`]) {
      expect(adminLocationFromPath(path)).toBeNull();
    }
  });
});

describe('admin sidebar and the address bar', () => {
  it('every sidebar entry keeps the slug, opens its screen, and survives a reload at its address', async () => {
    await openAt(`/${SLUG}`);
    const titles = links().filter((t) => t !== 'Sign out');
    expect(titles.length).toBeGreaterThanOrEqual(11);
    expect(titles.slice(0, 2)).toEqual(['Dashboard', 'Sale']);
    expect(titles).not.toContain('POS Access');
    for (const required of ['Dashboard', 'Menu items', 'Branches', 'Kitchens', 'Sale', 'Tablets']) {
      expect(titles).not.toContain('Staff');
      expect(titles).toContain(required);
    }
    const seen = new Map<string, { path: string; screen: string }>();
    for (const title of titles) {
      await click(title);
      const path = window.location.pathname;
      expect(adminLocationFromPath(path)?.slug).toBe(SLUG);
      expect(selected()).toBe(title);
      seen.set(title, { path, screen: screen() });
    }
    expect(new Set([...seen.values()].map((s) => s.path)).size).toBe(titles.length);
    expect(seen.get('Dashboard')!.path).toBe(`/${SLUG}`);
    expect(seen.get('Menu items')!.path).toBe(`/${SLUG}/menu`);
    expect(seen.get('Branches')!.path).toBe(`/${SLUG}/branches`);
    expect(seen.get('Kitchens')!.path).toBe(`/${SLUG}/kitchens`);

    for (const [title, { path, screen: shown }] of seen) {
      act(() => root?.unmount());
      host.remove();
      await openAt(path);
      expect(selected()).toBe(title);
      expect(screen()).toBe(shown);
      expect(window.location.pathname).toBe(path);
    }
  });

  it('each click is a history entry, and back and forward move between screens', async () => {
    await openAt(`/${SLUG}`);
    const start = window.history.length;
    await click('Menu items');
    await click('Sale');
    expect(window.history.length).toBe(start + 2);
    const settle = (): Promise<void> => new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    await act(async () => { const moved = settle(); window.history.back(); await moved; });
    expect(window.location.pathname).toBe(`/${SLUG}/menu`);
    expect(selected()).toBe('Menu items');
    expect(screen()).toBe('Step items');
    await act(async () => { const moved = settle(); window.history.forward(); await moved; });
    expect(selected()).toBe('Sale');
  });

  it('an unknown section is the dashboard, and the address says so', async () => {
    await openAt(`/${SLUG}/nothing-here`);
    expect(selected()).toBe('Dashboard');
    expect(window.location.pathname).toBe(`/${SLUG}`);
  });

  it('a section the plan leaves out is neither offered nor opened by its address', async () => {
    menu = BASIC_MENU;
    await openAt(`/${SLUG}/branches`);
    expect(links()).not.toContain('Branches');
    expect(selected()).toBe('Dashboard');
    expect(screen()).toBe('Dashboard');
    expect(window.location.pathname).toBe(`/${SLUG}`);
  });

  it('a deep link signed out shows the sign-in and keeps the section for after it', async () => {
    signedInAs(null);
    await openAt(`/${SLUG}/menu`);
    expect(screen()).toBe(`Sign in ${SLUG}`);
    expect(window.location.pathname).toBe(`/${SLUG}/menu`);
  });

  it("another restaurant's address with this session shows that restaurant's sign-in, not this one's data", async () => {
    await openAt(`/${OTHER}/menu`);
    expect(screen()).toBe(`Sign in ${OTHER}`);
    expect(host.querySelector('nav')).toBeNull();
    expect(window.location.pathname).toBe(`/${OTHER}/menu`);
  });

  it('navigation under another restaurant uses that restaurant\'s slug', async () => {
    signedInAs(OTHER);
    await openAt(`/${OTHER}`);
    await click('Menu items');
    expect(window.location.pathname).toBe(`/${OTHER}/menu`);
    await click('Branches');
    expect(window.location.pathname).toBe(`/${OTHER}/branches`);
  });

  it('an unknown restaurant is not found, whatever section follows it', async () => {
    await openAt('/unknown-restaurant/menu');
    expect(host.textContent).toContain('Restaurant not found');
    expect(host.querySelector('nav')).toBeNull();
  });
});
