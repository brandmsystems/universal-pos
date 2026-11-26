import type { Store } from './storage.js';

/**
 * The outbound queue.
 *
 * ###########################################################################
 * THE IDEMPOTENCY KEY IS MINTED HERE, WHEN THE INTENT IS ENQUEUED.
 *
 * Never in a tap handler. A key minted in `onClick` is a NEW key on the second
 * tap: the waiter taps Fire, the spinner does not move because the wifi is bad,
 * they tap again, and the kitchen gets two tickets and the stock ledger two
 * deductions. The header exists precisely to make that harmless, and minting the
 * key in the handler disarms it while appearing to satisfy the requirement.
 *
 * The lease token is attached from the lease the operation was ENQUEUED under,
 * not the current one. An operation queued under a lease that has since been
 * force-released must arrive carrying the old token so the server can quarantine
 * it; attaching the current token would launder a stranded device's writes into
 * apparently valid ones, defeating the only mechanism that makes force release
 * survivable.
 * ###########################################################################
 */

export interface QueuedOperation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string | null;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body: unknown;
  readonly enqueuedAt: number;
  readonly attempts: number;
}

/**
 * A cap, because storage pressure is real on a PWA. Approaching it is a VISIBLE
 * state, not a silent eviction: a tablet quietly holding a whole service's
 * orders is the failure the offline-window display exists to prevent, arriving
 * by a different route.
 */
export const QUEUE_CAP = 500;
export const QUEUE_WARN_AT = 400;

const KEY = 'queue.v1';
const REJECTED_KEY = 'queue.rejected.v1';

/**
 * An operation the server refused permanently.
 *
 * It is NOT deleted. A queued write that vanishes is indistinguishable from one
 * that succeeded, and the whole reason the server quarantines a batch rather
 * than dropping it is that somebody has to be able to see what did not happen.
 * The client owes the same: refused work moves here, stays here, and the shift
 * screen shows the count.
 */
export interface RejectedOperation extends QueuedOperation {
  readonly rejectedAt: number;
  readonly code: string;
  readonly detail: string;
}

export interface QueueSnapshot {
  readonly depth: number;
  readonly oldestAgeMs: number | null;
  readonly nearCap: boolean;
  readonly full: boolean;
  readonly rejected: number;
}

export class QueueFullError extends Error {
  readonly code = 'queue_full';
  constructor() {
    super(
      `the outbound queue is at its cap of ${QUEUE_CAP} operations. Nothing further ` +
        'can be accepted offline without risking silent loss.',
    );
    this.name = 'QueueFullError';
  }
}

export function createQueue(store: Store, mintKey: () => string = defaultKey) {
  let items: QueuedOperation[] = store.get<QueuedOperation[]>(KEY) ?? [];
  let refused: RejectedOperation[] = store.get<RejectedOperation[]>(REJECTED_KEY) ?? [];
  const listeners = new Set<(snapshot: QueueSnapshot) => void>();

  const persist = (): void => {
    store.set(KEY, items);
    store.set(REJECTED_KEY, refused);
    const snapshot = describe();
    for (const listener of listeners) listener(snapshot);
  };

  function describe(): QueueSnapshot {
    const oldest = items[0];
    return {
      depth: items.length,
      oldestAgeMs: oldest ? Date.now() - oldest.enqueuedAt : null,
      nearCap: items.length >= QUEUE_WARN_AT,
      full: items.length >= QUEUE_CAP,
      rejected: refused.length,
    };
  }

  return {
    snapshot: describe,

    onChange(listener: (snapshot: QueueSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The one entry point. Components describe an INTENT; they never reach the
     * fetch layer, and they never see a key.
     */
    enqueue(intent: {
      method: QueuedOperation['method'];
      path: string;
      body: unknown;
      leaseToken: string | null;
    }): QueuedOperation {
      if (items.length >= QUEUE_CAP) throw new QueueFullError();
      const operation: QueuedOperation = {
        id: mintKey(),
        idempotencyKey: mintKey(),
        leaseToken: intent.leaseToken,
        method: intent.method,
        path: intent.path,
        body: intent.body,
        enqueuedAt: Date.now(),
        attempts: 0,
      };
      items = [...items, operation];
      persist();
      return operation;
    },

    peek(): QueuedOperation | null {
      return items[0] ?? null;
    },

    /** Acknowledged by a response. The key retires with the operation. */
    settle(id: string): void {
      items = items.filter((item) => item.id !== id);
      persist();
    },

    /** A retry keeps the SAME key. That is the entire point of the queue. */
    retried(id: string): void {
      items = items.map((item) =>
        item.id === id ? { ...item, attempts: item.attempts + 1 } : item,
      );
      persist();
    },

    all(): readonly QueuedOperation[] {
      return items;
    },

    /**
     * Permanently refused. Moved aside rather than deleted, and moved aside
     * rather than left at the head: a dead operation that blocks the queue takes
     * the whole shift's work down with it.
     */
    reject(id: string, code: string, detail: string): void {
      const operation = items.find((item) => item.id === id);
      items = items.filter((item) => item.id !== id);
      if (operation) {
        refused = [...refused, { ...operation, rejectedAt: Date.now(), code, detail }];
      }
      persist();
    },

    rejected(): readonly RejectedOperation[] {
      return refused;
    },

    /** Only after a human has been shown them. */
    clearRejected(): void {
      refused = [];
      persist();
    },
  };
}

function defaultKey(): string {
  return crypto.randomUUID();
}

export type Queue = ReturnType<typeof createQueue>;
