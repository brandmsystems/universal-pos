import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Api } from '../src/services/api.js';
import { ApiError } from '../src/services/api.js';
import { MyTakings } from '../src/features/billing/billing/MyTakings.js';
import {
  cellValue, fileStem, rangeProblem, renderTakingsHtml, takingsReport, type TakingsSummary,
} from '../src/features/billing/print/takingsReport.js';
import { printHtml } from '../src/features/billing/print/receipt.js';

const writeFile = vi.fn();
vi.mock('xlsx', () => ({
  utils: {
    book_new: () => ({ sheets: [] as unknown[] }),
    aoa_to_sheet: (rows: unknown[][]) => ({ rows }),
    book_append_sheet: (book: { sheets: unknown[] }, sheet: unknown, name: string) => { book.sheets.push({ name, sheet }); },
  },
  writeFile: (...args: unknown[]) => writeFile(...args),
}));
const saved = vi.fn();
const texts: string[] = [];
vi.mock('jspdf', () => ({
  jsPDF: class {
    setFont() { return this; }
    setFontSize() { return this; }
    text(t: string) { texts.push(t); return this; }
    splitTextToSize(t: string) { return [t]; }
    addPage() { return this; }
    save(name: string) { saved(name); }
  },
}));
vi.mock('../src/features/billing/print/receipt.js', async (original) => ({
  ...await original<typeof import('../src/features/billing/print/receipt.js')>(),
  printHtml: vi.fn(),
}));

/**
 * My takings: the till's own X-read. Every figure on screen, in the printout and
 * in both files is the server's; the screen labels them and adds nothing up.
 */

const SUMMARY: TakingsSummary = {
  period: 'day', fromDate: '2026-10-22', toDate: '2026-10-22',
  bills: [
    { billId: 'b1', billNo: 7, businessDate: '2026-10-22', billedAt: '2026-10-22 13:05:00+00', serviceType: 'parcel',
      seating: 'counter', parcelNo: 3, pickupName: 'Rahul', subtotalMinor: 10000, taxMinor: 500, totalMinor: 10500, collectedMinor: 10500 },
  ],
  items: [{ name: 'Rice', quantity: 1, amountMinor: 5000 }, { name: 'Dal Tadka', quantity: 1, amountMinor: 5000 }],
  methods: [{ method: 'cash', payments: 1, amountMinor: 5500 }, { method: 'upi', payments: 1, amountMinor: 5000 }],
  totals: { bills: 1, payments: 2, salesMinor: 10500, taxMinor: 500, collectedMinor: 10500 },
};

