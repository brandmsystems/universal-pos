import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, scopedStore } from '../src/services/storage.js';

/**
 * The staff login takes each restaurant's own colour, from the restaurant's
 * theme (the public lookup's `themeColor`, applied by RestaurantGate as
 * `--color-primary` and friends). Two restaurants, two colours -- and the PIN
 * screen names no colour of its own, so there is nothing restaurant-specific
 * to drift.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

async function openTill(slug: string, name: string, themeColor: string | null, themeColorSecondary: string | null = null): Promise<void> {
  window.history.replaceState(null, '', `/${slug}/pos`);
  vi.stubGlobal('location', { ...window.location, assign: vi.fn(), pathname: `/${slug}/pos`, search: '' });
  scopedStore(createStore(), `pos:${slug}`).set('device.v1',
    { tenantSlug: slug, deviceId: 'd1', branchId: 'b1', fingerprint: 'f'.repeat(20) });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://x').pathname;
    if (path === `/api/public/restaurants/${slug}`) {
      return Response.json({ slug, name, signInAvailable: true, themeColor, themeColorSecondary, logoUrl: null });
    }
    if (path === `/api/public/restaurants/${slug}/till/staff`) {
      return Response.json({ staff: [{ userId: 'u1', fullName: 'Rithesh', hasPin: true }] });
    }
    return Response.json({ rows: [] });
  }));
  const { App } = await import('../src/app/pos/App.js');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const primary = (): string => document.documentElement.style.getPropertyValue('--color-primary');

describe('the staff login wears each restaurant\'s own colours', () => {
  it('a red restaurant and a green one each get their own, on the cards and on the PIN screen', async () => {
    await openTill('kfc', 'KFC', '#e4002b');
    expect(primary()).toBe('#e4002b');
    expect(host.textContent).toContain('KFC');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Rithesh'))!.click(); });
    // The PIN screen's colour is the theme variable, not a value.
    expect(host.querySelector('button.bg-primary')?.textContent).toContain('Sign in');
    act(() => root?.unmount());
    host.remove();
    document.documentElement.removeAttribute('style');

    await openTill('green-bowl', 'Green Bowl', '#1b7f3a');
    expect(primary()).toBe('#1b7f3a');
    expect(host.textContent).toContain('Green Bowl');
  });

  it('a secondary colour, when set, is the tinted surfaces; the primary stays the buttons', async () => {
    await openTill('green-bowl', 'Green Bowl', '#1b7f3a', '#f59e0b');
    const style = document.documentElement.style;
    expect(primary()).toBe('#1b7f3a');
    expect(style.getPropertyValue('--color-brand-secondary')).toBe('#f59e0b');
    expect(style.getPropertyValue('--color-accent')).toContain('#f59e0b');
  });

  it('without a secondary the tints come from the primary, as before', async () => {
    await openTill('kfc', 'KFC', '#e4002b');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('#e4002b');
    expect(document.documentElement.style.getPropertyValue('--color-brand-secondary')).toBe('');
  });

  it('a restaurant with no colour keeps the POS default', async () => {
    await openTill('plain', 'Plain', null);
    expect(primary()).toBe('');
  });

  it('the PIN screen names no colour of its own', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../src/features/auth/pos/PinLogin.tsx'), 'utf8');
    expect(source.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
    expect(source).not.toContain('bg-brand-gradient');
  });
});
