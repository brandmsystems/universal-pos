import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { signToken } from '../auth/jwt.js';
import { enqueue } from '../notifications/outbox.js';

/**
 * Impersonation is the one sanctioned crossing of the plane boundary.
 *
 * The token is a REFERENCE, not an assertion. A signed JWT is a bearer credential
 * and revoking one is impossible without state, so `sid` is resolved against the
 * session row on EVERY request. The row -- not the token -- is authoritative for
 * revocation, expiry and write access.
 *
 * That couples impersonated tenant-plane requests to control-plane availability.
 * Accepted deliberately: failing closed is correct, and immediate revocation is
 * the entire justification for the per-request read. The session must NEVER be
 * cached.
 */

export const IMPERSONATION_TOKEN_TYPE = 'impersonation';

export type ImpersonationReasonCode =
  | 'support_ticket'
  | 'incident'
  | 'data_correction'
  | 'onboarding_assist'
  | 'compliance_request';

export const MAX_SESSION_MINUTES = 60;

export interface StartImpersonationInput {
  readonly tenantId: string;
  readonly platformUserId: string;
  readonly reasonCode: ImpersonationReasonCode;
  readonly reasonDetail: string;
  readonly minutes: number;
  readonly write?: {
    readonly reasonCode: ImpersonationReasonCode;
    readonly reasonDetail: string;
  };
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface StartedImpersonation {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly writeEnabled: boolean;
}

export class TenantNotImpersonableError extends Error {
  /**
   * Added when the route that raises it was built. Without a `code` the error
   * contract had nothing to map, so the one legitimate refusal on
   * `POST /impersonation` would have reached the console as
   * `500 internal_error, retryable: false` -- indistinguishable from a bug in
   * the control plane, on the screen where the operator's next move is to call
   * the tenant back.
   */
  readonly code = 'tenant_not_impersonable';
  constructor(tenantId: string, status: string) {
    super(`tenant ${tenantId} is ${status}: impersonation is refused`);
    this.name = 'TenantNotImpersonableError';
  }
}

/**
 * ###########################################################################
 * WRITE ACCESS IS A SECOND KEY, AND A ROUTE CAN ONLY DECLARE ONE.
 *
 * `platform.impersonation.start` and `platform.impersonation.write` are separate
 * permissions on purpose: `support` holds the first and NOT the second, and its
 * catalogue entry says "May impersonate read-only" in as many words.
 *
 * `POST /impersonation` is guarded by `platform.impersonation.start`, and
 * `RoutePermission` is a single value -- so the registrar checks one key and the
 * second has nowhere to be declared. A support user sending `write: {...}` would
 * therefore have been granted a write session, past both the plane guard and the
 * per-key check, while `platform.impersonation.write` sat in
 * PLATFORM_KEYS_WITHOUT_ROUTES as though nothing needed it.
 *
 * So the handler checks it and raises this. That is a check a handler CAN
 * forget, which is worth naming rather than glossing: the durable fix is for a
 * route to declare more than one permission (or a conditional one), and until it
 * can, `startImpersonation` has exactly one caller and that caller is the check.
 * ###########################################################################
 */
export class ImpersonationWriteNotPermittedError extends Error {
  readonly code = 'impersonation_write_not_permitted';
  constructor(readonly roleKey: string) {
    super(
      `the platform role ${JSON.stringify(roleKey)} may start a read-only impersonation ` +
        'session but does not hold platform.impersonation.write. Write access is a ' +
        'separate permission with its own reason, not a flag on the start request.',
    );
    this.name = 'ImpersonationWriteNotPermittedError';
  }
}

/**
 * Nothing was revoked: no such session, or it was already revoked.
 *
 * Raised rather than returned as `{ revoked: false }`, because
 * `DELETE /impersonation/:id` declares `audit: { action: 'impersonation.revoked' }`
 * and the registrar writes that row on any non-throwing return. A 200 on a no-op
 * would put a revocation in the platform audit log for a session nobody revoked
 * -- the same defect the unserved-route refusal exists to prevent, reached from
 * the other side.
 */
export class ImpersonationSessionNotRevocableError extends Error {
  readonly code = 'impersonation_session_not_revocable';
  constructor(readonly sessionId: string) {
    super(
      `impersonation session ${sessionId} was not revoked: it does not exist, or it was ` +
        'already revoked. Revocation is a one-way stamp and happens once.',
    );
    this.name = 'ImpersonationSessionNotRevocableError';
  }
}

/**
 * Ladder rulings:
 *   purged                    -- refused outright. There is nothing left to see.
 *   hard_lock                 -- permitted. That is precisely when support is needed.
 *   retention, purge_pending  -- permitted, READ-ONLY regardless of the write flag.
 *   deactivated               -- permitted, READ-ONLY. Support may need to see what
 *                                a switched-off restaurant held; nobody should be
 *                                changing it while it is off.
 */
export function impersonationPosture(tenantStatus: string): {
  allowed: boolean;
  forceReadOnly: boolean;
} {
  if (tenantStatus === 'purged') return { allowed: false, forceReadOnly: true };
  if (tenantStatus === 'retention' || tenantStatus === 'purge_pending'
    || tenantStatus === 'deactivated') {
    return { allowed: true, forceReadOnly: true };
  }
  return { allowed: true, forceReadOnly: false };
}

export async function startImpersonation(
  client: pg.ClientBase,
  key: string,
  input: StartImpersonationInput,
): Promise<StartedImpersonation> {
  const tenant = await client.query<{ status: string }>(
    `SELECT status FROM platform.tenant WHERE id = $1`,
    [input.tenantId],
  );
  const status = tenant.rows[0]?.status;
  if (status === undefined) throw new Error(`unknown tenant ${input.tenantId}`);

  const posture = impersonationPosture(status);
  if (!posture.allowed) throw new TenantNotImpersonableError(input.tenantId, status);

  const sessionId = randomUUID();
  // The cap is enforced by a CHECK on the row as well; this keeps the error
  // legible rather than surfacing as a constraint name.
  const minutes = Math.min(input.minutes, MAX_SESSION_MINUTES);

  const inserted = await client.query<{ expires_at: Date; write_enabled: boolean }>(
    `INSERT INTO platform.impersonation_session
       (id, tenant_id, platform_user_id, reason_code, reason_detail,
        write_enabled, write_reason_code, write_reason_detail,
        expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9::int), $10, $11)
     RETURNING expires_at, write_enabled`,
    [
      sessionId,
      input.tenantId,
      input.platformUserId,
      input.reasonCode,
      input.reasonDetail,
      input.write !== undefined,
      input.write?.reasonCode ?? null,
      input.write?.reasonDetail ?? null,
      minutes,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  const row = inserted.rows[0]!;

  // The tenant owner is told. Outbox, not inline: a mail outage must not prevent
  // support from starting a session, and must not silently skip the notice either.
  await enqueue(client, {
    topic: 'tenant.impersonation_started',
    dedupeKey: `${sessionId}:started`,
    payload: {
      tenantId: input.tenantId,
      sessionId,
      platformUserId: input.platformUserId,
      reasonCode: input.reasonCode,
      writeEnabled: input.write !== undefined,
      expiresAt: row.expires_at.toISOString(),
    },
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = signToken(
    {
      typ: IMPERSONATION_TOKEN_TYPE,
      sub: input.platformUserId,
      // NOT `tenant_id`: this shape must be inert against both existing guards.
      act_tenant_id: input.tenantId,
      sid: sessionId,
      write: input.write !== undefined,
      iat: issuedAt,
      exp: Math.floor(row.expires_at.getTime() / 1000),
    },
    key,
  );

  return {
    sessionId,
    token,
    expiresAt: row.expires_at,
    writeEnabled: row.write_enabled,
  };
}

export async function revokeImpersonation(
  client: pg.ClientBase,
  sessionId: string,
  revokedByPlatformUserId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE platform.impersonation_session
        SET revoked_at = now(), revoked_by_platform_user_id = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, revokedByPlatformUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface LiveSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly platformUserId: string;
  readonly platformUserName: string;
  readonly platformUserEmail: string;
  readonly writeEnabled: boolean;
  readonly expiresAt: Date;
  readonly reasonCode: string;
  readonly tenantStatus: string;
}

/**
 * One indexed read, every request, never cached. Server time decides expiry, not
 * the token's `exp`: a clock-skewed or reissued token must not outlive the row.
 */
export async function loadLiveSession(
  client: pg.ClientBase,
  sessionId: string,
): Promise<LiveSession | null> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    platform_user_id: string;
    full_name: string;
    email: string;
    write_enabled: boolean;
    expires_at: Date;
    reason_code: string;
    tenant_status: string;
  }>(
    `SELECT s.id, s.tenant_id, s.platform_user_id, u.full_name, u.email,
            s.write_enabled, s.expires_at, s.reason_code, t.status AS tenant_status
       FROM platform.impersonation_session s
       JOIN platform.platform_user u ON u.id = s.platform_user_id
       JOIN platform.tenant t ON t.id = s.tenant_id
      WHERE s.id = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sessionId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    sessionId: row.id,
    tenantId: row.tenant_id,
    platformUserId: row.platform_user_id,
    platformUserName: row.full_name,
    platformUserEmail: row.email,
    writeEnabled: row.write_enabled,
    expiresAt: row.expires_at,
    reasonCode: row.reason_code,
    tenantStatus: row.tenant_status,
  };
}
