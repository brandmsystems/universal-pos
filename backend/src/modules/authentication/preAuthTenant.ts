import type pg from 'pg';

/**
 * Resolving a tenant before there is a token to read one from.
 *
 * ###########################################################################
 * THE ONE PLACE A TENANT ID MAY COME FROM SOMETHING OTHER THAN A VERIFIED JWT.
 *
 * `tenantContext.ts` states the rule the whole isolation model rests on: a
 * tenant id is only ever populated from a verified JWT, never from a body, query
 * param or header. A login has no JWT -- that is what a login is for -- so the
 * pre-auth surface needed an explicit, narrow exception rather than a quiet one.
 *
 * DECIDED (CLAUDE.md): the tenant comes from the PATH for credential
 * presentation (`/api/auth/:tenantSlug/...`) and from the TOKEN ITSELF for
 * enrolment (`<slug>.<secret>`). Refresh needs neither: its tenant comes from
 * the verified refresh token, so it stays on the original rule.
 *
 * Why a slug and not a tenant id: a uuid in a URL is an oracle -- it either
 * resolves or it does not, and it is guessable in bulk. A slug is already public
 * (it is how the tenant is addressed), already unique, already format-checked by
 * `tenant_slug_format`, and already something a staff member can type.
 *
 * Nothing here authorises anything. Resolving a tenant only decides which
 * tenant's credentials the presented secret will be verified against, and the
 * verification is unchanged.
 * ###########################################################################
 */

export type TenantAuthRefusal = 'tenant_unknown' | 'tenant_login_blocked';

/**
 * ###########################################################################
 * AN ALLOWLIST, BECAUSE A BLOCKLIST FAILS OPEN.
 *
 * `tenant_status_known` permits seven values today. A blocklist naming
 * `hard_lock`, `retention`, `purge_pending`, `purged` would silently admit an
 * eighth status somebody adds later -- the same polarity mistake as the
 * reporting table gate and `OWNER_WITHHELD`.
 *
 * The three below are the ladder as CLAUDE.md specifies it: `soft_lock` is
 * "read-only, no new orders", which still requires being able to log in and see
 * why; `hard_lock` is "login blocked, data intact", which is this list's
 * boundary. A new status is refused authentication until someone justifies it
 * here, and refusing is the safe direction.
 * ###########################################################################
 */
export const AUTHENTICABLE_TENANT_STATUSES: readonly string[] = [
  'active',
  'past_due',
  'soft_lock',
];

export interface ResolvedTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly status: string;
}

/**
 * The same allowlist, re-applied at REFRESH. Login is not the only moment a
 * session is granted: a refresh mints a new access token, and without this a
 * restaurant deactivated (or hard-locked) after its tablets signed in kept
 * them working for the whole twelve-hour refresh window.
 */
export async function tenantStillAuthenticable(
  client: pg.ClientBase,
  tenantId: string,
): Promise<boolean> {
  const found = await client.query<{ status: string }>(
    `SELECT status FROM platform.tenant WHERE id = $1`, [tenantId]);
  const status = found.rows[0]?.status;
  return status !== undefined && AUTHENTICABLE_TENANT_STATUSES.includes(status);
}

/**
 * `tenant_slug_format` caps a slug at 63 characters. Bounded here so a
 * pathological path segment never reaches the query -- NOT re-validated here,
 * because a second copy of that regex is a second thing to keep in step with the
 * CHECK. A slug that the CHECK would have rejected simply does not resolve.
 */
const SLUG_MAX = 63;

export async function resolveTenantForAuth(
  client: pg.ClientBase,
  slug: string,
): Promise<{ tenant: ResolvedTenant } | { refusal: TenantAuthRefusal }> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > SLUG_MAX) {
    return { refusal: 'tenant_unknown' };
  }

  // platform.tenant carries no RLS, which is what makes this reachable with no
  // tenant GUC set. It is a control-plane read, and it returns one row or none.
  const found = await client.query<{ id: string; slug: string; status: string }>(
    // The CURRENT slug or a former one (0073): a tablet set up before a rename,
    // and a setup code issued before it, still reach their restaurant.
    `SELECT id, slug::text AS slug, status
       FROM platform.tenant
      WHERE id = platform.tenant_id_for_slug($1)`,
    [slug],
  );

  const row = found.rows[0];
  if (!row) return { refusal: 'tenant_unknown' };
  if (!AUTHENTICABLE_TENANT_STATUSES.includes(row.status)) {
    return { refusal: 'tenant_login_blocked' };
  }
  return { tenant: { tenantId: row.id, slug: row.slug, status: row.status } };
}
