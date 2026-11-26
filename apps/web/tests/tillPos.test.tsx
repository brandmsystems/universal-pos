import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';
import { ApiError, createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { createQueue } from '../src/services/queue.js';
import { createPump } from '../src/services/pump.js';
import { createConsensusKeys } from '../src/lib/consensus.js';
import { Shift } from '../src/features/orders/pos/Shift.js';

/**
 * The owner's till: one email-and-password sign-in becomes a device and a
 * branch session, with no setup code; a browser that already is the till signs
 * the same till back in; and the POS is ONE screen -- New order, then the bill
 * and payment -- with no Dine-in, Parcel or KOT tabs.
 */

const BRANCH = '44444444-4444-4444-8444-444444444444';
const DEVICE = '55555555-5555-4555-8555-555555555555';

type Answer = { status: number; body: unknown };
let calls: string[] = [];

function serve(answers: Record<string, Answer | ((body: unknown) => Answer)>): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const path = url.split('?')[0]!;
    const found = answers[path];
    const answer = typeof found === 'function' ? found(init?.body ? JSON.parse(String(init.body)) : undefined) : found;
    if (answer === undefined) return Response.json({ rows: [] });
    return Response.json(answer.body, { status: answer.status });
  }));
}

const TILL = { status: 200, body: { deviceId: DEVICE, branchId: BRANCH, userId: 'u1', accessToken: 'till', refreshToken: 'till-r' } };

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('setting up the till', () => {
  it('one call: the same username and password, and this browser; holds the till session', async () => {
    const asked: unknown[] = [];
    serve({ '/api/auth/spice/till': (body) => { asked.push(body); return TILL; } });
    const api = createApi(scopedStore(createStore(), 'pos:spice'));
    const { device, session } = await api.setUpTill({ tenantSlug: 'spice', email: 'o@x.in', password: 'pw', deviceName: 'Counter' });

    expect(calls).toEqual(['POST /api/auth/spice/till']);
    expect(asked[0]).toMatchObject({ login: 'o@x.in', password: 'pw', deviceName: 'Counter' });
    expect(device).toMatchObject({ tenantSlug: 'spice', deviceId: DEVICE, branchId: BRANCH });
    expect(device.fingerprint.length).toBeGreaterThanOrEqual(16);
    expect(session).toMatchObject({ accessToken: 'till', branchId: BRANCH, userId: 'u1' });
    expect(api.session()?.accessToken).toBe('till');
  });

  it('the next sign-in on this browser sends the same fingerprint: the same till, whoever signs in', async () => {
    const asked: { deviceFingerprint: string; login: string }[] = [];
    serve({ '/api/auth/spice/till': (body) => { asked.push(body as never); return TILL; } });
    const store = scopedStore(createStore(), 'pos:spice');
    await createApi(store).setUpTill({ tenantSlug: 'spice', email: 'o@x.in', password: 'pw', deviceName: 'Counter' });
    const again = createApi(store);
    again.signOut();
    await again.setUpTill({ tenantSlug: 'spice', email: 'asha', password: 'pw2', deviceName: 'Counter' });
    expect(asked.map((a) => a.login)).toEqual(['o@x.in', 'asha']);
    expect(asked[1]!.deviceFingerprint).toBe(asked[0]!.deviceFingerprint);
  });

  it('a refusal leaves nothing behind: no session and no device', async () => {
    serve({ '/api/auth/spice/till': { status: 403, body: { error: 'till_not_permitted', retryable: false } } });
    const api = createApi(scopedStore(createStore(), 'pos:spice'));
    const refused = await api.setUpTill({ tenantSlug: 'spice', email: 'tara', password: 'pw', deviceName: 'Counter' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).failure).toMatchObject({ code: 'till_not_permitted' });
    expect(api.session()).toBeNull();
    expect(api.device()).toBeNull();
  });
});

