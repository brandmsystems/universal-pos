/**
 * The offline window and the replay-protection window are ONE constraint, not
 * two independent numbers.
 *
 * Sync idempotency rests on `request_claim`: a resynced batch is safe because
 * its claims are still on record and replay is detected. Once those claims are
 * purged, the same batch applies again as if new -- silently, and against money
 * and stock. So the offline window must stay well inside claim retention, and
 * raising one without the other must FAIL rather than quietly remove the
 * guarantee.
 *
 * The margin is 3x rather than 1x because the two clocks do not start together:
 * a device's window begins when it loses connectivity, the purge runs on its own
 * schedule against `created_at`, and a batch is only presented for replay at the
 * far end of the window. 1x would be exactly the boundary case.
 */

/** Mirrors `app.purge_request_claims(retain_days DEFAULT 7)` in migration 0025. */
export const REQUEST_CLAIM_RETENTION_DAYS = 7;

/** A "retry" beyond this is a new request, not a retry. */
export const OFFLINE_WINDOW_HOURS = 24;

export const OFFLINE_WINDOW_SAFETY_FACTOR = 3;

/**
 * Throws at module load, so raising one constant without the other fails the
 * BOOT rather than only a test. A test can be skipped; a process that will not
 * start cannot.
 */
export function assertOfflineWindowFitsClaimRetention(
  windowHours: number = OFFLINE_WINDOW_HOURS,
  retentionDays: number = REQUEST_CLAIM_RETENTION_DAYS,
  factor: number = OFFLINE_WINDOW_SAFETY_FACTOR,
): void {
  const retentionHours = retentionDays * 24;
  if (windowHours * factor >= retentionHours) {
    throw new Error(
      `offline window of ${windowHours}h with a ${factor}x margin does not fit inside ` +
        `request_claim retention of ${retentionDays}d (${retentionHours}h). ` +
        'A device syncing after its claims were purged would replay its batch as new work ' +
        'against money and stock. Raise retention or lower the window -- they are one constraint.',
    );
  }
}

assertOfflineWindowFitsClaimRetention();

export const OFFLINE_WINDOW_MS = OFFLINE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Short and renewable. A long lease means a dead tablet blocks a table for the
 * length of the lease, and the failure mode of "too short" is a renewal round
 * trip while the failure mode of "too long" is an unusable table mid-service.
 */
export const LEASE_DURATION_MINUTES = 15;
export const LEASE_DURATION_MS = LEASE_DURATION_MINUTES * 60 * 1000;
