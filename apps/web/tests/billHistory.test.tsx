import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Api } from '../src/services/api.js';
import { ApiError } from '../src/services/api.js';
import { BillHistory, type HistoryAccess } from '../src/features/billing/history/BillHistory.js';

/**
 * Bill history on the till and the manager screens: what is offered follows
 * the person's keys and the bill's state as the server states them, and a bill
 * edit is saved only after the server has worked out its totals. Nothing here
 * decides; these assert that the screen does not offer what the server refuses.
 */

const TODAY = '2026-11-21';
const bill = (over: Record<string, unknown>) => ({
  billId: 'b1', billNo: 7, businessDate: TODAY, generatedAt: '2026-11-21T08:05:00Z', generatedBy: 'Asha',
  status: 'open', version: 1, serviceType: 'dine_in', seating: 'counter', orderNo: 3, pickupName: null,
  subtotalMinor: 20000, taxMinor: 1000, totalMinor: 21000, roundOffMinor: 0, payableMinor: 21000,
  paidMinor: 0, refundedMinor: 0, outstandingMinor: 21000, methods: [], editState: 'editable', canEdit: true,
  lastEdit: null, replacedByBillNo: null, revisesBillNo: null, supplementary: false, ...over,
});
const figures = { billCount: 1, voidBillCount: 0, salesMinor: 21000, taxMinor: 1000, payableMinor: 21000,
  collectedMinor: 0, refundedMinor: 0, outstandingMinor: 21000, methods: [] };
const history = (days: unknown[]) => ({ period: 'today', fromDate: TODAY, toDate: TODAY, today: TODAY, days });
const day = (over: Record<string, unknown>, bills: unknown[]) => ({
  businessDate: TODAY, state: 'open', submission: null, billsSinceSubmission: 0, figures, bills, ...over,
});
const detailOf = (b: Record<string, unknown>) => ({
  bill: b, tenders: [], refunds: [], revisions: [],
  lines: [{ lineId: 'l1', kind: 'item', name: 'Thali', addOns: [], menuItemId: 'm1', modifierOptionIds: [],
    quantity: 2, remainingQuantity: 2, amountMinor: 20000, taxMinor: 1000, taxRateBps: 500 }],
  day: { businessDate: TODAY, state: 'open', submission: null, billsSinceSubmission: 0 },
});
const POS: HistoryAccess = { base: '/pos', capacity: 'pos', canEdit: true, canSubmit: true, canReopen: false, canPrint: true };
const MANAGER: HistoryAccess = { base: '/admin', capacity: 'manager', canEdit: true, canSubmit: true, canReopen: true, canPrint: true };

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const textarea = (): HTMLTextAreaElement => host.querySelector('textarea')!;
async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function open(access: HistoryAccess, get: (path: string) => unknown, write: ReturnType<typeof vi.fn> = vi.fn(async () => ({}))) {
  const api = { get: vi.fn(async (path: string) => get(path)), postDetailed: vi.fn() } as unknown as Api;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<BillHistory api={api} access={access} write={write as never} />); });
  await settle();
  return { api, write };
}

