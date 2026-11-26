import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import {
  ADMIN_SECTION_KEYS, BUSINESS_TYPES, BUSINESS_TYPE_KEYS, THEME_COLOR_PATTERN, businessTypeOf,
} from '@universalpos/shared';
import { accentFor, applyBusinessTheme, titleFor, visibleSections } from '../src/lib/business.js';

/**
 * The manager shell takes its sections, words and look from the business type
 * registry. The screens are stubbed: what is under test is which sections the
 * shell offers a restaurant and a shop, what they are called, and what the
 * document is told about the theme.
 */

vi.mock('../src/features/dashboard/admin/Dashboard.js', () => ({ Dashboard: () => <p data-screen="">Dashboard</p> }));
vi.mock('../src/features/settings/admin/TaxRates.js', () => ({ TaxRates: () => <p data-screen="">Tax rates</p> }));
vi.mock('../src/features/settings/admin/setup/Setup.js', () => ({
  Setup: () => <p data-screen="">Setup</p>,
  StepScreen: () => <p data-screen="">Step</p>,
}));
vi.mock('../src/features/settings/admin/Table.js', () => ({
  Table: (props: { resource: string; title: string }) => <p data-screen="">{`Table ${props.resource} ${props.title}`}</p>,
}));
vi.mock('../src/features/access/admin/pos-kds-access/PosKdsAccessPage.js', () => ({
  PosKdsAccessPage: () => <p data-screen="">Access</p>,
}));
vi.mock('../src/features/auth/admin/SignIn.js', () => ({ SignIn: () => <p data-screen="">Sign in</p> }));
vi.mock('../src/components/UserBadge.js', () => ({ UserBadge: () => null }));

const { App } = await import('../src/app/admin/App.js');

const SHOP = 'corner-shop';
const KITCHEN = 'spice-garden';
const MENU = { branches: true, kot: true, devices: true, reports: true, tables: true };

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    const known = /\/api\/public\/restaurants\/(corner-shop|spice-garden|old-api)$/.exec(url);
    if (known) {
      const slug = known[1]!;
      return Response.json({
        slug, name: slug, signInAvailable: true, themeColor: null, logoUrl: null,
        ...(slug === 'old-api' ? {} : { businessType: slug === SHOP ? 'general_retail' : 'restaurant' }),
      });
    }
    if (url.includes('/admin/entitlements')) return Response.json({ planKey: 'pro', entitlements: { reports: 'basic' }, menu: MENU });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  applyBusinessTheme(null);
});

async function openAs(slug: string, at = ''): Promise<void> {
  window.localStorage.setItem('kk.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', tenantSlug: slug, branchId: null, userId: 'u',
  }));
  window.history.replaceState(null, '', `/${slug}${at}`);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const sidebar = (): string[] => [...host.querySelectorAll('nav button')].map((b) => b.textContent ?? '').filter((t) => t !== 'Sign out');

describe('the manager shell follows the business type', () => {
  it('shows a restaurant every section, with its own words', async () => {
    await openAs(KITCHEN);
    const titles = sidebar();
    for (const expected of ['Dashboard', 'Open orders', 'Menu items', 'Kitchens', 'Tablets']) expect(titles).toContain(expected);
    expect(titles.length).toBeGreaterThanOrEqual(11);
    expect(document.documentElement.dataset['businessTheme']).toBe('restaurant');
    expect(document.documentElement.dataset['radius']).toBeUndefined();
  });

  it('shows a shop no kitchen and no open orders, in shop words, with its own theme', async () => {
    await openAs(SHOP);
    const titles = sidebar();
    expect(titles).toContain('Products');
    expect(titles).toContain('Sales and bills');
    expect(titles).toContain('Counters');
    for (const gone of ['Kitchens', 'Open orders', 'Menu items', 'Tablets']) expect(titles, gone).not.toContain(gone);
    expect(document.documentElement.dataset['businessTheme']).toBe('retail');
    expect(document.documentElement.dataset['radius']).toBe('sharp');
    // The accent is the type's own, because this shop set no colour of its own.
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#2563eb');
  });

  it('opens the shop\'s product screen with its sidebar entry selected and named in shop words', async () => {
    await openAs(SHOP, '/menu');
    expect(host.querySelector('nav button.font-bold')?.textContent).toBe('Products');
    expect(window.location.pathname).toBe(`/${SHOP}/menu`);
  });

  it('sends a shop that deep-links to a restaurant-only section to its dashboard', async () => {
    await openAs(SHOP, '/kitchens');
    expect(window.location.pathname).toBe(`/${SHOP}`);
    expect(host.querySelector('[data-screen]')?.textContent).toBe('Dashboard');
  });

  it('treats an API that sends no type as a restaurant', async () => {
    await openAs('old-api');
    expect(sidebar()).toContain('Kitchens');
    expect(document.documentElement.dataset['businessTheme']).toBe('restaurant');
  });
});

