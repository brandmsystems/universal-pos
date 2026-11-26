import { ApiError, type Api } from './api.js';
import type { Queue } from './queue.js';
import type { Leases } from './lease.js';

/**
 * The thing that actually sends the queue.
 *
 * ###########################################################################
 * WITHOUT THIS, THE QUEUE IS A DRAWER.
 *
 * `createQueue` mints keys, persists intents, caps itself and reports its depth,
 * and every one of those behaviours was correct and tested while nothing in the
 * application ever sent an item. An enqueue that is never drained is worse than
 * a failed write: the tap appeared to work, the depth counter says "1 waiting",
 * and the order does not exist. This module is the caller, and it is registered
 * in App.tsx -- the only place it can be, so there is exactly one pump.
 *
 * STRICTLY SERIAL, STRICTLY FIFO. Two operations in flight can arrive out of
 * order, and `order.line.add` followed by `order.line.edit` reordered is an edit
 * to a line that does not exist yet. The queue is a queue, not a pool.
 * ###########################################################################
 */

const IDLE_MS = 1_500;
/** Backoff for a retryable refusal or an unreachable server. Capped, not infinite. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface PumpState {
  readonly sending: boolean;
  /** When the next attempt is due, if the pump is backing off. */
  readonly nextAttemptAt: number | null;
  readonly consecutiveFailures: number;
}

export function createPump(deps: { api: Api; queue: Queue; leases: Leases }) {
  let stopped = false;
  let failures = 0;
  let nextAttemptAt: number | null = null;
  let sending = false;
  const listeners = new Set<(state: PumpState) => void>();

  function announce(): void {
    const state: PumpState = { sending, nextAttemptAt, consecutiveFailures: failures };
    for (const listener of listeners) listener(state);
  }

  async function sendOne(): Promise<'sent' | 'blocked' | 'empty'> {
    const operation = deps.queue.peek();
    if (!operation) {
      failures = 0;
      nextAttemptAt = null;
      return 'empty';
    }
    if (nextAttemptAt !== null && Date.now() < nextAttemptAt) return 'blocked';

    sending = true;
    announce();
    try {
      await deps.api.send(operation.method, operation.path, operation.body, {
        idempotencyKey: operation.idempotencyKey,
        leaseToken: operation.leaseToken,
      });
      deps.queue.settle(operation.id);
      failures = 0;
      nextAttemptAt = null;
      return 'sent';
    } catch (error) {
      if (!(error instanceof ApiError)) {
        // Not a refusal we can classify. Treated as permanent, because a bug in
        // our own send path retried forever is a queue that never drains and a
        // waiter who is never told.
        deps.queue.reject(operation.id, 'client_error', String(error));
        return 'sent';
      }

      if (error.failure.kind === 'offline') {
        failures += 1;
        nextAttemptAt = Date.now() + backoff();
        return 'blocked';
      }

      if (error.failure.kind === 'signed-out') {
        // Nothing to do but wait for someone to sign in. The queue is kept: the
        // work was real and the next shift's token will send it.
        nextAttemptAt = Date.now() + BACKOFF_MS[BACKOFF_MS.length - 1]!;
        return 'blocked';
      }

      if (error.failure.retryable) {
        failures += 1;
        deps.queue.retried(operation.id);
        nextAttemptAt = Date.now() + backoff();
        return 'blocked';
      }

      // Permanent. Two of these codes mean the tablet has lost the table, so the
      // lease is dropped as well -- otherwise every following operation for that
      // session queues up behind a credential the server has already killed.
      const code = error.failure.code;
      if (code === 'lease_token_unknown' || code === 'lease_subject_mismatch'
          || code === 'lease_not_held' || code === 'lease_force_released') {
        const sessionId = sessionIdIn(operation.path);
        if (sessionId) deps.leases.forget(sessionId);
      }
      deps.queue.reject(operation.id, code, error.message);
      failures = 0;
      return 'sent';
    } finally {
      sending = false;
      announce();
    }
  }

  function backoff(): number {
    return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
  }

  async function drain(): Promise<void> {
    // One at a time, and stop the moment the head cannot go: the next item is
    // not independent of it.
    for (;;) {
      if (stopped) return;
      const outcome = await sendOne();
      if (outcome !== 'sent') return;
    }
  }

  return {
    onChange(listener: (state: PumpState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Called after an enqueue, so the first attempt does not wait for the tick. */
    kick(): void {
      void drain();
    },

    start(): () => void {
      stopped = false;
      const handle = setInterval(() => void drain(), IDLE_MS);
      const onWake = (): void => {
        if (document.visibilityState === 'visible') {
          // A tablet coming back from sleep should not serve out its backoff:
          // the reason it failed was probably that it was asleep.
          nextAttemptAt = null;
          void drain();
        }
      };
      document.addEventListener('visibilitychange', onWake);
      window.addEventListener('online', onWake);
      void drain();
      return () => {
        stopped = true;
        clearInterval(handle);
        document.removeEventListener('visibilitychange', onWake);
        window.removeEventListener('online', onWake);
      };
    },
  };
}

/**
 * Reads the session out of a queued path, for the lease-forget above.
 *
 * Only `/pos/session/:id/...` carries it. An order or bill path does NOT, and
 * this deliberately does not guess: the client does not hold the order-to-session
 * mapping for a session it has lost, and inventing one here would forget the
 * wrong table.
 */
function sessionIdIn(path: string): string | null {
  const match = /^\/pos\/session\/([0-9a-f-]{36})\b/.exec(path);
  return match ? match[1]! : null;
}

export type Pump = ReturnType<typeof createPump>;
