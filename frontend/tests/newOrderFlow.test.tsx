import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { createConsensusKeys } from '../src/lib/consensus.js';
import { NewOrder } from '../src/features/billing/billing/NewOrder.js';
import { BillingWorkspace } from '../src/features/billing/billing/Desk.js';
import { printHtml } from '../src/features/billing/print/receipt.js';
import { createReceiptPrinter, type ReceiptPrinter } from '../src/features/billing/print/serialPrinter.js';
import { fakeSerial } from './fakeSerial.js';

vi.mock('../src/features/billing/print/receipt.js', async (original) => ({
  ...await original<typeof import('../src/features/billing/print/receipt.js')>(),
  printHtml: vi.fn(),
}));

/**
 * Basic's one POS screen: pick items, Confirm -- the order is opened, filled,
 * sent to the kitchen and handed to billing in that order, each step once --
 * and then billed straight away for payment. Nothing prints on Confirm: the three
 * labelled copies (customer, kitchen, billing counter) print once the bill is paid in
 * full, and each can be reprinted safely. A retry after a failure finishes
 * the SAME order; it never opens a second one or sends a second ticket.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const DEVICE = { tenantSlug: 'spice', deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) };
const MENU = [
  { id: 'm1', name: 'Veg Thali', price_minor: '15000', orderable: true, category_id: null },
  { id: 'm2', name: 'Masala Tea', price_minor: '2000', orderable: true, category_id: null },
];

interface Call { method: string; path: string; body: Record<string, unknown> | null; key: string | null }

/** The branch's parcel-charge terms the fake server prices with. 0/0 is a branch that takes none. */
let terms = { defaultMinor: 0, maxMinor: 0 };
/**
 * The fake server's `POST /pos/quote`: a 5% split CGST + SGST, the charge
 * defaulting to the branch's and refused over its cap -- the shape and the
 * refusal the real one answers (basicTill.test.ts 3c asserts the real one).
 */
function quoteAnswer(body: Record<string, unknown>): Response {
  const lines = (body['lines'] as { menuItemId: string; quantity: number }[]) ?? [];
  const items = lines.reduce((n, l) => n + Number(MENU.find((m) => m.id === l.menuItemId)?.price_minor ?? 1000) * l.quantity, 0);
  const parcel = body['parcel'] === true;
  const charge = parcel ? Number(body['parcelChargeMinor'] ?? terms.defaultMinor) : 0;
  if (charge > terms.maxMinor) {
    return Response.json({ error: 'parcel_charge_above_max', retryable: false,
      detail: `A parcel charge of ${charge} is more than this branch allows (${terms.maxMinor}).` }, { status: 422 });
  }
  const subtotal = items + charge;
  const half = Math.round(subtotal * 250 / 10000);
  return Response.json({
    itemsMinor: items, parcelChargeMinor: charge, subtotalMinor: subtotal,
    taxes: [{ name: 'CGST', rateBps: 250, amountMinor: half }, { name: 'SGST', rateBps: 250, amountMinor: half }],
    taxMinor: half * 2, totalMinor: subtotal + half * 2,
    // As the server: paid to the nearest rupee, under 50 paise down, 50 or more up.
    roundOffMinor: (subtotal + half * 2) % 100 >= 50 ? 100 - ((subtotal + half * 2) % 100) : -((subtotal + half * 2) % 100),
    payableMinor: Math.round((subtotal + half * 2) / 100) * 100,
    parcelCharge: parcel ? terms : null,
  });
}
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

/** A server that answers the order steps; `failOnce` refuses that path the first time with a dropped connection. */
function serve(failOnce: string | null = null): void {
  calls = [];
  terms = { defaultMinor: 0, maxMinor: 0 };
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname.replace(/^\/api\/t/, '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, key: headers.get('idempotency-key') });
    if (failOnce !== null && path === failOnce && !failed) { failed = true; throw new TypeError('network down'); }
    const ok = (body: unknown) => Response.json(body);
    if (path === '/pos/menu') return ok({ menu: MENU });
    if (path === '/pos/quote') return quoteAnswer(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (path === '/pos/parcel' || path === '/pos/dine-in') return ok({ sessionId: SESSION, orderId: ORDER, parcelNo: 7 });
    if (path.endsWith('/parcel-charge')) return ok({ orderId: ORDER, amountMinor: 0, lineId: null });
    if (path.endsWith('/lease')) return ok({ sessionId: SESSION, deviceId: 'd1', token: 'lease-1', expiresAt: new Date(Date.now() + 900_000).toISOString(), claimedAt: new Date().toISOString() });
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
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label || b.textContent?.startsWith(label)) as HTMLButtonElement;
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function openNewOrder(onHandedOver = vi.fn()): Promise<void> {
  const store = scopedStore(createStore(), 'pos:spice');
  const api = createApi(store);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<NewOrder api={api} device={DEVICE} leases={createLeases(store, api)} kot
      onCancel={() => undefined} onHandedOver={onHandedOver} />);
  });
  await settle();
}