describe('the helpers read the registry and nothing else', () => {
  const SECTIONS = ADMIN_SECTION_KEYS.map((key) => ({ path: key, title: `T:${key}` }));

  it('orders sections as the type lists them and drops what it omits', () => {
    expect(visibleSections(SECTIONS, BUSINESS_TYPES.restaurant).map((s) => s.path)).toEqual([...ADMIN_SECTION_KEYS]);
    const shop = visibleSections(SECTIONS, BUSINESS_TYPES.general_retail).map((s) => s.path);
    expect(shop).not.toContain('kitchens');
    expect(shop).toContain('menu');
  });

  it('follows a synthetic type: a registry entry the shell has never seen still drives it', () => {
    const synthetic = { ...BUSINESS_TYPES.general_retail, nav: ['', 'tax', 'bills'] as const, navLabels: { tax: 'Duties' } };
    expect(visibleSections(SECTIONS, synthetic).map((s) => s.path)).toEqual(['', 'tax', 'bills']);
    expect(titleFor(synthetic, { path: 'tax', title: 'Tax rates' })).toBe('Duties');
    expect(titleFor(synthetic, { path: 'bills', title: 'Bills' })).toBe('Bills');
  });

  it('keeps a business\'s own colour over its type\'s, and the product\'s colours for a restaurant', () => {
    expect(accentFor('#112233', BUSINESS_TYPES.general_retail)).toBe('#112233');
    expect(accentFor(null, BUSINESS_TYPES.general_retail)).toBe('#2563eb');
    expect(accentFor(null, BUSINESS_TYPES.restaurant)).toBeNull();
    expect(businessTypeOf('nonsense').key).toBe('restaurant');
  });

  it('writes only accents the theme code will accept', () => {
    const accents = BUSINESS_TYPE_KEYS.map((key) => BUSINESS_TYPES[key].theme.primary).filter((c): c is string => c !== null);
    expect(accents.length).toBeGreaterThanOrEqual(5);
    for (const accent of accents) expect(THEME_COLOR_PATTERN.test(accent), accent).toBe(true);
  });

  it('has a corner-radius rule in the stylesheet for every radius the registry uses', () => {
    const css = readFileSync(path.resolve(import.meta.dirname, '../src/styles/business-themes.css'), 'utf8');
    const used = new Set(BUSINESS_TYPE_KEYS.map((key) => BUSINESS_TYPES[key].theme.radius).filter((r) => r !== 'soft'));
    expect(used.size, 'the registry should exercise more than one radius').toBeGreaterThanOrEqual(2);
    for (const radius of used) expect(css, `no rule for radius ${radius}`).toContain(`data-radius="${radius}"`);
    // The admin and the POS must both load it.
    for (const sheet of ['admin.css', 'pos.css']) {
      expect(readFileSync(path.resolve(import.meta.dirname, '../src/styles', sheet), 'utf8')).toContain('business-themes.css');
    }
  });

  it('keeps the admin\'s section list equal to the registry\'s list of sections', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../src/app/admin/App.tsx'), 'utf8');
    const block = source.slice(source.indexOf('const SECTIONS'), source.indexOf('/** The sidebar\'s icon'));
    const paths = [...block.matchAll(/path: '([^']*)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(13);
    expect(paths).toEqual([...ADMIN_SECTION_KEYS]);
  });
});
