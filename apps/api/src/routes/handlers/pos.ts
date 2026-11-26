import { BranchScopeRequiredError } from './staff.js';
import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../../core/middleware/routeRegistry.js';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { requireIdempotencyKey } from '../../core/middleware/posHeaders.js';
import { listAdjustmentReasons } from '../../modules/orders/adjustmentReasons.js';
import { readBoard } from '../../modules/orders/board.js';
import { readMenuForBranch } from '../../modules/menu/read.js';
import { readFloor } from '../../modules/restaurants/floor.js';
import {
  openSession, closeSession, moveSession, currentBusinessDate,
  joinTable, unjoinTable, setGuestCount, openParcel, openCounterDineIn, markParcelPickedUp,
  markReadyForBilling, reopenForOrdering, cancelOrder,
} from '../../modules/orders/session.js';
import { listOpenOrders } from '../../modules/orders/openOrders.js';
import { listParcels } from '../../modules/orders/parcels.js';
import { listBillingQueue } from '../../modules/orders/billingQueue.js';
import { hasFeature } from '../../modules/platform/entitlements.js';
import { addLine, editLine, removeLine, setParcelCharge } from '../../modules/orders/orderEntry.js';
import { quoteOrder } from '../../modules/payments/quote.js';
import { tillSummary } from '../../modules/reporting/tillSummary.js';
import { voidLine, compLine, discountLine } from '../../modules/orders/adjustments.js';
import { fireOrder } from '../../modules/kitchen/fire.js';
import {
  generateBill, takePayment, recordTender, voidTender, recordRefund,
} from '../../modules/payments/billing.js';
import { printBill } from '../../modules/payments/billPrint.js';
import { billDetail, billHistory } from '../../modules/payments/billHistory.js';
import { previewBillRevision, reviseBill } from '../../modules/payments/billRevision.js';
import {
  businessDateParam, dayBranch, dayReview, reopenDay, setPosEditing, submitDay, type EditAuthority,
} from '../../modules/payments/dayEnd.js';
import { activeBranchFor } from './admin.js';
import { recordManualSettlement } from '../../modules/offline/manualSettlement.js';
import { claimLease, renewLease, releaseLease, forceReleaseLease } from '../../modules/offline/lease.js';
import { requestReprint } from '../../modules/kitchen/printWorker.js';
import { orderTickets, markTicketReady } from '../../modules/kitchen/orderTickets.js';
import { resolveActor } from '../../modules/authz/authorityStore.js';

/**
 * The route layer, and nothing more.
 *
 * ###########################################################################
 * NO DECISION IS MADE HERE.
 *
 * Every handler does three things: read the request, call one domain function,
 * return what it returned. There is no price arithmetic, no availability
 * precedence, no cap check, no snapshot -- because a rule implemented at the
 * route layer is a rule the offline sync path and the job runner do not get.
 *
 * That is not a style preference. `receiveBatch` replays the SAME operations
 * from a tablet that was offline; if `addLine`'s snapshot lived in the handler,
 * a synced line would be written with no snapshot at all and nobody would see
 * it until a bill failed to reconcile weeks later.
 * ###########################################################################
 */

type Handler = RouteDefinition['handler'];

function body<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw new Error(`missing path parameter ${name}`);
  return value;
}

/**
 * The branch, from the VERIFIED token. Never from the body.
 *
 * A body-supplied branch is a client claim about which branch a write belongs
 * to, and the token already carries the answer -- so accepting it from the body
 * is an authorisation check performed against data the caller controls. The
 * permission was resolved against the token's branch; the write must land in the
 * same one.
 */
/** The token's branch, or null for a restaurant-wide (owner) session: reads and
 *  reprints are scoped to it when there is one, and to the tenant otherwise. */
function branchIfAny(request: FastifyRequest): string | null {
  const branchId = (request.claims ?? {})['branch_id'];
  return typeof branchId === 'string' && branchId !== '' ? branchId : null;
}

function branchOf(request: FastifyRequest): string {
  const branchId = (request.claims ?? {})['branch_id'];
  if (typeof branchId !== 'string' || branchId === '') throw new BranchScopeRequiredError('This screen');
  return branchId;
}