describe('the day list', () => {
  it('shows today with its state, figures and Submit Day Bills; a submitted day offers the till no submit and no edit', async () => {
    await open(POS, () => history([day({}, [bill({})])]));
    expect(host.textContent).toContain('Today');
    expect(host.textContent).toContain('Editable');
    expect(host.textContent).toContain('#7');
    expect(host.textContent).toContain('D-3');
    expect(button('Submit Day Bills')).toBeDefined();
    act(() => root?.unmount());
    host.remove();

    await open(POS, () => history([day({ state: 'submitted', submission: { status: 'submitted', submittedAt: '2026-11-21T16:00:00Z',
      submittedBy: 'Asha', reopenedAt: null, reopenedBy: null, reopenReason: null } }, [bill({ editState: 'submitted', canEdit: false })])]));
    expect(host.textContent).toContain('Submitted');
    expect(button('Submit Day Bills')).toBeUndefined();
    expect(button('Reopen day for editing')).toBeUndefined();
  });

  it('the manager is offered Reopen on a submitted day, and the till never is', async () => {
    const submitted = day({ state: 'submitted', submission: { status: 'submitted', submittedAt: '2026-11-21T16:00:00Z',
      submittedBy: 'Asha', reopenedAt: null, reopenedBy: null, reopenReason: null } }, [bill({ editState: 'submitted', canEdit: false })]);
    await open(MANAGER, () => history([submitted]));
    expect(button('Reopen day for editing')).toBeDefined();
  });

  it('searches with the words typed, and says when nothing matched', async () => {
    const asked: string[] = [];
    await open(POS, (path) => { asked.push(path); return history(path.includes('q=') ? [] : [day({}, [bill({})])]); });
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'P-4');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { search.form!.requestSubmit(); });
    await settle();
    expect(asked.at(-1)).toBe('/pos/bills?period=today&q=P-4');
    expect(host.textContent).toContain('No bill matches that search');
  });
});

