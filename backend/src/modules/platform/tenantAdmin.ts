import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { publishAndAnnounce } from './entitlements.js';
import { addressOf, checkedLogo, logoUrl, themeColorOf } from './branding.js';
import { adoptTenantContext } from '../../core/database/unitOfWork.js';
import { checkedBusinessType } from './provisioning.js';

/**
 * A Super Admin's (and, for editing, a Salesperson's) hand on a restaurant
 * record. Control plane only: every statement here reads or writes schema
 * `platform`, same boundary as `directory.ts`.
 */

export class BusinessTypeLockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'business_type_locked';
  constructor(readonly orders: number) {
    super(`this business has taken ${orders} order(s), so its type is fixed: what it sold was recorded under one kind of business. A different kind of business is set up as a new tenant.`);
    this.name = 'BusinessTypeLockedError';
  }
}

export class TenantUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'restaurant_unknown';
  constructor(tenantId: string) {
    super(`no restaurant has the id ${tenantId}`);
    this.name = 'TenantUnknownError';
  }
}

/**
 * Deactivation is refused from anywhere but `active`.
 *
 * A tenant on the ladder has a day 0, and `tenant_delinquency_consistent` says
 * a deactivated tenant has none -- so switching one off would have to clear
 * day 0, and the debt would vanish from dunning with it. A delinquent tenant is
 * already losing access on the ladder's own schedule.
 */
export class TenantNotDeactivatableError extends Error {
  readonly statusCode = 409;
  readonly code = 'tenant_not_deactivatable';
  constructor(readonly status: string) {
    super(
      `only an active restaurant can be deactivated; this one is ${status}. A `
      + 'restaurant behind on payment is already on the suspension ladder, and '
      + 'deactivating it would erase the date it fell behind.',
    );
    this.name = 'TenantNotDeactivatableError';
  }
}

export class TenantNotDeactivatedError extends Error {
  readonly statusCode = 409;
  readonly code = 'tenant_not_deactivated';
  constructor(readonly status: string) {
    super(`this restaurant is ${status}, not deactivated, so there is nothing to reactivate.`);
    this.name = 'TenantNotDeactivatedError';
  }
}

export class ReasonRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'reason_required';
  constructor() {
    super('a reason of at least three characters is required, and it is kept on the record.');
    this.name = 'ReasonRequiredError';
  }
}

export class TenantEditInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'tenant_edit_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'TenantEditInvalidError';
  }
}

/**
 * The scoping rule `listTenants` applies to a Salesperson, applied to a write.
 * A tenant outside their book is answered as UNKNOWN, not forbidden: the list
 * does not show it to them, and a 403 would confirm it exists.
 */
async function lockTenant(
  client: pg.ClientBase,
  tenantId: string,
  provisionedByPlatformUserId: string | undefined,
): Promise<{ status: string }> {
  const found = await client.query<{ status: string }>(
    `SELECT t.status
       FROM platform.tenant t
       LEFT JOIN platform.provisioning_request pr ON pr.tenant_id = t.id
      WHERE t.id = $1
        AND ($2::uuid IS NULL OR pr.requested_by_platform_user_id = $2::uuid)
      FOR UPDATE OF t`,
    [tenantId, provisionedByPlatformUserId ?? null]);
  const row = found.rows[0];
  if (!row) throw new TenantUnknownError(tenantId);
  return row;
}

function reasonOf(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length < 3) throw new ReasonRequiredError();
  return reason.trim();
}

/**
 * Name, legal name, address and theme colour. The slug is deliberately not
 * editable: it is the path segment every tablet and every staff login is
 * addressed by (`/api/auth/:tenantSlug/...`), so renaming it would sign a
 * restaurant out of every device it owns.
 */
