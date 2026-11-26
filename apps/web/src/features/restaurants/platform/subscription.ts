import { EXPIRING_WITHIN_DAYS } from '@katkitchen/shared';
import type { Plan, PlanOption, TenantSummary } from '../../../types/restaurant.js';
import { formatMoney } from '../../../components/platform/kit.js';

/**
 * The rules the restaurant screens share: which plans can be sold today, and
 * how a subscription's status reads (active / expiring soon / expired /
 * suspended). The shapes live in src/types/restaurant.ts.
 */

/**
 * What can be SOLD today: the newest published version of each active plan.
 * Older versions stay on the subscriptions already sold on them, but a new
 * restaurant is never put on yesterday's price.
 */
export function sellableOptions(plans: readonly Plan[]): readonly PlanOption[] {
  return plans
    .filter((plan) => plan.status === 'active')
    .flatMap((plan) => {
      const latest = [...plan.versions]
        .filter((v) => v.publishedAt !== null)
        .sort((a, b) => b.version - a.version)[0];
      if (!latest) return [];
      return [{
        priceMinor: latest.priceMinor,
        currency: latest.currency,
        billingPeriod: latest.billingPeriod,
        planName: plan.name,
        planVersionId: latest.planVersionId,
        planKey: plan.key,
        label: `${plan.name} — ${formatMoney(latest.priceMinor, latest.currency)} / ${
          latest.billingPeriod === 'yearly' ? 'year' : 'month'}`,
      }];
    })
    // Cheapest first -- Basic, Pro -- the order they are compared in.
    .sort((a, b) => a.priceMinor - b.priceMinor);
}

/* --------------------------------------------------- subscription health --- */

export type SubscriptionHealth = 'active' | 'expiring' | 'expired' | 'suspended' | 'none';

/** How close to the end counts as "expiring soon" -- one rule, shared with the API. */
export { EXPIRING_WITHIN_DAYS };

/**
 * The status a person reads: derived from the expiry date and the restaurant's
 * own standing, never stored. A stored "expiring soon" would be wrong the day
 * after it was written.
 *
 * Suspended wins over everything: a restaurant that cannot trade -- switched
 * off, or locked on the payment ladder -- is suspended whatever its dates say.
 * `active` and `past_due` restaurants still trade (past due is a banner), so
 * for them the dates decide.
 */
export function subscriptionHealth(t: TenantSummary, now: number = Date.now()): SubscriptionHealth {
  if (t.status !== 'active' && t.status !== 'past_due') return 'suspended';
  if (t.subscriptionId === null || t.currentPeriodEnd === null) return 'none';
  const days = (new Date(t.currentPeriodEnd).getTime() - now) / 86_400_000;
  if (days < 0) return 'expired';
  if (days <= EXPIRING_WITHIN_DAYS) return 'expiring';
  return 'active';
}

export const HEALTH_WORDS: Readonly<Record<SubscriptionHealth, string>> = {
  active: 'Active', expiring: 'Expiring soon', expired: 'Expired', suspended: 'Suspended', none: 'No plan',
};

/** Literal class strings, so Tailwind's scanner sees every one. */
export const HEALTH_TONES: Readonly<Record<SubscriptionHealth, string>> = {
  active: 'bg-status-good/15 text-status-good',
  expiring: 'bg-status-warn/15 text-status-warn',
  expired: 'bg-status-critical/15 text-status-critical',
  suspended: 'bg-secondary text-muted-foreground',
  none: 'bg-secondary text-subtle-foreground',
};

export const BILLING_WORDS: Readonly<Record<TenantSummary['billingStatus'], string>> = {
  none: 'Not billed yet', paid: 'Paid', due: 'Invoice due', overdue: 'Overdue', void: 'Voided',
};

export const BILLING_TONES: Readonly<Record<TenantSummary['billingStatus'], string>> = {
  none: 'text-subtle-foreground', paid: 'text-status-good', due: 'text-muted-foreground',
  overdue: 'text-status-critical', void: 'text-subtle-foreground',
};
