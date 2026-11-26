import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { generateBill } from '../helpers/billing.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/core/database/tenantContext.js';
import { fireOrder } from '../../src/modules/kitchen/fire.js';
import {
  markTicketReady, StaleKdsViewError,
} from '../../src/modules/kitchen/orderTickets.js';
import {
  editLine, removeLine, LineAlreadyFiredError,
} from '../../src/modules/orders/orderEntry.js';
import {
  recordRefund, recordTender, voidTender, takePayment, nearestRupeeRoundOff,
  PaymentExceedsBalanceError, PaymentInvalidError, BillNotPayableError, PaymentBillUnknownError,
  UnassignedGuestLinesError,
  LinesAlreadyBilledError,
} from '../../src/modules/payments/billing.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { paymentMix, salesSummary } from '../../src/modules/reporting/salesReports.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;
let tenantId: string, branchId: string, userId: string;
let grillId: string, burgerId: string, taxClassId: string;
let recallReasonId: string, refundReasonId: string, voidReasonId: string;

const DATE = '2026-05-01';
const ctx = (): TenantContext => peekTenantContext()!;

async function seatSession(): Promise<string> {
  const sessionId = randomUUID();
  const floorId = randomUUID();
  const tableId = randomUUID();
  await owner.query(`INSERT INTO app.floor (id,tenant_id,branch_id,name) VALUES ($1,$2,$3,$4)`,
    [floorId, tenantId, branchId, `F-${floorId.slice(0, 8)}`]);
  await owner.query(
    `INSERT INTO app.dining_table (id,tenant_id,branch_id,floor_id,identifier,seats) VALUES ($1,$2,$3,$4,'1',4)`,
    [tableId, tenantId, branchId, floorId]);
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id) VALUES ($1,$2,$3,$4,$5)`,
    [sessionId, tenantId, branchId, DATE, userId]);
  await owner.query(
    `INSERT INTO app.table_session_table (id,tenant_id,session_id,dining_table_id) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), tenantId, sessionId, tableId]);
  return sessionId;
}

async function addLine(
  orderId: string,
  // `taxRateBps` is explicit rather than derived because this helper writes the
  // line directly. At an unregistered branch a 500bps line is refused by
  // `order_line_tax_requires_registration`, which is the trigger doing its job:
  // a fixture that wants an untaxed bill has to build untaxed lines, exactly as
  // `resolveOrderableItem` would have.
  opts: { price?: number; guestNo?: number | null; taxRateBps?: number } = {},
): Promise<string> {
  const lineId = randomUUID();
  const price = opts.price ?? 21000;
  await owner.query(
    `INSERT INTO app.order_line
       (id,tenant_id,branch_id,order_id,kind,menu_item_id,display_name,unit_price_minor,
        quantity,line_total_minor,tax_class_key,tax_rate_bps,guest_no,created_by_user_id)
     VALUES ($1,$2,$3,$4,'item',$5,'Burger',$6,1,$6,'food_5',$9,$7,$8)`,
    [lineId, tenantId, branchId, orderId, burgerId, price, opts.guestNo ?? null, userId,
     opts.taxRateBps ?? 500]);
  return lineId;
}

/**
 * A combo: one parent line the kitchen never sees, and one component it does.
 * `parent_line_id` is the link `fireOrder` follows to decide the parent is fired
 * as well.
 *
 * The shapes come from `order_line_shape_exact`, which is strict about which
 * half of a combo carries money: the PARENT has no unit price and no line total
 * and only a `display_total_minor`; the COMPONENT carries the real amounts. That
 * is the priced-document rule -- the money lives on the rows the bill sums, and
 * the parent exists to be READ.
 */
async function addCombo(orderId: string): Promise<{ parentId: string; componentId: string }> {
  const parentId = randomUUID();
  const componentId = randomUUID();
  // ONE transaction, because a DEFERRED trigger checks that the components add
  // up to the parent's display total: `combo <id> allocates 0 across components
  // but displays 30000`. On an autocommit connection the parent commits alone
  // and is refused for a shortfall the next statement was about to fix -- which
  // is the constraint working, and the reason a real combo is written atomically.
  await owner.query('BEGIN');
  await owner.query(
    `INSERT INTO app.order_line
       (id,tenant_id,branch_id,order_id,kind,menu_item_id,display_name,
        quantity,display_total_minor,tax_class_key,tax_rate_bps,created_by_user_id)
     VALUES ($1,$2,$3,$4,'combo_parent',$5,'Thali',1,30000,'food_5',500,$6)`,
    [parentId, tenantId, branchId, orderId, burgerId, userId]);
  await owner.query(
    `INSERT INTO app.order_line
       (id,tenant_id,branch_id,order_id,kind,parent_line_id,menu_item_id,display_name,
        unit_price_minor,quantity,line_total_minor,tax_class_key,tax_rate_bps,created_by_user_id)
     VALUES ($1,$2,$3,$4,'combo_component',$5,$6,'Thali · Burger',30000,1,30000,'food_5',500,$7)`,
    [componentId, tenantId, branchId, orderId, parentId, burgerId, userId]);
  await owner.query('COMMIT');
  return { parentId, componentId };
}