/** What Confirm wrote. The estimate is a POST that writes nothing, so it is not one. */
const writes = (): Call[] => calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/lease') && c.path !== '/pos/quote');
const quotes = (): Record<string, unknown>[] => calls.filter((c) => c.path === '/pos/quote').map((c) => c.body!);
/** Past the estimate's 250 ms pause, so the newest one has been asked and answered. */
const estimated = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await settle();
};
const chargeBox = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>('input[aria-label="Parcel charge"]');
const estimate = (): string => host.querySelector('[aria-label="Estimate"]')?.textContent ?? '';

describe('Confirm order', () => {
  it('opens a PARCEL with the name, adds each item with its quantity and note, sends to the kitchen, hands over -- in that order', async () => {
    serve();
    const handedOver = vi.fn();
    await openNewOrder(handedOver);
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { button('Masala Tea').click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await type(host.querySelector('input[placeholder="e.g. Rahul"]') as HTMLInputElement, 'Rahul');
    // The note is folded behind + until wanted.
    expect(host.querySelector('input[aria-label="Note for Veg Thali"]')).toBeNull();
    await act(async () => { button('Add a note for Veg Thali').click(); });
    await type(host.querySelector('input[aria-label="Note for Veg Thali"]') as HTMLInputElement, 'less spicy');

    await act(async () => { button('Confirm order').click(); });
    await settle();

    expect(writes().map((c) => [c.path, c.body])).toEqual([
      ['/pos/parcel', { pickupName: 'Rahul' }],
      [`/pos/order/${ORDER}/line`, { menuItemId: 'm1', quantity: 2, note: 'less spicy' }],
      [`/pos/order/${ORDER}/line`, { menuItemId: 'm2', quantity: 1 }],
      [`/pos/order/${ORDER}/fire`, { sessionVersion: 3 }],
      [`/pos/session/${SESSION}/ready-for-billing`, {}],
    ]);
    expect(handedOver).toHaveBeenCalledWith(SESSION);
  });

  it('without the Parcel switch it is a counter dine-in order, with no name when none was typed', async () => {
    serve();
    await openNewOrder();
    await act(async () => { button('Masala Tea').click(); });
    await act(async () => { button('Confirm order').click(); });
    await settle();
    expect(writes()[0]).toMatchObject({ path: '/pos/dine-in', body: { pickupName: null } });
  });

  it('a double tap sends the order once', async () => {
    serve();
    await openNewOrder();
    await act(async () => { button('Masala Tea').click(); });
    await act(async () => { button('Confirm order').click(); button('Confirm order').click(); });
    await settle();
    expect(writes().filter((c) => c.path === '/pos/dine-in')).toHaveLength(1);
    expect(writes().filter((c) => c.path.endsWith('/fire'))).toHaveLength(1);
  });

  it('a dropped connection mid-way: the cart locks, and Try again finishes the SAME order with the same keys', async () => {
    serve(`/pos/order/${ORDER}/fire`);
    const handedOver = vi.fn();
    await openNewOrder(handedOver);
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { button('Confirm order').click(); });
    await settle();

    expect(host.textContent).toContain('tap Confirm order again to finish this same order');
    expect(button('Try again')).toBeDefined();
    expect(button('Veg Thali').disabled).toBe(true);
    expect(handedOver).not.toHaveBeenCalled();
    const firstFire = writes().find((c) => c.path.endsWith('/fire'))!;
    const firstLine = writes().find((c) => c.path.endsWith('/line'))!;

    await act(async () => { button('Try again').click(); });
    await settle();

    // No second order; the line and the kitchen send replay under the keys they first went with.
    expect(writes().filter((c) => c.path === '/pos/dine-in')).toHaveLength(1);
    const lines = writes().filter((c) => c.path.endsWith('/line'));
    expect(new Set(lines.map((c) => c.key))).toEqual(new Set([firstLine.key]));
    const fires = writes().filter((c) => c.path.endsWith('/fire'));
    expect(fires).toHaveLength(2);
    expect(fires[1]!.key).toBe(firstFire.key);
    expect(handedOver).toHaveBeenCalledWith(SESSION);
  });
});

