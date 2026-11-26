import type pg from 'pg';
import { directionOfChange } from './segments.js';
import { applyExpansion, scheduleContraction, type ScheduledChange } from './scheduledChange.js';

/**
 * A requested subscription change, routed to the arm the asymmetry demands.
 *
 * ###########################################################################
 * THE DIRECTION IS DECIDED HERE, NOT BY THE CALLER.
 *
 * `applyExpansion` and `scheduleContraction` were both built, both tested, and
 * had no caller that could pick between them -- and picking is the whole rule:
 * expansions take effect immediately, contractions wait for the period boundary
 * so that no unused value ever exists to refund, credit or forfeit.
 *
 * A route handler must not make that decision. It needs the CURRENT plan price
 * and the CURRENT seat count to compute the direction, which means reading the
 * live plan version and the open segment -- exactly the "route layer takes its
 * own snapshot" defect the thin-handler gate exists to prevent. Worse, the
 * handler would be the only place the rule lived, so a second caller (a
 * self-service upgrade on the tenant plane, a migration script) would get the
 * arms the wrong way round and back-date a downgrade.
 *
 * `applyExpansion` re-checks the direction with the same function and throws if
 * it disagrees. Two independent computations of one rule is deliberate here: the
 * cheap one guards against this module passing a contraction into the immediate
 * arm.
 * ###########################################################################
 */

export class SubscriptionNotLiveError extends Error {
  readonly code = 'subscription_not_live';
  constructor(readonly subscriptionId: string, readonly status: string) {
    super(
      `subscription ${subscriptionId} is ${status}. A cancelled or expired subscription ` +
        'is a closed commercial record; re-selling means creating a new one, not editing ' +
        'the shape of one that already ended.',
    );
    this.name = 'SubscriptionNotLiveError';
  }
}

export class PlanVersionNotPublishedError extends Error {
  readonly code = 'plan_version_not_published';
  constructor(readonly planVersionId: string) {
    super(
      `plan version ${planVersionId} has no published_at. A draft version has no price ` +
        'anybody agreed to, and a subscription pinned to one would invoice from a figure ' +
        'that was still being edited.',
    );
    this.name = 'PlanVersionNotPublishedError';
  }
}

export class PlanVersionUnknownError extends Error {
  readonly code = 'plan_version_unknown';
  constructor(readonly planVersionId: string) {
    super(`no plan version ${planVersionId}`);
    this.name = 'PlanVersionUnknownError';
  }
}

export class NoChangeRequestedError extends Error {
  readonly code = 'plan_change_is_a_no_op';
  constructor(readonly subscriptionId: string) {
    super(
      `the request leaves subscription ${subscriptionId} on the same plan version at the ` +
        'same quantity. Applying it would split the open segment in two identical halves ' +
        'and bill the period as two supplies.',
    );
    this.name = 'NoChangeRequestedError';
  }
}

export interface PlanChangeRequest {
  readonly subscriptionId: string;
  /** Absent means "keep the current plan version" -- a seat-only change. */
  readonly targetPlanVersionId?: string | undefined;
  /** Absent means "keep the current quantity" -- a plan-only change. */
  readonly targetQuantity?: number | undefined;
  /** The platform user who asked. Recorded on a scheduled change. */
  readonly requestedByPlatformUserId: string | null;
  readonly at?: Date | undefined;
}

export interface PlanChangeCurrentState {
  readonly tenantId: string;
  readonly subscriptionStatus: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly planKey: string;
  readonly priceMinor: number;
  readonly quantity: number;
  readonly currentPeriodEnd: string;
  /**
   * False for a subscription that has never had a segment opened. Surfaced
   * rather than swallowed: it means nothing has ever been billable, and the
   * change is about to open the FIRST segment mid-period.
   */
  readonly hasOpenSegment: boolean;
}

export type PlanChangeResult =
  | {
      readonly direction: 'expand';
      readonly effect: 'immediate';
      readonly segmentId: string;
      readonly from: PlanChangeCurrentState;
      readonly toPlanVersionId: string;
      readonly toQuantity: number;
    }
  | {
      readonly direction: 'contract';
      readonly effect: 'at_period_end';
      readonly scheduled: ScheduledChange;
      readonly from: PlanChangeCurrentState;
      readonly toPlanVersionId: string;
      readonly toQuantity: number;
    };

