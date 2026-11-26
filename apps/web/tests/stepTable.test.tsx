import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StepTable, type Column, type Filter } from '../src/features/settings/admin/setup/common.js';

/**
 * Search, filters, sorting and 10-per-page paging on the setup lists, driven
 * the way a person does it: typing, choosing, clicking a header, a page number.
 */

interface Row { readonly id: string; readonly name: string; readonly floor: string; readonly seats: number }

const tables = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
  id: `t${i + 1}`, name: `T${i + 1}`, floor: i % 2 === 0 ? 'Ground' : 'Terrace', seats: (i % 3) + 2,
}));

const columns: readonly Column<Row>[] = [
  { title: 'Table', value: (r) => r.name, render: (r) => r.name },
  { title: 'Floor', value: (r) => r.floor, render: (r) => r.floor },
  { title: 'Seats', value: (r) => r.seats, render: (r) => String(r.seats) },
];
const filters: readonly Filter<Row>[] = [
  { kind: 'choice', label: 'Floor', value: (r) => r.floor },
  { kind: 'choice', label: 'Seats', value: (r) => String(r.seats) },
  { kind: 'range', label: 'Seats range', value: (r) => r.seats },
];

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); });

async function show(rows: readonly Row[], withFilters = filters): Promise<void> {
  if (root === null) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => {
    root!.render(<StepTable rows={rows} failed={false} columns={columns} filters={withFilters} empty="No tables yet."
      noun="tables" onEdit={() => undefined} />);
  });
}
const names = (): string[] => [...host.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent ?? '')
  .filter((t) => !t.startsWith('No records'));
const summary = (): string => host.querySelector('nav[aria-label="Pagination"] span')?.textContent ?? '';
const button = (text: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
async function click(el: Element): Promise<void> { await act(async () => { (el as HTMLElement).click(); }); }
async function type(label: string, value: string): Promise<void> {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(label: string, value: string): Promise<void> {
  const select = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const header = (title: string): HTMLButtonElement =>
  [...host.querySelectorAll('th button')].find((b) => b.textContent?.startsWith(title)) as HTMLButtonElement;

describe('the setup lists', () => {
  it('shows 10 rows and no page buttons for exactly 10', async () => {
    await show(tables(10));
    expect(names()).toHaveLength(10);
    expect(summary()).toBe('1–10 of 10 tables');
    expect(button('2')).toBeUndefined();
  });

  it('pages 11+ rows 10 at a time with Previous | 1 | 2 | Next', async () => {
    await show(tables(47));
    expect(names()).toHaveLength(10);
    expect(summary()).toBe('1–10 of 47 tables');
    await click(button('5'));
    expect(names()).toEqual(['T41', 'T42', 'T43', 'T44', 'T45', 'T46', 'T47']);
    expect(summary()).toBe('41–47 of 47 tables');
  });

  it('searches across the columns and goes back to page 1', async () => {
    await show(tables(47));
    await click(button('3'));
    await type('Search', 't4');
    expect(names()).toEqual(['T4', 'T40', 'T41', 'T42', 'T43', 'T44', 'T45', 'T46', 'T47']);
    expect(summary()).toBe('1–9 of 9 tables');
  });

  it('combines several filters, and sorts both ways with a visible direction', async () => {
    await show(tables(47));
    await choose('Floor', 'Terrace');
    await choose('Seats', '4');
    expect(names().length).toBeGreaterThan(0);
    expect(names().every((n) => Number(n.slice(1)) % 2 === 0 && (Number(n.slice(1)) - 1) % 3 === 2)).toBe(true);
    await click(header('Table'));
    expect(header('Table').textContent).toContain('↑');
    const up = names();
    await click(header('Table'));
    expect(header('Table').textContent).toContain('↓');
    expect(names()).toEqual([...up].reverse());
    expect(host.querySelector('th[aria-sort="descending"]')).not.toBeNull();
  });

  it('keeps search, filter and sort together while paging', async () => {
    await show(tables(47));
    await type('Search', 't');
    await choose('Floor', 'Ground');
    await click(header('Seats'));
    expect(summary()).toBe('1–10 of 24 tables');
    const seats = [...host.querySelectorAll('tbody tr')].map((tr) => Number(tr.querySelectorAll('td')[2]!.textContent));
    expect(seats).toEqual([...seats].sort((a, b) => a - b));
    await click(button('3'));
    expect(summary()).toBe('21–24 of 24 tables');
    // Sorting again keeps the page.
    await click(header('Seats'));
    expect(summary()).toBe('21–24 of 24 tables');
  });

  it('filters by a range', async () => {
    await show(tables(12));
    await type('Seats range min', '4');
    expect(names()).toEqual(['T3', 'T6', 'T9', 'T12']);
  });

  it('says so when nothing matches, and Clear brings everything back', async () => {
    await show(tables(47));
    await type('Search', 'nothing like this');
    expect(host.textContent).toContain('No records found.');
    await click(button('Clear search and filters'));
    expect(names()).toHaveLength(10);
    expect(summary()).toBe('1–10 of 47 tables');
  });

  it('moves to the last page that exists when rows are deleted from the last page', async () => {
    await show(tables(21));
    await click(button('3'));
    expect(names()).toEqual(['T21']);
    await show(tables(20));
    expect(summary()).toBe('11–20 of 20 tables');
    expect(names()[0]).toBe('T11');
  });

  it('hides a filter that has only one value, and keeps the empty message for an empty list', async () => {
    await show(tables(1));
    expect(host.querySelector('select[aria-label="Floor"]')).toBeNull();
    await show([]);
    expect(host.textContent).toContain('No tables yet.');
  });
});
