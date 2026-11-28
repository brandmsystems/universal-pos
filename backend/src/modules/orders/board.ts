import type { TenantContext } from '../../database/tenantContext.js';
import { readMenuForBranch } from '../products/read.js';

/**
 * The POS board read.
 *
 * ###########################################################################
 * THIS IS A DOMAIN READ, AND IT LIVES IN THE DOMAIN FOR A STRUCTURAL REASON.
 *
 * It used to sit in `src/routes/pos.ts`, which made the thin-handler gate
 * pass by GEOGRAPHY: `src/routes/handlers/pos.ts` issued no SQL because the six
 * queries below were one directory over, inside the route layer, unscanned.
 *
 * The queries were never the defect -- see the live-price note on the catalogue
 * read -- but a gate scoped to one directory beside a directory that grows is
 * the wrong polarity. Moving the read here lets the gate deny SQL across the
 * whole route layer with only the two registrars exempted, rather than carrying
 * a domain module on its allowlist as a precedent.
 * ###########################################################################
 */

export interface BoardResponse {
  readonly session: Record<string, unknown> | null;
  readonly tables: readonly Record<string, unknown>[];
  readonly lines: readonly Record<string, unknown>[];
  /**
   * ###########################################################################
   * THE LEASE ROW IS RETURNED WHATEVER STATE IT IS IN, WITH THE STATE ON IT.
   *
   * This used to filter `released_at IS NULL AND force_released_at IS NULL AND
   * expires_at > now()`, which collapsed four different situations into one
   * `null`: never leased, released normally, expired, and FORCE-RELEASED. The
   * client then had no way to tell a manager taking the table from a lease
   * quietly timing out -- and those need different words in front of a waiter,
   * who otherwise retries, reboots the tablet, and re-keys the order elsewhere.
   *
   * The server already draws that distinction: `lease_force_released` and
   * `lease_expired` are two of the five quarantine reasons. Filtering it away
   * here threw away information the sync path depends on.
   *
   * `null` now means exactly one thing: this session has never been leased.
   * Anything else carries `state`, and the client compares `device_id` to its
   * own -- a live lease in this response is not necessarily a grant to the
   * device reading it.
   * ###########################################################################
   */
  readonly lease: Record<string, unknown> | null;
  /**
   * Server time at the moment of the read, so a client countdown is anchored to
   * the clock that decides. Free here, and the alternative is a tablet trusting
   * its own clock to know when to stop accepting writes.
   */
  readonly serverNow: string;
  /**
   * Resolved SERVER-SIDE, precedence already applied, with the reason per item.
   *
   * The tablet must never re-derive availability. All three concerns deny, but
   * they say different things to the waiter -- "available from 07:00" is not
   * "sold out" -- and a tablet holding three booleans gets that wrong at 11:01am.
   */
  readonly menu: readonly Record<string, unknown>[];
  /**
   * What ETag would carry later, and what tells an offline tablet its cached
   * menu is stale. Free now, expensive to retrofit.
   */
  readonly menuVersion: string;
  /**
   * ###########################################################################
   * THE BILLS, WITH THEIR TENDERS AND WHAT IS STILL OUTSTANDING.
   *
   * Nothing read this. `recordTender` returns `outstandingMinor` in its own
   * response, and that was the only way a client could ever learn it -- so a
   * tablet that took a partial cash tender and then reloaded, or a second
   * tablet asked to finish the settlement, had no way to find out that ₹200 of
   * ₹900 was already in the till. It would have shown the full total again.
   *
   * Returned per bill rather than as one session figure, because a split bill
   * is several documents and "outstanding" is a property of each. `settled` and
   * `outstanding_minor` are derived HERE, not by the client: they are money, and
   * the priced-document rule says money has one author. A tablet summing tender
   * rows itself is a second opinion about how much is in the drawer.
   * ###########################################################################
   */
  readonly bills: readonly Record<string, unknown>[];
  /**
   * The tenant's tax options, on the board rather than fetched separately.
   *
   * Two reasons. The doctrine below -- one round trip, not six -- applies: a
   * till that asked for this on its own would render the field a moment after
   * the bill, or not at all on a flaky connection. And the alternative is
   * giving a cashier a permission to read the admin settings route, which is
   * authority they do not need for a flag that decides whether one field is
   * drawn.
   */
  readonly taxOptions: { readonly b2bCaptureEnabled: boolean };
  readonly entitlement: { readonly features: Record<string, boolean> };
}

/**
 * ###########################################################################
 * ONE ROUND TRIP, NOT SIX.
 *
 * Six responses are six INSTANTS: the menu can change between call three and
 * call five, and the tablet renders a price it will not be allowed to charge.
 * The waiter is standing at the table while this happens.
 * ###########################################################################
 */
