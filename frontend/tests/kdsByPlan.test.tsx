import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewRestaurantModal } from '../src/features/restaurants/platform/NewRestaurantModal.js';
import type { PlatformApi } from '../src/services/platformApi.js';
import type { PlanOption } from '../src/types/restaurant.js';

/**
 * The Sales Person is never asked about a kitchen screen -- the plan they pick
 * decides. (The kitchen screen and the KOT ticket panel were removed with
 * Basic-only, 0077; the kitchen gets its printed ticket.)
 */


let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}


describe('Create restaurant', () => {
  const option = (key: string, name: string, priceMinor: number): PlanOption => ({
    planVersionId: `v-${key}`, planKey: key, planName: name, priceMinor, currency: 'INR',
    billingPeriod: 'monthly', label: `${name} — ₹${priceMinor / 100} / month`,
  });
  const PLANS: readonly PlanOption[] = [
    option('basic', 'Basic', 99900), option('standard', 'Standard', 179900), option('pro', 'Pro', 249900),
  ];

  async function choosePlan(id: string): Promise<void> {
    const select = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === id)) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('offers the three plans and never asks about a kitchen screen or branches', async () => {
    const api = { get: async () => ({ available: true, problem: null }) } as unknown as PlatformApi;
    await mount(<NewRestaurantModal api={api} open planOptions={PLANS} onClose={() => undefined} onCreated={() => undefined} />);
    // The wizard shows the plan on its own step.
    const stepButton = [...document.querySelectorAll('nav[aria-label="Steps"] button')]
      .find((b) => /Plan and subscription/.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { stepButton.click(); });
    const plan = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'v-pro'))!;
    expect([...plan.options].map((o) => o.value).filter((v) => v !== '')).toEqual(['v-basic', 'v-standard', 'v-pro']);
    for (const p of PLANS) {
      await choosePlan(p.planVersionId);
      const groups = [...document.querySelectorAll('[role="radiogroup"]')].map((g) => g.getAttribute('aria-label'));
      expect(groups, 'the only choice besides the plan is how the subscription starts')
        .toEqual(['How the subscription starts']);
      expect(document.body.textContent).not.toMatch(/KDS Required|kitchen screen|additional branch/i);
    }
  });
});
