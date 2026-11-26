import { randomUUID } from 'node:crypto';
import { publishAndAnnounce } from '../platform/entitlements.js';
import type pg from 'pg';
import { openSegment, directionOfChange } from './segments.js';

/**
 * Scheduled contractions, and the over-quota ruling.
 *
 * Upgrades and seat increases never reach this module: they open a segment
 * immediately. Only contractions are scheduled, and the whole point of scheduling
 * them is that no unused value ever exists to refund, credit or forfeit.
 */

export class PendingChangeExistsError extends Error {
  readonly statusCode = 409;
  readonly code = 'pending_change_exists';
  constructor(readonly subscriptionId: string) {
    super(
      `subscription ${subscriptionId} already has a pending change. A queue of ` +
        'contradictory scheduled downgrades has no defensible resolution order.',
    );
    this.name = 'PendingChangeExistsError';
  }
}

export interface ScheduledChange {
  readonly id: string;
  readonly kind: 'downgrade' | 'seat_decrease';
  readonly effectiveAt: Date;
  readonly targetPlanVersionId: string | null;
  readonly targetQuantity: number | null;
}

/**
 * A scheduled change is VISIBLE and REVOCABLE.
 *
 * A tenant who downgrades by mistake and discovers it at renewal has a legitimate
 * complaint, and "you clicked it six weeks ago" is not an answer. So the pending
 * change is queryable for display and can be withdrawn at any point before the
 * boundary.
 */
