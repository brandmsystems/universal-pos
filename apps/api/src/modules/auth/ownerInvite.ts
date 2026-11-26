import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { adoptTenantContext } from '../../core/database/unitOfWork.js';
import { hashSecret } from './deviceAuth.js';
import { AUTHENTICABLE_TENANT_STATUSES } from './preAuthTenant.js';

/**
 * Redeeming a Restaurant Manager's setup link: the only way a restaurant
 * provisioned from the console ever gets a password.
 *
 * ###########################################################################
 * THE MANAGER SETS THEIR OWN PASSWORD, AND NOBODY ELSE EVER KNOWS IT.
 *
 * CLAUDE.md: "Superadmin cannot set a tenant user's password. Invite token
 * only; the client sets their own." `tenant_owner_invite` stores only the
 * SHA-256 of the token, and provisioning returned the raw token exactly once --
 * but until this function existed nothing could redeem it, so every restaurant
 * created through the console had an owner who could never sign in. Correct,
 * tested, and unreachable, which is this project's most familiar defect.
 * ###########################################################################
 *
 * The rejections are reported to the attempt log verbatim but reach the caller
 * as one uniform refusal, like every other credential route: someone holding a
 * guessed token learns nothing about which of four things was wrong with it.
 */

/** Ten, not the control plane's twelve: this is typed on a restaurant floor. */
export const OWNER_PASSWORD_MIN_LENGTH = 10;

export type OwnerInviteRejection =
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_used'
  | 'tenant_login_blocked';

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** The policy is checked BEFORE the token, so a weak password never becomes a token oracle. */
export function ownerPasswordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < OWNER_PASSWORD_MIN_LENGTH) {
    return `the password must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > 200) return 'the password must be at most 200 characters';
  return null;
}

export type AcceptOwnerInviteResult =
  | { readonly ok: true; readonly tenantId: string; readonly tenantSlug: string;
      readonly userId: string; readonly email: string }
  | { readonly ok: false; readonly reason: OwnerInviteRejection; readonly tenantId: string | null };

export async function acceptOwnerInvite(
  client: pg.ClientBase,
  input: { token: string; password: string },
): Promise<AcceptOwnerInviteResult> {
  if (input.token.length < 20 || input.token.length > 200) {
    return { ok: false, reason: 'invite_invalid', tenantId: null };
  }

  // platform.* carries no RLS, which is what makes this lookup possible before
  // any tenant is known. Locked, so two tabs redeeming the same link cannot
  // both set a password.
  const found = await client.query<{
    id: string; tenant_id: string; email: string; status: string; expired: boolean;
    slug: string; tenant_status: string;
  }>(
    `SELECT i.id, i.tenant_id, i.email::text AS email, i.status, i.expires_at < now() AS expired,
            t.slug::text AS slug, t.status AS tenant_status
       FROM platform.tenant_owner_invite i
       JOIN platform.tenant t ON t.id = i.tenant_id
      WHERE i.token_hash = $1
      FOR UPDATE OF i`,
    [hashInviteToken(input.token)]);
  const invite = found.rows[0];
  if (!invite) return { ok: false, reason: 'invite_invalid', tenantId: null };
  if (invite.status === 'accepted') return { ok: false, reason: 'invite_used', tenantId: invite.tenant_id };
  if (invite.status !== 'pending') return { ok: false, reason: 'invite_invalid', tenantId: invite.tenant_id };
  if (invite.expired) return { ok: false, reason: 'invite_expired', tenantId: invite.tenant_id };
  if (!AUTHENTICABLE_TENANT_STATUSES.includes(invite.tenant_status)) {
    return { ok: false, reason: 'tenant_login_blocked', tenantId: invite.tenant_id };
  }

  // From here on the writes are to schema `app`, under the tenant the INVITE
  // names -- never one the request supplied.
  const tenant = await adoptTenantContext(client, invite.tenant_id);
  const user = await tenant.client.query<{ id: string }>(
    `SELECT id FROM app.app_user WHERE tenant_id = $1 AND email = $2 FOR UPDATE`,
    [invite.tenant_id, invite.email]);
  const userId = user.rows[0]?.id;
  if (userId === undefined) return { ok: false, reason: 'invite_invalid', tenantId: invite.tenant_id };

  await tenant.client.query(
    `UPDATE app.credential SET status = 'revoked', revoked_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'password' AND status = 'active'`,
    [invite.tenant_id, userId]);
  await tenant.client.query(
    `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash)
     VALUES ($1, $2, $3, 'password', $4)`,
    [randomUUID(), invite.tenant_id, userId, await hashSecret(input.password)]);
  // Only an INVITED user is switched on. A manager whose account was suspended
  // since the invite went out stays suspended; a setup link is not a pardon.
  await tenant.client.query(
    `UPDATE app.app_user SET status = 'active' WHERE tenant_id = $1 AND id = $2 AND status = 'invited'`,
    [invite.tenant_id, userId]);
  await client.query(
    `UPDATE platform.tenant_owner_invite
        SET status = 'accepted', accepted_at = now(), accepted_user_id = $2
      WHERE id = $1`,
    [invite.id, userId]);

  return { ok: true, tenantId: invite.tenant_id, tenantSlug: invite.slug, userId, email: invite.email };
}
