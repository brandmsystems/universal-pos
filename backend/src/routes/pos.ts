import { leasedOn, type RouteDefinition } from '../middleware/routeRegistry.js';
import { handlerLookup, pathId, type Handler } from './lookup.js';

/**
 * The POS surface.
 *
 * Called from a tablet, over bad wifi, by someone standing up. Everything here
 * is shaped by that: one aggregate read rather than six, an idempotency key on
 * every mutation, a lease on everything that touches a session, and a batch
 * endpoint that is its own thing rather than a loop.
 *
 * The board READ is not here -- it is `src/modules/orders/board.ts`. This module is
 * declarative: the route table only. The two request-shape guards (idempotency
 * key, lease token) are `middleware/posHeaders.ts`, which app.ts calls.
 * Nothing here issues SQL, and the thin-handler gate enforces that across the
 * whole route layer rather than over one directory inside it.
 */

/* ----------------------------------------------------------- the routes --- */


/**
 * The POS route table.
 *
 * `lease: leasedOn.<subject>` on everything that touches a leased session, and
 * the subject is the operative half: it tells the registrar how to reach the
 * session from this route's own parameters, so the lease is resolved from the
 * database before the handler runs. The exemptions are declared, not discovered.
 */
export function posRoutes(handlers: Record<string, Handler> = {}): readonly RouteDefinition[] {
  const h = handlerLookup(handlers);

  return [
    // ---- reads -------------------------------------------------------------
    {
      method: 'GET', url: '/pos/session/:id/board', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.view' }, audit: 'none', handler: h('board'),
    },
    {
      method: 'GET', url: '/pos/menu', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.view' }, audit: 'none', handler: h('menu'),
    },
    // ###################################################################
    // THE FIRST SCREEN OF A SHIFT, WHICH HAD NO ENDPOINT.
    //
    // `/pos/session/:id/board` reads one session and is everything a waiter
    // needs once they are AT a table. Nothing enumerated the tables, so the
    // screen a shift opens on could not be built. `table.view` was sitting in
    // KEYS_WITHOUT_ROUTES the whole time, which is exactly what that ratchet
    // is for.
    // ###################################################################
    // ###################################################################
    // THE ADJUSTMENT VOCABULARY, ON BOTH SURFACES THAT NEED IT.
    //
    // Two declarations, one handler. A single route could not serve both:
    // permission is one key per route, and the KITCHEN system role holds
    // `kds.view` without `order.view` -- so a list gated on `order.view` alone
    // would leave the KDS recall sheet unable to read the reasons its own
    // mutation requires, which is the defect being fixed, moved one screen over.
    //
    // Gating instead on a key that happens to be in every role (`menu.view`)
    // would rest the guarantee on a coincidence in the seed rather than on a
    // rule, and the seed is editable per tenant.
    // ###################################################################
    {
      method: 'GET', url: '/pos/adjustment-reasons', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.view' }, audit: 'none',
      handler: h('adjustmentReasons'),
    },
    {
      method: 'GET', url: '/pos/floor', plane: 'tenant',
      permission: { plane: 'tenant', key: 'table.view' }, audit: 'none', handler: h('floor'),
    },
    {
      method: 'GET', url: '/pos/sync/quarantine', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.exception.view' }, audit: 'none', handler: h('quarantine'),
      // Borrows the exception report's KEY, not its tier: resolving a stranded
      // offline batch is operations every plan needs, not a Max-only report.
      plan: { reports: 'basic' },
    },

    // ---- the lease ---------------------------------------------------------
    {
      method: 'POST', url: '/pos/session', plane: 'tenant', lease: 'exempt',
      // Seating a party at tables needs the plan's tables (Basic has none:
      // its dine-in is numbered at the counter, POST /pos/dine-in).
      plan: [{ feature: 'tables' }, { module: 'tables' }],
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { action: 'table.session.opened', target: 'table_session' },
      handler: h('openSession'),
    },
    {
      // Closing is a consensus act on the session, so it needs the lease like
      // any other write against it. `closeSession` was implemented and had no
      // route at all: the handler-to-route correspondence gate found it.
      method: 'DELETE', url: '/pos/session/:id', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'table.session.close' },
      audit: { action: 'table.session.closed', target: 'table_session' },
      handler: h('closeSession'),
    },
    {
      // A party moving from table 4 to table 7 keeps ONE session -- this moves
      // the relation, it does not open a second. Hence PATCH on the session
      // rather than anything table-keyed, which is the same reason the lease is
      // keyed on the session and not the table.
      method: 'PATCH', url: '/pos/session/:id/table', plane: 'tenant', lease: leasedOn.session,
      plan: [{ feature: 'tables' }, { module: 'tables' }],
      permission: { plane: 'tenant', key: 'table.session.transfer' },
      audit: { action: 'table.session.moved', target: 'table_session' },
      handler: h('moveSession'),
    },
    {
      // More guests arrive: the next table joins the SAME session, so there is
      // still one order and one bill. Same key as a move -- both change which
      // tables a party holds, and neither touches money.
      method: 'POST', url: '/pos/session/:id/tables', plane: 'tenant', lease: leasedOn.session,
      plan: [{ feature: 'tables' }, { module: 'tables' }],
      permission: { plane: 'tenant', key: 'table.session.transfer' },
      audit: { action: 'table.session.joined', target: 'table_session' },
      handler: h('joinTable'),
    },
    {
      // The table goes back to the floor; every line stays with the party, and
      // paying separately is Split bill's job.
      method: 'DELETE', url: '/pos/session/:id/tables/:tableId', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'table.session.transfer' },
      audit: { action: 'table.session.unjoined', target: 'table_session' },
      handler: h('unjoinTable'),
    },
    {
      method: 'PATCH', url: '/pos/session/:id/guests', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { action: 'table.session.guests_changed', target: 'table_session' },
      handler: h('setGuests'),
    },
    {
      // A parcel is a session with no table: exempt from the lease for the same
      // reason opening a table is -- there is no session to hold yet.
      method: 'POST', url: '/pos/parcel', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { action: 'parcel.opened', target: 'table_session' },
      handler: h('openParcel'),
    },
    {
      // The till's own X-read: what the signed-in person took, by day, week or
      // month, or a chosen from/to range. A till key, not a report (modules/reports/tillSummary.ts).
      method: 'GET', url: '/pos/my-takings', plane: 'tenant',
      permission: { plane: 'tenant', key: 'till.summary.view' }, audit: 'none', handler: h('myTakings'),
    },
    {
      method: 'GET', url: '/pos/parcels', plane: 'tenant',
      permission: { plane: 'tenant', key: 'table.view' }, audit: 'none', handler: h('parcels'),
    },
    {
      // Dine-in with no table (Basic): a session numbered at the counter, from
      // the same counter as parcels. Exempt from the lease like any open.
      method: 'POST', url: '/pos/dine-in', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { action: 'dine_in.counter.opened', target: 'table_session' },
      handler: h('openCounterDineIn'),
    },
    {
      method: 'GET', url: '/pos/dine-ins', plane: 'tenant',
      permission: { plane: 'tenant', key: 'table.view' }, audit: 'none', handler: h('counterDineIns'),
    },
    {
      method: 'POST', url: '/pos/session/:id/pickup', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'table.session.open' },
      audit: { action: 'parcel.picked_up', target: 'table_session' },
      handler: h('pickupParcel'),
    },

    // ---- KOT hands the order to Billing ------------------------------------
    // One order, two owners in turn. The hand-over is under the KOT lease; after
    // it every order change is refused in the domain, and Billing takes the
    // session with its own lease route and its own key.
    {
      method: 'POST', url: '/pos/session/:id/ready-for-billing', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'order.handover' },
      // The document decides whether every item must have been sent (KOT plans).
      plan: 'document',
      audit: { action: 'order.handed_to_billing', target: 'table_session' },
      handler: h('readyForBilling'),
    },
    {
      method: 'POST', url: '/pos/session/:id/billing-lease', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'bill.generate' }, audit: 'none',
      handler: h('claimBillingLease'),
    },
    {
      method: 'GET', url: '/billing/queue', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', plan: 'document',
      handler: h('billingQueue'),
    },
    {
      // Claim or renew. audit 'none' deliberately: lease churn is constant and
      // the lease ROW is already the record, with its own one-way stamps.
      method: 'POST', url: '/pos/session/:id/lease', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'table.session.open' }, audit: 'none', handler: h('claimLease'),
    },
    {
      method: 'DELETE', url: '/pos/session/:id/lease', plane: 'tenant', lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'table.session.open' }, audit: 'none', handler: h('releaseLease'),
    },
    {
      // EXEMPT, and this is the whole reason the exemption exists: the lease is
      // being force-released BECAUSE the device holding it died, so the manager
      // has no token by definition. Requiring one would make the recovery path
      // depend on the thing being recovered from.
      method: 'POST', url: '/pos/session/:id/lease/force-release',
      plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'table.session.lease.force_release' },
      audit: { action: 'table.session.lease.force_released', target: 'table_session' },
      handler: h('forceRelease'),
    },

    // ---- the order ---------------------------------------------------------
    {
      method: 'POST', url: '/pos/order/:id/line', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: { action: 'order.line.added', target: 'order_line' },
      handler: h('addLine'),
    },
    {
      method: 'PATCH', url: '/pos/order/:id/line/:lineId', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.line.remove' },
      audit: { action: 'order.line.edited', target: 'order_line' },
      handler: h('editLine'),
    },
    {
      // Set or replace (0 clears) a parcel's charge. The amount is typed, so
      // the domain caps it at the branch's maximum; the key is the one that
      // adds lines, because the cap -- not the key -- is the control.
      method: 'POST', url: '/pos/order/:id/parcel-charge', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.create' },
      audit: { action: 'order.parcel_charge.set', target: 'sales_order', targetId: pathId },
      handler: h('setParcelCharge'),
    },
    {
      // A POST only because a cart does not fit a query string; it writes
      // nothing and claims no key (POS_POST_READS). No session exists yet.
      method: 'POST', url: '/pos/quote', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'order.create' }, audit: 'none',
      handler: h('quote'),
    },
    {
      // ONE audit row per fire, not one per line. The domain tables are the
      // fine-grained history; the audit log records who decided what.
      method: 'POST', url: '/pos/order/:id/fire', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'kot.fire' },
      // Sending to the kitchen is the KOT flow; Basic bills without it.
      plan: [{ feature: 'kot' }, { module: 'kot' }],
      audit: { action: 'order.confirmed', target: 'sales_order' },
      handler: h('fire'),
    },
    {
      method: 'POST', url: '/pos/order/:id/void', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.void' },
      audit: { action: 'order.voided', target: 'order_line' },
      handler: h('void'),
    },
    {
      method: 'POST', url: '/pos/order/:id/comp', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.comp' },
      audit: { action: 'order.comped', target: 'order_line' },
      handler: h('comp'),
    },
    {
      method: 'POST', url: '/pos/order/:id/discount', plane: 'tenant', lease: leasedOn.order,
      permission: { plane: 'tenant', key: 'order.discount' },
      audit: { action: 'order.discounted', target: 'order_line' },
      handler: h('discount'),
    },

    // ---- money -------------------------------------------------------------
    {
      // Under the SESSION, not at /pos/bill with the session in the body.
      //
      // A bill is generated for a session and the lease is held on that session,
      // so putting it in the path makes the lease subject a route parameter like
      // every other leased route. The body form needed a whole extra branch in
      // the guard -- `LeaseSubjectSource` with an `in: 'body'` arm -- for exactly
      // one route, and an untested branch inside a security guard is the same
      // shape as every other defect this phase found.
      method: 'POST', url: '/pos/session/:id/bill', plane: 'tenant',
      lease: leasedOn.session,
      permission: { plane: 'tenant', key: 'bill.generate' },
      audit: { action: 'bill.generated', target: 'bill' },
      handler: h('generateBill'),
    },
    {
      // The paper: BILL before payment, RECEIPT after, each copy counted so a
      // second one prints as a REPRINT. Exempt from the lease: a receipt is
      // asked for after the table has closed and nobody holds it any more, and
      // printing changes nothing about the bill.
      method: 'POST', url: '/pos/bill/:id/print', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'bill.reprint' },
      audit: { action: 'bill.printed', target: 'bill' },
      handler: h('printBill'),
    },
    // ---- bill history, bill edits and day end (0086) ------------------------
    // Branch-wide, and that is decided: the till reviews the whole day before it
    // submits it. Edits and day end are lease-exempt like a reprint: they reach
    // bills whose table has closed, and they lock the session and the bill
    // themselves, under the day lock (payments/dayEnd.ts).
    {
      method: 'GET', url: '/pos/bills', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', handler: h('billHistory'),
    },
    {
      method: 'GET', url: '/pos/bills/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', handler: h('billDetail'),
    },
    {
      // The edit run and rolled back, for the confirmation's figures. Audited like
      // the setup import's preview: a POST that writes, even to undo it.
      method: 'POST', url: '/pos/bills/:id/revise/preview', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'bill.edit' },
      audit: { action: 'bill.revision.previewed', target: 'bill', targetId: pathId },
      handler: h('previewBillRevision'),
    },
    {
      method: 'POST', url: '/pos/bills/:id/revise', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'bill.edit' },
      audit: { action: 'bill.revised', target: 'bill', targetId: pathId },
      handler: h('reviseBill'),
    },
    {
      method: 'GET', url: '/pos/day', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', handler: h('dayReview'),
    },
    {
      method: 'POST', url: '/pos/day/submit', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'payment.settlement.close' },
      audit: { action: 'day.submitted', target: 'day_submission' },
      handler: h('submitDay'),
    },
    {
      method: 'POST', url: '/pos/bill/:id/tender', plane: 'tenant', lease: leasedOn.bill,
      permission: { plane: 'tenant', key: 'payment.collect' },
      audit: { action: 'payment.collected', target: 'tender' },
      handler: h('tender'),
    },
    {
      // Several methods at once, all or none: card ₹500 + cash note ₹500 on an
      // ₹850 bill takes ₹850 and returns ₹150 change in one write.
      method: 'POST', url: '/pos/bill/:id/payment', plane: 'tenant', lease: leasedOn.bill,
      permission: { plane: 'tenant', key: 'payment.collect' },
      audit: { action: 'payment.collected', target: 'tender' },
      handler: h('payment'),
    },
    {
      method: 'POST', url: '/pos/bill/:id/tender/:tenderId/void',
      plane: 'tenant', lease: leasedOn.bill,
      permission: { plane: 'tenant', key: 'payment.tender.void' },
      audit: { action: 'payment.tender.voided', target: 'tender' },
      handler: h('voidTender'),
    },
    {
      method: 'POST', url: '/pos/bill/:id/refund', plane: 'tenant', lease: leasedOn.bill,
      permission: { plane: 'tenant', key: 'payment.refund' },
      audit: { action: 'payment.refunded', target: 'refund' },
      handler: h('refund'),
    },
    {
      // EXEMPT: a cashier keying in money a manual card machine took during an
      // outage, after the fact and usually on a different device from the one
      // that held the table.
      method: 'POST', url: '/pos/bill/:id/settle-manual', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'payment.settle.manual' },
      audit: { action: 'payment.settled_manually', target: 'tender' },
      handler: h('settleManual'),
    },
    {
      // What the KOT screen shows after a send: each kitchen ticket, its printer,
      // and whether the paper went. Read-only over the print jobs fire wrote.
      method: 'GET', url: '/pos/order/:id/tickets', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kot.view' },
      plan: [{ feature: 'kot' }, { module: 'kot' }],
      audit: 'none',
      handler: h('orderTickets'),
    },
    {
      method: 'POST', url: '/pos/kot/:id/reprint', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'kot.reprint' },
      plan: [{ feature: 'kot' }, { module: 'kot' }],
      audit: { action: 'kot.reprinted', target: 'print_job' },
      handler: h('reprint'),
    },
    {
      // A restaurant without a kitchen screen: KOT says the food is ready.
      // Lease-exempt like the reprint -- it changes the kitchen ticket, not the
      // order, and food can be ready after the order is handed to Billing.
      method: 'POST', url: '/pos/kot/:id/ready', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'kot.ready' },
      plan: [{ feature: 'kot' }, { module: 'kot' }],
      audit: { action: 'kot.marked_ready', target: 'kot', targetId: pathId },
      handler: h('markTicketReady'),
    },

    // ---- the batch ---------------------------------------------------------
    {
      // Its own thing, not a loop. See syncRoutes below.
      method: 'POST', url: '/pos/sync', plane: 'tenant', lease: 'exempt',
      permission: { plane: 'tenant', key: 'order.create' },
      audit: { action: 'offline.batch.received', target: 'sync_batch' },
      handler: h('sync'),
    },
  ];
}
