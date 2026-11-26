import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';
import {
  androidSteps, iphoneSteps, isInstalledApp, phoneKind, posInstallUrl, posManifestPath, usableAsAppIcon,
  wantsInstallHelp, withoutInstallParam,
} from '../src/lib/posApp.js';
import {
  installState, linkPosManifest, promptInstall, registerPosWorker, resetInstallPromptForTests, setPosAppIdentity,
  watchInstallPrompt,
} from '../src/services/posApp.js';
import { InstallPosApp, qrPath } from '../src/features/dashboard/admin/InstallPosApp.js';
import type { Api } from '../src/services/api.js';

/**
 * The installable POS app: each restaurant's home-screen icon opens that
 * restaurant's `/{slug}/pos` and nothing else; the service worker caches
 * nothing; nginx serves the worker, icons and manifest; the manager's card
 * shows the link, QR code and the plan's till count; and the POS's own install
 * help appears only for the install link, never inside the installed app.
 * The manifest itself is the API's (apps/api tests/platform/posAppManifest and
 * tests/http/staffAndBranding).
 */

const WEB = path.resolve(import.meta.dirname, '..');

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { resetInstallPromptForTests(); });
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  localStorage.clear();
  document.head.querySelectorAll('link[rel="manifest"], link[rel="apple-touch-icon"], meta[name="apple-mobile-web-app-title"]')
    .forEach((element) => element.remove());
  window.history.replaceState(null, '', '/');
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/* ----------------------------------------------------------------- lib ------ */

describe('the install link and the address an icon opens', () => {
  it('the link is the restaurant POS with the install query; the manifest is the restaurant own', () => {
    expect(posInstallUrl('https://katkitchen.example', 'kfc')).toBe('https://katkitchen.example/kfc/pos?install=1');
    expect(posManifestPath('kfc')).toBe('/api/public/restaurants/kfc/manifest');
    expect(posManifestPath('green-bowl')).toBe('/api/public/restaurants/green-bowl/manifest');
  });

  it('only ?install=1 asks for the help, and removing it keeps everything else of the address', () => {
    expect(wantsInstallHelp('?install=1')).toBe(true);
    expect(wantsInstallHelp('')).toBe(false);
    expect(wantsInstallHelp('?install=0')).toBe(false);
    expect(withoutInstallParam('https://x.example/kfc/pos?install=1')).toBe('/kfc/pos');
    expect(withoutInstallParam('https://x.example/kfc/pos?a=b&install=1#billing')).toBe('/kfc/pos?a=b#billing');
  });

  it('puts the right phone first; an iPad that reports a Mac counts with the iPhone', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1';
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15';
    expect(phoneKind(android, 5)).toBe('android');
    expect(phoneKind(iphone, 5)).toBe('iphone');
    expect(phoneKind(mac, 5)).toBe('iphone');
    expect(phoneKind(mac, 0)).toBe('other');
    expect(phoneKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0', 0)).toBe('other');
  });

  it('knows the installed app from a browser tab, on Android and on an iPhone', () => {
    const media = (standalone: boolean) => ((query: string) => ({ matches: standalone && query === '(display-mode: standalone)' })) as never;
    expect(isInstalledApp({ matchMedia: media(true), navigator: {} as Navigator })).toBe(true);
    expect(isInstalledApp({ matchMedia: media(false), navigator: { standalone: true } as never })).toBe(true);
    expect(isInstalledApp({ matchMedia: media(false), navigator: {} as Navigator })).toBe(false);
    expect(isInstalledApp({ matchMedia: undefined as never, navigator: {} as Navigator })).toBe(false);
  });

  it('a logo is the iPhone icon only when square and at least 180 px', () => {
    expect(usableAsAppIcon(512, 512)).toBe(true);
    expect(usableAsAppIcon(180, 180)).toBe(true);
    expect(usableAsAppIcon(179, 179)).toBe(false);
    expect(usableAsAppIcon(600, 300)).toBe(false);
  });

  it('the steps name the app and send an iPhone to set the till up inside the Home Screen app', () => {
    expect(androidSteps('KFC POS').join(' ')).toContain('Install app');
    expect(iphoneSteps('KFC POS').join(' ')).toContain('Add to Home Screen');
    expect(iphoneSteps('KFC POS').at(-1)).toContain('set up the till there');
  });
});

/* ------------------------------------------------------------ services ------ */

