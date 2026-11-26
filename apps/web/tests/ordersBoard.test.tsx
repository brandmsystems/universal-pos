import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { OrdersBoard } from '../src/features/billing/billing/OrdersBoard.js';
import type { QueueRow } from '../src/features/billing/billing/Desk.js';

/**
 * The POS Orders board: On process (to bill + part paid), All and Completed;
 * a card per order with its lines, quantities and amounts, "+N more", and the
 * total -- every figure the server's (each line's amount, the bill's total or
 * the order's amount before tax). See details and Pay bill open the order.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

const row = (over: Partial<QueueRow>): QueueRow => ({
  sessionId: 's1', orderId: 'o1', businessDate: '2026-10-16', leftover: false, serviceType: 'dine_in', parcelNo: 4,
  pickupName: null, tables: [], itemCount: 1, amountMinor: '10000', billedMinor: null, paidMinor: '0', payment: 'none',
  readyAt: '2026-10-16T12:30:00Z', readyBy: 'Asha', status: 'ready', ...over,
});

const ROWS: QueueRow[] = [
  row({ sessionId: 's1', pickupName: 'Ariel', parcelNo: 25, amountMinor: '8734', billedMinor: '9171', status: 'ready' }),
  row({ sessionId: 's2', serviceType: 'parcel', pickupName: 'Morgan', parcelNo: 16, billedMinor: '8696', paidMinor: '5000', payment: 'part', status: 'in_progress' }),
  row({ sessionId: 's3', pickupName: 'Maja', parcelNo: 12, billedMinor: '9834', paidMinor: '9834', payment: 'full', status: 'completed' }),
];

const line = (id: string, name: string, quantity: number, total: string) => ({
  id, order_id: 'o', kind: 'item', parent_line_id: null, display_name: name, quantity,
  unit_price_minor: null, line_total_minor: total, display_total_minor: null, tax_rate_bps: 500, fired: true,
});

async function open(onOpen = vi.fn(), rows: readonly QueueRow[] = ROWS): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://x').pathname;
    const lines = path.includes('/s1/')
      ? [line('a', 'Scrambled eggs', 1, '1699'), line('b', 'Salmon Bagel', 1, '1849'), line('c', 'Belgian Waffles', 2, '3898'),
        line('d', 'Lemonade', 1, '1249'), line('e', 'Coffee', 1, '499'), line('f', 'Juice', 1, '599')]
      : [line('x', 'Pad Thai', 1, '1699')];
    return Response.json({ session: null, tables: [], bills: [], lines, lease: null, menu: [], menuVersion: '', serverNow: '', taxOptions: { b2bCaptureEnabled: false } });
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<OrdersBoard api={createApi(createStore())} rows={rows} onOpen={onOpen} />); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const cards = (): HTMLElement[] => [...host.querySelectorAll('article')];
const tab = async (label: string): Promise<void> => {
  await act(async () => { [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith(label))!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('the POS Orders board', () => {
  it('opens on On process: the to-bill and part-paid orders, as cards with their items and the server\'s total', async () => {
    await open();
    expect(cards()).toHaveLength(2);
    const ariel = cards().find((c) => c.textContent?.includes('Ariel'))!;
    for (const text of ['D-25', 'To bill', 'Scrambled eggs', 'Belgian Waffles', '₹38.98', 'Total', '₹91.71']) {
      expect(ariel.textContent, text).toContain(text);
    }
    // Every item is listed -- none hidden behind "+N more" -- in a list that scrolls inside the card.
    const items = ariel.querySelector('ul[aria-label="Items"]')!;
    expect(items.className).toContain('overflow-y-auto');
    expect(items.querySelectorAll('li')).toHaveLength(6);
    expect(items.textContent).toContain('Juice');
    expect(ariel.textContent).not.toContain('more');
    const morgan = cards().find((c) => c.textContent?.includes('Morgan'))!;
    expect(morgan.textContent).toContain('P-16');
    expect(morgan.textContent).toContain('Part paid');
  });

  it('a billed order says what the server says is paid: nothing, part, or all of it', async () => {
    await open(vi.fn(), [
      row({ sessionId: 'n', pickupName: 'Nora', billedMinor: '9000', paidMinor: '0', payment: 'none', status: 'in_progress' }),
      row({ sessionId: 'p', pickupName: 'Pia', billedMinor: '9000', paidMinor: '4000', payment: 'part', status: 'in_progress' }),
      row({ sessionId: 'f', pickupName: 'Fay', billedMinor: '9000', paidMinor: '9000', payment: 'full', status: 'in_progress' }),
    ]);
    const card = (name: string): string => cards().find((c) => c.textContent?.includes(name))!.textContent ?? '';
    expect(card('Nora')).toContain('Unpaid');
    expect(card('Nora')).not.toContain('Part paid');
    expect(card('Pia')).toContain('Part paid');
    expect(card('Fay')).toContain('Paid');
    expect(card('Fay')).toContain('Complete');
    expect(card('Fay')).not.toContain('Part paid');
  });

  it('Completed and All filter; search finds by name or number', async () => {
    await open();
    await tab('Completed');
    expect(cards().map((c) => c.textContent?.includes('Maja'))).toEqual([true]);
    expect(cards()[0]!.querySelector('button:disabled')?.textContent).toContain('Paid');
    await tab('All');
    expect(cards()).toHaveLength(3);
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search orders"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(search, 'p-16'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain('Morgan');
  });

  it('See details and Pay bill open the order', async () => {
    const onOpen = vi.fn();
    await open(onOpen);
    const ariel = cards().find((c) => c.textContent?.includes('Ariel'))!;
    await act(async () => { [...ariel.querySelectorAll('button')].find((b) => b.textContent?.includes('Pay bill'))!.click(); });
    await act(async () => { [...ariel.querySelectorAll('button')].find((b) => b.textContent?.includes('See details'))!.click(); });
    expect(onOpen.mock.calls).toEqual([['s1'], ['s1']]);
  });
});