describe('after Confirm: the bill and payment; the copies print once the order is PAID', () => {
  const TOTAL = 15750;
  /** A bill made under the nearest-rupee rule (0082) in the one test that sets it; 0 elsewhere. */
  let roundOff = 0;
  /** The parcel charge inside the bill's 150.00 subtotal, as the board splits it (0081); 0 elsewhere. */
  let chargeOnBill = 0;
  /** How the bill was taxed (0083); GST forward elsewhere. */
  let taxedAs: { tax_account_type: string; prices_include_tax: boolean } = { tax_account_type: 'gst', prices_include_tax: false };
  const billRow = (paid: number) => ({ id: 'bill1', bill_no: 12, subtotal_minor: '15000', tax_minor: '750', total_minor: String(TOTAL),
    items_minor: String(15000 - chargeOnBill), parcel_charge_minor: String(chargeOnBill), ...taxedAs,
    round_off_minor: String(roundOff), payable_minor: String(TOTAL + roundOff),
    paid_minor: String(paid), outstanding_minor: String(TOTAL + roundOff - paid), settled: paid >= TOTAL + roundOff, tenders: [] });
  const LAYOUT = {
    printerName: null, connection: null, printerType: 'thermal', paperSize: 'thermal_80', orientation: 'portrait',
    marginMm: 3, fontSizePx: 12, show: { logo: true, details: true, customer: true, tax: true, payments: true },
    copies: { customer: true, kitchen: true, counter: true }, autoPrint: true,
  };
  const printedBill = (copyNo: number, parcel: boolean, paid: number, layout: unknown) => ({
    kind: paid >= TOTAL ? 'receipt' : 'bill', copyNo, layout, currency: 'INR', timezone: 'Asia/Kolkata', billNo: 12, businessDate: '2026-10-13',
    openedAt: '2026-10-13T10:00:00Z', billedAt: '2026-10-13T10:01:00Z', settledAt: null, printedAt: '2026-10-13T10:01:00Z',
    serviceType: parcel ? 'parcel' : 'dine_in', tables: [], parcelNo: 7, pickupName: parcel ? 'Rahul' : null, covers: null,
    waiter: null, cashier: 'Asha',
    restaurant: { name: 'Spice', legalName: null, address: null, phone: null, gstin: null, footer: '' },
    lines: [{ quantity: 1, name: 'Veg Thali', rateMinor: 15000, grossMinor: 15000, addOns: [], lessMinor: 0, lessLabel: null }],
    subtotalMinor: 15000, taxes: [], taxMinor: 750, totalMinor: TOTAL, tenders: [], paidMinor: paid, outstandingMinor: TOTAL - paid,
  });

  async function confirmed(parcel: boolean, layout: unknown = LAYOUT, printer?: ReceiptPrinter): Promise<void> {
    let billed = false;
    let paid = 0;
    let closed = false;
    let copies = 0;
    let charge = 0;
    calls = [];
    vi.mocked(printHtml).mockClear();
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://x').pathname.replace(/^\/api\/t/, '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ method, path, body, key: new Headers(init?.headers).get('idempotency-key') });
      const json = (answer: unknown) => Response.json(answer);
      const lease = { sessionId: SESSION, deviceId: 'd1', token: 't', expiresAt: new Date(Date.now() + 900_000).toISOString(), claimedAt: new Date().toISOString() };
      if (path === '/billing/queue') {
        return json({ kot: true, rows: [{ sessionId: SESSION, orderId: ORDER, businessDate: '2026-10-13', leftover: false,
          serviceType: parcel ? 'parcel' : 'dine_in', parcelNo: 7, pickupName: parcel ? 'Rahul' : null, tables: [], itemCount: 1,
          amountMinor: '15000', billedMinor: null, paidMinor: String(paid), readyAt: new Date().toISOString(), readyBy: 'Asha',
          payment: paid === 0 ? 'none' : paid >= TOTAL ? 'full' : 'part',
          status: closed ? 'completed' : paid === 0 ? 'ready' : 'in_progress' }] });
      }
      if (method === 'DELETE' && path === `/pos/session/${SESSION}`) { closed = true; return json({ closed: true }); }
      if (path === '/pos/menu') return json({ menu: MENU });
      if (path === '/pos/parcel' || path === '/pos/dine-in') return json({ sessionId: SESSION, orderId: ORDER, parcelNo: 7 });
      if (path.endsWith('/lease') || path.endsWith('/billing-lease')) return json(lease);
      if (path === `/pos/session/${SESSION}/board`) {
        const lines = charge === 0 && !calls.some((c) => c.path.endsWith('/parcel-charge')) ? [] : [{
          id: 'charge1', order_id: ORDER, kind: 'charge', parent_line_id: null, display_name: 'Parcel charge', quantity: 1,
          unit_price_minor: String(charge), line_total_minor: String(charge), display_total_minor: null, tax_rate_bps: 500,
          fired: false, note: null, adjusts_line_id: null, adjustment_reason_id: null, adjustment_reason_name: null,
          adjustment_note: null, guest_no: null,
        }];
        return json({ session: { version: 3 }, lines, bills: billed ? [billRow(paid)] : [] });
      }
      if (path === `/pos/order/${ORDER}/parcel-charge`) {
        // As the server: the unpaid bill is voided, so the board shows none until it is made again.
        charge = Number(body?.['amountMinor'] ?? 0);
        billed = false;
        return json({ orderId: ORDER, amountMinor: charge, lineId: 'charge1', billsVoided: 1 });
      }
      if (path === `/pos/session/${SESSION}/bill`) { billed = true; return json({ billId: 'bill1' }); }
      if (path === '/pos/bill/bill1/payment') {
        const parts = (body?.['parts'] ?? []) as { amountMinor?: number; cashReceivedMinor?: number }[];
        const offered = parts.reduce((sum, p) => sum + (p.amountMinor ?? p.cashReceivedMinor ?? 0), 0);
        const applied = Math.min(offered, TOTAL - paid);
        paid += applied;
        return json({ tenders: [], totalMinor: TOTAL, appliedMinor: applied, paidMinor: paid, outstandingMinor: TOTAL - paid,
          changeMinor: offered - applied, status: paid >= TOTAL ? 'settled' : 'partially_paid' });
      }
      if (path === '/pos/bill/bill1/print') { copies += 1; return json(printedBill(copies, parcel, paid, layout)); }
      if (path === `/pos/order/${ORDER}/tickets`) {
        return json([{ kotId: 'k1', ticketText: `SPICE\nKOT #4\n${parcel ? 'PARCEL P-7 Rahul' : 'DINE-IN D-7'}\n 1 x Veg Thali\n      * less spicy` }]);
      }
      return json({ rows: [] });
    }));
    const store = scopedStore(createStore(), 'pos:spice');
    const api = createApi(store);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<BillingWorkspace api={api} device={DEVICE} billingLeases={createLeases(scopedStore(store, 'billing'), api, 'billing')}
        orderLeases={createLeases(store, api)} keys={createConsensusKeys()} printer={printer} />);
    });
    await settle();
    await act(async () => { button('Veg Thali').click(); });
    if (parcel) await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await act(async () => { button('Confirm order').click(); });
    await settle();
    await settle();
    await settle();
  }

  it('the bill shows its round-off and the net payable, and the balance due is that payable', async () => {
    roundOff = 50;
    try {
      await confirmed(true);
      const box = host.textContent ?? '';
      expect(box).toContain('Grand total₹157.50');
      expect(box).toContain('Round off₹0.50');
      expect(box).toContain('Net payable₹158.00');
      expect(host.querySelector('[aria-label="Balance due"]')!.textContent).toBe('₹158');
    } finally {
      roundOff = 0;
    }
  });

  it('the payment area shows the parcel charge on its own line, inside the subtotal; a bill without one shows neither row', async () => {
    chargeOnBill = 2000;
    try {
      await confirmed(true);
      const box = host.textContent ?? '';
      expect(box).toContain('Items₹130.00');
      expect(box).toContain('Parcel charge₹20.00');
      expect(box).toContain('Subtotal₹150.00');
    } finally {
      chargeOnBill = 0;
    }
    act(() => root?.unmount());
    host.remove();
    await confirmed(true);
    expect(host.textContent).toContain('Subtotal₹150.00');
    expect(host.textContent).not.toContain('Items₹');
    expect(host.textContent).not.toContain('Parcel charge₹');
  });

  it('the payment area names the tax the bill was charged under, and says when prices include it (0083)', async () => {
    try {
      taxedAs = { tax_account_type: 'vat', prices_include_tax: true };
      await confirmed(true);
      expect(host.textContent).toContain('Taxable value₹150.00');
      expect(host.textContent).toContain('VAT (included)₹7.50');
      act(() => root?.unmount());
      host.remove();
      taxedAs = { tax_account_type: 'none', prices_include_tax: false };
      await confirmed(true);
      expect(host.textContent).toContain('Subtotal₹150.00');
      expect(host.textContent).not.toMatch(/(Tax|GST|VAT)(\s\(included\))?₹/);
    } finally {
      taxedAs = { tax_account_type: 'gst', prices_include_tax: false };
    }
  });

  async function payCash(rupees: string): Promise<void> {
    await type(host.querySelector('input[aria-label="Cash received"]') as HTMLInputElement, rupees);
    await act(async () => { button('Add payment').click(); });
    await settle();
    await settle();
  }

  const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

  describe('changing the parcel charge on the bill screen, before payment', () => {
    const box = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>('aside input[aria-label="Parcel charge"]');

    it('Update sends the charge and makes the bill again; Remove clears it; the 0 line is not listed', async () => {
      await confirmed(true);
      expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(1);
      expect(box()).not.toBeNull();
      expect(button('Update').disabled).toBe(true);

      await type(box()!, '30');
      await act(async () => { button('Update').click(); });
      await settle();
      expect(posts(`/pos/order/${ORDER}/parcel-charge`).map((c) => c.body)).toEqual([{ amountMinor: 3000 }]);
      expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(2);
      expect(host.textContent).toContain('Parcel charge');
      expect(box()!.value).toBe('30.00');

      await act(async () => { button('Remove').click(); });
      await settle();
      expect(posts(`/pos/order/${ORDER}/parcel-charge`).map((c) => c.body)).toEqual([{ amountMinor: 3000 }, { amountMinor: 0 }]);
      expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(3);
      expect(box()!.value).toBe('');
      // The cleared line stays on the server at 0; the order table does not show it.
      expect([...host.querySelectorAll('tbody tr')].some((r) => r.textContent?.includes('Parcel charge'))).toBe(false);
    });

    it('is gone once money is taken, and never offered on dine-in', async () => {
      await confirmed(true);
      await type(host.querySelector('input[aria-label="UPI amount"]') as HTMLInputElement, '50');
      await act(async () => { button('Add payment').click(); });
      await settle();
      await settle();
      expect(box()).toBeNull();
      act(() => root?.unmount());
      root = null;
      host.remove();

      await confirmed(false);
      expect(box()).toBeNull();
    });
  });
  const closes = () => calls.filter((c) => c.method === 'DELETE' && c.path === `/pos/session/${SESSION}`);
  const inDialog = (label: string): HTMLButtonElement =>
    [...host.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
  const printFromPreview = async (): Promise<void> => { await act(async () => { inDialog('Print').click(); }); };
  const printed = (): string[] => vi.mocked(printHtml).mock.calls.map(([html]) => html);

  it('Confirm makes the bill and prints NOTHING: no print dialog, no counted print', async () => {
    await confirmed(false);
    expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(1);
    expect(posts('/pos/bill/bill1/print')).toHaveLength(0);
    expect(printed()).toHaveLength(0);
    expect(host.textContent).toContain('Bill #12');
    expect(host.textContent).toContain('Balance due');
  });

  for (const parcel of [false, true]) {
    it(`${parcel ? 'parcel' : 'dine-in'}: a full cash payment prints all three labelled copies ONCE`, async () => {
      await confirmed(parcel);
      await payCash('200');
      // One counted bill print serves the customer and counter copies; the kitchen copy is READ.
      expect(posts('/pos/bill/bill1/print')).toHaveLength(1);
      expect(printed()).toHaveLength(1);
      const html = printed()[0]!;
      expect(html.match(/class="page /g)).toHaveLength(3);
      for (const label of ['>CUSTOMER<', '>KITCHEN<', '>COUNTER<']) expect(html).toContain(label);
      expect(html).toContain('* less spicy');
      expect(html.match(/class="parcel">PARCEL</g)?.length ?? 0).toBe(parcel ? 3 : 0);
      // Paid in full completes the order: no second tap, and the change stays on screen.
      expect(closes()).toHaveLength(1);
      await settle();
      expect(host.textContent).toContain('Paid and completed.');
      expect(host.textContent).toContain('Change');
    });
  }

  it('a part payment prints nothing; the payment that completes it prints once', async () => {
    await confirmed(false);
    await payCash('50');
    expect(printed()).toHaveLength(0);
    expect(posts('/pos/bill/bill1/print')).toHaveLength(0);
    expect(closes()).toHaveLength(0);
    await payCash('107.50');
    expect(closes()).toHaveLength(1);
    expect(printed()).toHaveLength(1);
    expect(posts('/pos/bill/bill1/print')).toHaveLength(1);
    expect(posts('/pos/bill/bill1/payment')).toHaveLength(2);
  });

  it('with automatic printing off, the paid copies open in the preview and print from its button', async () => {
    await confirmed(false, { ...LAYOUT, autoPrint: false, copies: { customer: true, kitchen: false, counter: true } });
    await payCash('200');
    expect(printed()).toHaveLength(0);
    expect(host.querySelector('[role="dialog"][aria-label="Print preview"]')).not.toBeNull();
    // The branch prints two copies, so there are two tabs and no kitchen copy.
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())).toEqual(['Customer bill', 'Counter copy']);
    await act(async () => { inDialog('Print 2 copies').click(); });
    expect(printed()).toHaveLength(1);
    expect(printed()[0]).not.toContain('>KITCHEN<');
  });

  it('reprinting the kitchen copy reads the ticket again -- no order, no kitchen send, no new print job', async () => {
    await confirmed(true);
    await payCash('200');
    const before = calls.filter((c) => c.method !== 'GET').length;
    await act(async () => { button('Reprint kitchen copy').click(); });
    await settle();
    expect(calls.filter((c) => c.method !== 'GET').length).toBe(before);
    expect(posts('/pos/parcel')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/fire'))).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reprint'))).toHaveLength(0);
    await printFromPreview();
    const html = printed().at(-1)!;
    expect(html.match(/class="page /g)).toHaveLength(1);
    expect(html).toContain('KITCHEN · REPRINT');
    expect(html).toContain('class="parcel">PARCEL<');
  });

  it('reprinting the customer or counter copy is a counted bill print, marked REPRINT, and nothing else', async () => {
    await confirmed(false);
    await payCash('200');
    await act(async () => { button('Reprint customer copy').click(); });
    await settle();
    await printFromPreview();
    await act(async () => { inDialog('Close').click(); });
    await act(async () => { button('Reprint counter copy').click(); });
    await settle();
    await printFromPreview();
    expect(posts('/pos/bill/bill1/print')).toHaveLength(3);
    expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(1);
    expect(printed().at(-2)).toContain('CUSTOMER · REPRINT');
    expect(printed().at(-1)).toContain('COUNTER · REPRINT');
  });

  it('a Bluetooth printer connected on this till takes the copies directly; a dropped copy is retried from the same pages', async () => {
    const serial = fakeSerial({ failOnCopy: 2 });
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    await confirmed(true, { ...LAYOUT, connection: 'bluetooth' }, printer);
    await payCash('200');
    await settle();
    // No print dialog: the customer copy went to the printer, the kitchen copy dropped mid-way.
    expect(printed()).toHaveLength(0);
    expect(serial.copies().map((c) => c.match(/CUSTOMER|KITCHEN|COUNTER/)?.[0])).toEqual(['CUSTOMER']);
    const alert = [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
    expect(alert).toContain('Copy 2 of 3 may be incomplete');
    expect(alert).toContain('Not printed: kitchen, counter copy');

    const before = calls.length;
    await act(async () => { button('Retry').click(); });
    await settle();
    // The same pages again: nothing read, billed, sent to the kitchen or charged.
    expect(calls.length).toBe(before);
    expect(posts('/pos/bill/bill1/print')).toHaveLength(1);
    expect(serial.copies().map((c) => c.match(/CUSTOMER|KITCHEN|COUNTER/)?.[0])).toEqual(['CUSTOMER', 'KITCHEN', 'COUNTER']);
    expect(serial.copies()[1]).toContain('* less spicy');
    expect(serial.copies().every((c) => c.includes('*** PARCEL ***'))).toBe(true);
    expect(host.textContent).not.toContain('Not printed:');
  });

  it('printing directly skips the preview: automatic printing off still sends the paid copies straight to the printer', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    await confirmed(false, { ...LAYOUT, connection: 'bluetooth', autoPrint: false }, printer);
    await payCash('200');
    await settle();
    expect(host.querySelector('[role="dialog"][aria-label="Print preview"]')).toBeNull();
    expect(printed()).toHaveLength(0);
    expect(serial.copies().map((c) => c.match(/CUSTOMER|KITCHEN|COUNTER/)?.[0])).toEqual(['CUSTOMER', 'KITCHEN', 'COUNTER']);
    expect(posts('/pos/bill/bill1/print')).toHaveLength(1);
  });

  it('a reprint goes straight to a connected printer, with no preview, and is still one counted print', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    await confirmed(false, { ...LAYOUT, connection: 'bluetooth' }, printer);
    await payCash('200');
    await settle();
    await act(async () => { button('Reprint customer copy').click(); });
    await settle();
    expect(host.querySelector('[role="dialog"][aria-label="Print preview"]')).toBeNull();
    expect(printed()).toHaveLength(0);
    expect(serial.copies().at(-1)).toContain('CUSTOMER');
    expect(serial.copies().at(-1)).toContain('REPRINT');
    expect(posts('/pos/bill/bill1/print')).toHaveLength(2);
    expect(posts(`/pos/session/${SESSION}/bill`)).toHaveLength(1);
  });

  it('a Bluetooth printer this till has not connected prints through the dialog, as before', async () => {
    await confirmed(false, { ...LAYOUT, connection: 'bluetooth' }, createReceiptPrinter(fakeSerial(), null));
    await payCash('200');
    expect(printed()).toHaveLength(1);
  });

  it('a copy that could not be fetched is named, and nothing half-prints', async () => {
    await confirmed(false);
    vi.mocked(printHtml).mockClear();
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) =>
      String(input).includes('/tickets') ? Promise.reject(new TypeError('down')) : real(input, init)));
    await act(async () => { button('Print kitchen copy').click(); });
    await settle();
    expect(host.textContent).toContain('Did not print: kitchen copy');
    expect(printed()).toHaveLength(0);
  });
});

