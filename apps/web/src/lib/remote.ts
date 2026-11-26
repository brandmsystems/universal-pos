/**
 * ###########################################################################
 * EVERY REMOTE VALUE IS known, stale OR unknown. ABSENCE IS NEVER A DISCRIMINATOR.
 *
 * `const tables = data ?? []` renders "no open tables" during a failed fetch. A
 * supervisor sees an empty floor at 8pm on a Saturday and concludes the service
 * is over: nothing threw, nothing logged, the screen was confident and wrong.
 *
 * There is deliberately no `.value` on the unknown branch, so a component that
 * renders a value without handling all three states does not compile. That is
 * the enforcement -- not a lint rule, not a review comment.
 * ###########################################################################
 */

export type UnknownReason =
  | 'never-read'
  | 'read-failed'
  | 'offline'
  | 'not-permitted'
  /**
   * There is no route that serves this value.
   *
   * Not a failure and not a permission: the read does not exist, so no retry,
   * reload or re-login will produce it. Added because the alternative was a
   * screen rendering a hardcoded list beside real data and looking identical to
   * it -- `app.adjustment_reason` has no endpoint, and a faked reason list would
   * have sent uuids the tenant does not have.
   *
   * It renders like every other unknown -- hatched and captioned -- and the
   * caption is the one that names the missing route.
   */
  | 'no-route';

export type Remote<T> =
  | { readonly state: 'known'; readonly value: T; readonly at: number }
  | { readonly state: 'stale'; readonly value: T; readonly at: number }
  | { readonly state: 'unknown'; readonly reason: UnknownReason };

export const unknown = <T>(reason: UnknownReason = 'never-read'): Remote<T> => ({
  state: 'unknown',
  reason,
});

export const known = <T>(value: T, at: number = Date.now()): Remote<T> => ({
  state: 'known',
  value,
  at,
});

/**
 * A known value becomes stale; an unknown one stays unknown.
 *
 * Staleness is not a downgrade of "no data" -- there is nothing to keep showing,
 * and inventing an empty value to mark stale is the bug this whole module exists
 * to prevent.
 *
 * It does stop being `never-read`: this is called when a read came back
 * offline, and `never-read` is what a loading skeleton keys on. Left as it was,
 * a first read that failed offline would read as "still loading" forever.
 */
export function stale<T>(previous: Remote<T>): Remote<T> {
  if (previous.state !== 'unknown') return { state: 'stale', value: previous.value, at: previous.at };
  return previous.reason === 'never-read' ? unknown<T>('offline') : previous;
}