export async function scheduleContraction(
  client: pg.ClientBase,
  params: {
    tenantId: string;
    subscriptionId: string;
    kind: 'downgrade' | 'seat_decrease';
    targetPlanId?: string;
    targetPlanVersionId?: string;
    targetQuantity?: number;
    requestedByUserId?: string | null;
  },
): Promise<ScheduledChange> {
  const sub = (await client.query<{ current_period_end: string }>(
    `SELECT current_period_end::text FROM platform.subscription WHERE id = $1`,
    [params.subscriptionId],
  )).rows[0];
  if (!sub) throw new Error(`subscription ${params.subscriptionId} not found`);

  const existing = await client.query(
    `SELECT 1 FROM platform.scheduled_subscription_change
      WHERE subscription_id = $1 AND status = 'pending'`,
    [params.subscriptionId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new PendingChangeExistsError(params.subscriptionId);
  }

  const id = randomUUID();
  await client.query(
    `INSERT INTO platform.scheduled_subscription_change
       (id, tenant_id, subscription_id, kind, target_plan_id, target_plan_version_id,
        target_quantity, effective_at, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9)`,
    [id, params.tenantId, params.subscriptionId, params.kind,
     params.targetPlanId ?? null, params.targetPlanVersionId ?? null,
     params.targetQuantity ?? null, sub.current_period_end,
     params.requestedByUserId ?? null],
  );

  return {
    id, kind: params.kind,
    effectiveAt: new Date(sub.current_period_end),
    targetPlanVersionId: params.targetPlanVersionId ?? null,
    targetQuantity: params.targetQuantity ?? null,
  };
}

export async function pendingChangeFor(
  client: pg.ClientBase,
  subscriptionId: string,
): Promise<ScheduledChange | null> {
  const r = await client.query<{
    id: string; kind: 'downgrade' | 'seat_decrease'; effective_at: string;
    target_plan_version_id: string | null; target_quantity: number | null;
  }>(
    `SELECT id, kind, effective_at::text, target_plan_version_id, target_quantity
       FROM platform.scheduled_subscription_change
      WHERE subscription_id = $1 AND status = 'pending'`,
    [subscriptionId],
  );
  const row = r.rows[0];
  return row ? {
    id: row.id, kind: row.kind, effectiveAt: new Date(row.effective_at),
    targetPlanVersionId: row.target_plan_version_id,
    targetQuantity: row.target_quantity,
  } : null;
}

export async function revokeScheduledChange(
  client: pg.ClientBase,
  params: { changeId: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE platform.scheduled_subscription_change
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [params.changeId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface QuotaBreach {
  readonly metric: string;
  readonly current: number;
  readonly allowed: number;
}

/**
 * Reads platform.usage_counter -- the daily rollup -- NEVER schema `app`.
 *
 * The control plane does not query tenant data. Usage flows up as aggregates and
 * this is where it is consumed.
 */
export async function quotaBreachesForPlan(
  client: pg.ClientBase,
  params: { tenantId: string; planVersionId: string; periodDays?: number },
): Promise<readonly QuotaBreach[]> {
  const limits = (await client.query<{ limits: Record<string, number> }>(
    `SELECT limits FROM platform.plan_version WHERE id = $1`, [params.planVersionId],
  )).rows[0]?.limits ?? {};

  // ######################################################################
  // A LEVEL IS READ; A FLOW IS SUMMED.
  //
  // `branches` is a stock -- the latest row IS the current value. `orders.created`
  // is a rate, and taking its latest row compares one day against a monthly
  // limit: at 300 orders a day against a limit of 10,000 a month, the tenant is
  // nine thousand over and reads as comfortably inside.
  //
  // metric_kind is pinned from platform.usage_metric, so this cannot be decided
  // by guessing from the metric's name.
  // ######################################################################
  const usage = await client.query<{ metric: string; value: string }>(
    `WITH levels AS (
       SELECT DISTINCT ON (metric) metric, value
         FROM platform.usage_counter
        WHERE tenant_id = $1 AND metric_kind = 'level'
        ORDER BY metric, as_of_date DESC
     ),
     flows AS (
       SELECT metric, SUM(value) AS value
         FROM platform.usage_counter
        WHERE tenant_id = $1 AND metric_kind = 'flow'
          AND as_of_date > (CURRENT_DATE - $2::integer)
        GROUP BY metric
     )
     SELECT metric, value::text FROM levels
     UNION ALL
     SELECT metric, value::text FROM flows`,
    [params.tenantId, params.periodDays ?? 30],
  );

  const breaches: QuotaBreach[] = [];
  for (const row of usage.rows) {
    const allowed = limits[row.metric];
    if (typeof allowed !== 'number') continue;
    const current = Number(row.value);
    if (current > allowed) breaches.push({ metric: row.metric, current, allowed });
  }
  return breaches;
}

export interface ApplyResult {
  readonly changeId: string;
  readonly outcome: 'applied' | 'failed';
  readonly breaches?: readonly QuotaBreach[];
}

/**
 * ###########################################################################
 * THE OVER-QUOTA RULING.
 *
 * A downgrade that would leave the tenant above the target plan's limits FAILS TO
 * APPLY. The subscription stays on the current plan and the tenant is notified.
 *
 * It does not shrink entitlements and hope. The entitlement document fails
 * closed, so over-quota already means "cannot ADD a branch" -- but if enforcement
 * reached EXISTING branches, applying this downgrade would silently disable two
 * locations that are open and trading. A billing job must never take a restaurant
 * offline.
 * ###########################################################################
 */
export async function applyDueChanges(
  client: pg.ClientBase,
  params: { now: Date },
): Promise<readonly ApplyResult[]> {
  const due = await client.query<{
    id: string; tenant_id: string; subscription_id: string;
    kind: 'downgrade' | 'seat_decrease';
    target_plan_id: string | null; target_plan_version_id: string | null;
    target_quantity: number | null;
  }>(
    `SELECT id, tenant_id, subscription_id, kind, target_plan_id, target_plan_version_id,
            target_quantity
       FROM platform.scheduled_subscription_change
      WHERE status = 'pending' AND effective_at <= $1
      ORDER BY effective_at`,
    [params.now],
  );

  const results: ApplyResult[] = [];

  for (const change of due.rows) {
    const current = (await client.query<{
      plan_id: string; plan_version_id: string; quantity: number;
    }>(
      `SELECT s.plan_id, s.plan_version_id,
              COALESCE((SELECT quantity FROM platform.subscription_segment
                         WHERE subscription_id = s.id AND ends_at IS NULL), 1) AS quantity
         FROM platform.subscription s WHERE s.id = $1`,
      [change.subscription_id],
    )).rows[0]!;

    const targetVersionId = change.target_plan_version_id ?? current.plan_version_id;
    const breaches = await quotaBreachesForPlan(client, {
      tenantId: change.tenant_id, planVersionId: targetVersionId,
    });

    if (breaches.length > 0) {
      const detail = breaches
        .map((b) => `${b.metric}: ${b.current} in use, ${b.allowed} allowed`)
        .join('; ');
      await client.query(
        `UPDATE platform.scheduled_subscription_change
            SET status = 'failed', failure_reason = $2
          WHERE id = $1`,
        [change.id,
         `downgrade not applied -- the tenant is over the target plan's limits (${detail}). ` +
         'The subscription stays on its current plan; applying this would have disabled ' +
         'resources that are in use.'],
      );
      // Notification via the outbox, never inline.
      await client.query(
        `INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
         VALUES ($1, 'billing.downgrade_blocked', $2, $3::jsonb)
         ON CONFLICT (topic, dedupe_key) DO NOTHING`,
        [randomUUID(), change.id,
         JSON.stringify({ changeId: change.id, tenantId: change.tenant_id, breaches })],
      );
      results.push({ changeId: change.id, outcome: 'failed', breaches });
      continue;
    }

    await openSegment(client, {
      tenantId: change.tenant_id,
      subscriptionId: change.subscription_id,
      planId: change.target_plan_id ?? current.plan_id,
      planVersionId: targetVersionId,
      quantity: change.target_quantity ?? current.quantity,
      at: params.now,
    });

    if (change.target_plan_version_id) {
      await client.query(
        `UPDATE platform.subscription
            SET plan_id = $2, plan_version_id = $3, updated_at = now()
          WHERE id = $1`,
        [change.subscription_id, change.target_plan_id, change.target_plan_version_id],
      );
      await publishAndAnnounce(client, change.tenant_id, 'scheduled plan change applied');
    }

    await client.query(
      `UPDATE platform.scheduled_subscription_change
          SET status = 'applied', applied_at = now() WHERE id = $1`,
      [change.id],
    );
    results.push({ changeId: change.id, outcome: 'applied' });
  }

  return results;
}

/** Expansions bypass scheduling entirely: they take effect at once. */
export async function applyExpansion(
  client: pg.ClientBase,
  params: {
    tenantId: string; subscriptionId: string;
    planId: string; planVersionId: string; quantity: number;
    currentPriceMinor: number; currentQuantity: number; targetPriceMinor: number;
    at: Date;
  },
): Promise<{ segmentId: string }> {
  const direction = directionOfChange(
    { planPriceMinor: params.currentPriceMinor, quantity: params.currentQuantity },
    { planPriceMinor: params.targetPriceMinor, quantity: params.quantity },
  );
  if (direction !== 'expand') {
    throw new Error(
      'a contraction must be scheduled to the period boundary, not applied immediately',
    );
  }

  const { segmentId } = await openSegment(client, {
    tenantId: params.tenantId, subscriptionId: params.subscriptionId,
    planId: params.planId, planVersionId: params.planVersionId,
    quantity: params.quantity, at: params.at,
  });

  await client.query(
    `UPDATE platform.subscription
        SET plan_id = $2, plan_version_id = $3, updated_at = now() WHERE id = $1`,
    [params.subscriptionId, params.planId, params.planVersionId],
  );
  await publishAndAnnounce(client, params.tenantId, 'plan upgraded');

  return { segmentId };
}
