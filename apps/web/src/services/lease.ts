import { ApiError, type Api } from './api.js';
import type { Store } from './storage.js';
import { parsePgTimestamp } from '../lib/pgtime.js';

/**
 * The client's half of the session lease.
 *
 * ###########################################################################
 * THE TOKEN IS THE WRITE CREDENTIAL, AND IT IS PER CLAIM.
 *
 * The server resolves the lease FROM the token and refuses a write whose token
 * names a dead lease or a different session -- so this module is not a
 * convenience, it is the only thing that makes a leased route usable. Two
 * consequences shape it:
 *
 * 1. The token is persisted. A tablet that reloads mid-service must keep
 *    writing; a token held only in memory would mean a reload silently drops
 *    the table's write authority and every queued operation is refused.
 *
 * 2. An operation carries the token it was ENQUEUED under, not the current one.
 *    The queue already does this. It matters because release-and-reclaim mints a
 *    NEW token: an operation queued before a force release arrives carrying the
 *    dead one and is refused, which is exactly what force release promises the
 *    manager who used it.
 * ###########################################################################
 *
 * A tablet may hold several tables at once -- a waiter working four of them is
 * the normal case, not an edge one -- so this is a map, not a single slot, and
 * one timer renews all of them.
 */

const LEASES_KEY = 'leases.v1';

/** Renew well inside the window: a missed renewal costs the table, not a retry. */
const RENEW_EVERY_MS = 60_000;
const RENEW_WHEN_UNDER_MS = 8 * 60_000;

export interface HeldLease {
  readonly sessionId: string;
  readonly token: string;
  /**
   * Server time as epoch ms, translated once on receipt -- or null when the
   * server's own timestamp could not be parsed. Never NaN: a NaN here compares
   * false against everything and turns a held lease into a read-only screen.
   */
  readonly expiresAtMs: number | null;
}

interface Stored {
  readonly leases: readonly HeldLease[];
  /** serverNow minus Date.now() at the last read. Never trust the tablet clock. */
  readonly skewMs: number;
}

interface ClaimResponse {
  sessionId: string;
  deviceId: string;
  token: string;
  expiresAt: string;
  claimedAt: string;
}

/**
 * Which owner this tablet is. KOT claims an order being taken
 * (`/pos/session/:id/lease`, `table.session.open`); Billing claims one KOT
 * handed over (`/pos/session/:id/billing-lease`, `bill.generate`). Same
 * lease underneath -- the server refuses each route the other stage.
 */
export type LeaseOwner = 'kot' | 'billing';