describe('the takings report shape', () => {
  it('has the four sections, from the server\'s figures: Rice – ₹50.00 is a line of Item Details', () => {
    const report = takingsReport(SUMMARY, 'Asha');
    expect(report.title).toBe('My takings · Daily');
    expect(report.subtitle).toBe('22 Oct 2026 · Asha');
    expect(report.sections.map((s) => s.title)).toEqual(['Sales Summary', 'Bill Amount', 'Item Details', 'Transactions']);
    const items = report.sections.find((s) => s.title === 'Item Details')!;
    expect(items.rows[0]!.map((c) => (typeof c === 'object' ? c.minor : c))).toEqual(['Rice', 1, 5000]);
    const bills = report.sections.find((s) => s.title === 'Bill Amount')!;
    expect(bills.rows[0]![1]).toBe('Parcel P-3 · Rahul');
    const methods = report.sections.find((s) => s.title === 'Transactions')!;
    expect(methods.rows.map((r) => r[0])).toEqual(['Cash', 'UPI', 'Total']);
  });

  it('a bill paid to the nearest rupee is listed at its net payable, and the summary adds Round off and Net payable', () => {
    const rounded: TakingsSummary = {
      ...SUMMARY,
      bills: [{ ...SUMMARY.bills[0]!, totalMinor: 10549, roundOffMinor: -49, payableMinor: 10500, collectedMinor: 10500 }],
      totals: { ...SUMMARY.totals, salesMinor: 10549, roundOffMinor: -49, payableMinor: 10500 },
    };
    const report = takingsReport(rounded, null);
    const summary = report.sections.find((s) => s.title === 'Sales Summary')!;
    expect(summary.rows.map((r) => [r[0], typeof r[1] === 'object' ? r[1].minor : r[1]])).toEqual([
      ['Bills', 1], ['Total sales', 10549], ['Round off', -49], ['Net payable', 10500],
      ['Tax', 500], ['Transactions', 2], ['You collected', 10500],
    ]);
    const bills = report.sections.find((s) => s.title === 'Bill Amount')!;
    expect(bills.head[3]).toBe('Net payable');
    expect(bills.rows[0]![3]).toEqual({ minor: 10500 });
    // No round-off: the two rows are not shown at all.
    expect(takingsReport(SUMMARY, null).sections[0]!.rows.map((r) => r[0])).not.toContain('Round off');
  });

  it('a spreadsheet gets money as a number it can sum; the file is named for the period', () => {
    expect(cellValue({ minor: 5050 })).toBe(50.5);
    expect(cellValue('Rice')).toBe('Rice');
    expect(fileStem(SUMMARY)).toBe('my-takings-daily-2026-10-22');
    expect(fileStem({ ...SUMMARY, period: 'week', fromDate: '2026-10-19' })).toBe('my-takings-weekly-2026-10-19-to-2026-10-22');
  });

  it('a From/To range is titled Custom and named for its dates; a bad pair is refused in words before asking', () => {
    const custom: TakingsSummary = { ...SUMMARY, period: 'custom', fromDate: '2026-10-01', toDate: '2026-10-15' };
    expect(takingsReport(custom, null).title).toBe('My takings · Custom');
    expect(takingsReport(custom, null).subtitle).toBe('1 Oct – 15 Oct 2026');
    expect(fileStem(custom)).toBe('my-takings-custom-2026-10-01-to-2026-10-15');
    expect(rangeProblem('2026-10-01', '2026-10-15', '2026-10-22')).toBeNull();
    expect(rangeProblem('2026-10-22', '2026-10-22', '2026-10-22')).toBeNull();
    expect(rangeProblem('', '2026-10-15', '2026-10-22')).toContain('both');
    expect(rangeProblem('2026-10-16', '2026-10-15', '2026-10-22')).toContain('on or before');
    expect(rangeProblem('2026-10-16', '2026-10-23', '2026-10-22')).toContain('after today');
    expect(rangeProblem('2026-10-16', '2026-10-23', null)).toBeNull(); // today unknown: the server decides
    expect(rangeProblem('2025-10-22', '2026-10-22', '2026-10-22')).toBeNull(); // 366 days
    expect(rangeProblem('2025-10-21', '2026-10-22', '2026-10-22')).toContain('366');
  });

  it('the receipt-printer copy is one compact column on a roll, with every section', () => {
    const html = renderTakingsHtml(takingsReport(SUMMARY, 'Asha'), 'Spice');
    expect(html).toContain('size: 80mm auto');
    for (const text of ['Spice', 'SALES SUMMARY', 'Bill Amount', 'Item Details', 'Rice', '₹50.00', 'You collected', '₹105.00']) {
      expect(html.toUpperCase()).toContain(text.toUpperCase());
    }
    expect(renderTakingsHtml(takingsReport(SUMMARY, null), 'Spice', 58)).toContain('size: 58mm auto');
  });
});

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.mocked(printHtml).mockClear();
  writeFile.mockClear();
  saved.mockClear();
  texts.length = 0;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const dateField = (label: 'From date' | 'To date'): HTMLInputElement =>
  [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
async function setDate(label: 'From date' | 'To date', value: string): Promise<void> {
  await act(async () => {
    const input = dateField(label);
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function downloadAs(label: 'PDF' | 'Excel (.xlsx)'): Promise<void> {
  await act(async () => { button('Download').click(); });
  await act(async () => { button(label).click(); });
  await settle();
}

async function open(get: (path: string) => Promise<unknown>): Promise<void> {
  const api = { get: vi.fn(get) } as unknown as Api;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MyTakings api={api} restaurant="Spice" who="Asha" onClose={() => undefined} />); });
  await settle();
}

describe('the My takings panel', () => {
  it('opens on Daily, switches period, and downloads PDF and Excel and prints from the same figures', async () => {
    const asked: string[] = [];
    await open(async (path) => { asked.push(path); return path.endsWith('week') ? { ...SUMMARY, period: 'week', fromDate: '2026-10-19' } : SUMMARY; });
    expect(asked).toEqual(['/pos/my-takings?period=day']);
    for (const text of ['Sales Summary', 'Bill Amount', 'Item Details', 'Transactions', 'Rice', '₹50.00', 'Parcel P-3 · Rahul', '₹105.00']) {
      expect(host.textContent).toContain(text);
    }

    await act(async () => { button('Weekly').click(); });
    await settle();
    expect(asked.at(-1)).toBe('/pos/my-takings?period=week');
    expect(host.textContent).toContain('19 Oct – 22 Oct 2026 · Asha');

    await downloadAs('Excel (.xlsx)');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [book, name] = writeFile.mock.calls[0] as [{ sheets: { name: string }[] }, string];
    expect(name).toBe('my-takings-weekly-2026-10-19-to-2026-10-22.xlsx');
    expect(book.sheets.map((s) => s.name)).toEqual(['Sales Summary', 'Bill Amount', 'Item Details', 'Transactions']);

    await downloadAs('PDF');
    expect(saved).toHaveBeenCalledWith('my-takings-weekly-2026-10-19-to-2026-10-22.pdf');
    expect(texts).toContain('Rice');
    // The PDF's standard font has no rupee sign: "Rs" there, the same figure.
    expect(texts).toContain('Rs 50.00');

    await act(async () => { button('Print').click(); });
    expect(vi.mocked(printHtml)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(printHtml).mock.calls[0]![0]).toContain('Rice');
  });

  it('says plainly when the sign-in takes no payments, and offers nothing to download', async () => {
    await open(async () => { throw new ApiError({ kind: 'refused', status: 403, code: 'forbidden', retryable: false }, 'no'); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('does not take payments');
    expect(button('Download').disabled).toBe(true);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('an empty period says so in each section rather than showing blank tables', async () => {
    await open(async () => ({ ...SUMMARY, bills: [], items: [], methods: [],
      totals: { bills: 0, payments: 0, salesMinor: 0, taxMinor: 0, collectedMinor: 0 } }));
    expect(host.textContent).toContain('No bills in this period.');
    expect(host.textContent).toContain('No items in this period.');
    expect(host.textContent).toContain('No payments in this period.');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('No takings for 22 Oct 2026');
  });

  it('a From/To range is read with those dates and every section, the files and the title follow it', async () => {
    const asked: string[] = [];
    const ranged: TakingsSummary = { ...SUMMARY, period: 'custom', fromDate: '2026-10-01', toDate: '2026-10-15',
      items: [{ name: 'Paneer Tikka', quantity: 4, amountMinor: 96000 }] };
    await open(async (path) => { asked.push(path); return path.includes('from=') ? ranged : SUMMARY; });
    // The fields start on the period shown, and cannot pass today.
    expect(dateField('From date').value).toBe('2026-10-22');
    expect(dateField('To date').max).toBe('2026-10-22');

    await setDate('From date', '2026-10-01');
    await setDate('To date', '2026-10-15');
    await act(async () => { button('Apply dates').click(); });
    await settle();
    expect(asked.at(-1)).toBe('/pos/my-takings?from=2026-10-01&to=2026-10-15');
    expect(host.textContent).toContain('1 Oct – 15 Oct 2026 · Asha');
    expect(host.textContent).toContain('Paneer Tikka');
    expect(host.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(0);

    // View report reads the chosen range again, not Daily.
    await act(async () => { button('View report').click(); });
    await settle();
    expect(asked.at(-1)).toBe('/pos/my-takings?from=2026-10-01&to=2026-10-15');

    await downloadAs('Excel (.xlsx)');
    expect(writeFile.mock.calls[0]![1]).toBe('my-takings-custom-2026-10-01-to-2026-10-15.xlsx');
    await downloadAs('PDF');
    expect(saved).toHaveBeenCalledWith('my-takings-custom-2026-10-01-to-2026-10-15.pdf');
    expect(texts).toContain('Paneer Tikka');

    // Back to a tab: the named period again.
    await act(async () => { button('Monthly').click(); });
    await settle();
    expect(asked.at(-1)).toBe('/pos/my-takings?period=month');
  });

  it('an unusable range is refused on screen and never asked for', async () => {
    const asked: string[] = [];
    await open(async (path) => { asked.push(path); return SUMMARY; });
    const apply = async (): Promise<string | null | undefined> => {
      await act(async () => { button('Apply dates').click(); });
      await settle();
      return host.querySelector('[role="alert"]')?.textContent;
    };
    await setDate('From date', '2026-10-15');
    await setDate('To date', '2026-10-10');
    expect(await apply()).toContain('on or before');
    await setDate('To date', '2026-10-23');
    expect(await apply()).toContain('after today');
    await setDate('From date', '');
    expect(await apply()).toContain('both');
    expect(asked).toEqual(['/pos/my-takings?period=day']);
  });

  it('a range the server refuses is said in words, with nothing left to download', async () => {
    await open(async (path) => {
      if (path.includes('from=')) throw new ApiError({ kind: 'refused', status: 400, code: 'till_range_invalid', retryable: false }, 'no');
      return SUMMARY;
    });
    await setDate('From date', '2026-10-01');
    await act(async () => { button('Apply dates').click(); });
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Those dates cannot be used');
    expect(button('Download').disabled).toBe(true);
  });
});