describe('the POS document links its own restaurant app', () => {
  it('one manifest link, pointing at the restaurant in the address; a second restaurant replaces it, never adds', () => {
    linkPosManifest('kfc');
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.getAttribute('href'))
      .toBe('/api/public/restaurants/kfc/manifest');
    linkPosManifest('green-bowl');
    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/api/public/restaurants/green-bowl/manifest');
  });

  it('names the iPhone Home Screen icon after the restaurant', () => {
    setPosAppIdentity({ name: 'KFC', logoUrl: null });
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')!.content).toBe('KFC POS');
  });

  it('registers the worker for this restaurant POS only, never from the HTTP cache', async () => {
    vi.stubGlobal('isSecureContext', true);
    const register = vi.fn(async () => ({}));
    expect(await registerPosWorker('kfc', { serviceWorker: { register } } as never)).toBe(true);
    expect(register).toHaveBeenCalledWith('/pos-sw.js', { scope: '/kfc/pos', updateViaCache: 'none' });
  });

  it('a browser without workers, a page off https, or a refused registration leaves the POS working as a page', async () => {
    vi.stubGlobal('isSecureContext', true);
    expect(await registerPosWorker('kfc', {} as Navigator)).toBe(false);
    expect(await registerPosWorker('kfc', { serviceWorker: { register: vi.fn(async () => { throw new Error('denied'); }) } } as never)).toBe(false);
    vi.stubGlobal('isSecureContext', false);
    const register = vi.fn(async () => ({}));
    expect(await registerPosWorker('kfc', { serviceWorker: { register } } as never)).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('holds the browser install prompt for its own button, and knows when the app was installed', async () => {
    watchInstallPrompt({ hold: true });
    const prompt = vi.fn(async () => undefined);
    const offered = Object.assign(new Event('beforeinstallprompt', { cancelable: true }),
      { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) });
    window.dispatchEvent(offered);
    expect(offered.defaultPrevented).toBe(true);
    expect(installState()).toEqual({ canPrompt: true, installed: false });
    expect(await promptInstall()).toBe('accepted');
    expect(prompt).toHaveBeenCalledOnce();
    // A prompt is spent once shown.
    expect(await promptInstall()).toBe('unavailable');
    window.dispatchEvent(new Event('appinstalled'));
    expect(installState()).toEqual({ canPrompt: false, installed: true });
  });

  it('a plain POS visit leaves the browser its own install bar', () => {
    watchInstallPrompt({ hold: false });
    const offered = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(), userChoice: new Promise(() => {}) });
    window.dispatchEvent(offered);
    expect(offered.defaultPrevented).toBe(false);
  });
});

/* ------------------------------------------------------- service worker ----- */

