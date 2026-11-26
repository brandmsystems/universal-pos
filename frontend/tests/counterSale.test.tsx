import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BUSINESS_TYPES } from '@universalpos/shared';
import { createStore, scopedStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { BusinessProvider } from '../src/lib/businessContext.js';
import { NewOrder } from '../src/features/billing/billing/NewOrder.js';

/**
 * A shop's till is the order screen without a table, a parcel or a kitchen, and
 * with a scan box. It is chosen by the registry's `workflow`, so a general-retail
 * business gets it and a restaurant does not. A product is never sent to a
 * kitchen -- even on a plan that sends orders to one -- while a dish on the same
 * order still is.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const DEVICE = { tenantSlug: 'shop', deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) };
const MENU = [
  { id: 'p1', name: 'Blue Pen', price_minor: '1500', orderable: true, category_id: null, kind: 'product', barcode: '8901234567890' },
  { id: 'p2', name: 'Blue Notebook', price_minor: '4000', orderable: true, category_id: null, kind: 'product', barcode: '8901234500011' },
  { id: 'p3', name: 'Red Stapler', price_minor: '9000', orderable: false, category_id: null, kind: 'product', barcode: '8909999999999',
    unavailable_message: 'sold out today' },
  { id: 'd1', name: 'Veg Thali', price_minor: '15000', orderable: true, category_id: null, kind: 'single', barcode: null },
];

interface Call { method: string; path: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function serve(): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname.replace(/^\/api\/t/, '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    const ok = (body: unknown) => Response.json(body);
    if (path === '/pos/menu') return ok({ menu: MENU });
    if (path === '/pos/quote') {
      return ok({ itemsMinor: 1500, parcelChargeMinor: 0, subtotalMinor: 1500, taxes: [], taxMinor: 0, totalMinor: 1500, parcelCharge: null });
    }
    if (path === '/pos/parcel' || path === '/pos/dine-in') return ok({ sessionId: SESSION, orderId: ORDER, parcelNo: 1 });
    if (path.endsWith('/lease')) {
      return ok({ sessionId: SESSION, deviceId: 'd1', token: 'lease-1', expiresAt: new Date(Date.now() + 900_000).toISOString(), claimedAt: new Date().toISOString() });
    }
    if (path.endsWith('/line')) return ok({ lineId: crypto.randomUUID() });
    if (path === `/pos/session/${SESSION}/board`) return ok({ session: { version: 3 }, lines: [], bills: [] });
    if (path.endsWith('/fire')) return ok({ stations: [] });
    if (path.endsWith('/ready-for-billing')) return ok({ sessionId: SESSION });
    return ok({ rows: [] });
  }));
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const pressEnter = async (input: HTMLInputElement): Promise<void> => {
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
};
const scanBox = (): HTMLInputElement | null => host.querySelector('input[aria-label="Scan a barcode or search products"]');
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(label)) as HTMLButtonElement;
const cartText = (): string => host.querySelector('[aria-label="Order lines"]')?.textContent ?? '';
const writes = (): string[] => calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/lease') && c.path !== '/pos/quote')
  .map((c) => c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'));

async function open(type: 'general_retail' | 'restaurant'): Promise<void> {
  serve();
  const store = scopedStore(createStore(), 'pos:shop');
  const api = createApi(store);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BusinessProvider type={BUSINESS_TYPES[type]}>
        <NewOrder api={api} device={DEVICE} leases={createLeases(store, api)} kot
          onCancel={() => undefined} onHandedOver={() => undefined} />
      </BusinessProvider>);
  });
  await settle();
}

describe('the counter-sale screen', () => {
  it('shows a shop a scan box, and no parcel switch, kitchen note or kitchen wording', async () => {
    await open('general_retail');
    expect(scanBox()).not.toBeNull();
    expect(host.querySelector('[aria-label="Parcel (take away)"]')).toBeNull();
    expect(host.textContent).toContain('New sale');
    await act(async () => { button('Blue Pen').click(); });
    expect(host.querySelector('button[aria-label^="Add a note for"]')).toBeNull();
    expect(host.textContent).not.toContain('sends the order to the kitchen');
    expect(button('Confirm sale')).toBeDefined();
  });

  it('keeps a restaurant exactly as it was: no scan box, the parcel switch, the kitchen note', async () => {
    await open('restaurant');
    expect(scanBox()).toBeNull();
    expect(host.querySelector('[aria-label="Parcel (take away)"]')).not.toBeNull();
    await act(async () => { button('Veg Thali').click(); });
    expect(host.querySelector('button[aria-label^="Add a note for"]')).not.toBeNull();
    expect(host.textContent).toContain('Confirm sends the order to the kitchen.');
    expect(host.textContent).toContain('Confirm order');
  });

  it('adds the product whose barcode was scanned, once per scan, and clears the box', async () => {
    await open('general_retail');
    await type(scanBox()!, '8901234567890');
    await pressEnter(scanBox()!);
    await type(scanBox()!, '8901234567890');
    await pressEnter(scanBox()!);
    expect(cartText()).toContain('Blue Pen');
    expect(cartText()).toContain('2'); // quantity two, from two scans
    expect(scanBox()!.value).toBe('');
  });

  it('adds a product typed by a name that matches only one, and says so when several or none match', async () => {
    await open('general_retail');
    await type(scanBox()!, 'stapl');
    await pressEnter(scanBox()!);
    // A name that only a sold-out product matches finds nothing sellable.
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Nothing sells under "stapl"');
    await type(scanBox()!, 'blue');
    await pressEnter(scanBox()!);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('2 products match');
    expect(cartText()).not.toContain('Blue');
    await type(scanBox()!, 'zzzz');
    await pressEnter(scanBox()!);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Nothing sells under "zzzz"');
    await type(scanBox()!, 'notebook');
    await pressEnter(scanBox()!);
    expect(cartText()).toContain('Blue Notebook');
  });

  it('refuses a scanned barcode of a product that cannot be sold now, and says why', async () => {
    await open('general_retail');
    await type(scanBox()!, '8909999999999');
    await pressEnter(scanBox()!);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Red Stapler cannot be sold now: sold out today');
    expect(cartText()).not.toContain('Red Stapler');
  });

  it('Confirm on products alone writes open, line, ready-for-billing -- and NEVER fires, though the plan has a kitchen', async () => {
    await open('general_retail');
    await type(scanBox()!, '8901234567890');
    await pressEnter(scanBox()!);
    await act(async () => { button('Confirm sale').click(); });
    await settle();
    expect(writes()).toEqual(['/pos/dine-in', '/pos/order/:id/line', '/pos/session/:id/ready-for-billing']);
    // The quote is never asked for a parcel in a shop.
    expect(calls.filter((c) => c.path === '/pos/quote').every((c) => c.body!['parcel'] === false)).toBe(true);
  });

  it('a dish on the same order still goes to the kitchen: the fire step is skipped only when nothing in the cart is cooked', async () => {
    await open('general_retail');
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { button('Blue Pen').click(); });
    await act(async () => { button('Confirm sale').click(); });
    await settle();
    expect(writes()).toEqual(['/pos/dine-in', '/pos/order/:id/line', '/pos/order/:id/line', '/pos/order/:id/fire', '/pos/session/:id/ready-for-billing']);
  });
});
