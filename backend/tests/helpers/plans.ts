import { ENTITLEMENTS, planTermsFor, type PlanKey } from '@universalpos/shared';
import type {
  EntitlementCache, EntitlementDocument,
} from '../../src/modules/platform/entitlements.js';

/** A document for one of the standard plans, as `publishEntitlement` would write it. */
export function planDocument(tenantId: string, plan: PlanKey, version = 1): EntitlementDocument {
  return {
    tenantId,
    version,
    planKey: plan,
    planVersion: 1,
    status: 'active',
    ...planTermsFor(ENTITLEMENTS[plan]),
    publishedAt: new Date(0).toISOString(),
  };
}

/**
 * A collaborator seam, not a stand-in for the thing under test: the suites that
 * use it test the KOT flow or reports, and need every tenant they create to be
 * on a plan that includes them. `tests/http/planGates.test.ts` is where
 * the gate itself is tested, against real documents.
 */
export function planCache(plan: PlanKey = 'pro'): EntitlementCache {
  return {
    async get(tenantId) { return planDocument(tenantId, plan); },
    async put() { /* answers every tenant; nothing to hold */ },
  };
}
