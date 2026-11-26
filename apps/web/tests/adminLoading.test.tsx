import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../src/app/admin/App.js';

/**
 * Loading skeletons in the restaurant admin, against the REAL screens and the
 * real api client -- only `fetch` is replaced, and any read can be held open.
 *
 * A skeleton is "asked, not answered". Each screen is checked in all three of
 * its other states too, because a skeleton that outlives an error or an empty
 * list is a screen promising data that is not coming.
 */

const SLUG = 'spice-garden-blr';
const NAME = 'Spice Garden';

type Answer = { status: number; body: unknown };
let answers: Map<string, Answer>;
let held: Map<string, (() => void)[]>;
let offline: Set<string>;

function answer(path: string, body: unknown, status = 200): void {
  answers.set(path, { status, body });
}

/** Every request to `path` waits until `release(path)`. */
function hold(path: string): void {
  held.set(path, []);
}

async function release(path: string): Promise<void> {
  const waiting = held.get(path) ?? [];
  held.delete(path);
  await act(async () => {
    for (const go of waiting) go();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

beforeEach(() => {
  window.localStorage.setItem('kk.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', tenantSlug: SLUG, branchId: null, userId: 'u',
  }));
  held = new Map();
  offline = new Set();
  answers = new Map();
  answer(`/api/public/restaurants/${SLUG}`, { slug: SLUG, name: NAME, signInAvailable: true, themeColor: null, logoUrl: null });
  answer('/api/t/admin/entitlements', {
    planKey: 'pro', entitlements: { reports: 'basic' },
    menu: { branches: true, kot: true, devices: true, reports: true, tables: true },
  });
  answer('/api/t/admin/branches', {
    rows: [{ id: 'b1', name: 'Koramangala', status: 'active' }],
    editable: ['name'], creatable: ['name'], deletes: 'archive', required: [],
  });
  answer('/api/t/admin/menu/items', {
    rows: [{ id: 'i1', name: 'Paneer Tikka', kind: 'single', category_id: null, station_code: 'grill', price_minor: '32000', barcode: null }],
  });
  answer('/api/t/admin/kitchens', { rows: [{ id: 'k1', name: 'Tandoor', kind: 'food', printerName: 'Pass printer' }] });
  answer('/api/t/admin/access', []);
  for (const empty of ['menu/categories', 'tax-classes', 'addons', 'printers', 'floors', 'floor-types']) {
    answer(`/api/t/admin/${empty}`, { rows: [] });
  }

  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    const waiting = held.get(path);
    if (waiting !== undefined) await new Promise<void>((resolve) => waiting.push(resolve));
    if (offline.has(path)) throw new TypeError('Failed to fetch');
    const found = answers.get(path);
    if (found === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(found.body, { status: found.status });
  }));
});

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function openAt(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await settle();
}

const skeletons = (): string[] => [...host.querySelectorAll('[data-skeleton]')].map((e) => e.getAttribute('data-skeleton')!);
const main = (): string => host.querySelector('main')?.textContent ?? '';
const selected = (): string => host.querySelector('nav button.font-bold')?.textContent ?? '';

/** The shell stays: sidebar, the chosen entry, the restaurant, the address. */
function shellIntact(title: string, path: string): void {
  expect(host.querySelector('nav')).not.toBeNull();
  expect(selected()).toBe(title);
  expect(host.querySelector('nav')!.textContent).toContain(NAME);
  expect(host.querySelector('nav')!.textContent).toContain('Sign out');
  expect(window.location.pathname).toBe(path);
}

