import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrintPreview } from '../src/features/billing/print/PrintPreview.js';
import { DEFAULT_LAYOUT } from '../src/features/billing/print/receipt.js';

/**
 * The preview sizes a roll to its content. A frame that has not loaded its page
 * yet has a document with no document element -- the moment Print opens the
 * preview -- and measuring it then crashed the POS ("Cannot read properties of
 * null (reading 'scrollHeight')"). It must wait for the page instead.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe('the print preview', () => {
  it('opens while its frame has no page yet, then sizes itself when the page loads', async () => {
    let loaded = false;
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get')
      .mockImplementation(() => ({ documentElement: loaded ? { scrollHeight: 700 } : null }) as unknown as Document);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const pages = [{ purpose: 'kitchen' as const, ticket: { ticketText: 'KOT #1\n 1 x Tea' }, parcel: false, reprint: false }];
    await act(async () => { root!.render(<PrintPreview pages={pages} layout={DEFAULT_LAYOUT} maxWidth={1000} />); });
    const frame = host.querySelector('iframe')!;
    expect(frame).not.toBeNull();

    loaded = true;
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    expect(frame.style.height).toBe('708px');
  });
});
