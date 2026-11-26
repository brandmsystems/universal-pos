import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Credential events.
 *
 * ###########################################################################
 * THIS IS NOT THE AUDIT LOG, AND THE DIFFERENCE IS THE WHOLE DESIGN.
 *
 * `tenant_audit_log` answers "who changed what, under whose authority". A failed
 * login has no who, changed nothing, and had no authority -- which is why
 * `tenant_audit_log_attribution_exact` cannot hold it and why a fourth
 * `actor_kind` was rejected: a new enum value is a value every existing
 * attribution query must remember to exclude, and the fifth query is the one
 * somebody forgets.
 *
 * So this table records what was ATTEMPTED. It never records authority, and
 * nothing here is an attribution.
 * ###########################################################################
 */

/**
 * Fixed, not tenant policy. It is a platform-wide security-telemetry window and
 * there is no tenant-visible read path to tune it against yet -- see the open
 * item in CLAUDE.md about a tenant-visible view.
 */
export const AUTH_ATTEMPT_RETENTION_DAYS = 30;

export type AttemptMethod = 'password' | 'pin' | 'refresh' | 'device_enrol' | 'owner_invite' | 'staff_invite';

export type AttemptOutcome = 'success' | 'rejected';

export interface AuthAttempt {
  readonly method: AttemptMethod;
  readonly outcome: AttemptOutcome;
  /**
   * Verbatim from the domain's own rejection unions (`PinRejection`,
   * `EnrolmentFailure`, `TokenError.code`). Reported rather than a boolean, for
   * the same reason a quarantine reports which of five things happened.
   *
   * Required on a rejection and forbidden on a success, by CHECK.
   */
  readonly reason: string | null;
  readonly tenantId: string | null;
  /**
   * The subject AS TYPED. Never resolved, never an FK: the attempts worth having
   * are the ones against subjects that do not exist.
   */
  readonly claimedSubject: string | null;
  /** Set only where a real user was resolved, which implies a resolved tenant. */
  readonly resolvedUserId: string | null;
  readonly branchId: string | null;
  readonly deviceFingerprint: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  /** The control-plane subject. Mutually exclusive with tenantId/resolvedUserId. */
  readonly platformUserId?: string | null;
}

/** Mirrors the CHECK constraints, so a bad row fails here with a better message. */
export class MalformedAuthAttemptError extends Error {
  readonly code = 'malformed_auth_attempt';
  constructor(why: string) {
    super(`refusing to record an auth attempt: ${why}`);
    this.name = 'MalformedAuthAttemptError';
  }
}

/** Bounded here as well as by CHECK, so a 1MB body cannot become a 1MB row. */
function bounded(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * ###########################################################################
 * A FAILURE TO RECORD PROPAGATES. IT IS NOT BEST-EFFORT.
 *
 * The tempting shape is a try/catch that logs and carries on, so telemetry can
 * never break a login. The cost of that shape is a security log that is quietly
 * empty exactly when someone needs to read it, and nothing that would have said
 * so.
 *
 * If the database is healthy enough to verify a credential it is healthy enough
 * to insert one row on the same connection. An insert that fails here means a
 * missing table or a revoked grant -- a deploy fault, which should be loud.
 * ###########################################################################
 */
export async function recordAuthAttempt(
  client: pg.ClientBase,
  attempt: AuthAttempt,
): Promise<void> {
  if (attempt.outcome === 'rejected' && !attempt.reason) {
    throw new MalformedAuthAttemptError('a rejection with no reason is unactionable');
  }
  if (attempt.outcome === 'success' && attempt.reason) {
    throw new MalformedAuthAttemptError('a success carrying a rejection reason is a contradiction');
  }
  if (attempt.resolvedUserId !== null && attempt.tenantId === null) {
    throw new MalformedAuthAttemptError('a resolved user implies a resolved tenant');
  }
  // Mirrors `auth_attempt_one_plane`. An attempt belongs to exactly one plane,
  // and a row claiming both is a row nobody can read back during an incident.
  if ((attempt.platformUserId ?? null) !== null
      && (attempt.tenantId !== null || attempt.resolvedUserId !== null)) {
    throw new MalformedAuthAttemptError(
      'an attempt cannot name both a platform user and a tenant subject');
  }

  await client.query(
    `INSERT INTO platform.auth_attempt
       (id, method, outcome, reason, tenant_id, claimed_subject, resolved_user_id,
        branch_id, device_fingerprint, ip, user_agent, request_id, platform_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      randomUUID(),
      attempt.method,
      attempt.outcome,
      attempt.reason,
      attempt.tenantId,
      bounded(attempt.claimedSubject, 320),
      attempt.resolvedUserId,
      attempt.branchId,
      bounded(attempt.deviceFingerprint, 200),
      attempt.ip,
      bounded(attempt.userAgent, 1000),
      attempt.requestId,
      attempt.platformUserId ?? null,
    ],
  );
}

/** Runs as the owner. See the migration for why there is no append-only trigger. */
export async function purgeAuthAttempts(
  client: pg.ClientBase,
  retainDays: number = AUTH_ATTEMPT_RETENTION_DAYS,
): Promise<number> {
  const result = await client.query<{ purge_auth_attempts: number }>(
    'SELECT platform.purge_auth_attempts($1) AS purge_auth_attempts',
    [retainDays],
  );
  return result.rows[0]?.purge_auth_attempts ?? 0;
}