export async function editTenant(
  client: pg.ClientBase,
  input: {
    tenantId: string;
    name?: unknown;
    legalName?: unknown;
    address?: unknown;
    themeColor?: unknown;
    themeColorSecondary?: unknown;
    businessType?: unknown;
    provisionedByPlatformUserId?: string | undefined;
  },
): Promise<{
  tenantId: string; name: string; legalName: string | null;
  address: string | null; themeColor: string | null; themeColorSecondary: string | null;
  businessType: string;
}> {
  await lockTenant(client, input.tenantId, input.provisionedByPlatformUserId);
  const sets: string[] = [];
  const values: unknown[] = [input.tenantId];
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length < 2
      || input.name.trim().length > 120) {
      throw new TenantEditInvalidError('name must be 2 to 120 characters.');
    }
    values.push(input.name.trim());
    sets.push(`name = $${values.length}`);
  }
  if (input.legalName !== undefined) {
    if (input.legalName !== null && (typeof input.legalName !== 'string'
      || input.legalName.trim().length > 200)) {
      throw new TenantEditInvalidError('legalName must be text of at most 200 characters, or null.');
    }
    const legal = typeof input.legalName === 'string' && input.legalName.trim() !== ''
      ? input.legalName.trim() : null;
    values.push(legal);
    sets.push(`legal_name = $${values.length}`);
  }
  const address = addressOf(input.address);
  if (address !== undefined) {
    values.push(address);
    sets.push(`address = $${values.length}`);
  }
  const themeColor = themeColorOf(input.themeColor);
  if (themeColor !== undefined) {
    values.push(themeColor);
    sets.push(`theme_color = $${values.length}`);
  }
  const themeColorSecondary = themeColorOf(input.themeColorSecondary, 'themeColorSecondary');
  if (themeColorSecondary !== undefined) {
    values.push(themeColorSecondary);
    sets.push(`theme_color_secondary = $${values.length}`);
  }
  if (input.businessType !== undefined) {
    if (typeof input.businessType !== 'string') throw new TenantEditInvalidError('businessType must be a registry key.');
    const next = checkedBusinessType(input.businessType);
    const current = await client.query<{ business_type: string }>(
      `SELECT business_type FROM platform.tenant WHERE id = $1`, [input.tenantId]);
    if (current.rows[0]!.business_type !== next) {
      // Fixed once the business has taken an order: what it sold was recorded
      // under one kind of business, and a change would relabel its history.
      await adoptTenantContext(client, input.tenantId);
      const orders = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.table_session WHERE tenant_id = $1`, [input.tenantId]);
      if (Number(orders.rows[0]!.n) > 0) throw new BusinessTypeLockedError(Number(orders.rows[0]!.n));
      values.push(next);
      sets.push(`business_type = $${values.length}`);
    }
  }
  if (sets.length === 0) {
    throw new TenantEditInvalidError('nothing to change: send name, legalName, address, themeColor, themeColorSecondary or businessType.');
  }

  const updated = await client.query<{
    name: string; legal_name: string | null; address: string | null; theme_color: string | null;
    theme_color_secondary: string | null; business_type: string;
  }>(
    `UPDATE platform.tenant SET ${sets.join(', ')} WHERE id = $1
     RETURNING name, legal_name, address, theme_color, theme_color_secondary, business_type`,
    values);
  const row = updated.rows[0]!;
  return {
    tenantId: input.tenantId, name: row.name, legalName: row.legal_name,
    address: row.address, themeColor: row.theme_color, themeColorSecondary: row.theme_color_secondary,
    businessType: row.business_type,
  };
}

/**
 * The entitlement document is republished in the SAME transaction, and the
 * tenant plane's cache is told through the outbox -- the dunning recovery path
 * does exactly this, for the same reason: a status change the tablets do not
 * hear about is a status change that has not happened yet. A deactivated
 * tenant's document maps to `suspended`, which denies every write path.
 */
/**
 * Sets or replaces the restaurant's logo. Scoped like the edit: a Sales Person
 * may change only a restaurant they sold. The image is in the response nowhere
 * -- only its versioned public URL.
 */
export async function setTenantLogo(
  client: pg.ClientBase,
  input: {
    tenantId: string;
    contentType?: unknown;
    dataBase64?: unknown;
    byPlatformUserId: string;
    provisionedByPlatformUserId?: string | undefined;
  },
): Promise<{ tenantId: string; logoUrl: string | null }> {
  await lockTenant(client, input.tenantId, input.provisionedByPlatformUserId);
  const logo = checkedLogo(input);
  await client.query(
    `INSERT INTO platform.tenant_logo (tenant_id, content_type, bytes, sha256, updated_by_platform_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE
       SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
           updated_at = now(), updated_by_platform_user_id = EXCLUDED.updated_by_platform_user_id`,
    [input.tenantId, logo.contentType, logo.bytes, logo.sha256, input.byPlatformUserId]);
  const slug = (await client.query<{ slug: string }>(
    `SELECT slug::text AS slug FROM platform.tenant WHERE id = $1`, [input.tenantId])).rows[0]!.slug;
  return { tenantId: input.tenantId, logoUrl: logoUrl(slug, logo.sha256) };
}

export async function removeTenantLogo(
  client: pg.ClientBase,
  input: { tenantId: string; provisionedByPlatformUserId?: string | undefined },
): Promise<{ tenantId: string; logoUrl: null; removed: boolean }> {
  await lockTenant(client, input.tenantId, input.provisionedByPlatformUserId);
  const removed = await client.query(
    `DELETE FROM platform.tenant_logo WHERE tenant_id = $1`, [input.tenantId]);
  return { tenantId: input.tenantId, logoUrl: null, removed: (removed.rowCount ?? 0) > 0 };
}

async function republish(client: pg.ClientBase, tenantId: string, reason: string): Promise<void> {
  await publishAndAnnounce(client, tenantId, reason);
}

export async function deactivateTenant(
  client: pg.ClientBase,
  input: { tenantId: string; reason: unknown; deactivatedByPlatformUserId: string },
): Promise<{ tenantId: string; status: 'deactivated'; reason: string }> {
  const reason = reasonOf(input.reason);
  const { status } = await lockTenant(client, input.tenantId, undefined);
  if (status !== 'active') throw new TenantNotDeactivatableError(status);
  await client.query(
    `UPDATE platform.tenant
        SET status = 'deactivated', status_changed_at = now(),
            deactivated_at = now(), deactivation_reason = $2,
            deactivated_by_platform_user_id = $3
      WHERE id = $1`,
    [input.tenantId, reason, input.deactivatedByPlatformUserId]);
  await republish(client, input.tenantId, `deactivated: ${reason}`);
  return { tenantId: input.tenantId, status: 'deactivated', reason };
}

export async function reactivateTenant(
  client: pg.ClientBase,
  input: { tenantId: string; reason: unknown },
): Promise<{ tenantId: string; status: 'active'; reason: string }> {
  const reason = reasonOf(input.reason);
  const { status } = await lockTenant(client, input.tenantId, undefined);
  if (status !== 'deactivated') throw new TenantNotDeactivatedError(status);
  await client.query(
    `UPDATE platform.tenant
        SET status = 'active', status_changed_at = now(),
            deactivated_at = NULL, deactivation_reason = NULL,
            deactivated_by_platform_user_id = NULL
      WHERE id = $1`,
    [input.tenantId]);
  await republish(client, input.tenantId, `reactivated: ${reason}`);
  return { tenantId: input.tenantId, status: 'active', reason };
}

/* ------------------------------------------------------------ setup links --- */

export class OwnerResetReasonRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'owner_reset_reason_required';
  constructor() {
    super('the Restaurant Manager has already signed up, so a new setup link resets their '
      + 'password. Give a reason of at least 3 characters; it is kept on record.');
    this.name = 'OwnerResetReasonRequiredError';
  }
}

export class OwnerInviteMissingError extends Error {
  readonly statusCode = 409;
  readonly code = 'owner_invite_missing';
  constructor() {
    super('this restaurant has no owner invite on record to re-issue.');
    this.name = 'OwnerInviteMissingError';
  }
}

/**
 * A fresh setup link for the Restaurant Manager, replacing any still pending.
 *
 * The raw token is returned ONCE and never stored: only its SHA-256 reaches the
 * database, exactly as provisioning does it. The route that serves this must
 * therefore never record its result in an audit row -- it declares no
 * `afterIsResult`, on purpose.
 *
 * Once the manager has signed up, a new link RESETS their password -- the
 * decision (migration 0058) is to allow that, because a manager locked out of
 * their own restaurant needs a way back in, but never silently: a reason is
 * required and stored on the invite row with who issued it. The existing
 * password keeps working until the new link is used; using it replaces the
 * password (see acceptOwnerInvite).
 */
export async function reissueOwnerInvite(
  client: pg.ClientBase,
  input: {
    tenantId: string;
    invitedByPlatformUserId: string;
    provisionedByPlatformUserId?: string | undefined;
    /** Required once the manager has signed up (it is then a password reset). */
    reason?: unknown;
  },
): Promise<{ inviteToken: string; email: string; expiresAt: string; isReset: boolean }> {
  await lockTenant(client, input.tenantId, input.provisionedByPlatformUserId);
  const invites = await client.query<{
    email: string; status: string; invitee_name: string | null; invitee_phone: string | null;
  }>(
    `SELECT email::text AS email, status, invitee_name, invitee_phone
       FROM platform.tenant_owner_invite
      WHERE tenant_id = $1 ORDER BY created_at DESC`, [input.tenantId]);
  const isReset = invites.rows.some((row) => row.status === 'accepted');
  const reason = typeof input.reason === 'string' && input.reason.trim().length >= 3
    ? input.reason.trim() : null;
  if (isReset && reason === null) throw new OwnerResetReasonRequiredError();
  const email = invites.rows[0]?.email;
  if (email === undefined) throw new OwnerInviteMissingError();

  await client.query(
    `UPDATE platform.tenant_owner_invite SET status = 'revoked'
      WHERE tenant_id = $1 AND status = 'pending'`, [input.tenantId]);
  const inviteToken = randomBytes(32).toString('base64url');
  const inserted = await client.query<{ expires_at: string }>(
    `INSERT INTO platform.tenant_owner_invite
       (id, tenant_id, email, token_hash, expires_at, invited_by_platform_user_id,
        invitee_name, invitee_phone, reissue_reason)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, $6, $7, $8)
     RETURNING expires_at::text`,
    [randomUUID(), input.tenantId, email,
     createHash('sha256').update(inviteToken).digest(), input.invitedByPlatformUserId,
     invites.rows[0]?.invitee_name ?? null, invites.rows[0]?.invitee_phone ?? null, reason]);
  return { inviteToken, email, expiresAt: inserted.rows[0]!.expires_at, isReset };
}
