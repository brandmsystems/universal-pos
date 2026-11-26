import { PLAN_KEYS } from '@katkitchen/shared';

/**
 * The console sells exactly two plans: Basic and Pro, in that order.
 *
 * The key list is the shared `PLAN_KEYS`, the same definition the plan gates
 * and the admin menu read, so a third plan appears here only when it is added
 * there. Any other row in `platform.plan` -- the backend suite creates probe
 * plans in whatever database it runs against -- is not something anyone sells.
 */
export function standardPlans<T extends { readonly key: string }>(plans: readonly T[]): readonly T[] {
  const order = PLAN_KEYS as readonly string[];
  return plans
    .filter((plan) => order.includes(plan.key))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