async function newOrder(sessionId: string): Promise<string> {
  const orderId = randomUUID();
  await owner.query(
    `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, tenantId, branchId, sessionId, DATE, userId]);
  return orderId;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 8 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `svc+${superAdminId}@platform.test`, roleId]);
  const planId = randomUUID();
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'svc_plan','Svc')
    ON CONFLICT (key) DO NOTHING`, [planId]);
  const actualPlanId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='svc_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), actualPlanId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [actualPlanId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `svc-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `v${key.slice(4, 12)}`, name: 'Service Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);

  await owner.query(`INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')`, [tenantId]);
  grillId = randomUUID();
  await owner.query(
    `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name) VALUES ($1,$2,$3,'grill','Grill')`,
    [grillId, tenantId, branchId]);
  taxClassId = randomUUID();
  await owner.query(`INSERT INTO app.tax_class (id,tenant_id,key,name,rate_bps)
    VALUES ($1,$2,'food_5','Food 5%',500)`, [taxClassId, tenantId]);
  burgerId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id,tenant_id,key,name,kind,tax_class_id,station_code,price_minor)
     VALUES ($1,$2,'burger','Burger','single',$3,'grill',21000)`, [burgerId, tenantId, taxClassId]);

  recallReasonId = randomUUID(); refundReasonId = randomUUID(); voidReasonId = randomUUID();
  await owner.query(`INSERT INTO app.adjustment_reason (id,tenant_id,key,name) VALUES
    ($1,$4,'cooked_wrong','Cooked wrong'), ($2,$4,'customer_dispute','Customer dispute'),
    ($3,$4,'walked_out','Walked out')`,
    [recallReasonId, refundReasonId, voidReasonId, tenantId]);
  await owner.query(`INSERT INTO app.adjustment_reason_kind (tenant_id,reason_id,kind) VALUES
    ($1,$2,'recall'), ($1,$3,'refund'), ($1,$4,'void')`,
    [tenantId, recallReasonId, refundReasonId, voidReasonId]);
});

afterAll(async () => { await pool?.end(); await owner?.end(); });

async function fireOne(sessionId: string, orderId: string) {
  return withTenantTransaction(pool, tenantId, () =>
    fireOrder(ctx(), {
      branchId, orderId, sessionId,
      sessionVersion: 1, firedByUserId: userId, businessDate: DATE }));
}

/* --------------------------------------------------------------------- E --- */

describe('E. a fired combo is fired, parent included', () => {
  /**
   * #######################################################################
   * ROUTING AND fired_at ANSWER DIFFERENT QUESTIONS.
   *
   * Routing excludes `kind = 'combo'` correctly: a combo is not cooked, its
   * components are, each at its own station. The `fired_at` stamp copied that
   * exclusion -- and `fired_at` is not "did a kitchen get this?", it is "may the
   * till still change this line?". `editLine` and `removeLine` gate on exactly
   * that, and treat `fired_at IS NULL` as a pre-fire correction.
   *
   * So the combo parent stayed unfired forever, and a waiter could re-key or
   * delete "Thali" as a correction while the tandoor was already cooking its
   * components: no void row, no reason code, nothing in the exception report,
   * and the food still coming.
   * #######################################################################
   */
  it('stamps the parent, which never went to a station', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    const combo = await addCombo(orderId);

    await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {
        branchId, orderId, sessionId, sessionVersion: 1,
        firedByUserId: userId, businessDate: DATE }));

    const rows = await owner.query<{ id: string; kind: string; fired_at: string | null }>(
      `SELECT id, kind, fired_at::text FROM app.order_line
        WHERE tenant_id=$1 AND order_id=$2 ORDER BY kind`, [tenantId, orderId]);
    for (const row of rows.rows) {
      expect(row.fired_at, `${row.kind} must be fired`).not.toBeNull();
    }
    expect(rows.rows.find((r) => r.id === combo.parentId)!.fired_at).not.toBeNull();
  });

  it('refuses to EDIT a fired combo as though it were a correction', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    const combo = await addCombo(orderId);
    await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {
        branchId, orderId, sessionId, sessionVersion: 1,
        firedByUserId: userId, businessDate: DATE }));

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        editLine(ctx(), { lineId: combo.parentId, quantity: 2 })),
    ).rejects.toThrow(LineAlreadyFiredError);
  });

  it('refuses to REMOVE a fired combo, so it has to be voided with a reason', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    const combo = await addCombo(orderId);
    await withTenantTransaction(pool, tenantId, () =>
      fireOrder(ctx(), {
        branchId, orderId, sessionId, sessionVersion: 1,
        firedByUserId: userId, businessDate: DATE }));

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        removeLine(ctx(), combo.parentId)),
    ).rejects.toThrow(LineAlreadyFiredError);
  });

  it('still allows both BEFORE the fire, so the refusal is about firing', async () => {
    // The positive control: the parent is editable and removable while the
    // kitchen has not seen it, which is the whole point of the pre-fire window.
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    const combo = await addCombo(orderId);

    await withTenantTransaction(pool, tenantId, () =>
      editLine(ctx(), { lineId: combo.parentId, quantity: 3 }));
    const edited = (await owner.query<{ quantity: string }>(
      `SELECT quantity::text FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, combo.parentId])).rows[0]!;
    expect(Number(edited.quantity)).toBe(3);

    await withTenantTransaction(pool, tenantId, () => removeLine(ctx(), combo.parentId));
    const gone = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, combo.parentId]);
    expect(Number(gone.rows[0]!.n)).toBe(0);
  });
});

