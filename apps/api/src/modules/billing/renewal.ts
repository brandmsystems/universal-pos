import type pg from 'pg';

/**
 * Renewing a subscription: moving its current period forward by whole billing
 * periods.
 *
 * ###########################################################################
 * NOTHING ELSE EVER MOVED THE PERIOD, AND THE SEGMENTS DO NOT CARE THAT IT DOES.
 *
 * Provisioning opens a 14-day trial and no code path advanced it: every
 * subscription on the platform sat on `trialing` with an end date that passed
 * and stayed passed. This is the first writer of the period after creation.
 *
 * It is safe to move because billing does not read it. Invoices bill SEGMENTS
 * (`segments.ts`), and provisioning opened the first one at the trial's END --
 * so the paid period that begins where the trial ends is exactly where the
 * segment series already starts. Renewal therefore changes the window a human
 * reads ("expires on"), and never what is charged; there is deliberately no
 * "end trial early" here, because that would have to move a segment.
 * ###########################################################################
 *
 * Renewal extends from the current END, never from today: renewing a day early
 * must not forfeit the day, and renewing a lapsed subscription must not skip the
 * unpaid gap as if it had been covered.
 */

export class SubscriptionNotRenewableError extends Error {
  readonly statusCode = 409;
  readonly code = 'subscription_not_renewable';
  constructor(readonly status: string) {
    super(`a ${status} subscription cannot be renewed; only a trialing, active or past-due one can.`);
    this.name = 'SubscriptionNotRenewableError';
  }
}

export class SubscriptionUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'subscription_unknown';
  constructor(id: string) {
    super(`no subscription has the id ${id}`);
    this.name = 'SubscriptionUnknownError';
  }
}

export class RenewalPeriodsInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'renewal_periods_invalid';
  constructor() {
    super('periods must be a whole number from 1 to 12.');
    this.name = 'RenewalPeriodsInvalidError';
  }
}

export interface RenewalResult {
  readonly subscriptionId: string;
  readonly status: string;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly periods: number;
  readonly billingPeriod: string;
}

export async function renewSubscription(
  client: pg.ClientBase,
  input: {
    subscriptionId: string;
    periods: unknown;
    /** A Salesperson's own book only; the same scoping the tenant list applies. */
    provisionedByPlatformUserId?: string | undefined;
  },
): Promise<RenewalResult> {
  const periods = input.periods;
  if (typeof periods !== 'number' || !Number.isInteger(periods) || periods < 1 || periods > 12) {
    throw new RenewalPeriodsInvalidError();
  }

  const found = await client.query<{ status: string; billing_period: string }>(
    `SELECT s.status, pv.billing_period
       FROM platform.subscription s
       JOIN platform.plan_version pv ON pv.id = s.plan_version_id
       LEFT JOIN platform.provisioning_request pr ON pr.tenant_id = s.tenant_id
      WHERE s.id = $1
        AND ($2::uuid IS NULL OR pr.requested_by_platform_user_id = $2::uuid)
      FOR UPDATE OF s`,
    [input.subscriptionId, input.provisionedByPlatformUserId ?? null]);
  const row = found.rows[0];
  if (!row) throw new SubscriptionUnknownError(input.subscriptionId);
  if (!['trialing', 'active', 'past_due'].includes(row.status)) {
    throw new SubscriptionNotRenewableError(row.status);
  }

  const unit = row.billing_period === 'yearly' ? 'year' : 'month';
  // A trial ends where the first paid period begins, so renewing one makes it
  // active. past_due stays past_due: an unpaid invoice is dunning's to clear,
  // not a renewal's.
  const updated = await client.query<{ status: string; s: string; e: string }>(
    `UPDATE platform.subscription
        SET current_period_start = current_period_end,
            current_period_end = current_period_end + ($2::int * ('1 ' || $3)::interval),
            status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END,
            updated_at = now()
      WHERE id = $1
      RETURNING status, current_period_start::text AS s, current_period_end::text AS e`,
    [input.subscriptionId, periods, unit]);
  const after = updated.rows[0]!;
  return {
    subscriptionId: input.subscriptionId, status: after.status,
    currentPeriodStart: after.s, currentPeriodEnd: after.e,
    periods, billingPeriod: row.billing_period,
  };
}