export function createLeases(store: Store, api: Api, owner: LeaseOwner = 'kot') {
  const claimPath = (sessionId: string): string =>
    `/pos/session/${sessionId}/${owner === 'kot' ? 'lease' : 'billing-lease'}`;
  let state: Stored = store.get<Stored>(LEASES_KEY) ?? { leases: [], skewMs: 0 };
  const listeners = new Set<() => void>();

  function save(next: Stored): void {
    state = next;
    store.set(LEASES_KEY, next);
    for (const listener of listeners) listener();
  }

  function put(lease: HeldLease): void {
    save({
      ...state,
      leases: [...state.leases.filter((l) => l.sessionId !== lease.sessionId), lease],
    });
  }

  function drop(sessionId: string): void {
    save({ ...state, leases: state.leases.filter((l) => l.sessionId !== sessionId) });
  }

  /**
   * The clock the countdown uses. A tablet whose clock is wrong -- or wound back
   * deliberately -- must not be able to show itself more time than it has, for
   * the same reason the server decides expiry rather than the token.
   */
  function serverNow(): number {
    return Date.now() + state.skewMs;
  }

  function adopt(response: ClaimResponse): HeldLease {
    // An unparseable expiry is NOT stored as NaN. The lease is real -- the
    // server just granted it -- so the token is kept and the expiry is recorded
    // as unknown, which the UI renders as "no time shown" rather than as zero.
    const expiresAtMs = parsePgTimestamp(response.expiresAt);
    const lease: HeldLease = {
      sessionId: response.sessionId,
      token: response.token,
      expiresAtMs,
    };
    put(lease);
    return lease;
  }

  return {
    /** Sets the skew from any read that returned the server's own instant. */
    observeServerNow(serverNowText: string): void {
      const parsed = parsePgTimestamp(serverNowText);
      if (parsed !== null) save({ ...state, skewMs: parsed - Date.now() });
    },

    serverNow,

    /** The token for a session, or null. Read at ENQUEUE time, never at send time. */
    tokenFor(sessionId: string): string | null {
      const lease = state.leases.find((l) => l.sessionId === sessionId);
      if (!lease) return null;
      // A locally-expired lease still returns its token: the server decides, and
      // a refusal carrying a reason is more useful than a client that silently
      // declines to try. What the UI must not do is present it as live.
      return lease.token;
    },

    /** null means "not held" OR "held, expiry unknown" -- the caller must not
     * treat it as zero. `held()` distinguishes the two. */
    secondsRemaining(sessionId: string): number | null {
      const lease = state.leases.find((l) => l.sessionId === sessionId);
      if (!lease || lease.expiresAtMs === null) return null;
      return Math.max(0, Math.round((lease.expiresAtMs - serverNow()) / 1000));
    },

    held(): readonly HeldLease[] {
      return state.leases;
    },

    async claim(sessionId: string, branchId: string, deviceId: string): Promise<HeldLease> {
      const response = await api.mutate<ClaimResponse>(
        claimPath(sessionId),
        { deviceId, branchId },
        { idempotencyKey: crypto.randomUUID(), leaseToken: null },
      );
      return adopt(response);
    },

    async renew(sessionId: string, deviceId: string): Promise<HeldLease | null> {
      const existing = state.leases.find((l) => l.sessionId === sessionId);
      if (!existing) return null;
      try {
        const response = await api.mutate<ClaimResponse>(
          claimPath(sessionId),
          { deviceId, renew: true },
          { idempotencyKey: crypto.randomUUID(), leaseToken: existing.token },
        );
        return adopt(response);
      } catch (error) {
        // Offline or a server fault is NOT a reason to forget the lease: the
        // window is still running down and the token is still the one queued
        // work must carry. `lease_not_held` is different -- the server has no
        // live lease for this tablet (expired, released, or a session that no
        // longer exists), so renewing it again can never succeed. Kept, it
        // renewed forever. Queued work is unaffected: it carries the token it
        // was enqueued under, and the server refuses that with its own reason.
        if (error instanceof ApiError && error.failure.kind === 'refused'
            && error.failure.code === 'lease_not_held') {
          drop(sessionId);
        }
        return null;
      }
    },

    /**
     * Ordinary release. Dropped locally whatever the server says, because the
     * waiter has moved on: the worst case is a lease that expires on its own
     * fifteen minutes later, and the alternative is a tablet that believes it
     * still owns a table it has left.
     */
    async release(sessionId: string, deviceId: string): Promise<void> {
      const existing = state.leases.find((l) => l.sessionId === sessionId);
      drop(sessionId);
      // Billing holds no release key; its lease ends when the order closes or
      // runs out, which is also when nobody else wants it.
      if (!existing || owner === 'billing') return;
      try {
        await api.mutate(
          `/pos/session/${sessionId}/lease`,
          { deviceId },
          { idempotencyKey: crypto.randomUUID(), leaseToken: existing.token },
        );
      } catch {
        /* left to expire */
      }
    },

    /** Called when the server refuses a write for lease reasons. */
    forget(sessionId: string): void {
      drop(sessionId);
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    /**
     * One timer for every held lease. Renewal is idempotent server-side (claim
     * and renew are one route) so a duplicate tick costs nothing, and skipping
     * one costs a table.
     */
    startRenewing(deviceId: string): () => void {
      const tick = async (): Promise<void> => {
        for (const lease of [...state.leases]) {
          // An unknown expiry renews on every tick rather than never: the cost
          // is a request a minute, and the alternative is losing the table.
          if (lease.expiresAtMs === null
              || lease.expiresAtMs - serverNow() < RENEW_WHEN_UNDER_MS) {
            await this.renew(lease.sessionId, deviceId);
          }
        }
      };
      const handle = setInterval(() => void tick(), RENEW_EVERY_MS);
      // A tablet that slept through its renewal window wakes up needing one
      // immediately; the interval alone would wait a full minute.
      const onWake = (): void => {
        if (document.visibilityState === 'visible') void tick();
      };
      document.addEventListener('visibilitychange', onWake);
      return () => {
        clearInterval(handle);
        document.removeEventListener('visibilitychange', onWake);
      };
    },
  };
}

export type Leases = ReturnType<typeof createLeases>;