describe('E. KOT says when a ticket is ready', () => {
  // The kitchen screen was removed (Basic only). The ticket's state is still
  // DERIVED from its lines, and KOT's "Mark ready" is the one thing that moves
  // them -- so these assert the derivation and that one move.

  it('has no second source of truth for ticket state', async () => {
    const tables = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='app' AND table_name LIKE '%kds%'`);
    expect(tables.rows).toEqual([]);
  });

  it('refuses a direct write to the derived state', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId);
    const fired = await fireOne(sessionId, orderId);
    // Two writable state fields on parent and child WOULD disagree within a shift.
    await expect(
      owner.query(`UPDATE app.kot SET state='ready' WHERE id=$1`, [fired.stations[0]!.kotId]),
    ).rejects.toThrow(/derived from its lines/);
  });

  it('Mark ready moves every live line to ready, and the ticket derives ready from them', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId); await addLine(orderId);
    const fired = await fireOne(sessionId, orderId);
    const kotId = fired.stations[0]!.kotId;
    const state = async () => (await owner.query<{ state: string }>(
      `SELECT state FROM app.kot WHERE id=$1`, [kotId])).rows[0]!.state;
    expect(await state()).toBe('queued');

    const marked = await withTenantTransaction(pool, tenantId, () =>
      markTicketReady(ctx(), { kotId, branchId }));
    expect(marked).toEqual({ kotId, marked: 2 });
    expect(await state()).toBe('ready');
  });

  it('is refused at another branch', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId);
    const kotId = (await fireOne(sessionId, orderId)).stations[0]!.kotId;
    const otherBranchId = randomUUID();
    await owner.query(
      `INSERT INTO app.branch (id,tenant_id,code,name,timezone,gst_registration)
       VALUES ($1,$2,$3,'Second','Asia/Kolkata','unstated')`,
      [otherBranchId, tenantId, `B2-${otherBranchId.slice(0, 6)}`]);
    // The same answer as an id that does not exist: a distinct refusal would
    // confirm the ticket is real and someone else's.
    await expect(withTenantTransaction(pool, tenantId, () =>
      markTicketReady(ctx(), { kotId, branchId: otherBranchId }))).rejects.toBeInstanceOf(StaleKdsViewError);
  });
});

describe('F. bill and payment', () => {
  it('computes tax from the line snapshot, not the catalogue', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 21000 });

    // The catalogue moves after the order. The bill must not notice.
    await owner.query(`UPDATE app.menu_item SET price_minor=99999 WHERE id=$1`, [burgerId]);
    await owner.query(`UPDATE app.tax_class SET rate_bps=1800 WHERE id=$1`, [taxClassId]);

    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId, splitKind: 'whole' }));

    expect(bill.subtotalMinor).toBe(21000);
    expect(bill.taxMinor, '5% of the snapshot, not 18% of the catalogue').toBe(1050);
    expect(bill.totalMinor).toBe(22050);

    await owner.query(`UPDATE app.menu_item SET price_minor=21000 WHERE id=$1`, [burgerId]);
    await owner.query(`UPDATE app.tax_class SET rate_bps=500 WHERE id=$1`, [taxClassId]);
  });

  /**
   * #######################################################################
   * THE GST SNAPSHOT: FIVE COLUMNS A MIGRATION ADDED AND NO WRITE PATH FILLED.
   *
   * Migration 0037 added `supplier_gstin`, `place_of_supply_state_code`,
   * `recipient_gstin` and `recipient_legal_name`. `generateBill` wrote none of
   * them and nothing in the product could set `branch.gstin`, so every bill in
   * a real deployment read as an unregistered B2C supply with no place of
   * supply -- and the credit-note path, which reads these columns, reported
   * zero tax on every note.
   * #######################################################################
   */
  it('stamps the supplier GSTIN and place of supply from the branch', async () => {
    await owner.query(
      `UPDATE app.branch SET state_code='29', gstin='29AABCU9603R1ZM', gst_registration='registered' WHERE id=$1`,
      [branchId]);
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 10000 });

    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'whole' }));

    const row = (await owner.query<{
      supplier_gstin: string | null; place_of_supply_state_code: string | null;
      recipient_gstin: string | null; recipient_legal_name: string | null;
    }>(
      `SELECT supplier_gstin, place_of_supply_state_code, recipient_gstin,
              recipient_legal_name
         FROM app.bill WHERE tenant_id=$1 AND id=$2`,
      [tenantId, bill.billId])).rows[0]!;

    expect(row.supplier_gstin).toBe('29AABCU9603R1ZM');
    // The RESTAURANT's state, not the guest's: restaurant service is performed
    // where the restaurant is, so a diner from another state is still an
    // intra-state supply. Taking it from the guest would put IGST on a walk-in.
    expect(row.place_of_supply_state_code).toBe('29');
    // B2C, which is what a walk-in is and what `bill_b2b_named` expects.
    expect(row.recipient_gstin).toBeNull();
    expect(row.recipient_legal_name).toBeNull();
  });

  it('stamps the registration as it was, not as it later became', async () => {
    // The priced-document rule applied to the tax identity. A bill reprinted
    // after the branch re-registers must show what was true when it was issued;
    // a join at print time would silently rewrite every historical invoice.
    await owner.query(
      `UPDATE app.branch SET state_code='29', gstin='29AABCU9603R1ZM', gst_registration='registered' WHERE id=$1`,
      [branchId]);
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 10000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'whole' }));

    await owner.query(
      `UPDATE app.branch SET state_code='27', gstin='27AABCU9603R1ZM', gst_registration='registered' WHERE id=$1`,
      [branchId]);

    const after = (await owner.query<{ supplier_gstin: string | null;
      place_of_supply_state_code: string | null; }>(
      `SELECT supplier_gstin, place_of_supply_state_code FROM app.bill
        WHERE tenant_id=$1 AND id=$2`, [tenantId, bill.billId])).rows[0]!;
    expect(after.supplier_gstin).toBe('29AABCU9603R1ZM');
    expect(after.place_of_supply_state_code).toBe('29');

    await owner.query(
      `UPDATE app.branch SET state_code=NULL, gstin=NULL, gst_registration='unstated' WHERE id=$1`, [branchId]);
  });

  it('leaves the snapshot null for a branch that has not stated its position',
    async () => {
      // `unstated`, which is what migration 0048's backfill left on every row
      // that predates the question, and what provisioning writes for a first
      // branch created before the owner has ever signed in. Null GSTIN here
      // means "not answered yet" -- NOT "unregistered", which is the conflation
      // 0048 exists to end. What it must not become is an empty string, which
      // would pass a NOT NULL check and fail the format one.
      await owner.query(
        `UPDATE app.branch SET state_code=NULL, gstin=NULL, gst_registration='unstated' WHERE id=$1`, [branchId]);
      const sessionId = await seatSession();
      const orderId = await newOrder(sessionId);
      await addLine(orderId, { price: 10000 });
      const bill = await withTenantTransaction(pool, tenantId, () =>
        generateBill(ctx(), {
          branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
          splitKind: 'whole' }));
      const row = (await owner.query<{ supplier_gstin: string | null }>(
        `SELECT supplier_gstin FROM app.bill WHERE tenant_id=$1 AND id=$2`,
        [tenantId, bill.billId])).rows[0]!;
      expect(row.supplier_gstin).toBeNull();
    });

  it('stamps the stated position, so a zero-tax bill can prove it was lawful',
    async () => {
      // #####################################################################
      // WHY THE POSITION IS ON THE DOCUMENT AND NOT INFERRED FROM IT.
      //
      // A bill showing no tax is either a lawfully zero-rated supply by an
      // unregistered restaurant or a misconfigured tax class that lost real
      // money, and the paper cannot tell you which. A null `supplier_gstin`
      // does not separate them either: an `unstated` branch has no GSTIN and
      // DOES charge tax.
      //
      // So the branch's stated position travels on the bill, and
      // `bill_unregistered_carries_no_tax` refuses the document if the two ever
      // disagree -- which is the backstop for the line-level suppression, not a
      // second copy of it.
      // #####################################################################
      await owner.query(
        `UPDATE app.branch SET gstin=NULL, gst_registration='unregistered' WHERE id=$1`,
        [branchId]);
      const sessionId = await seatSession();
      const orderId = await newOrder(sessionId);
      // Untaxed, as resolveOrderableItem would have written them.
      await addLine(orderId, { price: 10000, taxRateBps: 0 });
      await addLine(orderId, { price: 25000, taxRateBps: 0 });

      const bill = await withTenantTransaction(pool, tenantId, () =>
        generateBill(ctx(), {
          branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
          splitKind: 'whole' }));

      const row = (await owner.query<{
        supplier_gst_registration: string | null; supplier_gstin: string | null;
        tax_minor: string; subtotal_minor: string; total_minor: string;
      }>(
        `SELECT supplier_gst_registration, supplier_gstin, tax_minor::text,
                subtotal_minor::text, total_minor::text
           FROM app.bill WHERE tenant_id=$1 AND id=$2`,
        [tenantId, bill.billId])).rows[0]!;

      expect(row.supplier_gst_registration).toBe('unregistered');
      expect(row.supplier_gstin).toBeNull();
      expect(row.tax_minor).toBe('0');
      // The whole reason the suppression lives in the line snapshot: the bill
      // total still equals the sum of its own lines, so the reconciliation a
      // GST return is built on holds.
      const lines = (await owner.query<{ tax: string; amount: string }>(
        `SELECT COALESCE(sum(tax_minor),0)::text AS tax,
                COALESCE(sum(amount_minor),0)::text AS amount
           FROM app.bill_line WHERE tenant_id=$1 AND bill_id=$2`,
        [tenantId, bill.billId])).rows[0]!;
      expect(lines.tax).toBe(row.tax_minor);
      expect(lines.amount).toBe(row.subtotal_minor);
      expect(row.total_minor).toBe('35000');

      await owner.query(
        `UPDATE app.branch SET gst_registration='unstated' WHERE id=$1`, [branchId]);
    });

  it('refuses a bill whose lines contradict the stated position', async () => {
    // ###################################################################
    // THE SYNTHETIC VIOLATION FOR THE DOCUMENT HALF.
    //
    // The order-line trigger stops a taxed line being written at an
    // unregistered branch. This asserts the second gate: a branch that was
    // registered when its lines were taken and is unregistered by the time the
    // bill is raised cannot produce a document that collects tax under no
    // registration. Without it, the switch would be a way to launder a taxed
    // order into an unregistered supply.
    // ###################################################################
    await owner.query(
      `UPDATE app.branch SET state_code='29', gstin='29AABCU9603R1ZM',
              gst_registration='registered' WHERE id=$1`, [branchId]);
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 10000, taxRateBps: 500 });

    // The position moves under the order. `stateBranchGstRegistration` refuses
    // exactly this while trade is open -- which is why it has to be forced here
    // to reach the constraint at all.
    await owner.query(
      `UPDATE app.branch SET gstin=NULL, gst_registration='unregistered' WHERE id=$1`,
      [branchId]);

    await expect(withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'whole' })))
      // Renamed by 0051 from `bill_unregistered_carries_no_tax`, because it now
      // governs the composition scheme as well: the fact it asserts is not "is
      // there a registration" but "may this position collect tax".
      .rejects.toThrow(/bill_non_collecting_position_carries_no_tax/);

    // AND THE SAME LAUNDERING ROUTE THROUGH COMPOSITION, which is the one a
    // reviewer would wave through: the branch still HOLDS a GSTIN, so it looks
    // registered from every angle except the one that matters.
    await owner.query(
      `UPDATE app.branch SET gstin='29AABCU9603R1ZM', gst_registration='composition'
        WHERE id=$1`, [branchId]);
    await expect(withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'whole' })))
      .rejects.toThrow(/bill_non_collecting_position_carries_no_tax/);

    // And the order-line trigger refuses a taxed line at such a branch outright,
    // naming the position rather than calling a registered branch unregistered.
    await expect(owner.query(
      `INSERT INTO app.order_line
         (id,tenant_id,branch_id,order_id,kind,menu_item_id,display_name,
          unit_price_minor,quantity,line_total_minor,tax_rate_bps,created_by_user_id)
       VALUES (gen_random_uuid(),$1,$2,$3,'item',NULL,'Smuggled',6000,1,6000,500,$4)`,
      [tenantId, branchId, orderId, userId]))
      .rejects.toThrow(/composition taxable person and may not collect tax/);

    await owner.query(
      `UPDATE app.branch SET state_code=NULL, gstin=NULL, gst_registration='unstated'
        WHERE id=$1`, [branchId]);
  });

  it('leaves no column on app.bill that no write path fills', async () => {
    // #####################################################################
    // THE GATE FOR THE DEFECT CLASS, NOT JUST THIS INSTANCE.
    //
    // A migration adding a column that nothing writes is invisible: every test
    // passes, every read returns null, and the meaning of the omission is
    // discovered by an auditor. So the check is structural -- every column on
    // app.bill is either written by the INSERT in generateBill, set by the
    // schema, written by a named later transition, or exempt WITH A REASON.
    // #####################################################################
    const written: Readonly<Record<string, string>> = {
      id: 'generateBill', tenant_id: 'generateBill', branch_id: 'generateBill',
      session_id: 'generateBill', business_date: 'generateBill',
      bill_no: 'generateBill (allocateBillNo)', split_kind: 'generateBill',
      subtotal_minor: 'generateBill', tax_minor: 'generateBill',
      total_minor: 'generateBill', generated_by_user_id: 'generateBill',
      supplier_gstin: 'generateBill, from branch.gstin',
      place_of_supply_state_code: 'generateBill, from branch.state_code',
      customer_id:
        'attachCustomerToBill, from a phone the cashier typed. Permanently nullable, by decision: a walk-in who gives no number is the majority of trade and a bill is complete without one. NOT the recipient -- recipient_gstin and recipient_legal_name are the snapshot a GST return reads, and this is the CRM link, so a customer correcting their name later cannot rewrite a filed return',
      supplier_gst_registration:
        'generateBill, from branch.gst_registration. The discriminator a null GSTIN could not be: it separates a lawfully zero-rated supply from a misconfigured tax class, and bill_unregistered_carries_no_tax refuses the document when it disagrees with the line rates',
      status: 'schema default; moved to settled/void by their own transitions',
      version: 'schema default; bumped by the optimistic-concurrency guard',
      generated_at: 'schema default',
      settled_at: 'the settlement transition, paired with status by bill_settlement_consistent',
      recipient_gstin:
        'setBillRecipient, from a GSTIN the cashier typed, behind the tenant b2b_capture_enabled setting and closed at the first tender by deny_tendered_bill_mutation. Null is B2C, which is correct for a walk-in, and bill_b2b_named holds either way',
      recipient_legal_name: 'setBillRecipient, alongside recipient_gstin and required by bill_b2b_named when it is set',
      recipient_state_code:
        'setBillRecipient, DERIVED from the GSTIN first two characters rather than asked for, because bill_recipient_state_matches_gstin requires them to agree and a second field is a second chance to disagree. Nothing reads it yet: restaurant service is performed on the premises, so the place of supply is the branch state whoever the recipient is. It is stored because it is the fact a practitioner may settle differently, and then the change is one argument at the jurisdiction resolver',
      supplier_state_code:
        'generateBill, from branch.state_code. Its own column rather than substring(supplier_gstin,1,2) because an unstated branch charges tax with no GSTIN at all, which is exactly the case where a head has to be decided',
      tax_treatment:
        'generateBill, derived by src/modules/tax/registry.ts from the supplier state and the place of supply, in the terms of the tenant own jurisdiction. Replaced app.tax_component, whose free-text name the outward-supply return matched to bucket a statutory figure',
      premises_class:
        'generateBill, from app.branch_premises_class for the financial year the bill falls in, or `unstated` where the branch has never answered. Stamped for the same reason as tax_jurisdiction: 18% with ITC and 5% without are two different regimes, the branch can move between them at a year boundary, and a reprint must show the one the document was issued under rather than the one in force when it is reprinted',
      rounding_rule:
        'generateBill, the jurisdiction\'s billRounding (0084): nearest_rupee in India (0082), none in the UAE, which is paid to the fils. `none` is also the stated rule of an Indian bill made before rounding existed, by backfill, so a paid bill never starts owing paise -- a positive discriminator rather than a null round-off',
      round_off_minor:
        'generateBill, from roundOffFor(rule, total); bill_round_off_matches_rule derives the same figure from the total, so no writer chooses it',
      currency:
        'generateBill, from platform.tenant.default_currency (0084), stamped so a reprint names the currency the figures were taken in whatever the restaurant bills in later. NOT NULL with no default once backfilled; frozen with the figures once tendered',
      payable_minor: 'GENERATED ALWAYS AS (total_minor + round_off_minor): what is collected, never written',
      tax_account_type:
        'generateBill, from branch.tax_account_type -- none when branch.tax_enabled is off (0083). NOT NULL with no default once backfilled to gst: bill_treatment_fits_tax_account ties it to the treatment, and the GST return reads only gst bills',
      prices_include_tax:
        'generateBill, from the ORDER\'s sales_order.prices_include_tax, fixed when the order opened (0083): whether the line amounts held their tax. NOT NULL with no default once backfilled to false',
      supplier_tax_registration_no:
        'generateBill, from branch.tax_registration_no on a VAT or OTHERS bill (0083). Null on GST (its GSTIN is supplier_gstin) and NONE bills, and where a branch states none -- bill_supplier_tax_registration_no_outside_gst holds it to the non-GST accounts',
      tax_jurisdiction:
        'generateBill, from platform.tenant.tax_jurisdiction via implementedTenantRegime. Stamped rather than joined for the same reason as every other column here: the heads on a document mean nothing without the law they were struck under, so a bill reprinted after a tenant jurisdiction is corrected must show the one it was issued under. NOT NULL with no default on both tables, because IN is the answer almost every time and that is exactly why it must not fill itself in',
    };
    const columns = (await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='app' AND table_name='bill' ORDER BY column_name`))
      .rows.map((r) => r.column_name);

    expect(columns.length).toBeGreaterThan(15);
    const unaccounted = columns.filter((c) => !(c in written));
    expect(
      unaccounted,
      'these columns on app.bill are filled by nothing and explained by nothing. ' +
        'Write them, or add the reason they stay null.',
    ).toEqual([]);
    // And the other direction, so the list cannot rot into a fiction.
    const stale = Object.keys(written).filter((c) => !columns.includes(c));
    expect(stale, 'these columns no longer exist').toEqual([]);
  });

  it('excludes a fully voided line from the bill', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    const keep = await addLine(orderId);
    const drop = await addLine(orderId);
    await owner.query(`UPDATE app.order_line SET fired_at=now() WHERE id=$1`, [drop]);
    await owner.query(
      `INSERT INTO app.order_line
         (id,tenant_id,branch_id,order_id,kind,display_name,unit_price_minor,quantity,
          line_total_minor,adjusts_line_id,adjusted_kind,adjusted_unit_price_minor,
          adjustment_reason_id,created_by_user_id)
       VALUES ($1,$2,$3,$4,'void','Burger (void)',21000,-1,-21000,$5,'item',21000,$6,$7)`,
      [randomUUID(), tenantId, branchId, orderId, drop, voidReasonId, userId]);

    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), {
        branchId, sessionId, businessDate: DATE, generatedByUserId: userId, splitKind: 'whole' }));
    expect(bill.lineCount).toBe(1);
    expect(bill.subtotalMinor).toBe(21000);
    void keep;
  });

  it('splits three ways with largest-remainder, losing nothing', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 100000 });

    const thirds = [3333, 3333, 3334];
    let total = 0;
    for (const share of thirds) {
      const bill = await withTenantTransaction(pool, tenantId, () =>
        generateBill(ctx(), {
          branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
          splitKind: 'by_percentage', shareBps: share }));
      total += bill.subtotalMinor;
    }
    // The naive version loses a rupee a table.
    expect(total).toBe(100000);
  });

  it('refuses a by-guest split while a shared line belongs to nobody', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { guestNo: 1 });
    await addLine(orderId, { guestNo: null });

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        generateBill(ctx(), {
          branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
          splitKind: 'by_guest', guestNos: [1] })),
    ).rejects.toThrow(UnassignedGuestLinesError);
  });

  it('splits by guest once the shared line is assigned', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { guestNo: 1 });
    const shared = await addLine(orderId, { guestNo: null });
    // Prompt, don't guess: the table decides who pays for the starter.
    await owner.query(`UPDATE app.order_line SET guest_no=2 WHERE id=$1`, [shared]);

    const g1 = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'by_guest', guestNos: [1] }));
    const g2 = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE, generatedByUserId: userId,
        splitKind: 'by_guest', guestNos: [2] }));
    expect(g1.lineCount).toBe(1);
    expect(g2.lineCount).toBe(1);
  });

  it('refuses a second allocation past 100% in the application, with words', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
      const inner = { tenantId, client, actor: null };
      await generateBill(inner, { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'by_percentage', shareBps: 6000 });
      // 60% + 60% is 120% of a line. Caught BEFORE the write, so the caller gets
      // a sentence instead of a constraint name and an order line uuid.
      await expect(generateBill(inner, { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'by_percentage', shareBps: 6000 }))
        .rejects.toThrow(LinesAlreadyBilledError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('still has the TRIGGER as the authority, proven by going around the check',
    async () => {
      // ###################################################################
      // THE EARLY CHECK MUST NOT MAKE THE DEFERRED TRIGGER UNREACHED CODE.
      //
      // `generateBill` now refuses over-allocation up front, which is better
      // for the caller and worse for this test: if the application check were
      // the only thing exercised, the constraint trigger would join the class of
      // things that exist, are correct, and are reached by nothing.
      //
      // So this writes `bill_line` DIRECTLY, bypassing the application entirely,
      // and requires COMMIT to fail. That is the posture the trigger exists for:
      // a bug in ops/billing.ts, a future code path, or a hand-run UPDATE.
      // ###################################################################
      const sessionId = await seatSession();
      const orderId = await newOrder(sessionId);
      const lineId = await addLine(orderId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
        const inner = { tenantId, client, actor: null };
        const first = await generateBill(inner, { branchId, sessionId, businessDate: DATE,
          generatedByUserId: userId, splitKind: 'by_percentage', shareBps: 6000 });

        // A second bill, and its line inserted by hand at another 6000bps.
        const second = await generateBill(inner, { branchId, sessionId,
          businessDate: DATE, generatedByUserId: userId, splitKind: 'by_line',
          lineIds: [] });
        await client.query(
          `INSERT INTO app.bill_line
             (id, tenant_id, bill_id, order_line_id, share_bps, display_name,
              amount_minor, tax_minor, tax_rate_bps)
           VALUES (gen_random_uuid(), $1, $2, $3, 6000, 'by hand', 0, 0, NULL)`,
          [tenantId, second.billId, lineId]);
        expect(first.billId).not.toBe(second.billId);

        await expect(client.query('COMMIT'))
          .rejects.toThrow(/allocated .*bps across bills/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

  it('settles on multi-tender and leaves the bill open until it balances', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 20000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    expect(bill.totalMinor).toBe(21000);

    const partial = await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'card', amountMinor: 10000,
        tenderedByUserId: userId }));
    expect(partial.settled).toBe(false);
    expect(partial.outstandingMinor).toBe(11000);

    const rest = await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'upi', amountMinor: 11000,
        tenderedByUserId: userId }));
    expect(rest.settled).toBe(true);
    expect(rest.outstandingMinor).toBe(0);
  });

  it('records rounding as the bill\'s own line, not a discrepancy (0082)', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 23581 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));

    // The paise to the nearest rupee are the bill's round-off; the payable is whole.
    expect(bill.roundOffMinor).not.toBe(0);
    expect(bill.payableMinor % 100).toBe(0);
    expect(bill.payableMinor).toBe(bill.totalMinor + bill.roundOffMinor);

    const result = await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'cash', amountMinor: bill.payableMinor,
        tenderedByUserId: userId }));
    // SUM(amount) - SUM(rounding) = payable: settled, with no tender rounding at all.
    expect(result.settled).toBe(true);

    const stored = await owner.query<{ round_off_minor: string; payable_minor: string; tender_rounding: string }>(
      `SELECT b.round_off_minor::text, b.payable_minor::text,
              (SELECT sum(rounding_minor) FROM app.tender WHERE bill_id = b.id)::text AS tender_rounding
         FROM app.bill b WHERE b.id = $1`, [bill.billId]);
    // A reportable figure on the bill, not a till discrepancy someone has to explain.
    expect(stored.rows[0]).toEqual({
      round_off_minor: String(bill.roundOffMinor), payable_minor: String(bill.payableMinor), tender_rounding: '0',
    });
  });

  it('rounds to the nearest rupee: under 50 paise down, 50 or more up', () => {
    for (const [total, payable] of [[26449, 26400], [26450, 26500], [26475, 26500], [26750, 26800], [19005, 19000], [26400, 26400]]) {
      expect(total! + nearestRupeeRoundOff(total!), `${total}`).toBe(payable);
    }
  });

  it('the database derives the round-off from the total: a bill cannot choose its own', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 10049 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    await expect(owner.query(`UPDATE app.bill SET round_off_minor = round_off_minor + 1 WHERE id = $1`, [bill.billId]))
      .rejects.toMatchObject({ constraint: 'bill_round_off_matches_rule' });
    await expect(owner.query(`UPDATE app.bill SET rounding_rule = 'none' WHERE id = $1`, [bill.billId]))
      .rejects.toMatchObject({ constraint: 'bill_round_off_matches_rule' });
  });

  it('refuses tenders that exceed the bill: the cashier gets a sentence, the trigger stays the authority', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 20000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        recordTender(ctx(), { billId: bill.billId, method: 'cash',
          amountMinor: bill.totalMinor + 5000, tenderedByUserId: userId })),
    ).rejects.toBeInstanceOf(PaymentExceedsBalanceError);

    // Bypassing the application: the deferred trigger still refuses at COMMIT,
    // so the early check has not turned it into unreached code.
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO app.tender (id,tenant_id,bill_id,kind,method,amount_minor,tendered_by_user_id)
         VALUES ($1,$2,$3,'capture','cash',$4,$5)`,
        [randomUUID(), tenantId, bill.billId, bill.totalMinor + 5000, userId]);
      await expect(owner.query('COMMIT')).rejects.toThrow(/tenders netting/);
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('freezes the bill once tendered against', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 20000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'card',
        amountMinor: bill.totalMinor, tenderedByUserId: userId }));

    // A reprint six months later must match the paper.
    await expect(
      owner.query(`UPDATE app.bill SET total_minor=1 WHERE id=$1`, [bill.billId]),
    ).rejects.toThrow(/has been tendered against/);
  });

  it('voids a tender with a negative row and reopens the bill', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 20000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    const tender = await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'cash',
        amountMinor: bill.totalMinor, tenderedByUserId: userId }));

    await withTenantTransaction(pool, tenantId, () =>
      voidTender(ctx(), { tenderId: tender.tenderId, reasonId: voidReasonId,
        voidedByUserId: userId }));

    const rows = await owner.query<{ kind: string; amount_minor: string }>(
      // The void points at the capture: that is the order, not two now() stamps that can tie.
      `SELECT kind, amount_minor::text FROM app.tender WHERE bill_id=$1 ORDER BY voids_tender_id IS NOT NULL`,
      [bill.billId]);
    expect(rows.rows.map((r) => r.kind)).toEqual(['capture', 'void']);
    // A negative row, never an update.
    expect(Number(rows.rows[1]!.amount_minor)).toBe(-bill.totalMinor);

    const status = await owner.query<{ status: string }>(
      `SELECT status FROM app.bill WHERE id=$1`, [bill.billId]);
    expect(status.rows[0]!.status).toBe('open');
  });

  it('refunds against a closed bill, bounded by what was taken', async () => {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: 20000 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    const tender = await withTenantTransaction(pool, tenantId, () =>
      recordTender(ctx(), { billId: bill.billId, method: 'card',
        amountMinor: bill.totalMinor, tenderedByUserId: userId }));

    await withTenantTransaction(pool, tenantId, () =>
      recordRefund(ctx(), { billId: bill.billId, branchId, amountMinor: 5000, method: 'card',
        reasonId: refundReasonId, originalTenderId: tender.tenderId, refundedByUserId: userId }));

    await expect(
      withTenantTransaction(pool, tenantId, () =>
        recordRefund(ctx(), { billId: bill.billId, branchId,
          amountMinor: bill.totalMinor, method: 'card', reasonId: refundReasonId,
          refundedByUserId: userId })),
    ).rejects.toThrow(/refunded .* against tenders/);
  });
});

/* ------------------------------------------------------------ stock rule --- */

describe('F2. partial payments, mixed methods and cash change', () => {
  /** A bill whose total is exactly `total` paise: one line, tax-free. */
  async function billOf(total: number): Promise<string> {
    const sessionId = await seatSession();
    const orderId = await newOrder(sessionId);
    await addLine(orderId, { price: total, taxRateBps: 0 });
    const bill = await withTenantTransaction(pool, tenantId, () =>
      generateBill(ctx(), { branchId, sessionId, businessDate: DATE,
        generatedByUserId: userId, splitKind: 'whole' }));
    expect(bill.totalMinor).toBe(total);
    return bill.billId;
  }
  const pay = (billId: string, parts: Parameters<typeof takePayment>[1]['parts']) =>
    withTenantTransaction(pool, tenantId, () =>
      takePayment(ctx(), { billId, parts, tenderedByUserId: userId }));
  const stored = async (billId: string) => (await owner.query<{
    method: string; amount_minor: string; cash_received_minor: string | null;
  }>(`SELECT method, amount_minor::text, cash_received_minor::text FROM app.tender
       WHERE bill_id = $1 ORDER BY tendered_at, method`, [billId])).rows;
  const status = async (billId: string) => (await owner.query<{ status: string }>(
    `SELECT status FROM app.bill WHERE id = $1`, [billId])).rows[0]!.status;

  it('1. exact cash settles with no change', async () => {
    const billId = await billOf(85000);
    const r = await pay(billId, [{ method: 'cash', cashReceivedMinor: 85000 }]);
    expect(r).toMatchObject({ paidMinor: 85000, outstandingMinor: 0, changeMinor: 0, settled: true });
    expect(await status(billId)).toBe('settled');
  });

  it('2. a ₹1,000 note on ₹850 applies ₹850 and returns ₹150, which is never sales', async () => {
    const billId = await billOf(85000);
    const r = await pay(billId, [{ method: 'cash', cashReceivedMinor: 100000 }]);
    expect(r).toMatchObject({ paidMinor: 85000, outstandingMinor: 0, changeMinor: 15000, settled: true });
    expect(r.tenders[0]).toMatchObject({ method: 'cash', amountMinor: 85000, cashReceivedMinor: 100000, changeMinor: 15000 });
    // The tender row carries ₹850; the note is beside it, not in it.
    expect(await stored(billId)).toEqual([{ method: 'cash', amount_minor: '85000', cash_received_minor: '100000' }]);
    const mix = await withTenantTransaction(pool, tenantId, async () => {
      const rows = await ctx().client.query<{ sum: string }>(
        `SELECT sum(amount_minor)::text AS sum FROM app.tender WHERE bill_id = $1`, [billId]);
      return Number(rows.rows[0]!.sum);
    });
    expect(mix).toBe(85000);
  });

  it('3/4. full card and full UPI', async () => {
    for (const method of ['card', 'upi'] as const) {
      const billId = await billOf(85000);
      const r = await pay(billId, [{ method, amountMinor: 85000, reference: 'REF-1' }]);
      expect(r).toMatchObject({ settled: true, changeMinor: 0, outstandingMinor: 0 });
    }
  });

  it('5-8. two and three methods together, cash always last', async () => {
    const cardUpi = await billOf(85000);
    expect(await pay(cardUpi, [{ method: 'card', amountMinor: 50000 }, { method: 'upi', amountMinor: 35000 }]))
      .toMatchObject({ settled: true, paidMinor: 85000 });

    // Card ₹500 + a ₹500 note on ₹850: cash applies ₹350, ₹150 back, ₹850 settled -- never ₹1,000.
    const cardCash = await billOf(85000);
    const r = await pay(cardCash, [{ method: 'cash', cashReceivedMinor: 50000 }, { method: 'card', amountMinor: 50000 }]);
    expect(r).toMatchObject({ paidMinor: 85000, changeMinor: 15000, outstandingMinor: 0, settled: true });
    expect(r.tenders.map((t) => [t.method, t.amountMinor, t.cashReceivedMinor]))
      .toEqual([['card', 50000, null], ['cash', 35000, 50000]]);

    const upiCash = await billOf(85000);
    expect(await pay(upiCash, [{ method: 'upi', amountMinor: 80000 }, { method: 'cash', cashReceivedMinor: 10000 }]))
      .toMatchObject({ paidMinor: 85000, changeMinor: 5000, settled: true });

    const three = await billOf(85000);
    const all = await pay(three, [
      { method: 'card', amountMinor: 50000 }, { method: 'upi', amountMinor: 20000 },
      { method: 'cash', cashReceivedMinor: 15000 }]);
    expect(all).toMatchObject({ paidMinor: 85000, changeMinor: 0, outstandingMinor: 0, settled: true });
    expect((await stored(three)).map((t) => t.method).sort()).toEqual(['card', 'cash', 'upi']);
  });

  it('9-11. a part payment leaves the bill open, and a second one settles it', async () => {
    const billId = await billOf(120000);
    const part = await pay(billId, [
      { method: 'card', amountMinor: 50000 }, { method: 'upi', amountMinor: 30000 },
      { method: 'cash', cashReceivedMinor: 20000 }]);
    expect(part).toMatchObject({ paidMinor: 100000, outstandingMinor: 20000, changeMinor: 0, settled: false });
    expect(await status(billId)).toBe('open');

    // ₹200 left; a ₹500 note pays it and ₹300 goes back.
    const rest = await pay(billId, [{ method: 'cash', cashReceivedMinor: 50000 }]);
    expect(rest).toMatchObject({ paidMinor: 120000, outstandingMinor: 0, changeMinor: 30000, settled: true });
    expect(await status(billId)).toBe('settled');
  });

  it('12. refuses malformed, negative, excessive and repeated payments, each for its own reason', async () => {
    const billId = await billOf(85000);
    for (const parts of [
      [{ method: 'card' as const, amountMinor: -100 }],
      [{ method: 'card' as const, amountMinor: 10.5 }],
      [{ method: 'card' as const, cashReceivedMinor: 100 }],
      [{ method: 'bitcoin' as never, amountMinor: 100 }],
      [{ method: 'cash' as const, cashReceivedMinor: 100 }, { method: 'cash' as const, cashReceivedMinor: 100 }],
      [{ method: 'cash' as const, amountMinor: 100, cashReceivedMinor: 500 }],
      [],
    ]) {
      await expect(pay(billId, parts), JSON.stringify(parts)).rejects.toBeInstanceOf(PaymentInvalidError);
    }
    // A card cannot be charged change.
    await expect(pay(billId, [{ method: 'card', amountMinor: 85001 }])).rejects.toBeInstanceOf(PaymentExceedsBalanceError);
    // Card covers it all and cash is then owed nothing: refused, not turned into change.
    await expect(pay(billId, [{ method: 'card', amountMinor: 85000 }, { method: 'cash', cashReceivedMinor: 1000 }]))
      .rejects.toBeInstanceOf(BillNotPayableError);
    // All or none: none of the refused attempts left a row.
    expect(await stored(billId)).toEqual([]);

    await pay(billId, [{ method: 'card', amountMinor: 85000 }]);
    await expect(pay(billId, [{ method: 'cash', cashReceivedMinor: 100 }])).rejects.toBeInstanceOf(BillNotPayableError);
  });

  it('the database refuses a cash note smaller than what it paid, and a note on a card', async () => {
    const billId = await billOf(85000);
    for (const [method, amount, received] of [['cash', 50000, 40000], ['card', 50000, 50000]] as const) {
      await expect(owner.query(
        `INSERT INTO app.tender (id,tenant_id,bill_id,kind,method,amount_minor,tendered_by_user_id,cash_received_minor)
         VALUES ($1,$2,$3,'capture',$4,$5,$6,$7)`,
        [randomUUID(), tenantId, billId, method, amount, userId, received]),
      ).rejects.toThrow(/tender_cash_received_shape/);
    }
  });

  it('17. a refund is bounded by what the bill took, not by the note handed over', async () => {
    const billId = await billOf(85000);
    const r = await pay(billId, [{ method: 'cash', cashReceivedMinor: 100000 }]);
    await expect(withTenantTransaction(pool, tenantId, () =>
      recordRefund(ctx(), { billId, branchId, amountMinor: 90000, method: 'cash',
        reasonId: refundReasonId, originalTenderId: r.tenders[0]!.tenderId, refundedByUserId: userId })),
    ).rejects.toThrow(/refunded .* against tenders/);
  });

  it('payments taken one after another: part cash, more cash, then card; UPI then cash', async () => {
    // ₹1,000: ₹600 cash now, the order is left and picked up again, ₹100 cash, then ₹300 card.
    const thousand = await billOf(100000);
    expect(await pay(thousand, [{ method: 'cash', cashReceivedMinor: 60000 }]))
      .toMatchObject({ appliedMinor: 60000, paidMinor: 60000, outstandingMinor: 40000, settled: false });
    expect(await status(thousand)).toBe('open');
    expect(await pay(thousand, [{ method: 'cash', cashReceivedMinor: 10000 }]))
      .toMatchObject({ appliedMinor: 10000, paidMinor: 70000, outstandingMinor: 30000, settled: false });
    expect(await pay(thousand, [{ method: 'card', amountMinor: 30000 }]))
      .toMatchObject({ appliedMinor: 30000, paidMinor: 100000, outstandingMinor: 0, settled: true });
    expect((await stored(thousand)).map((t) => [t.method, t.amount_minor]))
      .toEqual([['cash', '60000'], ['cash', '10000'], ['card', '30000']]);

    // ₹1,250: UPI ₹800, then a second payment of exactly ₹450 cash. The first is kept, not redone.
    const upiThenCash = await billOf(125000);
    expect(await pay(upiThenCash, [{ method: 'upi', amountMinor: 80000 }]))
      .toMatchObject({ outstandingMinor: 45000, settled: false });
    expect(await pay(upiThenCash, [{ method: 'cash', cashReceivedMinor: 45000 }]))
      .toMatchObject({ appliedMinor: 45000, changeMinor: 0, outstandingMinor: 0, settled: true });
    expect((await stored(upiThenCash)).map((t) => t.method)).toEqual(['upi', 'cash']);
  });

  it('16. reports count the sale once and the payments at what they applied, never the change', async () => {
    const mix = async () => new Map((await withTenantTransaction(pool, tenantId, () =>
      paymentMix(ctx(), { fromDate: DATE, toDate: DATE }))).map((r) => [r.method, r.collectedMinor]));
    const net = async () => (await withTenantTransaction(pool, tenantId, () =>
      salesSummary(ctx(), { fromDate: DATE, toDate: DATE }))).netMinor;

    const billId = await billOf(85000);
    const [mixBefore, netBefore] = [await mix(), await net()];
    await pay(billId, [{ method: 'card', amountMinor: 30000 }]);
    await pay(billId, [{ method: 'card', amountMinor: 20000 }, { method: 'cash', cashReceivedMinor: 100000 }]);
    const [mixAfter, netAfter] = [await mix(), await net()];

    // Three payments, one sale: the sales figure does not move with the number of payments.
    expect(netAfter).toBe(netBefore);
    // Card ₹500 in two goes; cash applied ₹350 of a ₹1,000 note. ₹650 change is in neither.
    expect((mixAfter.get('card') ?? 0) - (mixBefore.get('card') ?? 0)).toBe(50000);
    expect((mixAfter.get('cash') ?? 0) - (mixBefore.get('cash') ?? 0)).toBe(35000);
  });

  it('another restaurant cannot pay this bill: it does not exist there', async () => {
    const billId = await billOf(85000);
    await expect(withTenantTransaction(pool, randomUUID(), () =>
      takePayment(ctx(), { billId, parts: [{ method: 'card', amountMinor: 85000 }], tenderedByUserId: userId })),
    ).rejects.toBeInstanceOf(PaymentBillUnknownError);
    expect(await stored(billId)).toEqual([]);
  });

  it('a voided tender reopens the bill and the balance is due again', async () => {
    const billId = await billOf(85000);
    const r = await pay(billId, [{ method: 'card', amountMinor: 85000 }]);
    await withTenantTransaction(pool, tenantId, () =>
      voidTender(ctx(), { tenderId: r.tenders[0]!.tenderId, reasonId: voidReasonId, voidedByUserId: userId }));
    expect(await pay(billId, [{ method: 'upi', amountMinor: 85000 }])).toMatchObject({ settled: true, paidMinor: 85000 });
  });
});

describe('nothing reverses a stock deduction', () => {
  it('emits only inventory.deduct, and no code path reverses one', async () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

    async function walk(dir: string, prefix = ''): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
        else if (e.name.endsWith('.ts')) out.push(rel);
      }
      return out;
    }

    const files = await walk(src);
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(src, file), 'utf8');
      // Cooked food that left the kitchen cannot re-enter inventory. A returned
      // dish is inventory.waste in Phase 4 -- ingredients consumed AND no
      // revenue, which is a figure a kitchen manager watches. A reversal makes it
      // vanish from both sides and the kitchen never learns it happened.
      if (/inventory\.(return|reverse|credit|restock)/.test(source)) offenders.push(file);
    }
    expect(offenders, 'no reversal topic may exist').toEqual([]);

    const emitted = await owner.query<{ topic: string }>(
      `SELECT DISTINCT topic FROM platform.outbox WHERE topic LIKE 'inventory.%'`);
    expect(emitted.rows.map((r) => r.topic)).toEqual(['inventory.deduct']);
  });
});
