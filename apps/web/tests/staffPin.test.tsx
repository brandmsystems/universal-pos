import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { PinLogin, SUCCESS_MS } from '../src/features/auth/pos/PinLogin.js';

/**
 * Staff Login on the till: Screen 2 lists the till's staff as cards (from
 * `GET /api/public/restaurants/:slug/till/staff`); tapping one opens Screen 3,
 * the PIN keypad for that person, which signs in on the 4th digit
 * (`POST /api/auth/:slug/pin`) and never asks for a username.
 */

let root: Root | null = null;
let host: HTMLElement;
let calls: { path: string; body: Record<string, unknown> | null; fingerprint: string | null }[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label) as HTMLButtonElement;
const tap = async (label: string): Promise<void> => { await act(async () => { button(label).click(); }); await settle(); };
const card = async (name: string): Promise<void> => {
  await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!.click(); });
};
const dots = (): string => host.querySelector('[role="status"]')!.getAttribute('aria-label')!;

const DEVICE = { tenantSlug: 'cafe', deviceId: 'd1', branchId: 'b1', fingerprint: 'fingerprint-0123456789' };
const RESTAURANT = { slug: 'cafe', name: 'Cafe', signInAvailable: true, themeColor: null, logoUrl: null };
const STAFF = { status: 200, body: { staff: [{ userId: 'u1', fullName: 'Asha Rao' }, { userId: 'u2', fullName: 'Ravi' }] } };

function serve(answers: Record<string, { status: number; body: unknown }>): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      fingerprint: new Headers(init?.headers).get('x-device-fingerprint') });
    const answer = answers[path] ?? { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }));
}

async function open(handlers: { onSignedIn?: () => void; onTabletLost?: () => void } = {}): Promise<void> {
  const store = scopedStore(createStore(), 'pos:cafe');
  store.set('device.v1', DEVICE);
  const api = createApi(store);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<PinLogin api={api} device={DEVICE} restaurant={RESTAURANT}
      onSignedIn={handlers.onSignedIn ?? vi.fn()} onTabletLost={handlers.onTabletLost ?? vi.fn()} />);
  });
  await settle();
}

describe('Screen 2: who is signing in', () => {
  it('lists the till\'s staff as cards, read with the till\'s fingerprint', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': STAFF });
    await open();
    expect(calls[0]).toEqual({ path: '/api/public/restaurants/cafe/till/staff', body: null, fingerprint: DEVICE.fingerprint });
    expect(host.textContent).toContain('Who\'s signing in?');
    expect(host.textContent).toContain('Asha Rao');
    expect(host.textContent).toContain('AR');
    expect(host.textContent).toContain('Ravi');
    // No username, no password on this screen.
    expect(host.querySelectorAll('input')).toHaveLength(0);
  });

  it('shows a loading state, then an empty state that says who adds staff', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    await open();
    expect(host.querySelector('[aria-label="Loading staff"]')).not.toBeNull();
    await act(async () => { answer(Response.json({ staff: [] })); });
    await settle();
    expect(host.textContent).toContain('No staff have been added yet.');
    expect(host.textContent).toContain('Your Sales person adds staff and sets their PIN.');
  });

  it('lists staff without a PIN too, marked, with no PIN pad to open; the others still open theirs', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': { status: 200, body: { staff: [
      { userId: 'u1', fullName: 'PRAVEEN', hasPin: false }, { userId: 'u2', fullName: 'Rithesh', hasPin: true },
    ] } } });
    await open();
    expect(host.textContent).toContain('PRAVEEN');
    expect(host.textContent).toContain('PIN not set — ask your Sales person');
    expect(host.textContent).not.toContain('No staff have been added yet.');
    const praveen = [...host.querySelectorAll('[aria-disabled="true"]')];
    expect(praveen).toHaveLength(1);
    expect(praveen[0]!.tagName).not.toBe('BUTTON');
    await card('Rithesh');
    expect(host.textContent).toContain('Enter your 4-digit PIN');
  });

  it('a failed read says so and offers Try again, which reads again', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': { status: 500, body: { error: 'internal_error', retryable: false } } });
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The staff list did not load.');
    serve({ '/api/public/restaurants/cafe/till/staff': STAFF });
    await tap('Try again');
    expect(host.textContent).toContain('Asha Rao');
  });

  it('a browser that is no longer a till goes back to set-up', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': { status: 401, body: { error: 'tablet_not_set_up', retryable: false } } });
    const lost = vi.fn();
    await open({ onTabletLost: lost });
    expect(lost).toHaveBeenCalled();
  });

  it('managers are pointed to the Manager Login page -- no manager form on the till', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': STAFF });
    await open();
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Manager Login');
    expect(link?.getAttribute('href')).toBe('/cafe');
    expect(host.querySelectorAll('input')).toHaveLength(0);
  });
});

describe('Screen 3: the PIN', () => {
  it('shows the tapped person and signs them in on the 4th digit -- no username asked', async () => {
    serve({
      '/api/public/restaurants/cafe/till/staff': STAFF,
      '/api/auth/cafe/pin': { status: 200, body: { accessToken: 'a', refreshToken: 'r', userId: 'u1' } },
    });
    const signedIn = vi.fn();
    await open({ onSignedIn: signedIn });
    await card('Asha Rao');
    expect(host.textContent).toContain('Enter your 4-digit PIN');
    expect(host.querySelector('section[aria-label="PIN for Asha Rao"]')).not.toBeNull();
    expect(host.querySelectorAll('input')).toHaveLength(0);
    for (const d of ['5', '9', '2', '7']) await tap(d);
    const pin = calls.find((c) => c.path === '/api/auth/cafe/pin')!;
    expect(pin.body).toEqual({ userId: 'u1', pin: '5927', deviceFingerprint: DEVICE.fingerprint, branchId: 'b1' });
    // Success is said on the screen first, then the POS opens.
    expect(host.textContent).toContain('Signed in');
    expect(signedIn).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, SUCCESS_MS + 50)); });
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it('hides the PIN by default and shows it on request; Delete and Clear work; Back returns to the cards', async () => {
    serve({ '/api/public/restaurants/cafe/till/staff': STAFF });
    await open();
    await card('Ravi');
    await tap('3'); await tap('8');
    expect(host.textContent).not.toContain('38');
    await tap('Show PIN');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('38');
    await tap('Delete last digit');
    expect(dots()).toBe('1 of 4 digits entered');
    await tap('Clear');
    expect(dots()).toBe('0 of 4 digits entered');
    await tap('Back');
    expect(host.textContent).toContain('Who\'s signing in?');
  });

  it('a wrong PIN says so without repeating it, and clears; a lockout says how long', async () => {
    let refusal: unknown = { error: 'authentication_failed', retryable: false };
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = new URL(String(input), 'http://x').pathname;
      if (path === '/api/public/restaurants/cafe/till/staff') return Response.json(STAFF.body);
      return new Response(JSON.stringify(refusal), { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    await open();
    await card('Asha Rao');
    for (const d of ['5', '9', '2', '7']) await tap(d);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('That PIN was not accepted. Try again.');
    expect(host.textContent).not.toContain('5927');
    expect(dots()).toBe('0 of 4 digits entered');

    refusal = { error: 'authentication_failed', retryable: false, retryAfterSeconds: 60 };
    for (const d of ['5', '9', '2', '7']) await tap(d);
    expect(host.textContent).toContain('Wait 60 seconds');
  });
});
