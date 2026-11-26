import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditRestaurantModal } from '../src/features/restaurants/platform/RestaurantModals.js';
import type { PlatformApi } from '../src/services/platformApi.js';
import type { TenantSummary } from '../src/types/restaurant.js';

/**
 * Only a Super Admin may give a restaurant a new address, and the form says
 * what happens to the old one. Everyone else sees the slug read-only.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); });

const TENANT = { tenantId: 't1', slug: 'old-cafe', name: 'Old Cafe', legalName: null, address: null,
  themeColor: null, logoUrl: null, ownerName: null, ownerEmail: null, ownerPhone: null } as unknown as TenantSummary;

function api(): PlatformApi & { post: ReturnType<typeof vi.fn> } {
  return {
    session: () => null, signedIn: () => true, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(),
    get: vi.fn(async () => ({ available: true, problem: null })),
    post: vi.fn(async () => ({ slug: 'new-cafe' })), patch: vi.fn(), del: vi.fn(),
  } as unknown as PlatformApi & { post: ReturnType<typeof vi.fn> };
}

async function render(canRename: boolean, client = api()): Promise<typeof client> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<EditRestaurantModal api={client} tenant={TENANT} canRename={canRename}
      onClose={() => undefined} onSaved={() => undefined} />);
  });
  return client;
}

const slugInput = (): HTMLInputElement =>
  [...document.querySelectorAll('input')].find((i) => i.value === 'old-cafe' || i.value === 'new-cafe' || i.value === 'abc--x')!;

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('changing a restaurant\'s address', () => {
  it('a Super Admin can, and saving calls the rename route', async () => {
    const client = await render(true);
    const input = slugInput();
    expect(input.disabled).toBe(false);
    type(input, 'new-cafe');
    expect(document.body.textContent).toContain('The old one, /old-cafe, keeps working');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!;
    await act(async () => { save.click(); });
    expect(client.post).toHaveBeenCalledWith('/tenants/t1/slug', { slug: 'new-cafe' });
  });

  it('a dirty slug is refused before anything is sent', async () => {
    const client = await render(true);
    type(slugInput(), 'abc--x');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!;
    expect(save.disabled).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('anyone else sees it read-only', async () => {
    await render(false);
    expect(slugInput().disabled).toBe(true);
    expect(document.body.textContent).toContain('Only a Super Admin can change it');
  });
});
