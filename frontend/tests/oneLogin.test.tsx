import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { SignIn } from '../src/features/auth/admin/SignIn.js';

/**
 * One sign-in form, two doors, username and password (set by the Sales person)
 * at both:
 *
 * - `/{slug}`: the manager screens. A staff account is refused by the server
 *   (`staff_use_pos`) and told to use Staff Login. Staff Login sits top right.
 * - `/{slug}/pos`: the SAME form in POS mode, signing in on this computer's till
 *   (`POST /api/auth/:slug/till`) for staff and the manager alike. No staff list,
 *   no PIN, no `?to=pos`.
 */

let root: Root | null = null;
let host: HTMLElement;
let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

function serve(answers: Record<string, { status: number; body: unknown }>): void {
  calls = [];
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const answer = answers[path] ?? { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }));
}

async function render(element: (api: ReturnType<typeof createApi>) => React.ReactElement, store = createStore()): Promise<ReturnType<typeof createApi>> {
  const api = createApi(store);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element(api)); });
  return api;
}

async function submit(login: string): Promise<void> {
  const inputs = [...host.querySelectorAll('input')];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (const [el, value] of [[inputs[0]!, login], [inputs[1]!, 'secret-pass-2026']] as const) {
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const manager = (onSignedIn = vi.fn()) => render((api) =>
  <SignIn api={api} onSignedIn={onSignedIn} restaurant={{ slug: 'cafe', name: 'Cafe' }} />);
const pos = (onTill = vi.fn()) => render((api) =>
  <SignIn api={api} restaurant={{ slug: 'cafe', name: 'Cafe' }} pos={{ onTill }} />,
scopedStore(createStore(), 'pos:cafe'));

const TILL = { status: 200, body: { accessToken: 'till', refreshToken: 'till-r', userId: 'u2', deviceId: 'd1', branchId: 'b1' } };
const link = (text: string): HTMLAnchorElement | undefined =>
  [...host.querySelectorAll('a')].find((a) => a.textContent === text);

describe('the manager login page, /{slug}', () => {
  it('asks for a username and password, and has Staff Login top right opening /{slug}/pos -- no ?to=pos', async () => {
    serve({});
    await manager();
    expect(host.querySelector('label[for="email"]')?.textContent).toBe('Username');
    expect(link('Staff Login')?.getAttribute('href')).toBe('/cafe/pos');
    // Top right: in the header row beside the restaurant's name, before the form's fields.
    const header = link('Staff Login')!.parentElement!;
    expect(header.textContent).toContain('Cafe');
    expect(header.compareDocumentPosition(host.querySelector('input')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.innerHTML).not.toContain('to=pos');
  });

  it('a manager signs in to the manager screens; the POS is not touched', async () => {
    serve({ '/api/auth/cafe/login': { status: 200, body: { accessToken: 'office', refreshToken: 'r', lands: 'admin' } } });
    const signedIn = vi.fn();
    await manager(signedIn);
    await submit('MEERA');
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['POST /api/auth/cafe/login']);
    expect(bodies[0]).toMatchObject({ login: 'MEERA', audience: 'manager' });
  });

  it('a staff account is refused by the server and pointed to Staff Login; nothing opens', async () => {
    serve({ '/api/auth/cafe/login': { status: 403, body: { error: 'staff_use_pos', retryable: false } } });
    const signedIn = vi.fn();
    const api = await manager(signedIn);
    await submit('ASHA');
    expect(host.textContent).toContain('This is a staff account. Use Staff Login to open the POS.');
    expect(calls).toEqual(['POST /api/auth/cafe/login']);
    expect(signedIn).not.toHaveBeenCalled();
    expect(api.session()).toBeNull();
  });

  it('a wrong username or password says so and opens nothing', async () => {
    serve({ '/api/auth/cafe/login': { status: 401, body: { error: 'authentication_failed', retryable: false } } });
    const signedIn = vi.fn();
    await manager(signedIn);
    await submit('ASHA');
    expect(host.textContent).toContain('That username and password were not accepted.');
    expect(signedIn).not.toHaveBeenCalled();
  });
});

describe('the POS form, /{slug}/pos: the same username-and-password form, on this till', () => {
  it('is the same username and password form, titled for the POS, with a link to the manager screens', async () => {
    serve({});
    await pos();
    expect(host.textContent).toContain('Manager: set up this computer as the till');
    expect([...host.querySelectorAll('input')].map((i) => i.id)).toEqual(['email', 'password']);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(link('Manager screens')?.getAttribute('href')).toBe('/cafe');
    expect(calls).toEqual([]);
  });

  it('staff sign in on the till with username and password, and the till keeps the session', async () => {
    serve({ '/api/auth/cafe/till': TILL });
    const onTill = vi.fn();
    const api = await pos(onTill);
    await submit('ASHA');
    expect(calls).toEqual(['POST /api/auth/cafe/till']);
    expect(bodies[0]).toMatchObject({ login: 'ASHA', password: 'secret-pass-2026' });
    expect(onTill).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: 'cafe', deviceId: 'd1', branchId: 'b1' }),
      expect.objectContaining({ accessToken: 'till', userId: 'u2' }));
    expect(api.session()?.accessToken).toBe('till');
  });

  it('a manager\'s credentials set the till up and open NO session: the server answers the device only', async () => {
    serve({ '/api/auth/cafe/till': { status: 200, body: { tillOnly: true, deviceId: 'd1', branchId: 'b1' } } });
    const onTill = vi.fn();
    const api = await pos(onTill);
    await submit('MEERA');
    expect(onTill).toHaveBeenCalledWith(expect.objectContaining({ tenantSlug: 'cafe', deviceId: 'd1' }), null);
    expect(api.session()).toBeNull();
    expect(api.device()).toMatchObject({ deviceId: 'd1', branchId: 'b1' });
  });

  it('a wrong username or password opens nothing', async () => {
    serve({ '/api/auth/cafe/till': { status: 401, body: { error: 'authentication_failed', retryable: false } } });
    const onTill = vi.fn();
    const api = await pos(onTill);
    await submit('ASHA');
    expect(host.textContent).toContain('That username and password were not accepted.');
    expect(onTill).not.toHaveBeenCalled();
    expect(api.session()).toBeNull();
  });

  it('staff on a computer that is not the till yet are told the manager sets it up', async () => {
    serve({ '/api/auth/cafe/till': { status: 403, body: { error: 'till_not_permitted', retryable: false } } });
    const onTill = vi.fn();
    await pos(onTill);
    await submit('ASHA');
    expect(host.textContent).toContain('This computer is not the restaurant\'s till yet.');
    expect(onTill).not.toHaveBeenCalled();
  });

  it('a manager setting up a till when every till is in use is told so', async () => {
    serve({ '/api/auth/cafe/till': { status: 402, body: { error: 'upgrade_required', retryable: false } } });
    const onTill = vi.fn();
    await pos(onTill);
    await submit('MEERA');
    expect(host.textContent).toContain('Every till this plan allows is in use');
    expect(onTill).not.toHaveBeenCalled();
  });
});
