import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * The exception report.
 *
 * ###########################################################################
 * TWO SECTIONS, DERIVED FROM risk_subclass. NEVER AN ENUMERATED KEY LIST.
 *
 * `permission.risk_subclass` is `transaction | configuration`, required exactly
 * when risk_class is financial. The sections read that column, so a financial key
 * added in month nine lands in the right section without anyone editing this
 * file. A hardcoded key list here would be the same defect as OWNER_WITHHELD.
 *
 * PRIVACY-CLASS KEYS ARE NOT IN EITHER SECTION. customer.pii.view and
 * customer.pii.export go to app.pii_access_log with a DPO audience. An owner
 * scanning for till fraud must not have to page through customer lookups, and a
 * privacy log inside a loss-prevention report is a privacy log being used for the
 * wrong thing.
 * ###########################################################################
 */

export type ExceptionSection = 'transaction' | 'configuration';

export interface ExceptionRow {
  readonly action: string;
  readonly section: ExceptionSection;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly branchId: string | null;
  readonly reasonKey: string | null;
  readonly occurredAt: string;
  readonly authorisingMembershipId: string | null;
  readonly viaImpersonation: boolean;
}

export interface ActorAnomaly {
  readonly actorUserId: string;
  readonly actorName: string;
  readonly action: string;
  readonly countInPeriod: number;
  /** Mean per day over the baseline window, for this actor and action. */
  readonly baselinePerDay: number;
  readonly observedPerDay: number;
  /** observed / baseline. Ranked descending; 1.0 is business as usual. */
  readonly lift: number;
}

export interface ExceptionReport {
  readonly transaction: readonly ExceptionRow[];
  readonly configuration: readonly ExceptionRow[];
  /** What a manager is actually scanning for. Ranked, most unusual first. */
  readonly anomalies: readonly ActorAnomaly[];
}

/**
 * Sections come from the catalogue, not from a list in this file.
 *
 * `platform.permission` is immutable reference data seeded by migration, which is
 * why reading it here is a snapshot read and not a live-configuration read: the
 * risk classification of `order.void` does not change under a finished report.
 */
const SECTION_SQL = `
  SELECT p.key, p.risk_subclass
    FROM platform.permission p
   WHERE p.risk_class = 'financial' AND p.risk_subclass IS NOT NULL`;

async function sectionByAction(context: TenantContext): Promise<Map<string, ExceptionSection>> {
  const result = await context.client.query<{ key: string; risk_subclass: ExceptionSection }>(
    SECTION_SQL,
  );
  return new Map(result.rows.map((r) => [r.key, r.risk_subclass]));
}

export interface ExceptionParams {
  readonly branchId?: string | null;
  readonly fromDate: string;
  readonly toDate: string;
  /** Days of history used to establish each actor's own normal. */
  readonly baselineDays?: number;
}

/**
 * ###########################################################################
 * RANKED AGAINST THE ACTOR'S OWN BASELINE, NOT A GLOBAL THRESHOLD.
 *
 * A waiter who voids twice a shift is normal. The one who STARTED voiding twice
 * a shift last Tuesday is the finding. A global threshold reports the first and
 * misses the second, and after a week of reading the first nobody opens the
 * report again -- which is the same reason pre-fire corrections were kept out of
 * the void rows in Phase 3. The value of this report is inversely proportional to
 * the noise in it.
 * ###########################################################################
 */
export async function exceptionReport(
  context: TenantContext,
  params: ExceptionParams,
): Promise<ExceptionReport> {
  const sections = await sectionByAction(context);
  const actions = [...sections.keys()];
  const baselineDays = params.baselineDays ?? 28;

  const rows = await context.client.query<{
    action: string; actor_user_id: string | null; actor_name: string | null;
    branch_id: string | null; reason_key: string | null; occurred_at: string;
    authorising_membership_id: string | null; via_impersonation: boolean;
  }>(
    `SELECT l.action, l.actor_user_id, l.actor_name, l.branch_id,
            l.after ->> 'reason_key' AS reason_key,
            l.occurred_at::text, l.authorising_membership_id,
            l.via_impersonation
       FROM app.tenant_audit_log l
      WHERE l.tenant_id = $1
        AND l.action = ANY($2::text[])
        AND l.occurred_at >= $3::date
        AND l.occurred_at < ($4::date + 1)
        AND ($5::uuid IS NULL OR l.branch_id = $5::uuid)
      ORDER BY l.occurred_at DESC`,
    [context.tenantId, actions, params.fromDate, params.toDate, params.branchId ?? null],
  );

  const mapped: ExceptionRow[] = rows.rows.map((r) => ({
    action: r.action,
    section: sections.get(r.action) ?? 'transaction',
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    branchId: r.branch_id,
    reasonKey: r.reason_key,
    occurredAt: r.occurred_at,
    authorisingMembershipId: r.authorising_membership_id,
    viaImpersonation: r.via_impersonation,
  }));

  const anomalies = await actorAnomalies(context, params, actions, baselineDays);

  return {
    transaction: mapped.filter((r) => r.section === 'transaction'),
    configuration: mapped.filter((r) => r.section === 'configuration'),
    anomalies,
  };
}