describe('a screen whose data is loading shows its skeleton inside the shell', () => {
  it('Menu: skeleton with the real columns, then the menu', async () => {
    hold('/api/t/admin/menu/items');
    await openAt(`/${SLUG}/menu`);
    shellIntact('Menu items', `/${SLUG}/menu`);
    expect(skeletons()).toContain('food items');
    const bones = host.querySelector('[data-skeleton="food items"]')!;
    expect(bones.getAttribute('role')).toBe('status');
    expect(bones.textContent).toContain('Item');
    expect(bones.textContent).toContain('Price');
    expect(main()).not.toContain('Paneer Tikka');
    expect(main()).not.toContain('Dashboard');
    expect(main()).not.toContain('Loading…');

    await release('/api/t/admin/menu/items');
    expect(skeletons()).not.toContain('food items');
    expect(main()).toContain('Paneer Tikka');
    shellIntact('Menu items', `/${SLUG}/menu`);
  });

  it('Branches: table skeleton, then the branches', async () => {
    hold('/api/t/admin/branches');
    await openAt(`/${SLUG}/branches`);
    shellIntact('Branches', `/${SLUG}/branches`);
    expect(skeletons()).toContain('Branches');
    expect(main()).not.toContain('Koramangala');

    await release('/api/t/admin/branches');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Koramangala');
  });

  it('Kitchens: skeleton, then the kitchens', async () => {
    hold('/api/t/admin/kitchens');
    await openAt(`/${SLUG}/kitchens`);
    shellIntact('Kitchens', `/${SLUG}/kitchens`);
    expect(skeletons()).toContain('kitchens');
    expect(host.querySelector('[data-skeleton="kitchens"]')!.textContent).toContain('Printer');

    await release('/api/t/admin/kitchens');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Tandoor');
  });

  it('Sale (POS access): skeleton instead of "Loading…", then the read-only list', async () => {
    hold('/api/t/admin/access');
    await openAt(`/${SLUG}/access`);
    shellIntact('Sale', `/${SLUG}/access`);
    expect(skeletons()).toContain('access list');
    expect(main()).not.toContain('Loading…');

    await release('/api/t/admin/access');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Your Sales person adds staff.');
  });

  it('a plan-gated deep link waits as a skeleton, never as the dashboard', async () => {
    hold('/api/t/admin/entitlements');
    await openAt(`/${SLUG}/branches`);
    expect(skeletons()).toContain('Branches');
    expect(main()).not.toContain('Dashboard');
    expect(window.location.pathname).toBe(`/${SLUG}/branches`);

    await release('/api/t/admin/entitlements');
    expect(selected()).toBe('Branches');
    expect(main()).toContain('Koramangala');
  });
});

describe('a skeleton ends when the read ends, whatever it said', () => {
  it('Menu: a failed read shows the failure', async () => {
    answer('/api/t/admin/menu/items', { error: 'boom' }, 500);
    await openAt(`/${SLUG}/menu`);
    expect(skeletons()).not.toContain('food items');
    expect(main()).toContain('This list did not load.');
  });

  it('Branches: a failed read shows the failure', async () => {
    answer('/api/t/admin/branches', { error: 'boom' }, 500);
    await openAt(`/${SLUG}/branches`);
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('This list did not load.');
  });

  it('Sale (POS access): a failed read shows the failure', async () => {
    answer('/api/t/admin/access', { error: 'boom' }, 500);
    await openAt(`/${SLUG}/access`);
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('The access list did not load.');
  });

  it('Branches: a first read that fails OFFLINE ends the skeleton too', async () => {
    offline.add('/api/t/admin/branches');
    await openAt(`/${SLUG}/branches`);
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('This list did not load.');
  });

  it('Dashboard: a first read that fails OFFLINE ends the skeleton too', async () => {
    offline.add('/api/t/admin/reports/sales');
    await openAt(`/${SLUG}`);
    expect(skeletons()).not.toContain('sales figures');
    expect(main()).toContain('The figures could not be read');
  });

  it('Menu: an empty list shows the empty state', async () => {
    answer('/api/t/admin/menu/items', { rows: [] });
    await openAt(`/${SLUG}/menu`);
    expect(skeletons()).not.toContain('food items');
    expect(main()).toContain('No food items yet.');
  });

  it('Branches: an empty list shows the empty state', async () => {
    answer('/api/t/admin/branches', { rows: [], editable: [], creatable: [], deletes: 'none', required: [] });
    await openAt(`/${SLUG}/branches`);
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Nothing here yet.');
  });

  it('Dashboard: the figures skeleton, then the existing "could not be read" on failure', async () => {
    hold('/api/t/admin/reports/sales');
    answer('/api/t/admin/reports/sales', { error: 'boom' }, 500);
    await openAt(`/${SLUG}`);
    shellIntact('Dashboard', `/${SLUG}`);
    expect(skeletons()).toEqual(expect.arrayContaining(['sales figures', 'sales by hour', 'payments', 'top items']));
    expect(main()).not.toContain('could not be read');

    await release('/api/t/admin/reports/sales');
    expect(skeletons()).not.toContain('sales figures');
    expect(main()).toContain('The figures could not be read');
  });
});

describe('the restaurant lookup', () => {
  it('signed in, waits as the admin shell; an unknown restaurant then says so', async () => {
    hold(`/api/public/restaurants/${SLUG}`);
    answer(`/api/public/restaurants/${SLUG}`, { error: 'restaurant_not_found' }, 404);
    await openAt(`/${SLUG}/menu`);
    expect(skeletons()).toContain('restaurant');
    expect(host.textContent).not.toContain('Restaurant not found');

    await release(`/api/public/restaurants/${SLUG}`);
    expect(skeletons()).toEqual([]);
    expect(host.textContent).toContain('Restaurant not found');
  });
});