async function currentState(
  client: pg.ClientBase,
  subscriptionId: string,
): Promise<PlanChangeCurrentState> {
  // FOR UPDATE on the subscription: the direction is computed from what this row
  // says, and a concurrent change deciding "expand" from the same before-image
  // would open two segments for one instant and trip the exclusion constraint at
  // best, double-bill at worst.
  const result = await client.query<{
    tenant_id: string; status: string; plan_id: string; plan_version_id: string;
    plan_key: string; price_minor: string; quantity: number | null;
    current_period_end: string;
  }>(
    `SELECT s.tenant_id, s.status, s.plan_id, s.plan_version_id,
            p.key AS plan_key, pv.price_minor::text, s.current_period_end::text,
            (SELECT seg.quantity FROM platform.subscription_segment seg
              WHERE seg.subscription_id = s.id AND seg.ends_at IS NULL) AS quantity
       FROM platform.subscription s
       JOIN platform.plan_version pv ON pv.id = s.plan_version_id
       JOIN platform.plan p ON p.id = pv.plan_id
      WHERE s.id = $1
        FOR NO KEY UPDATE OF s`,
    [subscriptionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`subscription ${subscriptionId} not found`);

  return {
    tenantId: row.tenant_id,
    subscriptionStatus: row.status,
    planId: row.plan_id,
    planVersionId: row.plan_version_id,
    planKey: row.plan_key,
    priceMinor: Number(row.price_minor),
    // A subscription with no open segment bills as one seat: that is what
    // `applyDueChanges` already assumes with its COALESCE, and disagreeing here
    // would make the direction depend on which module asked.
    quantity: row.quantity ?? 1,
    currentPeriodEnd: row.current_period_end,
    hasOpenSegment: row.quantity !== null,
  };
}

const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = ['trialing', 'active', 'past_due'];

export async function changeSubscription(
  client: pg.ClientBase,
  request: PlanChangeRequest,
): Promise<PlanChangeResult> {
  const from = await currentState(client, request.subscriptionId);

  // An allowlist, not a blocklist: `subscription_status_known` permits five
  // values and a sixth added later must be refused until somebody decides it
  // may be re-priced.
  if (!LIVE_SUBSCRIPTION_STATUSES.includes(from.subscriptionStatus)) {
    throw new SubscriptionNotLiveError(request.subscriptionId, from.subscriptionStatus);
  }

  const targetVersionId = request.targetPlanVersionId ?? from.planVersionId;
  const targetQuantity = request.targetQuantity ?? from.quantity;

  const target = await client.query<{
    plan_id: string; price_minor: string; published_at: string | null;
  }>(
    `SELECT plan_id, price_minor::text, published_at::text
       FROM platform.plan_version WHERE id = $1`,
    [targetVersionId],
  );
  const targetRow = target.rows[0];
  if (!targetRow) throw new PlanVersionUnknownError(targetVersionId);
  if (targetRow.published_at === null) {
    throw new PlanVersionNotPublishedError(targetVersionId);
  }

  if (targetVersionId === from.planVersionId && targetQuantity === from.quantity) {
    throw new NoChangeRequestedError(request.subscriptionId);
  }

  const targetPriceMinor = Number(targetRow.price_minor);
  const direction = directionOfChange(
    { planPriceMinor: from.priceMinor, quantity: from.quantity },
    { planPriceMinor: targetPriceMinor, quantity: targetQuantity },
  );

  if (direction === 'contract') {
    // `kind` follows `scheduled_change_target_shape`: a downgrade must name a
    // plan and version, a seat_decrease must name a quantity. A plan change that
    // is also a seat change is a downgrade, because the plan is the stronger
    // statement and the row can only be one kind.
    const isPlanChange = targetVersionId !== from.planVersionId;
    const scheduled = await scheduleContraction(client, {
      tenantId: from.tenantId,
      subscriptionId: request.subscriptionId,
      kind: isPlanChange ? 'downgrade' : 'seat_decrease',
      ...(isPlanChange
        ? { targetPlanId: targetRow.plan_id, targetPlanVersionId: targetVersionId }
        : {}),
      targetQuantity,
      requestedByUserId: request.requestedByPlatformUserId,
    });
    return {
      direction, effect: 'at_period_end', scheduled, from,
      toPlanVersionId: targetVersionId, toQuantity: targetQuantity,
    };
  }

  const { segmentId } = await applyExpansion(client, {
    tenantId: from.tenantId,
    subscriptionId: request.subscriptionId,
    planId: targetRow.plan_id,
    planVersionId: targetVersionId,
    quantity: targetQuantity,
    currentPriceMinor: from.priceMinor,
    currentQuantity: from.quantity,
    targetPriceMinor,
    at: request.at ?? new Date(),
  });

  return {
    direction, effect: 'immediate', segmentId, from,
    toPlanVersionId: targetVersionId, toQuantity: targetQuantity,
  };
}
