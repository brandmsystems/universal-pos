import type { UnattributableDetail } from '../middleware/routeRegistry.js';

/**
 * An unattributable action is an internal invariant violation: the permission
 * check passed on a union that no single membership supplies. The request is
 * refused, so nothing is lost -- but a one-time alert is not detection. If this
 * ever fires, it means either the authority resolution or the membership data is
 * wrong, and that has to be visible the next morning rather than only in whatever
 * log rotation kept the line.
 *
 * The counter is per-process and resets on restart, so the nightly assertion must
 * run against the SCRAPED metric, not a live call into one instance. Calling
 * assertNoUnattributableActions() in-process only proves this instance is clean.
 */

let count = 0;
const recent: UnattributableDetail[] = [];
const RECENT_LIMIT = 50;

export function recordUnattributable(detail: UnattributableDetail): void {
  count += 1;
  recent.push(detail);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

export function unattributableCount(): number {
  return count;
}

export function resetUnattributableCount(): void {
  count = 0;
  recent.length = 0;
}

export class UnattributableActionsDetected extends Error {
  constructor(readonly total: number) {
    super(
      `${total} unattributable action(s) were refused since this process started. ` +
        'The permission check passed where no membership authorises it: the authority ' +
        'resolution or the membership data is wrong.',
    );
    this.name = 'UnattributableActionsDetected';
  }
}

/** Nightly data-quality assertion. Must be zero. */
export function assertNoUnattributableActions(): void {
  if (count > 0) throw new UnattributableActionsDetected(count);
}
