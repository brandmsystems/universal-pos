import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { TaxRates } from '../src/features/settings/admin/TaxRates.js';

/**
 * A tax rate's CGST / SGST / IGST, SHOWN on the Tax rates page and never typed:
 * the split is the server's (`GET /admin/tax-splits`), so the page has no CGST
 * or SGST input and draws exactly what it was sent.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

const CLASSES = [
  { id: 'c5', key: 'gst_5', name: 'GST 5% (restaurant)', rate_bps: 500, status: 'active' },
  { id: 'c0', key: 'gst_0', name: 'Exempt (0%)', rate_bps: 0, status: 'active' },
  { id: 'c50', key: 'odd', name: 'Fifty', rate_bps: 5000, status: 'active' },
];
const heads = (rate: number) => [
  { key: 'intra_state', name: 'Intra-state supply', heads: [{ name: 'CGST', rateBps: rate / 2 }, { name: 'SGST', rateBps: rate / 2 }] },
  { key: 'inter_state', name: 'Inter-state supply', heads: [{ name: 'IGST', rateBps: rate }] },
];
const SPLITS = {
  jurisdiction: 'IN',
  rows: [
    { taxClassId: 'c5', rateBps: 500, treatments: heads(500) },
    { taxClassId: 'c0', rateBps: 0, treatments: [] },
    { taxClassId: 'c50', rateBps: 5000, treatments: heads(5000) },
  ],
};

async function open(splitsAnswer: () => Response): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://x').pathname;
    if (path.endsWith('/admin/tax-classes')) return Response.json({ rows: CLASSES });
    if (path.endsWith('/admin/tax-splits')) return splitsAnswer();
    return Response.json({});
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<TaxRates api={createApi(createStore())} />); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rowOf = (name: string): string =>
  [...host.querySelectorAll('tr')].find((r) => r.textContent?.includes(name))?.textContent ?? '';

describe('the Tax rates page shows each rate on a bill', () => {
  it('CGST + SGST within the state and IGST across, as the server derived them', async () => {
    await open(() => Response.json(SPLITS));
    expect(host.textContent).toContain('On a bill');
    expect(rowOf('GST 5% (restaurant)')).toContain('CGST 2.5% + SGST 2.5% — within the state');
    expect(rowOf('GST 5% (restaurant)')).toContain('IGST 5% — across states');
    // 50% must not read as 5%: the formatter strips decimals, never digits.
    expect(rowOf('Fifty')).toContain('CGST 25% + SGST 25%');
    expect(rowOf('Fifty')).toContain('IGST 50%');
    expect(rowOf('Exempt (0%)')).toContain('No tax on the bill.');
  });

  it('offers nowhere to type CGST or SGST -- one rate per class', async () => {
    await open(() => Response.json(SPLITS));
    const labels = [...host.querySelectorAll('input')].map((i) => i.getAttribute('aria-label') ?? '');
    expect(labels.some((l) => /cgst|sgst|igst|cess/i.test(l))).toBe(false);
  });

  it('a split that could not be read says so, rather than showing no tax', async () => {
    await open(() => new Response('{}', { status: 500 }));
    expect(rowOf('GST 5% (restaurant)')).toContain('The split could not be read just now.');
    expect(rowOf('GST 5% (restaurant)')).not.toContain('No tax on the bill.');
  });
});
