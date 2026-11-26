import { PLAN_LIMITS, type PlanLimit } from '@katkitchen/shared';
import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * How much of a plan limit a restaurant is using right now, counted inside the
 * request's own transaction.
 *
 * ###########################################################################
 * THE COUNT IS SERIALISED, OR THE LIMIT IS A SUGGESTION.
 *
 * Two managers adding a branch at once on a one-branch plan would each count
 * zero and each insert. A transaction-scoped advisory lock per (tenant, limit)
 * makes the second request wait until the first commits, so it counts the
 * first one's row. Transaction-scoped rather than session-scoped because the
 * request runs through the transaction-mode pooler, which hands a session away
 * at COMMIT; an xact lock is released at exactly that moment and no other.
 *
 * Devices count what is enrolled AND what could still be enrolled: an unused
 * enrolment token becomes a device whenever someone types it in, and the
 * public enrolment route has no plan to check against. So the limit is spent
 * when the token is issued, and handed back if it expires unused.
 * ###########################################################################
 */
/**
 * One count per limit, keyed by the limit itself: a `Record<PlanLimit, ...>`
 * does not compile until every limit has one. The ternary this replaced read
 * "branches, or else devices", so a third limit would have been counted as
 * tablets with every test still green.
 *
 * Users count accounts that can sign in or are about to (active, invited) and
 * staff invites not yet accepted:
 * an invite becomes an account whenever someone redeems it, on a route with no
 * plan to check -- the same reasoning as unused tablet setup codes. A switched-
 * off or archived account does not count; switching one back on is checked
 * where it happens (`toggleAccess`).
 */
const COUNTS: Readonly<Record<PlanLimit, string>> = {
  branches: `SELECT count(*)::text AS n FROM app.branch WHERE tenant_id = $1 AND status = 'active'`,
  devices: `SELECT (
      (SELECT count(*) FROM app.device WHERE tenant_id = $1 AND status = 'active')
    + (SELECT count(*) FROM app.device_enrolment
        WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now())
    )::text AS n`,
  users: `SELECT (
      (SELECT count(*) FROM app.app_user WHERE tenant_id = $1 AND status IN ('active', 'invited'))
    + (SELECT count(*) FROM app.staff_invite
        WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now())
    )::text AS n`,
};

async function count(context: TenantContext, limit: PlanLimit): Promise<number> {
  const counted = await context.client.query<{ n: string }>(COUNTS[limit], [context.tenantId]);
  return Number(counted.rows[0]!.n);
}

/** For a write that is about to add one: serialised, so two adds cannot both see room. */
export async function planUsage(context: TenantContext, limit: PlanLimit): Promise<number> {
  await context.client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`plan-limit:${context.tenantId}:${limit}`],
  );
  return count(context, limit);
}

/**
 * Every limit's current usage, for the admin to SHOW ("3 of 4 users"). No lock:
 * a page view must never queue behind a write, and a figure that is a moment
 * stale only decides what a button says -- the write is still counted under
 * the lock and refused by the server.
 */
export async function usageNow(context: TenantContext): Promise<Record<PlanLimit, number>> {
  const out = {} as Record<PlanLimit, number>;
  for (const limit of PLAN_LIMITS) out[limit] = await count(context, limit);
  return out;
}