describe('the POS screen', () => {
  async function renderShift(canBill: boolean, logoUrl: string | null = null, takings = false): Promise<void> {
    serve({
      '/api/t/me': { status: 200, body: {
        kind: 'staff', userId: 'u1', fullName: 'Owner', employeeCode: null, email: 'o@x.in', roles: [],
        branchName: 'Main', deviceName: 'Counter', screens: { kot: true, billing: canBill, kitchen: false, takings },
      } },
      '/api/t/pos/my-takings': { status: 200, body: {
        period: 'day', fromDate: '2026-10-22', toDate: '2026-10-22', bills: [], items: [], methods: [],
        totals: { bills: 0, payments: 0, salesMinor: 0, taxMinor: 0, collectedMinor: 0 },
      } },
      '/api/t/pos/floor': { status: 200, body: { tables: [], serverNow: new Date().toISOString(), businessDate: '2026-10-09' } },
      '/api/t/billing/queue': { status: 200, body: { kot: true, rows: [] } },
    });
    const store = scopedStore(createStore(), 'pos:spice');
    const api = createApi(store);
    const queue = createQueue(store);
    const leases = createLeases(store, api);
    const billingLeases = createLeases(scopedStore(store, 'billing'), api, 'billing');
    const pump = createPump({ api, queue, leases });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Shift api={api} device={{ tenantSlug: 'spice', deviceId: DEVICE, branchId: BRANCH, fingerprint: 'f'.repeat(20) }}
        session={{ accessToken: 't', refreshToken: 'r', tenantSlug: 'spice', branchId: BRANCH, userId: 'u1' }}
        leases={leases} billingLeases={billingLeases} queue={queue} queueState={queue.snapshot()} pump={pump}
        keys={createConsensusKeys()} durability="persistent" onSignOut={() => undefined} logoUrl={logoUrl} />);
    });
  }
  const labels = (): string[] => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');

  it('the header shows the restaurant logo, and the shop icon only when it has none', async () => {
    await renderShift(true, '/api/public/restaurants/spice/logo');
    const logo = host.querySelector('img');
    expect(logo?.getAttribute('src')).toBe('/api/public/restaurants/spice/logo');
    act(() => root?.unmount());
    host.remove();
    await renderShift(true, null);
    expect(host.querySelector('img')).toBeNull();
  });

  it('My takings is in the header only for a sign-in whose keys give it, and opens the person\'s own takings', async () => {
    await renderShift(true);
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(labels().some((t) => t.includes('My takings'))).toBe(false);
    act(() => root?.unmount());
    host.remove();

    await renderShift(true, null, true);
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('My takings'))!;
    await act(async () => { open.click(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContain('GET /api/t/pos/my-takings?period=day');
    expect(host.querySelector('[role="dialog"][aria-label="My takings"]')).not.toBeNull();
    expect(host.textContent).toContain('No bills in this period.');
  });

  it('opens on New order with a Parcel switch, beside the orders waiting to be paid; no tabs', async () => {
    await renderShift(true);
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(labels().filter((t) => ['Dine-in', 'Parcel', 'KOT', 'Billing'].includes(t))).toEqual([]);
    expect(host.querySelector('[role="switch"][aria-label="Parcel (take away)"]')).not.toBeNull();
    expect(labels()).toContain('Confirm order');
    expect(host.textContent).toContain('To bill');
    expect(host.textContent).toContain('Billed');
    expect(calls).toContain('GET /api/t/billing/queue');
    // Nothing reads the removed floor, parcel list or KOT board.
    expect(calls.filter((c) => /\/pos\/(floor|parcels|dine-ins)/.test(c))).toEqual([]);
  });
});

