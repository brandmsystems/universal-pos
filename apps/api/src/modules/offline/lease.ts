import type { TenantContext } from '../../core/database/tenantContext.js';
import { LEASE_DURATION_MINUTES } from './window.js';
import { OrderInBillingError, OrderNotReadyForBillingError } from '../orders/session.js';

/**
 * The session lease.
 *
 * This is the single mechanism that makes the offline allowed-set safe. The
 * locality rule says an operation may go offline when its invariant is local to
 * the aggregate the device holds -- and "local" is only true if exactly one
 * device writes to that aggregate. Order lines merging, pre-fire edits having no
 * conflict, and a fire producing one KOT rather than two all rest on this and
 * nothing else.
 *
 * Keyed on the SESSION, never the table. A party moving from table 4 to table 7
 * keeps one session across both; a table-keyed lease would split at the move and
 * hand the second table to another device.
 */

export class LeaseHeldError extends Error {
  readonly statusCode = 409;
  readonly code = 'session_leased';
  constructor(readonly sessionId: string, readonly heldByDeviceId: string) {
    super(`session ${sessionId} is leased by device ${heldByDeviceId}`);
    this.name = 'LeaseHeldError';
  }
}

export class LeaseNotHeldError extends Error {
  readonly statusCode = 409;
  readonly code = 'lease_not_held';
  constructor(readonly sessionId: string, readonly deviceId: string, readonly why: string) {
    super(`device ${deviceId} does not hold a live lease on session ${sessionId}: ${why}`);
    this.name = 'LeaseNotHeldError';
  }
}

export interface Lease {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly claimedAt: string;
  /**
   * The write credential for this claim. Minted per CLAIM row, carried
   * unchanged through renewal, dead the moment the row is released or force
   * released -- so it identifies a lease EPOCH, not a device. See 0047.
   */
  readonly token: string;
}

interface LeaseRow {
  session_id: string; device_id: string; expires_at: string; claimed_at: string;
  token: string;
  released_at: string | null; force_released_at: string | null; live: boolean;
}

// A session accumulates leases over its life; the interesting one is the live
// row, and failing that the most recent, so `leaseState` can say WHY rather than
// just "no".
const SELECT_LEASE = `
  SELECT session_id, device_id, expires_at::text, claimed_at::text, token::text,
         released_at::text, force_released_at::text,
         (released_at IS NULL AND force_released_at IS NULL AND expires_at > now()) AS live
    FROM app.table_session_lease
   WHERE tenant_id = $1 AND session_id = $2
   ORDER BY (released_at IS NULL AND force_released_at IS NULL) DESC, claimed_at DESC
   LIMIT 1`;

/**
 * Claims a session for a device.
 *
 * Not idempotent-by-accident: re-claiming a session the SAME device already holds
 * renews rather than failing, because a terminal that reconnects mid-service must
 * not have to distinguish the two. A different device is refused.
 */
