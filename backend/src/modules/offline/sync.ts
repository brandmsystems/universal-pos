import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../database/tenantContext.js';
import { OFFLINE_WINDOW_HOURS, OFFLINE_WINDOW_MS } from './window.js';
import { leaseState } from './lease.js';

/**
 * Sync: applying a device's offline batch.
 *
 * ###########################################################################
 * THE LOCALITY RULE
 *
 *   An operation may go offline when its invariant is LOCAL to the aggregate
 *   the device holds. It may not when the invariant is GLOBAL across devices.
 *
 * "Anything touching money" was the original heuristic and it is a proxy:
 * settlement is forbidden because closing a bill is a CONSENSUS act, not because
 * money is special. Stating it as consensus is what lets you place a new
 * operation without re-litigating the list -- and it is what catches that firing
 * a KOT is not local either, unless a lease guarantees one writer.
 * ###########################################################################
 */

export const OFFLINE_ALLOWED = [
  'session.open',
  'order.line.add',
  'order.line.edit_prefire',
  'order.line.remove_prefire',
  'kot.fire',
] as const;

/**
 * Every one of these is downstream of settlement, which is why the forbidden set
 * is internally coherent: a waiter who cannot void a burned dish offline has lost
 * nothing, because they could not have settled the bill either. The void is
 * recorded on reconnect, before anything is owed.
 */
export const OFFLINE_FORBIDDEN = [
  'bill.generate',
  'payment.tender',
  'payment.tender.void',
  'payment.refund',
  'order.void',
  'order.comp',
  'order.discount',
] as const;

export type OfflineOperationKind =
  | (typeof OFFLINE_ALLOWED)[number]
  | (typeof OFFLINE_FORBIDDEN)[number];

export interface OfflineOperation {
  readonly kind: OfflineOperationKind;
  /** Client-generated. The replay key, resolved through request_claim. */
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly businessDate: string;
  readonly payload: Record<string, unknown>;
}

export interface SyncBatch {
  readonly clientBatchNo: number;
  readonly deviceId: string;
  readonly branchId: string;
  /** By the device's own clock; used only for staleness. Server time decides. */
  readonly offlineSince: string;
  readonly operations: readonly OfflineOperation[];
}

export type QuarantineReason =
  | 'lease_force_released' | 'lease_expired' | 'lease_conflict'
  | 'stale_beyond_window' | 'forbidden_operation';

export interface SyncOutcome {
  readonly batchId: string;
  readonly status: 'applied' | 'quarantined';
  readonly reason?: QuarantineReason;
  readonly detail?: string;
  readonly appliedOperations: number;
}

/**
 * Decides the fate of a batch BEFORE any of it is applied, and returns the reason
 * rather than a boolean -- an operator resolving a quarantine needs to know which
 * of five things happened, and "rejected" tells them nothing.
 *
 * Order matters. A force-released device is checked first because that is the
 * case where a human has already deliberately taken the session away, and every
 * later verdict would be a less accurate description of the same event.
 */
export async function adjudicateBatch(
  context: TenantContext,
  batch: SyncBatch,
  now: Date = new Date(),
): Promise<{ verdict: 'apply' } | { verdict: 'quarantine'; reason: QuarantineReason; detail: string }> {
  const forbidden = batch.operations.filter(
    (op) => (OFFLINE_FORBIDDEN as readonly string[]).includes(op.kind),
  );
  if (forbidden.length > 0) {
    return {
      verdict: 'quarantine',
      reason: 'forbidden_operation',
      detail:
        `batch contains ${forbidden.length} operation(s) no device may perform offline: ` +
        `${[...new Set(forbidden.map((o) => o.kind))].join(', ')}. ` +
        'A client that produced these is out of step with the locality rule.',
    };
  }

  // Staleness first among the lease checks: a week-old batch is refused even if
  // its lease somehow still looks live, because the damage is to the cost basis
  // rather than to session ownership.
  const offlineMs = now.getTime() - new Date(batch.offlineSince).getTime();
  if (offlineMs > OFFLINE_WINDOW_MS) {
    return {
      verdict: 'quarantine',
      reason: 'stale_beyond_window',
      detail:
        `device was offline ${Math.round(offlineMs / 3_600_000)}h, beyond the ` +
        `${OFFLINE_WINDOW_HOURS}h window. Absorbing it would apply movements behind ` +
        'newer ones that already moved the average cost, and its replay claims may ' +
        'have been purged.',
    };
  }

  const sessions = [...new Set(batch.operations.map((op) => op.sessionId))];
  for (const sessionId of sessions) {
    const state = await leaseState(context, { sessionId, deviceId: batch.deviceId });
    if (state.held) continue;
    if (state.why === 'force_released') {
      return {
        verdict: 'quarantine',
        reason: 'lease_force_released',
        detail: `session ${sessionId} was force-released away from this device; its later ` +
                'writes are quarantined, never merged',
      };
    }
    if (state.why === 'other_device') {
      return {
        verdict: 'quarantine',
        reason: 'lease_conflict',
        detail: `session ${sessionId} is held by another device`,
      };
    }
    // 'none' is legitimate for a session this batch itself opens offline; the
    // lease is claimed at apply time. Anything else is an expiry.
    const opensIt = batch.operations.some(
      (op) => op.kind === 'session.open' && op.sessionId === sessionId,
    );
    if (state.why === 'none' && opensIt) continue;
    return {
      verdict: 'quarantine',
      reason: 'lease_expired',
      detail: `lease on session ${sessionId} is ${state.why}`,
    };
  }

  return { verdict: 'apply' };
}