describe('the service worker caches nothing and answers only page loads', () => {
  const source = readFileSync(path.join(WEB, 'public/pos-sw.js'), 'utf8');

  function loadWorker(network: () => Promise<Response>) {
    const handlers: Record<string, (event: unknown) => void> = {};
    const deleted: string[] = [];
    const claim = vi.fn(async () => undefined);
    vm.runInNewContext(source, {
      self: { addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; }, skipWaiting: vi.fn(), clients: { claim } },
      caches: { keys: async () => ['left-over'], delete: async (key: string) => { deleted.push(key); return true; } },
      fetch: vi.fn(network),
      Response,
    });
    const fetchEvent = (mode: string) => {
      let answered: Promise<Response> | null = null;
      handlers['fetch']!({ request: { mode, url: 'https://x.example/kfc/pos' }, respondWith: (r: Promise<Response>) => { answered = r; } });
      return answered as Promise<Response> | null;
    };
    return { handlers, deleted, claim, fetchEvent };
  }

  it('never writes a cache: no open, put, match or addAll anywhere in it', () => {
    expect(source).not.toMatch(/caches\.open|\.put\(|\.match\(|addAll/);
  });

  it('the API, scripts and images go to the network untouched', () => {
    const worker = loadWorker(async () => new Response('x'));
    for (const mode of ['cors', 'same-origin', 'no-cors']) expect(worker.fetchEvent(mode)).toBeNull();
  });

  it('a page load online is the network answer itself', async () => {
    const page = new Response('<html>the POS</html>', { status: 200 });
    const answered = await loadWorker(async () => page).fetchEvent('navigate');
    expect(answered).toBe(page);
  });

  it('a page load offline says there is no connection, and is never stored', async () => {
    const answered = await loadWorker(async () => { throw new TypeError('Failed to fetch'); }).fetchEvent('navigate');
    expect(answered!.status).toBe(200);
    expect(answered!.headers.get('cache-control')).toBe('no-store');
    expect(await answered!.text()).toContain('No connection');
  });

  it('on activation it clears anything cached for it and takes over open POS pages', async () => {
    const worker = loadWorker(async () => new Response('x'));
    let done: Promise<unknown> | null = null;
    worker.handlers['activate']!({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(worker.deleted).toEqual(['left-over']);
    expect(worker.claim).toHaveBeenCalledOnce();
  });
});

/* ---------------------------------------------------------------- nginx ----- */

describe('production nginx serves the app, its worker, icons and manifest', () => {
  const conf = readFileSync(path.resolve(WEB, '../../deploy/web.nginx.conf'), 'utf8');
  // A regex location is quoted (its pattern has braces of its own); a prefix one is a bare word.
  const locations = [...conf.matchAll(/location\s+(\^~\s+|~\s+)?(?:"([^"]+)"|(\S+))\s*\{([^}]*)/g)]
    .map((m) => ({ kind: (m[1] ?? '').trim(), pattern: (m[2] ?? m[3])!, body: m[4]! }));

  /** nginx's choice: the longest prefix; `^~` stops there, else the first matching regex wins. */
  function route(uri: string) {
    const prefix = locations.filter((l) => l.kind !== '~' && uri.startsWith(l.pattern))
      .sort((a, b) => b.pattern.length - a.pattern.length)[0];
    if (prefix?.kind === '^~') return prefix;
    return locations.find((l) => l.kind === '~' && new RegExp(l.pattern).test(uri)) ?? prefix!;
  }

  it('reads the real config: at least the seven locations it has', () => {
    expect(locations.length).toBeGreaterThanOrEqual(7);
    expect(locations.map((l) => l.pattern)).toEqual(expect.arrayContaining(['/', '/assets/', '/api/']));
  });

  it.each(['/kfc/pos', '/kfc/pos/', '/green-bowl/pos'])('%s, the app icon start address, is the POS document, re-checked every load', (uri) => {
    const where = route(uri);
    expect(where.body).toContain('try_files /index.html');
    expect(where.body).toContain('no-cache');
  });

  it('a restaurant page and a section stay the manager screens', () => {
    expect(route('/kfc').body).toContain('/admin.html');
    expect(route('/kfc/menu').body).toContain('/admin.html');
  });

  it.each(['/pos-sw.js', '/app-icons/pos-icon-192.png', '/app-icons/pos-icon-512.png', '/app-icons/pos-icon-maskable-512.png', '/app-icons/pos-icon-apple-180.png'])(
    '%s is a file the build ships, served as itself and re-checked (so a new worker reaches installed apps)', (uri) => {
      expect(existsSync(path.join(WEB, 'public', uri))).toBe(true);
      const where = route(uri);
      expect(where.pattern).toBe('/');
      expect(where.body).toMatch(/try_files \$uri/);
      expect(where.body).toContain('no-cache');
    });

  it('the manifest is the API answer, through the same-origin proxy', () => {
    expect(route('/api/public/restaurants/kfc/manifest')).toMatchObject({ kind: '^~', pattern: '/api/' });
  });

  it('the POS document links the iPhone icon and Home Screen settings', () => {
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="apple-touch-icon" href="/app-icons/pos-icon-apple-180.png" />');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    // The manager screens are not an app: installing from there would open the dashboard.
    expect(readFileSync(path.join(WEB, 'admin.html'), 'utf8')).not.toMatch(/rel="manifest"|apple-touch-icon/);
  });
});

/* ------------------------------------------------------------ the POS ------- */

async function openPos(slug: string, name: string, search = ''): Promise<void> {
  window.history.replaceState(null, '', `/${slug}/pos${search}`);
  scopedStore(createStore(), `pos:${slug}`).set('device.v1',
    { tenantSlug: slug, deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const where = new URL(String(input), 'http://x').pathname;
    if (where === `/api/public/restaurants/${slug}`) {
      return Response.json({ slug, name, signInAvailable: true, themeColor: null, themeColorSecondary: null, logoUrl: null });
    }
    if (where === `/api/public/restaurants/${slug}/till/staff`) {
      return Response.json({ staff: [{ userId: 'u1', fullName: 'Rithesh', hasPin: true }] });
    }
    return Response.json({ rows: [] });
  }));
  const { App } = await import('../src/app/pos/App.js');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await settle();
}

const dialog = (): HTMLElement | null => host!.querySelector('[role="dialog"]');

describe('the POS opened from the install link', () => {
  it('shows how to install this restaurant app over the till, and Continue leaves the plain POS', async () => {
    await openPos('kfc', 'KFC', '?install=1');
    expect(dialog()?.textContent).toContain('Install KFC POS');
    expect(dialog()?.textContent).toContain('Add to Home Screen');
    // The till behind it is unchanged: the staff cards.
    expect(host!.textContent).toContain('Rithesh');
    await act(async () => {
      [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Continue in the browser')!.click();
    });
    expect(dialog()).toBeNull();
    expect(window.location.pathname + window.location.search).toBe('/kfc/pos');
    expect(host!.textContent).toContain('Rithesh');
  });

  it('a plain visit, and the installed app (whose start address has no query), never show it', async () => {
    await openPos('kfc', 'KFC');
    expect(dialog()).toBeNull();
    act(() => root?.unmount());
    host!.remove();

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)', addEventListener() {}, removeEventListener() {} }));
    await openPos('kfc', 'KFC', '?install=1');
    expect(dialog()).toBeNull();
  });

  it('offers the browser install as one tap when the browser has it, and says when it is done', async () => {
    watchInstallPrompt({ hold: true });
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }),
      { prompt: vi.fn(async () => undefined), userChoice: Promise.resolve({ outcome: 'accepted' as const }) }));
    await openPos('kfc', 'KFC', '?install=1');
    const install = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.includes('Install app'))!;
    await act(async () => { install.click(); });
    await act(async () => { window.dispatchEvent(new Event('appinstalled')); });
    expect(dialog()!.textContent).toContain('Installed. Open KFC POS from the Home Screen.');
  });

  it('each restaurant names its own Home Screen app; one never shows the other', async () => {
    await openPos('kfc', 'KFC', '?install=1');
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')!.content).toBe('KFC POS');
    act(() => root?.unmount());
    host!.remove();
    await openPos('green-bowl', 'Green Bowl', '?install=1');
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')!.content).toBe('Green Bowl POS');
    expect(dialog()!.textContent).toContain('Install Green Bowl POS');
    expect(dialog()!.textContent).not.toContain('KFC');
  });
});

