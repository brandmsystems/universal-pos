import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TenantStaff } from '../src/features/restaurants/platform/TenantStaff.js';
import type { PlatformApi } from '../src/services/platformApi.js';

/**
 * The Sales person's Sign-ins panel: staff are added with a username and a
 * 4-digit till PIN and have no password; the manager's username and password are
 * set here and nowhere else; a staff member's PIN is set and reset here.
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const buttons = (label: string): HTMLButtonElement[] =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent === label);
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const input = (placeholder: string): HTMLInputElement =>
  [...host.querySelectorAll('input')].find((i) => i.placeholder === placeholder)!;
const password = (): HTMLInputElement => [...host.querySelectorAll('input')].find((i) => i.type === 'password')!;

const MANAGER = { userId: 'o', fullName: 'Jacob', staffCode: null, status: 'active', manages: true, hasPassword: true, hasPin: false, access: null, roles: ['owner'] };
const asha = { userId: 'a', fullName: 'Asha', staffCode: 'ASHA', status: 'active', manages: false, hasPassword: false, hasPin: true, access: 'pos', roles: ['cashier', 'waiter'] };

async function openPanel(members: unknown[], used: number, writes: { method: string; path: string; body: unknown }[] = []): Promise<void> {
  const api = {
    get: async () => ({ members, used, limit: 4 }),
    post: async (path: string, body: unknown) => { writes.push({ method: 'POST', path, body }); return {}; },
    patch: async (path: string, body: unknown) => { writes.push({ method: 'PATCH', path, body }); return {}; },
  } as unknown as PlatformApi;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<TenantStaff api={api} tenantId="t1" />); });
  await settle();
}

describe('the Sales person\'s Sign-ins panel', () => {
  it('lists everyone with their username, password and PIN state; a PIN only for staff', async () => {
    await openPanel([MANAGER, asha], 2);
    expect(host.textContent).toContain('2 of 4 restaurant users');
    expect(host.textContent).toContain('Username: ASHA');
    expect(host.textContent).toContain('Username: — not set');
    expect(buttons('Reset PIN')).toHaveLength(1);
    expect(buttons('Set PIN')).toHaveLength(0);
    // Only the manager has a username and password to set; staff have a PIN.
    expect(buttons('Change sign-in')).toHaveLength(1);
    expect(buttons('Set sign-in')).toHaveLength(0);
    // The manager's access and on/off are not the Sales person's: only their sign-in.
    expect(buttons('Edit')).toHaveLength(1);
    expect(buttons('Switch off')).toHaveLength(1);
  });

  it('adds staff with a name, username and 4-digit PIN, and no password; a bad PIN cannot be sent', async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    await openPanel([MANAGER], 1, writes);
    await act(async () => { buttons('Add staff')[0]!.click(); });
    await type(input('Asha'), 'Asha');
    await type(input('ASHA'), 'asha 1');
    expect(input('ASHA').value).toBe('ASHA1');
    const add = buttons('Add staff').at(-1)!;
    expect(add.disabled).toBe(true);
    const secrets = [...host.querySelectorAll('input')].filter((i) => i.type === 'password');
    expect(secrets).toHaveLength(1);
    const pinInput = secrets[0]!;
    await type(pinInput, '59a');
    expect(add.disabled).toBe(true);
    await type(pinInput, '5927');
    expect(add.disabled).toBe(false);
    await act(async () => { add.click(); });
    await settle();
    expect(writes).toEqual([{ method: 'POST', path: '/tenants/t1/staff',
      body: { fullName: 'Asha', username: 'ASHA1', pin: '5927', access: 'pos' } }]);
  });

  it('sets the MANAGER\'s username and password through the same route', async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    await openPanel([MANAGER], 1, writes);
    await act(async () => { buttons('Change sign-in')[0]!.click(); });
    await type(input('ASHA'), 'jacob');
    await type(password(), 'jacob-pass-2026');
    await act(async () => { buttons('Save sign-in')[0]!.click(); });
    await settle();
    expect(writes).toEqual([{ method: 'POST', path: '/tenants/t1/staff/o/credentials',
      body: { username: 'JACOB', password: 'jacob-pass-2026' } }]);
  });

  it('resetting a staff PIN sends only the PIN, to that person', async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    await openPanel([MANAGER, asha], 2, writes);
    await act(async () => { buttons('Reset PIN')[0]!.click(); });
    const pinInput = [...host.querySelectorAll('input')].find((i) => i.type === 'password')!;
    await type(pinInput, '7149');
    await act(async () => { buttons('Set PIN').at(-1)!.click(); });
    await settle();
    expect(writes).toEqual([{ method: 'POST', path: '/tenants/t1/staff/a/pin', body: { pin: '7149' } }]);
  });

  it('at 4 of 4 there is no Add, and switching off sends only the flag', async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    await openPanel([MANAGER, asha, { ...asha, userId: 'b' }, { ...asha, userId: 'c' }], 4, writes);
    expect(buttons('Add staff')[0]!.disabled).toBe(true);
    await act(async () => { buttons('Switch off')[0]!.click(); });
    await settle();
    expect(writes[0]).toEqual({ method: 'POST', path: '/tenants/t1/staff/a/active', body: { active: false } });
  });
});

describe('the panel layout', () => {
  it('opens Edit in its own full-width row under the person -- not inside the Name cell -- and closes on a second tap', async () => {
    const MEMBER = { userId: 'r', fullName: 'Rithesh', staffCode: 'R1', status: 'active', manages: false, hasPassword: false, hasPin: false, access: 'orders', roles: ['waiter'] };
    const api = { get: async () => ({ members: [MEMBER], used: 2, limit: 4 }) } as unknown as PlatformApi;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<TenantStaff api={api} tenantId="t1" />); });
    await settle();
    const edit = buttons('Edit')[0]!;
    await act(async () => { edit.click(); });
    const cell = host.querySelector('input')!.closest('td')!;
    expect(cell.colSpan).toBe(6);
    expect(cell.textContent).toContain('Edit Rithesh');
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { buttons('Edit')[0]!.click(); });
    expect(host.querySelector('input')).toBeNull();
  });
});