/**
 * Records the batch and its verdict. The batch row exists either way -- a
 * quarantined batch that leaves no trace is indistinguishable from one that was
 * never sent, and the device will keep retrying it forever.
 *
 * `applyOperation` is injected rather than imported so this module owns the
 * adjudication and the ordering, and nothing else. Operations are applied in the
 * order the device recorded them, and stock movements are drained by business
 * date -- see drainStockOutbox.
 */
export async function receiveBatch(
  context: TenantContext,
  batch: SyncBatch,
  applyOperation: (op: OfflineOperation) => Promise<void>,
  now: Date = new Date(),
): Promise<SyncOutcome> {
  const batchId = randomUUID();
  const decision = await adjudicateBatch(context, batch, now);

  await context.client.query(
    `INSERT INTO app.sync_batch
       (id, tenant_id, branch_id, device_id, client_batch_no, offline_since,
        status, operation_count)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)`,
    [batchId, context.tenantId, batch.branchId, batch.deviceId, batch.clientBatchNo,
     batch.offlineSince, decision.verdict === 'apply' ? 'pending' : 'quarantined',
     batch.operations.length],
  );

  if (decision.verdict === 'quarantine') {
    await context.client.query(
      `INSERT INTO app.sync_quarantine
         (id, tenant_id, branch_id, sync_batch_id, reason, detail, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), context.tenantId, batch.branchId, batchId, decision.reason,
       decision.detail, JSON.stringify(batch)],
    );
    return {
      batchId, status: 'quarantined',
      reason: decision.reason, detail: decision.detail, appliedOperations: 0,
    };
  }

  let applied = 0;
  for (const op of batch.operations) {
    await applyOperation(op);
    applied += 1;
  }

  await context.client.query(
    `UPDATE app.sync_batch SET status = 'applied', applied_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, batchId],
  );

  return { batchId, status: 'applied', appliedOperations: applied };
}

export interface QueuedDeduction {
  readonly kotId: string;
  readonly businessDate: string;
}

/**
 * Drains queued deductions in BUSINESS-DATE order, not arrival order.
 *
 * Weighted average cost is order-dependent: issuing before or after a receipt
 * changes the basis. Ordering the drain fixes the common case -- a device syncing
 * several days of backlog at once. It does NOT fix a device syncing after newer
 * movements already shifted the average, which is why anything beyond the offline
 * window is quarantined upstream rather than reaching here, and why what does
 * reach here is marked.
 */
export function orderDeductionQueue(queue: readonly QueuedDeduction[]): readonly QueuedDeduction[] {
  return [...queue].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

export async function markSyncedLate(
  context: TenantContext,
  params: { kotId: string },
): Promise<number> {
  const result = await context.client.query(
    `UPDATE app.stock_movement SET synced_late = true
      WHERE tenant_id = $1 AND source_kot_id = $2 AND kind = 'consumption'`,
    [context.tenantId, params.kotId],
  );
  return result.rowCount ?? 0;
}

export async function openQuarantine(
  context: TenantContext,
  params: { branchId: string },
): Promise<ReadonlyArray<{ id: string; reason: QuarantineReason; detail: string; batchId: string }>> {
  const result = await context.client.query<{
    id: string; reason: QuarantineReason; detail: string; sync_batch_id: string;
  }>(
    `SELECT id, reason, detail, sync_batch_id
       FROM app.sync_quarantine
      WHERE tenant_id = $1 AND branch_id = $2 AND resolved_at IS NULL
      ORDER BY quarantined_at`,
    [context.tenantId, params.branchId],
  );
  return result.rows.map((r) => ({
    id: r.id, reason: r.reason, detail: r.detail, batchId: r.sync_batch_id,
  }));
}
