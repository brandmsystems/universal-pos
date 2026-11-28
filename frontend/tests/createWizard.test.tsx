import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { defaultModulesFor } from '@universalpos/shared';
import { NewRestaurantModal } from '../src/features/restaurants/platform/NewRestaurantModal.js';
import type { PlatformApi } from '../src/services/platformApi.js';

/**
 * The create wizard (Phase 1): the kind of business decides which modules start ticked,
 * the till is always on, and a step with a missing field will not advance.
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

async function mount(): Promise<void> {
  const api = { get: async () => ({ available: true, problem: null, countries: [], currencies: [], defaultCountry: 'IN' }) } as unknown as PlatformApi;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<NewRestaurantModal api={api} open planOptions={[]} onClose={() => undefined} onCreated={() => undefined} />);
  });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const stepButton = (title: RegExp): HTMLButtonElement =>
  [...document.querySelectorAll('nav[aria-label="Steps"] button')].find((b) => title.test(b.textContent ?? '')) as HTMLButtonElement;

async function chooseType(key: string): Promise<void> {
  const select = [...document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === key)) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, key);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const boxes = (): Map<string, HTMLInputElement> => new Map(
  [...document.querySelectorAll('input[type="checkbox"]')].map((box) => [
    (box.parentElement!.textContent ?? '').replace(' (always on)', '').trim().toLowerCase(), box as HTMLInputElement,
  ]));

describe('Create wizard', () => {
  it('has five steps, and the first will not advance with required fields empty', async () => {
    await mount();
    const steps = [...document.querySelectorAll('nav[aria-label="Steps"] button')];
    expect(steps).toHaveLength(5);
    const next = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Next') as HTMLButtonElement;
    await act(async () => { next.click(); });
    expect(steps[0]!.getAttribute('aria-current'), 'still on step 1').toBe('step');
    expect(document.body.textContent).toMatch(/Required/);
  });

  it('a retail business starts with its own modules, the till locked on and no kitchen', async () => {
    await mount();
    await act(async () => { stepButton(/Kind of business/).click(); });
    await chooseType('general_retail');
    const held = boxes();
    const retail = defaultModulesFor('general_retail');
    expect(retail.length).toBeGreaterThan(2);
    expect(held.get('pos')!.checked).toBe(true);
    expect(held.get('pos')!.disabled).toBe(true);
    expect(held.get('products')!.checked).toBe(true);
    expect(held.get('kitchen')!.checked).toBe(false);
    // A module of another kind of business is offered, unticked.
    await act(async () => { held.get('kitchen')!.click(); });
    expect(boxes().get('kitchen')!.checked).toBe(true);
    // Changing the kind resets to that kind's own modules.
    await chooseType('restaurant');
    expect(boxes().get('kitchen')!.checked).toBe(true);
    expect(boxes().get('products')?.checked ?? false).toBe(false);
  });
});