export async function readBoard(
  context: TenantContext,
  params: { sessionId: string; branchId: string; businessDate: string },
): Promise<BoardResponse> {
  const session = await context.client.query<Record<string, unknown>>(
    `SELECT s.id, s.branch_id, s.business_date::text, s.guest_count, s.status,
            s.version, s.opened_at::text,
            s.service_type, s.seating, s.parcel_no, s.pickup_name, s.picked_up_at::text,
            s.stage, s.billing_ready_at::text
       FROM app.table_session s
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [context.tenantId, params.sessionId],
  );

  const tables = await context.client.query<Record<string, unknown>>(
    // A party moving from table 4 to 7 keeps ONE session with two rows here, so
    // detached ones are excluded rather than the relation being read as a
    // single current table.
    `SELECT t.dining_table_id, d.identifier, d.seats
       FROM app.table_session_table t
       JOIN app.dining_table d ON d.tenant_id = t.tenant_id AND d.id = t.dining_table_id
      WHERE t.tenant_id = $1 AND t.session_id = $2 AND t.detached_at IS NULL`,
    [context.tenantId, params.sessionId],
  );

  const lines = await context.client.query<Record<string, unknown>>(
    // #######################################################################
    // AN ADJUSTMENT NOW SAYS WHICH LINE IT CAME OFF, AND WHY.
    //
    // These three columns were missing, so the POS listed voids and comps in a
    // separate "TAKEN OFF" block and said, in words, that it could not attach
    // them: matching by display name would pick the wrong one of two identical
    // dishes, and there was nothing else to match on. The reason code was
    // collected, stored, required -- and never shown to the person who chose it.
    //
    // `guest_no` joins them for the same reason: the split screen needs to know
    // whose line it is, and it was reading a column the board did not send.
    // #######################################################################
    `SELECT ol.id, ol.order_id, ol.kind, ol.parent_line_id, ol.menu_item_id,
            ol.display_name, ol.unit_price_minor::text, ol.quantity,
            ol.line_total_minor::text, ol.display_total_minor::text,
            ol.tax_rate_bps, ol.modifiers, ol.note, ol.guest_no,
            ol.adjusts_line_id, ol.adjustment_reason_id, ol.adjustment_note,
            ar.name AS adjustment_reason_name,
            (ol.fired_at IS NOT NULL) AS fired
       FROM app.order_line ol
       JOIN app.sales_order so ON so.tenant_id = ol.tenant_id AND so.id = ol.order_id
       LEFT JOIN app.adjustment_reason ar
              ON ar.tenant_id = ol.tenant_id AND ar.id = ol.adjustment_reason_id
      WHERE ol.tenant_id = $1 AND so.session_id = $2
      ORDER BY ol.created_at`,
    [context.tenantId, params.sessionId],
  );

  // Most recent lease for the session, in whatever state it is in. The state is
  // derived here rather than by the client: `expires_at > now()` is a comparison
  // against SERVER time, and a tablet re-deriving it from its own clock is the
  // one thing the lease design refuses.
  //
  // Precedence is deliberate and matches the quarantine reasons: force release
  // outranks expiry, because a lease that was force-released and has since
  // expired is a force release as far as the stranded device is concerned.
  const lease = await context.client.query<Record<string, unknown>>(
    `SELECT id, device_id, branch_id,
            expires_at::text, claimed_at::text, renewed_at::text,
            released_at::text, force_released_at::text,
            CASE
              WHEN force_released_at IS NOT NULL THEN 'force_released'
              WHEN released_at IS NOT NULL       THEN 'released'
              WHEN expires_at <= now()           THEN 'expired'
              ELSE 'live'
            END AS state,
            GREATEST(0, floor(EXTRACT(EPOCH FROM (expires_at - now()))))::int
              AS seconds_remaining
       FROM app.table_session_lease
      WHERE tenant_id = $1 AND session_id = $2
      ORDER BY claimed_at DESC
      LIMIT 1`,
    [context.tenantId, params.sessionId],
  );

  // Server time, for the client's lease countdown. The device clock is not an
  // input to anything: what a tablet can observe honestly is the OFFSET between
  // its clock and this value, measured at the last response. Absolute device
  // time cannot be trusted and must not be used to decide when a screen goes
  // read-only.
  const nowRow = await context.client.query<{ server_now: string }>(
    'SELECT now()::text AS server_now',
  );

  // A void is a NEGATIVE tender row with `voids_tender_id` set, not a flag on
  // the row it cancels -- the ledger is append-only and signed. So "paid" is a
  // plain sum over every row, voids included, and there is no filter to get
  // wrong. The rows come back whole so a cashier reconciling a drawer sees the
  // capture and its void as two events rather than an absence.
  const bills = await context.client.query<Record<string, unknown>>(
    `SELECT b.id, b.bill_no, b.split_kind, b.status,
            b.subtotal_minor::text, b.tax_minor::text, b.total_minor::text,
            -- Paid to the nearest rupee (0082): the round-off line, and what is owed.
            b.round_off_minor::text, b.payable_minor::text,
            -- The bill split as charged (0081): the dishes, and the parcel charge
            -- on its own line. As the diner saw them -- tax-inclusive on a
            -- reverse-mode bill (0083), so the two always sum to what was priced.
            ((CASE WHEN b.prices_include_tax THEN b.total_minor ELSE b.subtotal_minor END)
              - COALESCE(chg.amount, 0))::text AS items_minor,
            COALESCE(chg.amount, 0)::text AS parcel_charge_minor,
            -- How the bill was taxed (0083): the account, and whether prices include it.
            b.tax_account_type, b.prices_include_tax,
            b.generated_at::text, b.settled_at::text,
            -- WHETHER a customer is named, and never their number. The till
            -- needs to know whether to offer "attach" or "change", and whether
            -- redemption is even possible; it does not need the phone, which
            -- leaves the server through exactly one logged route.
            b.customer_id,
            -- The COMPANY on the bill, if a cashier recorded one. Not a phone
            -- and not personal data: a GSTIN is a business's public tax
            -- identifier, printed on the invoice it belongs to, and the till has
            -- to show whether one is already there before offering to add one.
            b.recipient_gstin, b.recipient_legal_name,
            -- The POSITION the bill was raised under, so the till can title the
            -- document. A composition taxable person hands over a BILL OF
            -- SUPPLY, not a tax invoice, and it has to say so on the paper.
            -- Snapshotted on the bill, so a reprint after the shop leaves the
            -- scheme still says what it said.
            b.supplier_gst_registration,
            COALESCE(paid.amount, 0)::text AS paid_minor,
            (b.payable_minor - COALESCE(paid.amount, 0))::text AS outstanding_minor,
            (COALESCE(paid.amount, 0) >= b.payable_minor) AS settled,
            COALESCE(t.rows, '[]'::json) AS tenders
       FROM app.bill b
       LEFT JOIN LATERAL (
         SELECT sum(tn.amount_minor - tn.rounding_minor) AS amount
           FROM app.tender tn
          WHERE tn.tenant_id = b.tenant_id AND tn.bill_id = b.id
       ) paid ON true
       LEFT JOIN LATERAL (
         SELECT sum(bl.amount_minor + CASE WHEN b.prices_include_tax THEN bl.tax_minor ELSE 0 END) AS amount
           FROM app.bill_line bl
           JOIN app.order_line ol ON ol.tenant_id = bl.tenant_id AND ol.id = bl.order_line_id
          WHERE bl.tenant_id = b.tenant_id AND bl.bill_id = b.id AND ol.kind = 'charge'
       ) chg ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', tn.id, 'kind', tn.kind, 'method', tn.method,
                  'amount_minor', tn.amount_minor::text,
                  'rounding_minor', tn.rounding_minor::text,
                  'cash_received_minor', tn.cash_received_minor::text,
                  'change_minor', COALESCE(tn.cash_received_minor - tn.amount_minor, 0)::text,
                  'reference', tn.reference,
                  'voids_tender_id', tn.voids_tender_id,
                  'settled_offline_manually', tn.settled_offline_manually,
                  'tendered_at', tn.tendered_at::text
                ) ORDER BY tn.tendered_at) AS rows
           FROM app.tender tn
          WHERE tn.tenant_id = b.tenant_id AND tn.bill_id = b.id
       ) t ON true
      -- A voided bill is a record, not something to pay: a parcel charge
      -- changed before payment voids the unpaid bill and the till makes it again.
      WHERE b.tenant_id = $1 AND b.session_id = $2 AND b.status <> 'void'
      ORDER BY b.bill_no`,
    [context.tenantId, params.sessionId],
  );

  // Absence is the stated default, not a missing row: `provisionTenant` writes
  // none and OFF is the conservative direction -- the field simply is not drawn.
  const taxOptions = await context.client.query<{ b2b_capture_enabled: boolean }>(
    `SELECT b2b_capture_enabled FROM app.tenant_tax_setting WHERE tenant_id = $1`,
    [context.tenantId],
  );

  const { menu, menuVersion } = await readMenuForBranch(context, {
    branchId: params.branchId,
  });

  return {
    session: session.rows[0] ?? null,
    tables: tables.rows,
    lines: lines.rows,
    lease: lease.rows[0] ?? null,
    serverNow: nowRow.rows[0]!.server_now,
    menu,
    menuVersion,
    bills: bills.rows,
    taxOptions: { b2bCaptureEnabled: taxOptions.rows[0]?.b2b_capture_enabled ?? false },
    entitlement: { features: {} },
  };
}