export async function claimLease(
  context: TenantContext,
  params: {
    sessionId: string; deviceId: string; branchId: string;
    /**
     * Which owner is claiming: KOT takes an order being taken, Billing takes one
     * handed over. The session row is locked first -- the same order as
     * `markReadyForBilling` (session, then lease) -- so the stage cannot change
     * between this check and the insert.
     */
    stage?: 'ordering' | 'billing';
  },
): Promise<Lease> {
  if (params.stage !== undefined) {
    const found = await context.client.query<{ stage: string }>(
      `SELECT stage FROM app.table_session WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [context.tenantId, params.sessionId]);
    const stage = found.rows[0]?.stage;
    if (params.stage === 'ordering' && stage === 'billing') throw new OrderInBillingError(params.sessionId);
    if (params.stage === 'billing' && stage !== 'billing') throw new OrderNotReadyForBillingError(params.sessionId);
  }
  const existing = await context.client.query<LeaseRow>(
    `SELECT session_id, device_id, expires_at::text, claimed_at::text, token::text,
            released_at::text, force_released_at::text, (expires_at > now()) AS live
       FROM app.table_session_lease
      WHERE tenant_id = $1 AND session_id = $2
        AND released_at IS NULL AND force_released_at IS NULL
      FOR UPDATE`,
    [context.tenantId, params.sessionId],
  );
  const held = existing.rows[0];

  if (held?.live) {
    if (held.device_id !== params.deviceId) {
      throw new LeaseHeldError(params.sessionId, held.device_id);
    }
    return renewLease(context, params);
  }

  if (held) {
    // EXPIRED, by server time: nobody holds the session. The row still counts
    // for `table_session_lease_one_live` until it is closed, and leaving it
    // open blocked every claim -- another device was told the table was held,
    // and the same device was sent to renew a lease renewal cannot extend -- so
    // a tablet that went quiet kept its table until a manager force-released
    // it. Closed here, and the claim below is a NEW lease with a new token:
    // expiry already ended the old epoch, so work queued under its token stays
    // refused, exactly as after a release. expires_at keeps its value, so the
    // row still shows it expired before it was closed.
    await context.client.query(
      `UPDATE app.table_session_lease SET released_at = now()
        WHERE tenant_id = $1 AND session_id = $2
          AND released_at IS NULL AND force_released_at IS NULL AND expires_at <= now()`,
      [context.tenantId, params.sessionId],
    );
  }

  const inserted = await context.client.query<LeaseRow>(
    `INSERT INTO app.table_session_lease
       (id, session_id, tenant_id, branch_id, device_id, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
     RETURNING session_id, device_id, expires_at::text, claimed_at::text, token::text,
               released_at::text, force_released_at::text, true AS live`,
    [params.sessionId, context.tenantId, params.branchId, params.deviceId,
     String(LEASE_DURATION_MINUTES)],
  );
  const row = inserted.rows[0]!;
  return {
    sessionId: row.session_id, deviceId: row.device_id,
    expiresAt: row.expires_at, claimedAt: row.claimed_at, token: row.token,
  };
}

/**
 * Renewal is the ONLY thing that moves expiry, which is what makes "a device
 * going offline gets its remaining window, not a fresh one" true with no separate
 * mechanism: expiry is absolute, and a disconnected device cannot renew.
 */
export async function renewLease(
  context: TenantContext,
  params: { sessionId: string; deviceId: string },
): Promise<Lease> {
  const result = await context.client.query<LeaseRow>(
    `UPDATE app.table_session_lease
        SET expires_at = now() + ($3 || ' minutes')::interval, renewed_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND device_id = $4
        AND released_at IS NULL AND force_released_at IS NULL
        AND expires_at > now()
      RETURNING session_id, device_id, expires_at::text, claimed_at::text, token::text,
                released_at::text, force_released_at::text, true AS live`,
    [context.tenantId, params.sessionId, String(LEASE_DURATION_MINUTES), params.deviceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new LeaseNotHeldError(params.sessionId, params.deviceId, 'no live lease to renew');
  }
  return {
    sessionId: row.session_id, deviceId: row.device_id,
    expiresAt: row.expires_at, claimedAt: row.claimed_at, token: row.token,
  };
}

/** Ordinary release by the holder. One-way, enforced by trigger. */
export async function releaseLease(
  context: TenantContext,
  params: { sessionId: string; deviceId: string },
): Promise<void> {
  await context.client.query(
    `UPDATE app.table_session_lease SET released_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND device_id = $3
        AND released_at IS NULL AND force_released_at IS NULL`,
    [context.tenantId, params.sessionId, params.deviceId],
  );
}

/**
 * Taking a session away from a device that still believes it holds it -- a dead
 * tablet, a lost terminal.
 *
 * Escalation-class and attributable, because it deliberately creates the split
 * the lease exists to prevent: for a window, two parties believe they own the
 * session. That is survivable ONLY because everything the stranded device
 * subsequently sends is quarantined rather than merged.
 */
export async function forceReleaseLease(
  context: TenantContext,
  params: { sessionId: string; byUserId: string; reasonId: string },
): Promise<{ strandedDeviceId: string }> {
  const result = await context.client.query<{ device_id: string }>(
    `UPDATE app.table_session_lease
        SET force_released_at = now(), force_released_by_user_id = $3,
            force_release_reason_id = $4
      WHERE tenant_id = $1 AND session_id = $2
        AND released_at IS NULL AND force_released_at IS NULL
      RETURNING device_id`,
    [context.tenantId, params.sessionId, params.byUserId, params.reasonId],
  );
  const row = result.rows[0];
  if (!row) throw new LeaseNotHeldError(params.sessionId, '-', 'no live lease to force-release');
  return { strandedDeviceId: row.device_id };
}

export type LeaseState =
  | { readonly held: true; readonly lease: Lease }
  | { readonly held: false; readonly why: 'none' | 'expired' | 'released' | 'force_released' | 'other_device' };

/**
 * Server time decides, never the device's clock. Same reasoning as the
 * impersonation session row deciding expiry rather than the token: a device with
 * a skewed or deliberately wound-back clock must not be able to extend its own
 * authority.
 */
export async function leaseState(
  context: TenantContext,
  params: { sessionId: string; deviceId: string },
): Promise<LeaseState> {
  const result = await context.client.query<LeaseRow>(SELECT_LEASE,
    [context.tenantId, params.sessionId]);
  const row = result.rows[0];
  if (!row) return { held: false, why: 'none' };
  if (row.force_released_at) return { held: false, why: 'force_released' };
  if (row.released_at) return { held: false, why: 'released' };
  if (row.device_id !== params.deviceId) return { held: false, why: 'other_device' };
  if (!row.live) return { held: false, why: 'expired' };
  return {
    held: true,
    lease: {
      sessionId: row.session_id, deviceId: row.device_id,
      expiresAt: row.expires_at, claimedAt: row.claimed_at, token: row.token,
    },
  };
}

/** Guard for every write that the locality rule permits offline. */
export async function requireLease(
  context: TenantContext,
  params: { sessionId: string; deviceId: string },
): Promise<Lease> {
  const state = await leaseState(context, params);
  if (!state.held) throw new LeaseNotHeldError(params.sessionId, params.deviceId, state.why);
  return state.lease;
}

/** Device-local ticket reference, printed before the server assigns a sequence. */
export function localKotReference(deviceId: string, localCounter: number): string {
  return `L-${deviceId.replace(/-/g, '').slice(0, 8)}-${localCounter}`;
}

