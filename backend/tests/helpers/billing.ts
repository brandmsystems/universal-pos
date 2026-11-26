import type { TenantContext } from '../../src/core/database/tenantContext.js';
import { generateBill as generateBillInStage } from '../../src/modules/payments/billing.js';

/**
 * Billing starts only on an order KOT handed over (`assertInBilling`). Suites
 * that test the bill ITSELF -- tax, splits, tenders, refunds -- are not about
 * the hand-over, which tests/http/serviceFlow.test.ts covers end to end, so
 * this puts the session in the billing stage exactly as the hand-over leaves
 * it (stage plus both stamps, which `table_session_stage_consistent` requires)
 * and then bills. Idempotent: a session already in billing is left alone.
 */
export async function handedToBilling(context: TenantContext, sessionId: string): Promise<void> {
  await context.client.query(
    `UPDATE app.table_session
        SET stage = 'billing', billing_ready_at = now(), billing_ready_by_user_id = opened_by_user_id
      WHERE tenant_id = $1 AND id = $2 AND stage = 'ordering'`,
    [context.tenantId, sessionId]);
}

export const generateBill: typeof generateBillInStage = async (context, request) => {
  await handedToBilling(context, request.sessionId);
  return generateBillInStage(context, request);
};
