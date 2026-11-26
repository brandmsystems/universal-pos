import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../src/app/platform/App.js';

/**
 * Loading skeletons in the console (Super Admin and Sales Person), against the
 * real screens and the real api client -- only `fetch` is replaced, and any
 * read can be held open.
 *
 * Before these, every console screen drew "could not be read just now" while
 * its first read was still in flight: `never-read` and `read-failed` were one
 * branch. Each case below pins both halves -- the skeleton while asked, and
 * no skeleton once answered or refused.
 */

type Answer = { status: number; body: unknown };
let answers: Map<string, Answer>;
let held: Map<string, (() => void)[]>;

function answer(path: string, body: unknown, status = 200): void {
  answers.set(`/api/platform${path}`, { status, body });
}

function hold(path: string): void {
  held.set(`/api/platform${path}`, []);
}

async function release(path: string): Promise<void> {
  const waiting = held.get(`/api/platform${path}`) ?? [];
  held.delete(`/api/platform${path}`);
  await act(async () => {
    for (const go of waiting) go();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

const TENANT = {
  tenantId: 't1', slug: 'dosa-corner', name: 'Dosa Corner', status: 'active', defaultCurrency: 'INR',
  revenueMinor: 0, priceMinor: 99900, priceCurrency: 'INR', billingPeriod: 'monthly', planName: 'Basic',
  subscriptionId: 's1', subscriptionStatus: 'active', currentPeriodStart: '2026-09-01', currentPeriodEnd: '2027-09-01',
  ownerName: 'Asha', ownerEmail: 'asha@dosa.example', ownerPhone: null, ownerInviteStatus: 'accepted',
  salesPersonName: null, salesPersonEmail: null, billingStatus: 'paid',
};

beforeEach(() => {
  held = new Map();
  answers = new Map();
  answer('/tenants', [TENANT]);
  answer('/plans', []);
  answer('/invoices', []);
  answer('/dunning', []);
  answer('/users', []);
  answer('/sales-persons', []);

  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    const waiting = held.get(path);
    if (waiting !== undefined) await new Promise<void>((resolve) => waiting.push(resolve));
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
  window.localStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function openAs(role: string): Promise<void> {
  window.localStorage.setItem('kk.platform.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', platformUserId: 'p1', role,
  }));
  window.history.replaceState(null, '', '/platform.html');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await settle();
}

async function go(title: string): Promise<void> {
  const button = [...host.querySelectorAll('aside nav button')]
    .find((b) => b.textContent?.startsWith(title)) as HTMLButtonElement;
  await act(async () => { button.click(); });
  await settle();
}

const skeletons = (): string[] => [...host.querySelectorAll('[data-skeleton]')].map((e) => e.getAttribute('data-skeleton')!);
const main = (): string => host.querySelector('main')?.textContent ?? '';

/** The shell stays: sidebar with its entries, sign-out, the address. */
function shellIntact(entry: string, path: string): void {
  const aside = host.querySelector('aside')!;
  expect(aside.textContent).toContain(entry);
  expect(aside.textContent).toContain('Sign out');
  expect(window.location.pathname).toBe(path);
}

describe('console screens show a skeleton while their read is out', () => {
  it('Super Admin dashboard: tiles, chart and lists, then the figures', async () => {
    for (const path of ['/tenants', '/plans', '/invoices', '/dunning']) hold(path);
    await openAs('super_admin');
    shellIntact('Dashboard', '/superadmin/dashboard');
    expect(skeletons()).toEqual(expect.arrayContaining([
      'Restaurants', 'Monthly recurring', 'Needs chasing today', 'Invoiced',
      'invoiced by day', 'plans by subscription', 'recent invoices',
    ]));
    expect(main()).not.toContain('Could not be read');
    expect(main()).not.toContain('No invoices have been raised');

    for (const path of ['/tenants', '/plans', '/invoices', '/dunning']) await release(path);
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('all active');
    expect(main()).toContain('No invoices have been raised');
  });

  it('a failed read shows its message, never a skeleton', async () => {
    answer('/tenants', { error: 'boom' }, 500);
    await openAs('super_admin');
    expect(skeletons()).not.toContain('Restaurants');
    expect(main()).toContain('Could not be read just now');
  });

  it('Plans: plan-card skeleton, then the empty catalogue', async () => {
    await openAs('super_admin');
    hold('/plans');
    await go('Plans');
    expect(skeletons()).toContain('plans');
    expect(main()).not.toContain('No plans exist yet');
    expect(main()).not.toContain('could not be read');

    await release('/plans');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('No plans exist yet');
  });

  it('Restaurants: the table under its real columns, then the rows', async () => {
    await openAs('super_admin');
    hold('/tenants');
    await go('Restaurants');
    const bones = host.querySelector('[data-skeleton="restaurants"]')!;
    expect(bones.getAttribute('role')).toBe('status');
    expect(bones.textContent).toContain('Sales person');
    expect(bones.textContent).toContain('Subscription');
    expect(main()).not.toContain('No restaurants yet');

    await release('/tenants');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Dosa Corner');
  });

  it('Billing: queue and ledger skeletons, then their empty text', async () => {
    await openAs('super_admin');
    hold('/dunning');
    hold('/invoices');
    await go('Billing');
    expect(skeletons()).toEqual(expect.arrayContaining(['dunning queue', 'invoices']));
    expect(main()).not.toContain('it is unknown');

    await release('/dunning');
    await release('/invoices');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('Nobody is behind on payment');
  });

  it('Platform staff and Sales persons: list skeletons, then the lists', async () => {
    await openAs('super_admin');
    hold('/users');
    await go('Platform staff');
    expect(host.querySelector('[data-skeleton="platform staff"]')!.textContent).toContain('Last sign-in');
    await release('/users');
    expect(skeletons()).toEqual([]);

    hold('/sales-persons');
    await go('Sales persons');
    expect(skeletons()).toContain('sales persons');
    expect(main()).not.toContain('No sales persons yet');
    await release('/sales-persons');
    expect(skeletons()).toEqual([]);
    expect(main()).toContain('No sales persons yet');
  });

  it('Sales Person home: tiles and their restaurant list load in the sales console', async () => {
    hold('/tenants');
    await openAs('sales');
    shellIntact('My dashboard', '/platform.html');
    expect(host.querySelector('[aria-label="Loading sales figures"]')?.getAttribute('aria-busy')).toBe('true');
    const bones = host.querySelector('[data-skeleton="restaurants"]')!;
    expect(bones.textContent).toContain('Login');
    expect(bones.textContent).not.toContain('Sales person');

    await release('/tenants');
    expect(skeletons()).toEqual([]);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(main()).toContain('Dosa Corner');
  });
});
