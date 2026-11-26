import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { known, stale, unknown } from '../src/lib/remote.js';
import { NewOrder } from '../src/features/billing/billing/NewOrder.js';

/**
 * Skeletons on the tablet apps, with the real api client. Each one is checked
 * against the failure that must end it: a skeleton over a failed read tells a
 * kitchen or a till that something is coming when it is not.
 */

let held: Map<string, (() => void)[]>;
let answers: Map<string, { status: number; body: unknown } | 'offline'>;

beforeEach(() => {
  held = new Map();
  answers = new Map();
  window.localStorage.setItem('kk.session.v1', JSON.stringify({
    accessToken: 'a', refreshToken: 'r', tenantSlug: 'spice-garden-blr', branchId: 'b1', userId: 'u',
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    const waiting = held.get(path);
    if (waiting !== undefined) await new Promise<void>((resolve) => waiting.push(resolve));
    const found = answers.get(path);
    if (found === 'offline') throw new TypeError('Failed to fetch');
    if (found === undefined) return Response.json({ rows: [] });
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
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function show(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  await settle();
}

async function release(path: string): Promise<void> {
  const waiting = held.get(path) ?? [];
  held.delete(path);
  await act(async () => { for (const go of waiting) go(); });
  await settle();
}

const skeleton = (label: string): Element | null => host.querySelector(`[data-skeleton="${label}"]`);

function newOrder(): React.ReactElement {
  const store = createStore();
  const api = createApi(store);
  return <NewOrder api={api} leases={createLeases(store, api, 'billing')}
    device={{ tenantSlug: 'spice-garden-blr', deviceId: 'd1', branchId: 'b1', fingerprint: 'f' }}
    kot onCancel={() => undefined} onHandedOver={() => undefined} />;
}

describe('Billing: new order menu', () => {
  it('menu-shaped skeleton, then the menu', async () => {
    held.set('/api/t/pos/menu', []);
    answers.set('/api/t/pos/menu', { status: 200, body: { menu: [
      { id: 'i1', name: 'Paneer Tikka', price_minor: '32000', category_id: null, orderable: true, unavailable_message: null, unavailable_reason: null },
    ] } });
    await show(newOrder());
    expect(skeleton('menu')).not.toBeNull();
    expect(host.textContent).not.toContain('Loading the menu');

    await release('/api/t/pos/menu');
    expect(skeleton('menu')).toBeNull();
    expect(host.textContent).toContain('Paneer Tikka');
  });

  it('a failed read ends the skeleton and says so, where before it said "Loading the menu…" for ever', async () => {
    answers.set('/api/t/pos/menu', { status: 500, body: { error: 'boom' } });
    await show(newOrder());
    expect(skeleton('menu')).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Loading the menu');
  });

  it('an empty menu says so', async () => {
    answers.set('/api/t/pos/menu', { status: 200, body: { menu: [] } });
    await show(newOrder());
    expect(skeleton('menu')).toBeNull();
    expect(host.textContent).toContain('Nothing on sale here.');
  });
});

describe('a read that failed offline is not still loading', () => {
  it('stale() of a never-read value is offline; every other value keeps its meaning', () => {
    expect(stale(unknown<number>())).toEqual({ state: 'unknown', reason: 'offline' });
    expect(stale(unknown<number>('read-failed'))).toEqual({ state: 'unknown', reason: 'read-failed' });
    expect(stale(unknown<number>('not-permitted'))).toEqual({ state: 'unknown', reason: 'not-permitted' });
    expect(stale(known(3, 10))).toEqual({ state: 'stale', value: 3, at: 10 });
  });
});
