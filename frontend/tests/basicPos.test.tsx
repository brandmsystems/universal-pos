import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { PosKdsAccessPage } from '../src/features/access/admin/pos-kds-access/PosKdsAccessPage.js';

/**
 * Basic only: one POS link, no tablet setup codes, a read-only access list
 * (staff are the Sales person's).
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

async function mount(element: React.ReactElement, answers: Record<string, unknown>): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://x').pathname.replace(/^\/api\/t/, '');
    return Response.json(answers[path] ?? { rows: [] });
  }));
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const SETUP_TEXT = 'Generate a code, then open the POS or kitchen link';

describe('the access page', () => {
  const account = {
    userId: 'u1', fullName: 'Asha', email: null, employeeCode: 'ASHA', status: 'active', hasPin: true, hasPassword: false,
    lastSignInAt: null, pendingReset: [], roles: [], kotAccess: true, billingAccess: true, kitchenAccess: false,
  };
  it('one POS link, no setup code, and a read-only list: no reset, no switch-off, no add', async () => {
    await mount(<PosKdsAccessPage api={createApi(createStore())} tenantSlug="cafe" kot />, { '/admin/access': [account] });
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/cafe/pos']);
    expect(host.textContent).not.toContain(SETUP_TEXT);
    expect(host.textContent).toContain('Asha');
    expect(host.textContent).toContain('the Sales person adds staff and changes their passwords.');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((t) => /Reset|Switch|Create|Add/i.test(t))).toBe(false);
  });
});
