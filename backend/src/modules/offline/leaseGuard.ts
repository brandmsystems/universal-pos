import type { TenantContext } from '../../database/tenantContext.js';

/**
 * The online half of the lease.
 *
 * `adjudicateBatch` guards the offline sync path and does it properly: it
 * resolves the lease row per session and quarantines a batch whose lease has
 * expired, been released, been force-released, or moved to another device. The
 * ONLINE path had no equivalent. That asymmetry is the whole defect: a device
 * whose session had been taken away could not merge a queued batch, but could
 * still add lines one request at a time over HTTP -- the slower route to the same
 * damage, and the one a stranded tablet takes automatically the moment its
 * connection comes back.
 *
 * This module is what the route registrar calls, driven by the route's own
 * `lease` declaration, so a leased write cannot reach a handler unguarded.
 */

export type LeaseSubjectKind = 'session' | 'order' | 'bill';

export class LeaseTokenUnknownError extends Error {
  readonly statusCode = 409;
  readonly code = 'lease_token_unknown';
  constructor() {
    // Deliberately says nothing about WHY. "No such lease", "that lease was
    // force-released" and "that lease belongs to another session" are one
    // message to the caller, because the distinction is only useful to someone
    // guessing tokens. The device's recovery is identical in all three: claim.
    super('the lease token does not name a live lease');
    this.name = 'LeaseTokenUnknownError';
  }
}

export class LeaseSubjectMismatchError extends Error {
  readonly statusCode = 409;
  readonly code = 'lease_subject_mismatch';
  constructor(readonly leasedSessionId: string, readonly targetSessionId: string) {
    super(
      `the lease is held on session ${leasedSessionId}, but this write targets ` +
        `session ${targetSessionId}`,
    );
    this.name = 'LeaseSubjectMismatchError';
  }
}

export class LeaseSubjectMissingError extends Error {
  readonly statusCode = 404;
  readonly code = 'lease_subject_not_found';
  constructor(kind: LeaseSubjectKind, id: string) {
    super(`no ${kind} ${id} in this tenant`);
    this.name = 'LeaseSubjectMissingError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `:id` means a different thing per subject, and the SQL is the only place that
 * knows which. One statement per kind, no dynamic table name -- a subject added
 * later is a compile error at the switch, not a silently unhandled string.
 */
const SUBJECT_SQL: Record<LeaseSubjectKind, string> = {
  session: `SELECT id AS session_id FROM app.table_session
             WHERE tenant_id = $1 AND id = $2`,
  order: `SELECT session_id FROM app.sales_order
           WHERE tenant_id = $1 AND id = $2`,
  bill: `SELECT session_id FROM app.bill
          WHERE tenant_id = $1 AND id = $2`,
};

export async function resolveLeaseSubject(
  context: TenantContext,
  kind: LeaseSubjectKind,
  id: string,
): Promise<string> {
  if (!UUID.test(id)) throw new LeaseSubjectMissingError(kind, id);
  const result = await context.client.query<{ session_id: string }>(
    SUBJECT_SQL[kind], [context.tenantId, id]);
  const row = result.rows[0];
  if (!row) throw new LeaseSubjectMissingError(kind, id);
  return row.session_id;
}

export interface HeldLease {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Resolves the lease FROM THE TOKEN and then checks the session matches.
 *
 * The order matters. Resolving by (session, device) taken from the request would
 * let the client name its own device, which is the mistake the previous shape
 * made in a smaller way. The token is the only thing the client supplies, and it
 * yields the session and the device -- so a request cannot assert a session it
 * does not hold, and cannot borrow another device's identity to hold one.
 *
 * Liveness is decided by `now()` on the server inside this transaction, for the
 * same reason the impersonation session row decides its own expiry: a device
 * with a wound-back clock must not be able to extend its own authority.
 */
export async function requireLeaseByToken(
  context: TenantContext,
  params: { token: string; targetSessionId: string },
): Promise<HeldLease> {
  // Shape-checked in TypeScript before it reaches SQL. `token = $2` against a
  // uuid column raises 22P02 on a malformed value, which would surface as a 500
  // -- a garbage token is a client error, and a distinguishable one is a probe
  // signal. Uniform `lease_token_unknown` either way.
  if (!UUID.test(params.token)) throw new LeaseTokenUnknownError();

  const result = await context.client.query<{
    session_id: string; device_id: string; token: string; expires_at: string;
  }>(
    `SELECT session_id, device_id, token::text, expires_at::text
       FROM app.table_session_lease
      WHERE tenant_id = $1 AND token = $2
        AND released_at IS NULL AND force_released_at IS NULL
        AND expires_at > now()`,
    [context.tenantId, params.token],
  );
  const row = result.rows[0];
  if (!row) throw new LeaseTokenUnknownError();
  if (row.session_id !== params.targetSessionId) {
    throw new LeaseSubjectMismatchError(row.session_id, params.targetSessionId);
  }
  return {
    sessionId: row.session_id, deviceId: row.device_id,
    token: row.token, expiresAt: row.expires_at,
  };
}