/* ----------------------------------------------------- the manager card ----- */

function fakeApi(answer: () => Promise<unknown>): Api {
  return { get: vi.fn(answer) } as unknown as Api;
}

async function openCard(api: Api, logoUrl: string | null = null): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<InstallPosApp api={api} slug="kfc" restaurantName="KFC" logoUrl={logoUrl} origin="https://pos.example" />);
  });
  await settle();
}

describe('Install POS App on the manager dashboard', () => {
  const tills = (used: number) => async () => ({ entitlements: { devices: 2 }, usage: { devices: used } });

  it('shows the restaurant, its install link as a button and a QR code drawn on this device', async () => {
    await openCard(fakeApi(tills(0)), '/api/public/restaurants/kfc/logo?v=abc');
    expect(host!.textContent).toContain('Install POS App');
    expect(host!.textContent).toContain('KFC');
    const button = [...host!.querySelectorAll('a')].find((a) => a.textContent?.includes('Install POS App'))!;
    expect(button.getAttribute('href')).toBe('https://pos.example/kfc/pos?install=1');
    const qr = host!.querySelector('svg[role="img"]')!;
    expect(qr.getAttribute('aria-label')).toBe('QR code: https://pos.example/kfc/pos?install=1');
    expect(qr.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(100);
    expect(host!.querySelector('img[src="/api/public/restaurants/kfc/logo?v=abc"]')).not.toBeNull();
    expect(host!.textContent).toContain('Android · Chrome');
    expect(host!.textContent).toContain('iPhone · Safari');
  });

  it('says how many tills are set up out of the plan limit', async () => {
    await openCard(fakeApi(tills(1)));
    expect(host!.querySelector('[role="status"]')!.textContent).toBe('Tills set up: 1 of 2. 1 more phone or computer can be set up as a till.');
  });

  it('at the limit a third phone may install, and is told it cannot become a till', async () => {
    await openCard(fakeApi(tills(2)));
    const status = host!.querySelector('[role="status"]')!.textContent!;
    expect(status).toContain('Tills set up: 2 of 2.');
    expect(status).toContain('cannot be set up as a till until one is taken out of use');
  });

  it('when the till count cannot be read, it says nothing about it rather than guess', async () => {
    await openCard(fakeApi(async () => { throw new Error('403'); }));
    expect(host!.querySelector('[role="status"]')).toBeNull();
    expect(host!.textContent).toContain('Install POS App');
  });

  it('Copy link copies the install link', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await openCard(fakeApi(tills(0)));
    await act(async () => { [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Copy link')!.click(); });
    expect(writeText).toHaveBeenCalledWith('https://pos.example/kfc/pos?install=1');
    expect(host!.textContent).toContain('Link copied');
  });

  it('draws one square per dark module, inside a four-module quiet zone', () => {
    expect(qrPath(2, (r, c) => r === c)).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
    expect(qrPath(3, () => false)).toBe('');
  });
});