describe('the order screen layout', () => {
  it('categories sit above the items; a long order scrolls in its own list while Confirm and the prices stay visible', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, name: `Dish ${i}`, price_minor: String(1000 + i * 100), orderable: true, category_id: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://x').pathname.replace(/^\/api\/t/, '');
      if (path === '/pos/menu') return Response.json({ menu: many });
      if (path === '/admin/menu/categories') return Response.json({ rows: [{ id: 'c1', name: 'Starters', display_order: 1 }] });
      if (path === '/pos/quote') return quoteAnswer(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ rows: [] });
    }));
    await openNewOrder();
    // The tabs come before the first item in the page.
    const nav = host.querySelector('nav[aria-label="Menu categories"]')!;
    expect(nav.textContent).toContain('All items');
    expect(nav.textContent).toContain('Starters');
    expect(nav.compareDocumentPosition(button('Dish 0')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (let i = 0; i < 30; i += 1) await act(async () => { button(`Dish ${i}`).click(); });
    const list = host.querySelector('[aria-label="Order lines"]')!;
    expect(list.className).toContain('overflow-y-auto');
    expect(list.querySelectorAll('li')).toHaveLength(30);
    // Each line says its price; nothing on the screen adds them up (FRONTEND.md section 2).
    expect(list.textContent).toContain('₹10.00 each');
    expect(list.textContent).toContain('₹39.00 each');
    // The only totals are the server's estimate, labelled as one.
    await estimated();
    expect(host.textContent).toContain('the bill, made on Confirm, is the record');
    // Confirm is outside the scrolling list, so it never scrolls away.
    expect(list.contains(button('Confirm order'))).toBe(false);
    expect(host.textContent).toContain('30 items');
  });
});