/**
 * The session, from the LEASE the registrar resolved. Never from the body.
 *
 * The lease guard has already looked the session up from the order in the URL
 * and refused a token that names a different one, so `heldLease.sessionId` is
 * the only value here that has been checked. A body field would be a second,
 * unchecked opinion about which table this write is for.
 */
function leasedSession(request: FastifyRequest): string {
  const held = request.heldLease;
  if (!held) throw new Error('this route is not leased; there is no session to read');
  return held.sessionId;
}

function actorId(context: TenantContext, request: FastifyRequest): string {
  const claims = request.claims ?? {};
  const sub = claims['sub'];
  if (typeof sub !== 'string') throw new Error('no subject on the request');
  return context.actor?.userId ?? sub;
}

/**
 * The discount cap comes from the SAME authority resolution the permission check
 * used, re-read inside the transaction rather than passed through a header.
 *
 * Re-resolving is cheap and is the only way the cap cannot disagree with the
 * permission: the union of memberships that granted `order.discount` is the
 * union whose caps apply.
 */
async function discountAuthority(
  context: TenantContext,
  request: FastifyRequest,
): Promise<{ discountPercentCap: number; discountAmountCap: number | null }> {
  const claims = request.claims ?? {};
  const branchId = typeof claims['branch_id'] === 'string' ? claims['branch_id'] : null;
  const actor = await resolveActor(context, actorId(context, request), branchId);
  if (!actor?.authority) throw new Error('no authority resolved for a discount');
  return {
    discountPercentCap: actor.authority.discountPercentCap,
    discountAmountCap: actor.authority.discountAmountCap,
  };
}

/** An edit as the request states it; the capacity and the branch are the route's and the token's. */
function revision(
  request: FastifyRequest, context: TenantContext, authority: EditAuthority, branchId: string | null,
): Parameters<typeof reviseBill>[1] {
  const input = body<{ expectedVersion?: unknown; reason?: unknown; remove?: unknown; add?: unknown; refundMethod?: unknown }>(request);
  return {
    billId: param(request, 'id'), branchId, authority,
    expectedVersion: input.expectedVersion, reason: input.reason, remove: input.remove, add: input.add,
    refundMethod: input.refundMethod, editedByUserId: actorId(context, request),
  };
}

async function posEditing(request: FastifyRequest, context: TenantContext, on: boolean) {
  const branchId = await dayBranch(context, await activeBranchFor(request));
  const today = await currentBusinessDate(context, branchId);
  return setPosEditing(context, {
    branchId, businessDate: businessDateParam(param(request, 'date'), today), today, on,
    reason: body<{ reason?: unknown }>(request).reason, userId: actorId(context, request),
  });
}