describe('/{slug}/pos opened directly, nobody signed in', () => {
  it('a browser that is not a till yet: straight onto the staff cards; a correct PIN makes it the till and opens the POS', async () => {
    window.history.replaceState(null, '', '/spice/pos');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/spice/pos', search: '' });
    let pinBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const path = url.split('?')[0]!;
      if (path === '/api/public/restaurants/spice') {
        return Response.json({ slug: 'spice', name: 'Spice', signInAvailable: true, themeColor: null, logoUrl: null });
      }
      if (path === '/api/public/restaurants/spice/till/staff') {
        // No till yet, so no fingerprint is sent -- and the cards still come.
        expect(new Headers(init?.headers).get('x-device-fingerprint')).toBeNull();
        return Response.json({ staff: [{ userId: 'u7', fullName: 'Asha', hasPin: true }] });
      }
      if (path === '/api/auth/spice/pin') {
        pinBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ accessToken: 'pin-token', refreshToken: 'r', userId: 'u7', deviceId: DEVICE, branchId: BRANCH });
      }
      if (path === '/api/t/me') {
        return Response.json({ kind: 'staff', userId: 'u7', fullName: 'Asha', employeeCode: 'ASHA', email: null, roles: [],
          branchName: 'Main', deviceName: 'Counter till', screens: { kot: true, billing: true, kitchen: false } });
      }
      if (path === '/api/t/billing/queue') return Response.json({ kot: true, rows: [] });
      return Response.json({ rows: [] });
    }));
    calls = [];
    const { App } = await import('../src/app/pos/App.js');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); });
    const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('This computer is not the till yet');
    expect(host.textContent).toContain('Who\'s signing in?');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Asha'))!.click(); });
    for (const d of ['5', '9', '2', '7']) {
      await act(async () => { [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === d)!.click(); });
      await settle();
    }
    // A fresh fingerprint and no branch: the server decides the till.
    expect(pinBody).toMatchObject({ userId: 'u7', pin: '5927' });
    expect(pinBody!['branchId']).toBeUndefined();
    expect(typeof pinBody!['deviceFingerprint']).toBe('string');
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await settle();
    expect(host.textContent).toContain('New order');
    // This browser is the till from now on.
    expect(scopedStore(createStore(), 'pos:spice').get('device.v1')).toMatchObject({ deviceId: DEVICE, branchId: BRANCH,
      fingerprint: pinBody!['deviceFingerprint'] });
  });

  it('a till a manager took out of use is not quietly re-made by a PIN: the manager sets it up again', async () => {
    window.history.replaceState(null, '', '/spice/pos');
    vi.stubGlobal('location', { ...window.location, assign: vi.fn(), pathname: '/spice/pos', search: '' });
    scopedStore(createStore(), 'pos:spice').set('device.v1',
      { tenantSlug: 'spice', deviceId: DEVICE, branchId: BRANCH, fingerprint: 'f'.repeat(20) });
    serve({
      '/api/public/restaurants/spice': { status: 200, body: { slug: 'spice', name: 'Spice', signInAvailable: true, themeColor: null, logoUrl: null } },
      '/api/public/restaurants/spice/till/staff': { status: 401, body: { error: 'tablet_not_set_up', retryable: false } },
    });
    const { App } = await import('../src/app/pos/App.js');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.textContent).toContain('This computer is not the till yet');
    expect(scopedStore(createStore(), 'pos:spice').get('device.v1')).not.toBeNull();
  });

  it('a right PIN on a computer staff may not make a till leads to the manager\'s set-up, which makes it one', async () => {
    // `till_not_permitted` used to end on a message whose only way on was the
    // Manager Login link -- the manager screens, which never set a till up.
    window.history.replaceState(null, '', '/spice/pos');
    vi.stubGlobal('location', { ...window.location, assign: vi.fn(), pathname: '/spice/pos', search: '' });
    serve({
      '/api/public/restaurants/spice': { status: 200, body: { slug: 'spice', name: 'Spice', signInAvailable: true, themeColor: null, logoUrl: null } },
      '/api/public/restaurants/spice/till/staff': { status: 200, body: { staff: [{ userId: 'u7', fullName: 'Asha', hasPin: true }] } },
      '/api/auth/spice/pin': { status: 403, body: { error: 'till_not_permitted', retryable: false } },
      // A manager's credentials: the till is set up, and no POS session comes with it.
      '/api/auth/spice/till': { status: 200, body: { tillOnly: true, deviceId: DEVICE, branchId: BRANCH } },
    });
    const { App } = await import('../src/app/pos/App.js');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); });
    const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const click = async (label: string) => {
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label
          || b.textContent?.trim() === label || b.textContent?.includes(label))!.click();
      });
      await settle();
    };
    await settle();
    await click('Asha');
    for (const d of ['5', '9', '2', '7']) await click(d);
    expect(calls).toContain('POST /api/auth/spice/pin');
    expect(host.textContent).toContain('This computer is not the till yet');
    expect(host.textContent).not.toContain('This account cannot use the POS');

    await click('Set up this computer as the till');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const [id, value] of [['email', 'MANAGER'], ['password', 'manager-pass']] as const) {
      const input = host.querySelector<HTMLInputElement>(`input#${id}`)!;
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(calls).toContain('POST /api/auth/spice/till');
    expect(scopedStore(createStore(), 'pos:spice').get('device.v1')).toMatchObject({ deviceId: DEVICE, branchId: BRANCH });
    // Back on the staff cards, now on a till.
    expect(host.textContent).toContain('Asha');
  });

  it('a till with nobody on it: Screen 2 the staff cards, Screen 3 the PIN, then the POS; managers go to their own page', async () => {
    window.history.replaceState(null, '', '/spice/pos');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/spice/pos', search: '' });
    scopedStore(createStore(), 'pos:spice').set('device.v1',
      { tenantSlug: 'spice', deviceId: DEVICE, branchId: BRANCH, fingerprint: 'f'.repeat(20) });
    serve({
      '/api/public/restaurants/spice': { status: 200, body: { slug: 'spice', name: 'Spice', signInAvailable: true, themeColor: null, logoUrl: null } },
      '/api/public/restaurants/spice/till/staff': { status: 200, body: { staff: [{ userId: 'u7', fullName: 'Asha' }] } },
      '/api/auth/spice/pin': { status: 200, body: { accessToken: 'pin-token', refreshToken: 'r', userId: 'u7' } },
      '/api/t/me': { status: 200, body: { kind: 'staff', userId: 'u7', fullName: 'Asha', employeeCode: 'ASHA', email: null, roles: [],
        branchName: 'Main', deviceName: 'Counter', screens: { kot: true, billing: true, kitchen: false } } },
      '/api/t/billing/queue': { status: 200, body: { kot: true, rows: [] } },
    });
    const { App } = await import('../src/app/pos/App.js');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); });
    const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const press = async (label: string) => {
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label
          || b.textContent?.trim() === label)!.click();
      });
      await settle();
    };
    await settle();
    // Screen 2.
    expect(host.textContent).toContain('Who\'s signing in?');
    expect(host.textContent).toContain('Asha');
    // No manager form on the till: a link to the Manager Login page.
    expect([...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Manager Login')?.getAttribute('href')).toBe('/spice');
    expect(host.querySelectorAll('input')).toHaveLength(0);
    // Screen 3, then the POS.
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Asha'))!.click(); });
    expect(host.textContent).toContain('Enter your 4-digit PIN');
    for (const d of ['5', '9', '2', '7']) await press(d);
    expect(calls).toContain('POST /api/auth/spice/pin');
    expect(host.textContent).toContain('Signed in');
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await settle();
    expect(host.textContent).toContain('New order');
    expect(assign).not.toHaveBeenCalled();
  });
});