describe('a parcel charge and the estimate (0081)', () => {
  it('the Parcel switch offers the charge, filled with the branch\'s usual one, and the server\'s estimate adds it in', async () => {
    serve();
    terms = { defaultMinor: 2000, maxMinor: 5000 };
    await openNewOrder();
    await act(async () => { button('Veg Thali').click(); });
    expect(chargeBox()).toBeNull();
    await estimated();
    // Dine-in: an estimate with no charge in it.
    expect(estimate()).toContain('Items₹150.00');
    expect(estimate()).not.toContain('Parcel charge');
    expect(quotes().at(-1)).toEqual({ parcel: false, lines: [{ menuItemId: 'm1', quantity: 1 }] });

    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await estimated();
    expect(chargeBox()!.value).toBe('20.00');
    expect(host.textContent).toContain('Parcel charge, up to ₹50.00.');
    expect(estimate()).toContain('Parcel charge₹20.00');
    expect(estimate()).toContain('Subtotal₹170.00');
    expect(estimate()).toContain('CGST 2.5%');
    expect(estimate()).toContain('SGST 2.5%');
    // 178.50 is paid as 179: the server's round-off and payable, shown as given.
    expect(estimate()).toContain('Round off₹0.50');
    expect(estimate()).toContain('Payable₹179.00');

    // Typing re-asks the server; nothing is added up here.
    await type(chargeBox()!, '25');
    await estimated();
    expect(quotes().at(-1)).toMatchObject({ parcel: true, parcelChargeMinor: 2500 });
    expect(estimate()).toContain('Parcel charge₹25.00');
    // A quantity change re-asks too.
    await act(async () => { button('Veg Thali').click(); });
    await estimated();
    expect(quotes().at(-1)).toMatchObject({ lines: [{ menuItemId: 'm1', quantity: 2 }], parcelChargeMinor: 2500 });
    expect(estimate()).toContain('Subtotal₹325.00');
  });

  it('Confirm saves the charge on the order, after the lines and before the kitchen, under its own key', async () => {
    serve();
    terms = { defaultMinor: 2000, maxMinor: 5000 };
    await openNewOrder();
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await estimated();
    await type(chargeBox()!, '30.50');
    await act(async () => { button('Confirm order').click(); });
    await settle();
    expect(writes().map((c) => [c.path, c.body])).toEqual([
      ['/pos/parcel', { pickupName: null }],
      [`/pos/order/${ORDER}/line`, { menuItemId: 'm1', quantity: 1 }],
      [`/pos/order/${ORDER}/parcel-charge`, { amountMinor: 3050 }],
      [`/pos/order/${ORDER}/fire`, { sessionVersion: 3 }],
      [`/pos/session/${SESSION}/ready-for-billing`, {}],
    ]);
    const charge = writes().find((c) => c.path.endsWith('/parcel-charge'))!;
    expect(charge.key).toEqual(expect.any(String));
    expect(writes().filter((c) => c.key === charge.key)).toHaveLength(1);
  });

  it('a retry after a dropped charge write sends the same charge under the same key, once', async () => {
    serve(`/pos/order/${ORDER}/parcel-charge`);
    terms = { defaultMinor: 2000, maxMinor: 5000 };
    await openNewOrder();
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await estimated();
    await act(async () => { button('Confirm order').click(); });
    await settle();
    // Locked once the order exists: the charge cannot change under a retry.
    expect(chargeBox()!.disabled).toBe(true);
    await act(async () => { button('Try again').click(); });
    await settle();
    const sent = writes().filter((c) => c.path.endsWith('/parcel-charge'));
    expect(sent.map((c) => c.body)).toEqual([{ amountMinor: 2000 }, { amountMinor: 2000 }]);
    expect(sent[0]!.key).toBe(sent[1]!.key);
    expect(writes().filter((c) => c.path === '/pos/parcel')).toHaveLength(1);
  });

  it('a charge over the branch\'s maximum is the server\'s refusal, said beside the estimate; a non-amount stops Confirm', async () => {
    serve();
    terms = { defaultMinor: 2000, maxMinor: 5000 };
    await openNewOrder();
    await act(async () => { button('Veg Thali').click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await estimated();
    await type(chargeBox()!, '60');
    await estimated();
    expect(host.textContent).toContain('That parcel charge is more than this branch allows.');
    expect(estimate()).toBe('');
    await type(chargeBox()!, '2O');
    expect(host.textContent).toContain('Enter an amount like 20 or 20.50.');
    expect(button('Confirm order').disabled).toBe(true);
  });

  it('a branch that takes no parcel charge says so, and Confirm sends none', async () => {
    serve();
    await openNewOrder();
    await act(async () => { button('Masala Tea').click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await estimated();
    expect(chargeBox()!.disabled).toBe(true);
    expect(host.textContent).toContain('This branch takes no parcel charge.');
    await act(async () => { button('Confirm order').click(); });
    await settle();
    expect(writes().some((c) => c.path.endsWith('/parcel-charge'))).toBe(false);
  });
});

describe('the customer name', () => {
  it('takes at most 40 characters -- the most an order may carry, so a long name is never refused by the server', async () => {
    serve();
    await openNewOrder();
    expect(host.querySelector<HTMLInputElement>('input[placeholder="e.g. Rahul"]')!.maxLength).toBe(40);
  });
});
