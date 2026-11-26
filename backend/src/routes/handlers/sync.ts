import { BranchScopeRequiredError } from './staff.js';
import type { RouteDefinition } from '../../core/middleware/routeRegistry.js';
import type { TenantContext } from '../../core/database/tenantContext.js';
import {
  receiveBatch, openQuarantine, type OfflineOperation, type SyncBatch,
} from '../../modules/offline/sync.js';
import { openSession } from '../../modules/orders/session.js';
import { addLine, editLine, removeLine } from '../../modules/orders/orderEntry.js';
import { fireOrder } from '../../modules/kitchen/fire.js';
import { claimOrReplay, recordClaimResult } from '../../modules/orders/idempotency.js';

/**
 * The offline batch endpoint.
 *
 * ###########################################################################
 * THIS IS NOT A LOOP OVER THE OTHER ROUTES.
 *
 * Adjudicate first, then apply. The whole batch is judged before any of it is
 * written, and a batch that fails adjudication is quarantined ENTIRE -- never
 * its allowed prefix. Applying half a batch leaves the device's view and the
 * server's permanently divergent, with no mechanism that could ever reconcile
 * them, because the device believes it sent one thing and the server holds
 * another.
 *
 * The response is 202 for a quarantine, not an error. The batch WAS received
 * and IS recorded; a 4xx would make a well-behaved device retry forever, and
 * the batch row is evidence an operator has to be able to look at.
 * ###########################################################################
 */

type Handler = RouteDefinition['handler'];

export class UnknownOfflineOperationError extends Error {
  readonly code = 'unknown_offline_operation';
  constructor(readonly kind: string) {
    super(
      `no applier for offline operation '${kind}'. An operation the server cannot ` +
        'apply must fail loudly here rather than being skipped: a silently dropped ' +
        'operation is an order line the customer was never charged for.',
    );
    this.name = 'UnknownOfflineOperationError';
  }
}

/**
 * Applying one operation.
 *
 * Every branch calls the SAME domain function the online route calls. That is
 * the entire reason the route layer holds no logic: a synced `order.line.add`
 * must take the identical snapshot an online one does, and it does so because
 * there is only one `addLine`.
 *
 * Each operation is wrapped in `claimOrReplay` on the DEVICE's key, so a batch
 * retried after a partial network failure applies once. This is what couples the
 * offline window to claim retention -- once those claims are purged, a resynced
 * batch applies again as if new, against money and stock.
 */
export function applyOfflineOperation(
  context: TenantContext,
  batch: SyncBatch,
  actorUserId: string,
): (op: OfflineOperation) => Promise<void> {
  return async (op) => {
    const claim = await claimOrReplay(context, {
      idempotencyKey: op.idempotencyKey,
      operation: op.kind,
      branchId: batch.branchId,
      payload: op.payload,
    });
    if (claim.replayed) return;

    switch (op.kind) {
      case 'session.open': {
        const payload = op.payload as { diningTableIds: string[]; guestCount?: number };
        await openSession(
          context,
          { branchId: batch.branchId, diningTableIds: payload.diningTableIds,
            guestCount: payload.guestCount ?? null },
          actorUserId,
        );
        break;
      }
      case 'order.line.add': {
        const payload = op.payload as {
          orderId: string; menuItemId: string; quantity: number;
          modifierOptionIds?: string[]; note?: string; guestNo?: number | null;
        };
        await addLine(context, payload, actorUserId);
        break;
      }
      case 'order.line.edit_prefire': {
        const payload = op.payload as { lineId: string; quantity?: number; note?: string | null };
        await editLine(context, payload);
        break;
      }
      case 'order.line.remove_prefire': {
        const payload = op.payload as { lineId: string };
        await removeLine(context, payload.lineId);
        break;
      }
      case 'kot.fire': {
        const payload = op.payload as {
          orderId: string; sessionId: string; sessionVersion: number;
        };
        await fireOrder(context, {
          // No key passed: the claim above IS the device's claim, so a fire the
          // tablet already performed offline is not performed twice at sync.
          // `fireOrder` used to claim it a second time under the same operation
          // name with a payload that omitted `sessionVersion`, so the digests
          // disagreed and every offline fire raised at sync. `sequence_no` is
          // assigned here; `local_reference` is what the kitchen held until now.
          orderId: payload.orderId,
          sessionId: payload.sessionId,
          sessionVersion: payload.sessionVersion,
          branchId: batch.branchId,
          firedByUserId: actorUserId,
          businessDate: op.businessDate,
        });
        break;
      }
      default:
        throw new UnknownOfflineOperationError(op.kind);
    }

    await recordClaimResult(context, op.idempotencyKey, { applied: true });
  };
}

export function syncHandlers(): Record<string, Handler> {
  return {
    /**
     * What was quarantined and has not been resolved.
     *
     * ###################################################################
     * A QUARANTINED BATCH THAT NOBODY CAN SEE IS A DELETED BATCH.
     *
     * The whole justification for quarantining a batch rather than dropping it
     * is that somebody has to be able to find out what did not happen -- the
     * detail on each row is written for a person resolving it, naming which
     * rule refused and why. `openQuarantine` produced exactly that and had no
     * HTTP caller, so for its entire life the answer was unreachable and a
     * stranded tablet's work was, in practice, silently discarded.
     *
     * Branch from the verified token, never a query parameter: a quarantine row
     * names operations at one branch and reading another's is not this
     * session's business.
     * ###################################################################
     */
    quarantine: async (request, _reply, context) => {
      const branchId = (request.claims ?? {})['branch_id'];
      if (typeof branchId !== 'string' || branchId === '') throw new BranchScopeRequiredError('This screen');
      return { open: await openQuarantine(context, { branchId }) };
    },

    sync: async (request, reply, context) => {
      const batch = request.body as SyncBatch;
      const claims = request.claims ?? {};
      const actorUserId = String(claims['sub']);

      const outcome = await receiveBatch(
        context, batch, applyOfflineOperation(context, batch, actorUserId));

      if (outcome.status === 'quarantined') {
        // Accepted and recorded, not rejected. The device must stop retrying;
        // a human has to look at it.
        reply.code(202);
      }
      return outcome;
    },
  };
}