export function posHandlers(): Record<string, Handler> {
  return {
    board: async (request, _reply, context) => {
      const sessionId = param(request, 'id');
      const claims = request.claims ?? {};
      const branchId = String(claims['branch_id']);
      return readBoard(context, {
        sessionId, branchId,
        businessDate: await currentBusinessDate(context, branchId),
      });
    },

    /**
     * The standalone menu read, for a tablet refreshing a cached menu without a
     * session open. Same function the board calls -- see src/modules/menu/read.ts for
     * why that matters more than the round trip it saves.
     *
     * The branch comes from the verified token, never from a query parameter: a
     * tablet enrolled at one branch must not read another branch's prices.
     */
    menu: async (request, _reply, context) =>
      readMenuForBranch(context, { branchId: branchOf(request) }),

    /**
     * The floor a shift opens on. Branch comes from the verified token, never a
     * query parameter: a tablet enrolled at one branch must not read another's.
     */
    floor: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return readFloor(context, {
        branchId,
        businessDate: await currentBusinessDate(context, branchId),
      });
    },

    openSession: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      // The branch is the token's, not the body's -- see branchOf. Sending one
      // would let a till enrolled at Andheri seat a table at Bandra, and the
      // permission check would have passed against Andheri.
      const input = body<{ diningTableIds: string[]; guestCount?: number }>(request);
      return openSession(
        context, { ...input, branchId: branchOf(request) }, actorId(context, request));
    },

    closeSession: async (request, _reply, context) => {
      await closeSession(context, param(request, 'id'), actorId(context, request));
      return { closed: true };
    },

    moveSession: async (request, _reply, context) => {
      const input = body<{ fromDiningTableId: string; toDiningTableId: string }>(request);
      await moveSession(context, { sessionId: param(request, 'id'), ...input });
      return { moved: true };
    },

    joinTable: async (request, _reply, context) => {
      const input = body<{ diningTableId: string }>(request);
      await joinTable(context, { sessionId: leasedSession(request), diningTableId: input.diningTableId });
      return { joined: true };
    },

    unjoinTable: async (request, _reply, context) => {
      await unjoinTable(context, { sessionId: leasedSession(request), diningTableId: param(request, 'tableId') });
      return { unjoined: true };
    },

    setGuests: async (request, _reply, context) => {
      const input = body<{ guestCount: number }>(request);
      await setGuestCount(context, { sessionId: leasedSession(request), guestCount: input.guestCount });
      return { guestCount: input.guestCount };
    },

    openParcel: async (request, _reply, context) => {
      const input = body<{ pickupName?: string | null }>(request);
      return openParcel(
        context, { pickupName: input.pickupName ?? null, branchId: branchOf(request) }, actorId(context, request));
    },

    parcels: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return listParcels(context, { branchId, businessDate: await currentBusinessDate(context, branchId) });
    },

    openCounterDineIn: async (request, _reply, context) => {
      const input = body<{ pickupName?: string | null }>(request);
      return openCounterDineIn(
        context, { pickupName: input.pickupName ?? null, branchId: branchOf(request) }, actorId(context, request));
    },

    counterDineIns: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return listParcels(context, {
        branchId, businessDate: await currentBusinessDate(context, branchId), serviceType: 'dine_in',
      });
    },

    pickupParcel: async (request, _reply, context) => {
      await markParcelPickedUp(context, leasedSession(request), actorId(context, request));
      return { pickedUp: true };
    },

    claimLease: async (request, _reply, context) => {
      const input = body<{ deviceId: string; renew?: boolean }>(request);
      // Claim and renew are one route because the tablet does not know which it
      // needs -- it knows only that it wants to keep writing.
      const sessionId = param(request, 'id');
      return input.renew === true
        ? renewLease(context, { sessionId, deviceId: input.deviceId })
        : claimLease(context, {
            sessionId, deviceId: input.deviceId, branchId: branchOf(request), stage: 'ordering',
          });
    },

    /**
     * Billing's claim on a session KOT handed over: its own route and its own key
     * (`bill.generate`), so a billing terminal can hold the session without
     * holding `table.session.open` -- and a KOT tablet cannot take it back.
     */
    claimBillingLease: async (request, _reply, context) => {
      const input = body<{ deviceId: string; renew?: boolean }>(request);
      const sessionId = param(request, 'id');
      return input.renew === true
        ? renewLease(context, { sessionId, deviceId: input.deviceId })
        : claimLease(context, {
            sessionId, deviceId: input.deviceId, branchId: branchOf(request), stage: 'billing',
          });
    },

    readyForBilling: async (request, _reply, context) =>
      markReadyForBilling(context, {
        sessionId: leasedSession(request),
        // With KOT on the plan an unsent item is one the kitchen never saw;
        // without it (Basic) nothing is ever sent. Resolved by the registrar.
        requireAllSent: hasFeature(request.entitlement!, 'kot'),
      }, actorId(context, request)),

    reopenOrder: async (request, _reply, context) => {
      const reason = body<{ reason?: unknown }>(request).reason;
      if (typeof reason !== 'string' || reason.trim().length < 5) throw new ReopenReasonRequiredError();
      return reopenForOrdering(context, param(request, 'id'));
    },

    printBill: async (request, _reply, context) =>
      printBill(context, {
        billId: param(request, 'id'),
        branchId: branchIfAny(request),
        actorUserId: actorId(context, request),
      }),

    // ---- bill history, bill edits and day end (0086) -----------------------
    // The till's routes act in the POS capacity, the /admin/ ones as a manager:
    // the capacity is the route's, never the body's, and each route's key says
    // who may use it. The domain decides every edit again under the day lock.
    billHistory: async (request, _reply, context) => {
      const branchId = branchOf(request);
      const query = request.query as Record<string, unknown>;
      return billHistory(context, {
        branchId, viewer: 'pos', today: await currentBusinessDate(context, branchId),
        period: query['period'], from: query['from'], to: query['to'], q: query['q'],
      });
    },
    billDetail: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return billDetail(context, {
        billId: param(request, 'id'), branchId, viewer: 'pos', today: await currentBusinessDate(context, branchId),
      });
    },
    previewBillRevision: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      return previewBillRevision(context, revision(request, context, 'pos', branchOf(request)));
    },
    reviseBill: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      return reviseBill(context, revision(request, context, 'pos', branchOf(request)));
    },
    dayReview: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return dayReview(context, branchId, await currentBusinessDate(context, branchId));
    },
    submitDay: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      // The till submits TODAY: the business date is the branch's, never sent.
      const branchId = branchOf(request);
      return submitDay(context, {
        branchId, businessDate: await currentBusinessDate(context, branchId),
        submittedByUserId: actorId(context, request),
        expected: body<{ expected?: { billCount?: unknown; payableMinor?: unknown } }>(request).expected ?? null,
      });
    },
    adminBillHistory: async (request, _reply, context) => {
      const branchId = await dayBranch(context, await activeBranchFor(request));
      const query = request.query as Record<string, unknown>;
      return billHistory(context, {
        branchId, viewer: 'manager', today: await currentBusinessDate(context, branchId),
        period: query['period'], from: query['from'], to: query['to'], q: query['q'],
      });
    },
    adminBillDetail: async (request, _reply, context) => {
      const branchId = await activeBranchFor(request);
      return billDetail(context, {
        billId: param(request, 'id'), branchId, viewer: 'manager',
        today: await currentBusinessDate(context, await dayBranch(context, branchId)),
      });
    },
    adminPreviewBillRevision: async (request, _reply, context) =>
      previewBillRevision(context, revision(request, context, 'manager', await activeBranchFor(request))),
    adminReviseBill: async (request, _reply, context) =>
      reviseBill(context, revision(request, context, 'manager', await activeBranchFor(request))),
    adminSubmitDay: async (request, _reply, context) => {
      const branchId = await dayBranch(context, await activeBranchFor(request));
      return submitDay(context, {
        branchId,
        businessDate: businessDateParam(param(request, 'date'), await currentBusinessDate(context, branchId)),
        submittedByUserId: actorId(context, request),
        expected: body<{ expected?: { billCount?: unknown; payableMinor?: unknown } }>(request).expected ?? null,
      });
    },
    reopenDay: async (request, _reply, context) => {
      const branchId = await dayBranch(context, await activeBranchFor(request));
      return reopenDay(context, {
        branchId,
        businessDate: businessDateParam(param(request, 'date'), await currentBusinessDate(context, branchId)),
        reason: body<{ reason?: unknown }>(request).reason,
        reopenedByUserId: actorId(context, request),
      });
    },
    enablePosEditing: async (request, _reply, context) => posEditing(request, context, true),
    disablePosEditing: async (request, _reply, context) => posEditing(request, context, false),

    openOrders: async (request, _reply, context) =>
      ({ rows: await listOpenOrders(context, { branchId: branchIfAny(request) }) }),

    cancelOrder: async (request, _reply, context) => {
      const reason = body<{ reason?: unknown }>(request).reason;
      const result = await cancelOrder(context, {
        sessionId: param(request, 'id'),
        reason: typeof reason === 'string' ? reason : '',
        branchId: branchIfAny(request),
      }, actorId(context, request));
      return result;
    },

    billingQueue: async (request, _reply, context) => {
      const branchId = branchOf(request);
      return {
        // Whether orders arrive from KOT, or the Billing screen takes them itself
        // (Basic). From the same document every plan gate reads.
        kot: hasFeature(request.entitlement!, 'kot'),
        rows: await listBillingQueue(context, { branchId, businessDate: await currentBusinessDate(context, branchId) }),
      };
    },

    releaseLease: async (request, _reply, context) => {
      const input = body<{ deviceId: string }>(request);
      await releaseLease(context, { sessionId: param(request, 'id'), deviceId: input.deviceId });
      return { released: true };
    },

    forceRelease: async (request, _reply, context) => {
      const input = body<{ reasonId: string }>(request);
      return forceReleaseLease(context, {
        sessionId: param(request, 'id'),
        reasonId: input.reasonId,
        byUserId: actorId(context, request),
      });
    },

    addLine: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<{
        menuItemId: string; quantity: number;
        modifierOptionIds?: string[];
        choices?: { choiceGroupId: string; menuItemId: string }[];
        note?: string;
        /** 1..covers, or absent for a shared line. Validated in the domain. */
        guestNo?: number | null;
      }>(request);
      return addLine(
        context, { orderId: param(request, 'id'), ...input }, actorId(context, request));
    },

    myTakings: async (request, _reply, context) => {
      // The person and the branch are the token's; only the dates are asked for.
      const branchId = branchOf(request);
      const query = request.query as Record<string, unknown>;
      return tillSummary(context, {
        userId: actorId(context, request), branchId,
        period: query['period'], from: query['from'], to: query['to'],
        today: await currentBusinessDate(context, branchId),
      });
    },

    setParcelCharge: async (request, _reply, context) => {
      // The amount is the till's, like a discount amount: a person decided it,
      // and the domain bounds it by the branch's cap.
      const input = body<{ amountMinor: number }>(request);
      return setParcelCharge(
        context, { orderId: param(request, 'id'), amountMinor: input.amountMinor }, actorId(context, request));
    },

    quote: async (request, _reply, context) => {
      const input = body<{
        parcel?: boolean;
        lines?: { menuItemId: string; quantity: number; modifierOptionIds?: string[];
          choices?: { choiceGroupId: string; menuItemId: string }[] }[];
        parcelChargeMinor?: number | null;
      }>(request);
      return quoteOrder(context, {
        branchId: branchOf(request),
        parcel: input.parcel === true,
        lines: input.lines ?? [],
        parcelChargeMinor: input.parcelChargeMinor ?? null,
      });
    },

    editLine: async (request, _reply, context) => {
      const input = body<{ quantity?: number; note?: string | null }>(request);
      if (input.quantity === undefined && input.note === undefined) {
        await removeLine(context, param(request, 'lineId'));
        return { removed: true };
      }
      await editLine(context, { lineId: param(request, 'lineId'), ...input });
      return { edited: true };
    },

    fire: async (request, _reply, context) => {
      // sessionVersion is the one field that legitimately comes from the body:
      // it is the client asserting which version of the session it composed
      // against, which is the point of optimistic concurrency. The session and
      // the branch are not the client's to assert.
      const input = body<{ sessionVersion: number }>(request);
      const branchId = branchOf(request);
      const result = await fireOrder(context, {
        // No idempotency key passed: the registrar claimed it before this
        // handler ran. Passing it here is what produced a SECOND claim on the
        // same key under a different operation name, and every fire answered
        // 409 idempotency_key_reused.
        orderId: param(request, 'id'),
        sessionId: leasedSession(request),
        sessionVersion: input.sessionVersion,
        branchId,
        firedByUserId: actorId(context, request),
        businessDate: await currentBusinessDate(context, branchId),
      });
      return result;
    },

    void: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<{ lineId: string; quantity: number; reasonId: string; note?: string }>(request);
      return { adjustmentId: await voidLine(context, input, actorId(context, request)) };
    },

    comp: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<{ lineId: string; quantity: number; reasonId: string; note?: string }>(request);
      return { adjustmentId: await compLine(context, input, actorId(context, request)) };
    },

    discount: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<{
        lineId: string; reasonId: string; percent?: number; amountMinor?: number; note?: string;
      }>(request);
      return {
        adjustmentId: await discountLine(
          context, input, await discountAuthority(context, request), actorId(context, request)),
      };
    },

    generateBill: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      // Was `body<Parameters<typeof generateBill>[1]>` -- a straight
      // passthrough, which handed the client `generatedByUserId`, `branchId`,
      // `sessionId` AND `businessDate`. A bill is the document a till-shortfall
      // investigation reads, and its attribution was whatever the tablet said.
      // The audit row was always right (the registrar takes the actor from the
      // token); the money row was not.
      const input = body<{
        splitKind: Parameters<typeof generateBill>[1]['splitKind'];
        lineIds?: readonly string[];
        guestNos?: readonly number[];
        shareBps?: number;
      }>(request);
      const branchId = branchOf(request);
      return generateBill(context, {
        ...input,
        branchId,
        sessionId: leasedSession(request),
        businessDate: await currentBusinessDate(context, branchId),
        generatedByUserId: actorId(context, request),
      });
    },

    tender: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      // Who took the cash comes from the token, never the body. This is the one
      // attribution a shift reconciliation turns on.
      const input = body<Omit<
        Parameters<typeof recordTender>[1], 'billId' | 'tenderedByUserId'
      >>(request);
      return recordTender(context, {
        ...input,
        billId: param(request, 'id'),
        tenderedByUserId: actorId(context, request),
      });
    },

    payment: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<Omit<
        Parameters<typeof takePayment>[1], 'billId' | 'tenderedByUserId'
      >>(request);
      return takePayment(context, {
        parts: input.parts,
        billId: param(request, 'id'),
        tenderedByUserId: actorId(context, request),
      });
    },

    voidTender: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<{ reasonId: string }>(request);
      return voidTender(context, {
        tenderId: param(request, 'tenderId'),
        reasonId: input.reasonId,
        voidedByUserId: actorId(context, request),
      });
    },

    refund: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      const input = body<Omit<Parameters<typeof recordRefund>[1], 'billId' | 'refundedByUserId'>>(request);
      return recordRefund(context, {
        ...input, billId: param(request, 'id'),
        refundedByUserId: actorId(context, request),
      });
    },

    settleManual: async (request, _reply, context) => {
      requireIdempotencyKey(request);
      // Two people, and the distinction is the whole point of the route: the
      // CASHIER keying it in comes from the token, and the MANAGER who
      // authorised it comes from the body, because it is somebody else. A gate
      // would otherwise refuse both -- see THIRD_PARTY_ATTRIBUTION.
      const input = body<Omit<
        Parameters<typeof recordManualSettlement>[1], 'billId' | 'tenderedByUserId'
      >>(request);
      return recordManualSettlement(context, {
        ...input,
        billId: param(request, 'id'),
        tenderedByUserId: actorId(context, request),
      });
    },

    /**
     * The adjustment vocabulary. No branch, no lease, no idempotency key: it is
     * a tenant-wide read of a small catalogue, and the same handler serves the
     * KDS recall sheet under its own permission.
     */
    adjustmentReasons: async (_request, _reply, context) =>
      listAdjustmentReasons(context),

    orderTickets: async (request, _reply, context) =>
      orderTickets(context, {
        branchId: branchIfAny(request), orderId: param(request, 'id'),
      }),

    markTicketReady: async (request, _reply, context) =>
      markTicketReady(context, {
        kotId: param(request, 'id'), branchId: branchOf(request),
      }),

    reprint: async (request, _reply, context) => {
      // Reprint is not retry: it creates a NEW job, so the failure rate of the
      // original is not diluted by a human asking for another copy.
      return requestReprint(context.client, {
        tenantId: context.tenantId,
        branchId: branchIfAny(request),
        jobId: param(request, 'id'),
        byUserId: actorId(context, request),
      });
    },
  };
}

export class ReopenReasonRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'reopen_reason_required';
  constructor() {
    super('say why the order is going back to KOT (at least a few words); it is recorded with the reopen');
    this.name = 'ReopenReasonRequiredError';
  }
}
