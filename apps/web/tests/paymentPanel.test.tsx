import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { minorFromTyped, typedFromMinor, type Minor } from '../src/lib/money.js';
import {
  PaymentPanel, paymentParts, type PaymentPart, type PaymentResult,
} from '../src/features/billing/billing/PaymentPanel.js';
import type { BillRow } from '../src/features/orders/pos/board.js';

/**
 * The till sends what the cashier typed and shows what the server answered.
 * While typing it shows a labelled PREVIEW (`previewPayment`, the server's own
 * rule); once paid, the change on screen is the server's `changeMinor`, so a
 * ₹1,000 note on an ₹850 bill shows ₹150 because the server said so.
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const BILL = {
  id: 'b1', bill_no: 4, total_minor: '85000', paid_minor: '0', outstanding_minor: '85000',
  settled: false, tenders: [],
} as unknown as BillRow;

function type(label: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('typed amounts', () => {
  it('parses what a cashier types as text, never through a float', () => {
    expect(minorFromTyped('350')).toBe(35000);
    expect(minorFromTyped('350.5')).toBe(35050);
    expect(minorFromTyped(' 0.29 ')).toBe(29);
    for (const bad of ['', 'abc', '1.234', '-5', '1,000', '1e3']) expect(minorFromTyped(bad), bad).toBeNull();
    expect(typedFromMinor(85000 as Minor)).toBe('850.00');
  });

  it('builds the parts: non-cash with amounts, cash as the note received', () => {
    expect(paymentParts({ card: '500', upi: '', other: '', cash: '500' }, { card: ' C-9 ' })).toEqual([
      { method: 'card', amountMinor: 50000, reference: 'C-9' },
      { method: 'cash', cashReceivedMinor: 50000 },
    ]);
    expect(paymentParts({ card: '', upi: '', other: '', cash: '' }, {})).toBeNull();
    expect(paymentParts({ card: '0', upi: '', other: '', cash: '' }, {})).toBeNull();
    expect(paymentParts({ card: '12.345', upi: '', other: '', cash: '' }, {})).toBeNull();
  });
});

describe('the payment panel', () => {
  it('shows the balance to the nearest rupee, while Full still fills -- and pays -- the exact balance', async () => {
    const onPay = vi.fn(async (_parts: readonly PaymentPart[]) => null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const bill = { ...BILL, total_minor: '19635', outstanding_minor: '19635' } as unknown as BillRow;
    act(() => root!.render(<PaymentPanel bill={bill} busy={false} onPay={onPay} />));
    expect(host.querySelector('[aria-label="Balance due"]')!.textContent).toBe('₹196');
    const full = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Full')[0]!;
    act(() => { full.click(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Card amount"]')!.value).toBe('196.35');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add payment')!.click(); });
    expect(onPay).toHaveBeenCalledWith([{ method: 'card', amountMinor: 19635 }]);
  });

  it('sends card + cash in one payment and shows the server\'s change and status', async () => {
    const answer: PaymentResult = {
      tenders: [
        { tenderId: 't1', method: 'card', amountMinor: 50000, cashReceivedMinor: null, changeMinor: 0 },
        { tenderId: 't2', method: 'cash', amountMinor: 35000, cashReceivedMinor: 50000, changeMinor: 15000 },
      ],
      totalMinor: 85000, appliedMinor: 85000, paidMinor: 85000, outstandingMinor: 0, changeMinor: 15000, settled: true,
    };
    const onPay = vi.fn(async (_parts: readonly PaymentPart[]) => answer);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={BILL} busy={false} onPay={onPay} />));

    expect(host.textContent).toContain('Balance due₹850');
    type('Card amount', '500');
    type('Cash received', '500');
    const take = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add payment')!;
    await act(async () => { take.click(); });

    expect(onPay).toHaveBeenCalledWith([
      { method: 'card', amountMinor: 50000 }, { method: 'cash', cashReceivedMinor: 50000 }]);
    const status = host.querySelector('[role="status"]')!.textContent!;
    expect(status).toContain('Change to return₹150.00');
    expect(status).toContain('Cash applied₹350.00');
    expect(status).toContain('Cash received₹500.00');
    expect(status).toContain('This payment₹850.00');
    expect(status).toContain('Total settled₹850.00');
    expect(status).toContain('Balance due₹0.00');
    expect(status).toContain('Paid');
  });

  it('a part payment says Partially paid and the balance the server left', async () => {
    const onPay = vi.fn(async () => ({
      tenders: [{ tenderId: 't1', method: 'upi', amountMinor: 50000, cashReceivedMinor: null, changeMinor: 0 }],
      totalMinor: 85000, appliedMinor: 50000, paidMinor: 50000, outstandingMinor: 35000, changeMinor: 0, settled: false,
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={BILL} busy={false} onPay={onPay} />));
    type('UPI amount', '500');
    const take = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add payment')!;
    await act(async () => { take.click(); });
    const status = host.querySelector('[role="status"]')!.textContent!;
    expect(status).toContain('Partially paid');
    expect(status).toContain('Balance due₹350.00');
    expect(status).not.toContain('Change to return');
  });

  it('as the cashier types: what each method adds, the total added and the balance after', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={{ ...BILL, outstanding_minor: '11760' } as BillRow} busy={false} onPay={vi.fn()} />));
    const preview = (): string => host.querySelector('[aria-label="Payment preview"]')?.textContent ?? '';
    expect(preview()).toBe('');
    type('UPI amount', '100');
    expect(preview()).toContain('Preview');
    expect(preview()).toContain('Added₹100.00');
    expect(preview()).toContain('Balance after this payment₹18');
    type('Cash received', '50');
    expect(preview()).toContain('UPI −₹100.00 · Cash −₹17.60');
    expect(preview()).toContain('Added₹117.60');
    expect(preview()).toContain('Balance after this payment₹0');
    expect(preview()).toContain('Change to return₹32.40');
    // No amount beside the boxes and no slip box: the summary carries it.
    const upiRow = host.querySelector('input[aria-label="UPI amount"]')!.parentElement!;
    expect(upiRow.textContent).not.toContain('₹');
    expect(host.querySelector('input[aria-label="UPI reference"]')).toBeNull();
  });

  it('previews the refusal the server would give, rather than capping it', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={BILL} busy={false} onPay={vi.fn()} />));
    type('Card amount', '900');
    expect(host.querySelector('[aria-label="Payment preview"] [role="alert"]')?.textContent)
      .toContain('Card is more than the ₹850.00 left to pay');
  });

  it('after Add payment the preview gives way to the answer from the server', async () => {
    const onPay = vi.fn(async () => ({
      tenders: [{ tenderId: 't1', method: 'upi', amountMinor: 50000, cashReceivedMinor: null, changeMinor: 0 }],
      totalMinor: 85000, appliedMinor: 50000, paidMinor: 50000, outstandingMinor: 35000, changeMinor: 0, settled: false,
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={BILL} busy={false} onPay={onPay} />));
    type('UPI amount', '500');
    expect(host.querySelector('[aria-label="Payment preview"]')).not.toBeNull();
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add payment')!.click(); });
    expect(host.querySelector('[aria-label="Payment preview"]')).toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Balance due₹350.00');
  });

  it('will not send a malformed amount', () => {
    const onPay = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PaymentPanel bill={BILL} busy={false} onPay={onPay} />));
    type('Card amount', '5..0');
    const take = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add payment')!;
    expect(take.disabled).toBe(true);
    expect(host.textContent).toContain('Amounts are numbers like 350 or 350.50.');
  });
});
