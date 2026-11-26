import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore, trackDurability, type Durability } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { createQueue } from '../src/services/queue.js';
import { createPump } from '../src/services/pump.js';
import { createConsensusKeys } from '../src/lib/consensus.js';
import { Shift } from '../src/features/orders/pos/Shift.js';

/**
 * "This tablet has not been granted persistent storage" is the browser's answer,
 * and it arrives AFTER the first render. The till asks (persisted() first, then
 * persist()), records the answer, announces it so the warning follows it, lets a
 * tap ask again, and handles a refusal or a missing API without throwing. The
 * answer changes what the till SAYS; nothing it keeps is ever touched.
 */

const flush = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

describe('asking the browser to keep the till\'s storage', () => {
  it('a till already granted on an earlier visit is persistent without asking again', async () => {
    const persist = vi.fn(async () => true);
    const d = trackDurability(true, { persisted: async () => true, persist });
    await flush();
    expect(d.current()).toBe('persistent');
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks when not yet granted, records a grant and announces it', async () => {
    const heard: Durability[] = [];
    const d = trackDurability(true, { persisted: async () => false, persist: async () => true });
    d.onChange((x) => heard.push(x));
    await flush();
    expect(d.current()).toBe('persistent');
    expect(heard).toEqual(['persistent']);
  });

  it('a refusal leaves best-effort; asking again from a tap can still be granted', async () => {
    let grant = false;
    const heard: Durability[] = [];
    const d = trackDurability(true, { persisted: async () => false, persist: async () => grant });
    d.onChange((x) => heard.push(x));
    await flush();
    expect(d.current()).toBe('best-effort');
    expect(heard).toEqual([]);
    grant = true;
    expect(await d.ask()).toBe('persistent');
    expect(heard).toEqual(['persistent']);
  });

  it('an API that throws, or is missing, is handled: best-effort, no throw', async () => {
    const throwing = trackDurability(true, { persisted: async () => { throw new Error('policy'); }, persist: async () => true });
    await expect(throwing.ask()).resolves.toBe('best-effort');
    const missing = trackDurability(true, null);
    await expect(missing.ask()).resolves.toBe('best-effort');
    const noPersist = trackDurability(true, { persisted: async () => false } as never);
    await expect(noPersist.ask()).resolves.toBe('best-effort');
  });

  it('no usable storage at all is unavailable, and asking does not pretend otherwise', async () => {
    const persist = vi.fn(async () => true);
    const d = trackDurability(false, { persisted: async () => true, persist });
    await expect(d.ask()).resolves.toBe('unavailable');
    expect(persist).not.toHaveBeenCalled();
  });

  it('the answer changes nothing the till keeps: a queued write is still queued', async () => {
    const store = scopedStore(createStore(), 'pos:durability');
    const queue = createQueue(store);
    queue.enqueue({ kind: 'line.add', method: 'POST', path: '/pos/order/x/line', body: { menuItemId: 'm', quantity: 1 }, leaseToken: null } as never);
    const before = queue.snapshot().depth;
    await store.requestPersistence();
    expect(createQueue(store).snapshot().depth).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
});

describe('the warning on the till', () => {
  let root: Root | null = null;
  let host: HTMLElement;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function render(durability: Durability, onRequestPersistence?: () => Promise<Durability>): Promise<(next: Durability) => Promise<void>> {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = String(input);
      if (path.includes('/pos/menu')) return Response.json({ menu: [] });
      if (path.endsWith('/me')) {
        return Response.json({ kind: 'staff', userId: 'u1', fullName: 'Asha', employeeCode: null, email: null, roles: [],
          branchName: 'Main', deviceName: 'Counter', screens: { kot: true, billing: true, kitchen: false } });
      }
      return Response.json({ kot: true, rows: [] });
    }));
    const store = scopedStore(createStore(), 'pos:spice');
    const api = createApi(store);
    const queue = createQueue(store);
    const leases = createLeases(store, api);
    const billingLeases = createLeases(scopedStore(store, 'billing'), api, 'billing');
    const pump = createPump({ api, queue, leases });
    const device = { tenantSlug: 'spice', deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) };
    const session = { accessToken: 't', refreshToken: 'r', tenantSlug: 'spice', branchId: 'b1', userId: 'u1' };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const draw = async (d: Durability): Promise<void> => {
      await act(async () => {
        root!.render(<Shift api={api} device={device} session={session} leases={leases} billingLeases={billingLeases}
          queue={queue} queueState={queue.snapshot()} pump={pump} keys={createConsensusKeys()} durability={d}
          {...(onRequestPersistence ? { onRequestPersistence } : {})} onSignOut={() => undefined} />);
      });
    };
    await draw(durability);
    return draw;
  }
  const askButton = (): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((b) => /Keep this till|Ask again/.test(b.textContent ?? ''));

  it('says so when storage is not persistent, offers to ask, and goes away once granted', async () => {
    const ask = vi.fn(async (): Promise<Durability> => 'persistent');
    const redraw = await render('best-effort', ask);
    expect(host.textContent).toContain('has not been granted persistent storage');
    await act(async () => { askButton()!.click(); });
    expect(ask).toHaveBeenCalledTimes(1);
    // The parent hears the store's announcement and redraws with the new answer.
    await redraw('persistent');
    expect(host.textContent).not.toContain('persistent storage');
    expect(askButton()).toBeUndefined();
  });

  it('a refused request says what the browser wants, and can ask again', async () => {
    const ask = vi.fn(async (): Promise<Durability> => 'best-effort');
    await render('best-effort', ask);
    await act(async () => { askButton()!.click(); });
    expect(host.textContent).toContain('did not agree to keep this till');
    expect(host.textContent).toContain('Unsent work is still kept');
    expect(askButton()!.textContent).toBe('Ask again');
  });

  it('no storage at all: the hard warning, and no button that cannot help', async () => {
    await render('unavailable', vi.fn(async (): Promise<Durability> => 'unavailable'));
    expect(host.textContent).toContain('not letting the tablet store anything');
    expect(askButton()).toBeUndefined();
  });

  it('persistent from the start: no warning at all', async () => {
    await render('persistent', vi.fn(async (): Promise<Durability> => 'persistent'));
    expect(host.textContent).not.toContain('persistent storage');
  });
});