async function actorAnomalies(
  context: TenantContext,
  params: ExceptionParams,
  actions: readonly string[],
  baselineDays: number,
): Promise<readonly ActorAnomaly[]> {
  const result = await context.client.query<{
    actor_user_id: string; actor_name: string; action: string;
    in_period: string; baseline_count: string; period_days: string;
  }>(
    `WITH period AS (
       SELECT actor_user_id, max(actor_name) AS actor_name, action, count(*) AS n
         FROM app.tenant_audit_log
        WHERE tenant_id = $1 AND action = ANY($2::text[])
          AND occurred_at >= $3::date AND occurred_at < ($4::date + 1)
          AND ($5::uuid IS NULL OR branch_id = $5::uuid)
          AND actor_user_id IS NOT NULL
        GROUP BY actor_user_id, action
     ),
     baseline AS (
       SELECT actor_user_id, action, count(*) AS n
         FROM app.tenant_audit_log
        WHERE tenant_id = $1 AND action = ANY($2::text[])
          -- The window BEFORE the period. Including the period in its own
          -- baseline would dilute exactly the spike being looked for.
          AND occurred_at >= ($3::date - $6::integer)
          AND occurred_at < $3::date
          AND ($5::uuid IS NULL OR branch_id = $5::uuid)
          AND actor_user_id IS NOT NULL
        GROUP BY actor_user_id, action
     )
     SELECT p.actor_user_id, p.actor_name, p.action,
            p.n::text                            AS in_period,
            COALESCE(b.n, 0)::text               AS baseline_count,
            GREATEST(($4::date - $3::date) + 1, 1)::text AS period_days
       FROM period p
       LEFT JOIN baseline b
         ON b.actor_user_id = p.actor_user_id AND b.action = p.action`,
    [context.tenantId, actions, params.fromDate, params.toDate,
     params.branchId ?? null, baselineDays],
  );

  return result.rows
    .map((r) => {
      const periodDays = Number(r.period_days);
      const observedPerDay = Number(r.in_period) / periodDays;
      const baselinePerDay = Number(r.baseline_count) / baselineDays;
      return {
        actorUserId: r.actor_user_id,
        actorName: r.actor_name,
        action: r.action,
        countInPeriod: Number(r.in_period),
        baselinePerDay,
        observedPerDay,
        // No prior history is not "infinitely unusual" -- a new starter would top
        // the list every time and the report would be useless in their first
        // week. An unseen action is treated as one baseline occurrence.
        lift: observedPerDay / Math.max(baselinePerDay, 1 / baselineDays),
      };
    })
    .filter((a) => a.lift > 1)
    .sort((a, b) => b.lift - a.lift);
}

export interface PiiAccessRow {
  readonly actorUserId: string;
  readonly actorName: string | null;
  readonly permissionKey: string;
  readonly customerId: string | null;
  readonly resultCount: number | null;
  readonly reason: string | null;
  readonly occurredAt: string;
}

/**
 * The DPO's log. A SEPARATE function returning a SEPARATE shape, so there is no
 * call site at which privacy rows could be folded into the exception report by
 * accident.
 */
export async function piiAccessLog(
  context: TenantContext,
  params: { fromDate: string; toDate: string; actorUserId?: string | null },
): Promise<readonly PiiAccessRow[]> {
  const result = await context.client.query<{
    actor_user_id: string; actor_name: string | null; permission_key: string;
    customer_id: string | null; result_count: number | null; reason: string | null;
    occurred_at: string;
  }>(
    `SELECT l.actor_user_id, u.full_name AS actor_name, l.permission_key,
            l.customer_id, l.result_count, l.reason, l.occurred_at::text
       FROM app.pii_access_log l
       LEFT JOIN app.app_user u ON u.tenant_id = l.tenant_id AND u.id = l.actor_user_id
      WHERE l.tenant_id = $1
        AND l.occurred_at >= $2::date AND l.occurred_at < ($3::date + 1)
        AND ($4::uuid IS NULL OR l.actor_user_id = $4::uuid)
      ORDER BY l.occurred_at DESC`,
    [context.tenantId, params.fromDate, params.toDate, params.actorUserId ?? null],
  );

  return result.rows.map((r) => ({
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    permissionKey: r.permission_key,
    customerId: r.customer_id,
    resultCount: r.result_count,
    reason: r.reason,
    occurredAt: r.occurred_at,
  }));
}
