import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from '../src/services/storage.js';
import { createApi } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';
import { createQueue } from '../src/services/queue.js';
import { createPump } from '../src/services/pump.js';
import type { Board, BoardLine, BoardMenuItem } from '../src/features/orders/pos/board.js';

/**
 * ###########################################################################
 * THE REAL CLIENT STACK, WITH ONLY `fetch` REPLACED.
 *
 * Store, api, leases, queue and pump are all constructed by their own
 * factories. The only thing stubbed is the network, which is the one boundary
 * a render test genuinely cannot cross.
 *
 * The alternative -- hand-written fakes for five collaborators -- would be a
 * second implementation of the client's own plumbing, and a gate asserting that
 * the fakes behave as the gate's author imagined. That is the mistake CLAUDE.md
 * records as "when a synthetic probe agrees with the code and disagrees with
 * the real data, the probe inherited the bug": the queue's idempotency keys,
 * the lease's skew correction and the api's offline classification are all real
 * here, so a test cannot pass by agreeing with a fiction.
 * ###########################################################################
 */

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const ORDER_ID = '22222222-2222-4222-8222-222222222222';
export const LEASE_TOKEN = '33333333-3333-4333-8333-333333333333';

export const MENU: readonly BoardMenuItem[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Paneer Tikka',
    price_minor: '32000',
    category_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    orderable: true,
    unavailable_message: null,
    unavailable_reason: null,
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Dal Makhani',
    price_minor: '28000',
    category_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    orderable: true,
    unavailable_message: null,
    unavailable_reason: null,
  },
];

/** A line the server has acknowledged: it has an id and a real total. */
export const COMMITTED_LINE: BoardLine = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  order_id: ORDER_ID,
  kind: 'item',
  parent_line_id: null,
  display_name: 'Kadai Chicken',
  quantity: 1,
  unit_price_minor: '42000',
  line_total_minor: '42000',
  display_total_minor: null,
  tax_rate_bps: 500,
  fired: true,
  note: null,
  adjusts_line_id: null,
  adjustment_reason_id: null,
  adjustment_reason_name: null,
  adjustment_note: null,
  guest_no: null,
};

export function boardFixture(lines: readonly BoardLine[]): Board {
  const now = new Date();
  return {
    session: {
      id: SESSION_ID,
      version: 4,
      status: 'open',
      guest_count: 2,
      business_date: now.toISOString().slice(0, 10),
      opened_at: now.toISOString(),
    },
    tables: [],
    bills: [],
    lines,
    lease: null,
    menu: MENU,
    menuVersion: '1',
    // The client parses this with parsePgTimestamp, which expects Postgres'
    // `timestamptz::text` rather than ISO 8601 -- see FRONTEND.md 10b.
    serverNow: now.toISOString().replace('T', ' ').replace('Z', '+00'),
    taxOptions: { b2bCaptureEnabled: false },
  };
}

export interface Harness {
  readonly api: ReturnType<typeof createApi>;
  readonly leases: ReturnType<typeof createLeases>;
  readonly queue: ReturnType<typeof createQueue>;
  readonly pump: ReturnType<typeof createPump>;
  readonly store: ReturnType<typeof createStore>;
}

/**
 * Builds the stack and holds the lease, so the pane is writable.
 *
 * The lease is seeded through the store rather than by calling `claim()`,
 * because claiming is a network act and this test is not about the claim path.
 * The SHAPE written here is the lease module's own `Stored`, so a change to it
 * breaks this loudly rather than silently leaving the pane read-only.
 */
export function harness(board: Board): Harness {
  window.localStorage.clear();
  const store = createStore();
  store.set('leases.v1', {
    leases: [{
      sessionId: SESSION_ID,
      token: LEASE_TOKEN,
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    }],
    skewMs: 0,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : String(input);
    if (path.includes('/board')) {
      return new Response(JSON.stringify(board), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Anything else would be a write. The gate never drains the queue, because
    // a drained operation stops being queued and the state under test vanishes.
    return new Response(JSON.stringify({ error: 'not_stubbed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const api = createApi(store);
  const leases = createLeases(store, api);
  const queue = createQueue(store);
  const pump = createPump({ api, queue, leases });
  return { api, leases, queue, pump, store };
}

export async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  // The pane reads the board in an effect; let that settle before asserting.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}