describe('Allow POS Bill Editing', () => {
  const submission = { status: 'submitted', submittedAt: '2026-11-21T16:00:00Z', submittedBy: 'Asha',
    reopenedAt: null, reopenedBy: null, reopenReason: null };
  const grantOn = { on: true, enabledBy: 'Meera', enabledAt: '2026-11-21T17:00:00Z', reason: 'guest came back',
    disabledBy: null, disabledAt: null };
  const switchEl = (): HTMLButtonElement | null => host.querySelector('[role="switch"]');

  it('on the till: Bill Locked after day end, and Editing Enabled by Manager while a manager allows it', async () => {
    await open(POS, () => history([day({ state: 'submitted', submission }, [bill({ editState: 'submitted', canEdit: false })])]));
    expect(host.textContent).toContain('Bill Locked');
    expect(host.textContent).not.toContain('Editing Enabled by Manager');
    expect(switchEl()).toBeNull(); // the till never holds the switch
    act(() => root?.unmount());
    host.remove();

    await open(POS, () => history([day({ state: 'submitted', submission, posEditing: grantOn },
      [bill({ editState: 'granted', canEdit: true })])]));
    expect(host.textContent).toContain('Editing Enabled by Manager');
    expect(host.textContent).toContain('Meera');
    expect(host.textContent).not.toContain('Bill Locked');
    expect(switchEl()).toBeNull();
  });

  it('the till shows the manager\'s change without a new sign-in', async () => {
    let allowed = false;
    await open(POS, () => history([day({ state: 'submitted', submission, posEditing: allowed ? grantOn : null },
      [bill({ editState: allowed ? 'granted' : 'submitted', canEdit: allowed })])]));
    expect(host.textContent).toContain('Bill Locked');
    allowed = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(host.textContent).toContain('Editing Enabled by Manager');
  });

  it('the manager switches it on with a reason, and off without one, for today only', async () => {
    const write = vi.fn(async () => ({}));
    await open(MANAGER, () => history([
      day({ state: 'submitted', submission }, [bill({ editState: 'submitted', canEdit: false })]),
      day({ businessDate: '2026-11-20' }, [bill({ billId: 'b0', businessDate: '2026-11-20', editState: 'locked' })]),
    ]), write);
    // One switch: today's. A previous day never opens to the till.
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(switchEl()!.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('Allow POS Bill Editing');
    await act(async () => { switchEl()!.click(); });
    expect(host.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Allow POS Bill Editing');
    expect(button('Allow editing')!.disabled).toBe(true); // no reason yet
    await type(textarea(), 'guest came back');
    await act(async () => { button('Allow editing')!.click(); });
    await settle();
    expect(write).toHaveBeenCalledWith('/admin/days/2026-11-21/pos-editing/enable', { reason: 'guest came back' }, expect.any(String));
    act(() => root?.unmount());
    host.remove();

    const off = vi.fn(async () => ({}));
    await open(MANAGER, () => history([day({ state: 'submitted', submission, posEditing: grantOn },
      [bill({ editState: 'granted', canEdit: false })])]), off);
    expect(switchEl()!.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('allowed by Meera');
    await act(async () => { switchEl()!.click(); });
    await settle();
    expect(off).toHaveBeenCalledWith('/admin/days/2026-11-21/pos-editing/disable', {}, expect.any(String));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('before day end the switch is there but cannot be turned on: the till already edits today', async () => {
    await open(MANAGER, () => history([day({}, [bill({})])]));
    expect(switchEl()!.disabled).toBe(true);
    expect(host.textContent).toContain('until the day is submitted');
  });
});

describe('a bill and its edit', () => {
  it('a locked bill offers no Edit; an editable one does', async () => {
    const locked = bill({ editState: 'locked', canEdit: false, businessDate: '2026-11-20' });
    await open(POS, (path) => (path.startsWith('/pos/bills/') ? detailOf(locked) : history([day({ businessDate: '2026-11-20' }, [locked])])));
    await act(async () => { host.querySelector<HTMLButtonElement>('li button')!.click(); });
    await settle();
    expect(host.textContent).toContain('only a manager can edit it');
    expect(button('Edit bill')).toBeUndefined();
  });

  it('a paid bill on the till only gains items: no way to take one off', async () => {
    const paid = bill({ status: 'settled', paidMinor: 21000, outstandingMinor: 0 });
    await open(POS, (path) => (path.startsWith('/pos/bills/') ? detailOf(paid)
      : path === '/pos/menu' ? { menu: [{ id: 'm2', name: 'Lassi', price_minor: '5000', orderable: true }] }
        : history([day({}, [paid])])));
    await act(async () => { host.querySelector<HTMLButtonElement>('li button')!.click(); });
    await settle();
    await act(async () => { button('Edit bill')!.click(); });
    await settle();
    expect(host.textContent).toContain('taking items off is a refund a manager makes');
    expect(host.querySelector('[aria-label="One less Thali"]')).toBeNull();
    expect(host.querySelector('[aria-label="Add Lassi"]')).not.toBeNull();
  });

  it('Save waits for the server\'s totals, and a refusal is shown in the server\'s words', async () => {
    const open1 = bill({});
    const write = vi.fn(async (path: string) => {
      if (path.endsWith('/preview')) {
        return { before: { payableMinor: 21000, totalMinor: 21000 }, after: { payableMinor: 10500, totalMinor: 10500, subtotalMinor: 10000, taxMinor: 500, roundOffMinor: 0 },
          replacementBill: { billId: 'b2', billNo: 8, payableMinor: 10500 }, supplementaryBill: null, refund: null, collectMinor: 10500, differenceMinor: -10500 };
      }
      throw new ApiError({ kind: 'refused', status: 403, code: 'bill_edit_day_submitted', retryable: false },
        'the bills of 2026-11-21 have been submitted, so the till can no longer change them; a manager can');
    });
    await open(POS, (path) => (path.startsWith('/pos/bills/') ? detailOf(open1) : path === '/pos/menu' ? { menu: [] } : history([day({}, [open1])])), write);
    await act(async () => { host.querySelector<HTMLButtonElement>('li button')!.click(); });
    await settle();
    await act(async () => { button('Edit bill')!.click(); });
    await settle();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="One less Thali"]')!.click(); });
    expect(button('Save edit')!.disabled).toBe(true);
    expect(button('Check totals')!.disabled).toBe(true); // no reason yet
    await type(textarea(), 'guest wanted one thali');
    await act(async () => { button('Check totals')!.click(); });
    await settle();
    expect(write).toHaveBeenCalledWith('/pos/bills/b1/revise/preview',
      expect.objectContaining({ expectedVersion: 1, reason: 'guest wanted one thali', remove: [{ lineId: 'l1', quantity: 1 }], add: [] }),
      expect.any(String));
    expect(host.textContent).toContain('Reissued bill');
    expect(button('Save edit')!.disabled).toBe(false);
    await act(async () => { button('Save edit')!.click(); });
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('can no longer change them');
  });
});
