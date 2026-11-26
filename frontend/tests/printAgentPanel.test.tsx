import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { PrintAgentPanel } from '../src/features/settings/admin/setup/PrintAgentPanel.js';

/**
 * Setup -> Printers -> Print agent: set one up (the token is shown once, as an
 * agent.json naming this site), see what it last saw of each Wi-Fi or Ethernet
 * printer, and ask it for a test print.
 */

let root: Root | null = null;
let host: HTMLElement;
const calls: { method: string; path: string; body: unknown }[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  calls.length = 0;
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

function serve(state: { agents: unknown[]; printers: unknown[] }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname.endsWith('/admin/print-agents') && method === 'POST') {
      state.agents.push({ id: 'a1', name: 'Till PC', last_seen_at: null, agent_version: null, online: false });
      return Response.json({ id: 'a1', name: 'Till PC', branchId: 'b1', token: 'spice-hub.SECRET-TOKEN-VALUE' });
    }
    if (url.pathname.endsWith('/admin/print-agents')) return Response.json({ agents: state.agents, onlineWithinMs: 30000 });
    if (url.pathname.endsWith('/admin/printers')) return Response.json({ rows: state.printers });
    return Response.json({ id: 'p1', requested: true });
  }));
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<PrintAgentPanel api={createApi(createStore())} branchId="b1" />); });
  await settle();
}

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found as HTMLButtonElement;
};

const network = {
  id: 'p1', name: 'Grill printer', connection_kind: 'network', address: '192.168.1.50:9100', status: 'active',
  reach_checked_at: new Date().toISOString(), reachable: false, reach_error: 'ECONNREFUSED',
  test_print_requested_at: null, test_printed_at: null, test_print_error: null,
};

describe('the print agent panel', () => {
  it('sets an agent up at this branch and shows its token once, as agent.json for this site', async () => {
    serve({ agents: [], printers: [] });
    await mount();
    await act(async () => { button('Set up print agent').click(); });
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/t/admin/print-agents', body: { name: 'Till PC' } });
    const config = JSON.parse(host.querySelector('pre')!.textContent!);
    expect(config).toEqual({ server: window.location.origin, token: 'spice-hub.SECRET-TOKEN-VALUE' });
    expect(host.textContent).toContain('shown only once');
    expect(host.querySelector('a[download="universalpos-print-agent.mjs"]')).not.toBeNull();
    await act(async () => { button('Done').click(); });
    expect(host.textContent).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('says when no agent is running, shows what the agent saw, and asks for a test print', async () => {
    serve({ agents: [{ id: 'a1', name: 'Till PC', last_seen_at: '2026-11-11T08:00:00Z', agent_version: '1.0.0', online: false }], printers: [
      network, { ...network, id: 'u1', name: 'Counter USB', connection_kind: 'usb', address: null },
    ] });
    await mount();
    expect(host.textContent).toContain('No print agent is running');
    expect(host.textContent).toContain('Does not answer: ECONNREFUSED');
    expect(host.textContent).not.toContain('Counter USB');
    await act(async () => { button('Test print').click(); });
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/t/admin/printers/p1/test-print']);
  });
});
