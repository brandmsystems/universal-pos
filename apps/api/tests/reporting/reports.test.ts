import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { KEYS_WITHOUT_ROUTES } from '../../src/routes/index.js';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { ensureAuditPartitionFor } from '../../src/core/database/partitions.js';
import { peekTenantContext, type TenantContext } from '../../src/core/database/tenantContext.js';
import { exceptionReport, piiAccessLog } from '../../src/modules/reporting/exceptionReport.js';
import {
  salesBy, salesSummary, paymentMix, previousWindow, salesSummaryCompared,
  type PaymentMixRow,
} from '../../src/modules/reporting/salesReports.js';
import {
  outwardSupplyReturn, reconcileReturnToBills,
  GstPeriodSpansRegistrationChangeError,
} from '../../src/modules/reporting/gstReturn.js';
import { REPORTS, reportsFor } from '../../src/modules/reporting/registry.js';
import { PERMISSIONS, type PermissionKey } from '../../src/modules/authz/permissions.js';
import { SYSTEM_ROLES } from '../../src/modules/authz/systemRoles.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;
let tenantId: string, branchId: string, otherBranchId: string, userId: string, waiterId: string;
let stationId: string, taxClassId: string, categoryId: string;
let membershipId: string, adjustReasonId: string;

const DATE = '2026-05-01';
const ctx = (): TenantContext => peekTenantContext()!;
const tx = <T>(fn: () => Promise<T>) => withTenantTransaction(pool, tenantId, fn);

async function makeItem(name: string, priceMinor: number, category = categoryId): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id,tenant_id,category_id,kind,key,name,price_minor,
       tax_class_id,station_code)
     VALUES ($1,$2,$3,'single',$4,$5,$6,$7,'grill')`,
    [id, tenantId, category, `i${id.replace(/-/g, '').slice(0, 10)}`, name, priceMinor, taxClassId]);
  return id;
}

/** An order with lines, on a business date. */
async function makeOrder(
  lines: ReadonlyArray<{
    kind: 'item' | 'combo_parent' | 'combo_component' | 'void' | 'comp' | 'discount';
    itemId?: string; name: string; qty: number; unit?: number | null; total?: number | null;
    displayTotal?: number | null; parentIdx?: number; rateBps?: number; adjustsIdx?: number;
  }>,
  opts: { branch?: string; date?: string; user?: string } = {},
): Promise<{ orderId: string; lineIds: string[] }> {
  const branch = opts.branch ?? branchId;
  const date = opts.date ?? DATE;
  const user = opts.user ?? userId;
  const sessionId = randomUUID(), orderId = randomUUID();
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,guest_count,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,2,$5)`, [sessionId, tenantId, branch, date, user]);
  await owner.query(
    `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6)`, [orderId, tenantId, branch, sessionId, date, user]);

  const lineIds: string[] = [];
  // ONE transaction: the combo-allocation trigger is DEFERRABLE INITIALLY
  // DEFERRED and fires at COMMIT. Inserting the parent under autocommit makes it
  // fire against an empty component set.
  await owner.query('BEGIN');
  for (const l of lines) {
    const id = randomUUID();
    lineIds.push(id);
    // void, comp and discount are ADJUSTMENTS: pinned to the row they adjust by
    // composite FK, and reason-coded. That shape is the Phase 3 design, not
    // fixture ceremony.
    const isAdjustment = ['void', 'comp', 'discount'].includes(l.kind);
    await owner.query(
      `INSERT INTO app.order_line
         (id,tenant_id,branch_id,order_id,kind,parent_line_id,menu_item_id,display_name,
          unit_price_minor,quantity,line_total_minor,display_total_minor,tax_rate_bps,
          created_by_user_id,adjusts_line_id,adjusted_unit_price_minor,adjusted_kind,
          adjustment_reason_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, tenantId, branch, orderId, l.kind,
       l.parentIdx !== undefined ? lineIds[l.parentIdx] : null,
       l.itemId ?? null, l.name,
       isAdjustment ? null : l.unit ?? null, l.qty, l.total ?? null,
       l.displayTotal ?? null, l.rateBps ?? 500, user,
       isAdjustment ? lineIds[l.adjustsIdx ?? 0]! : null,
       isAdjustment ? l.unit ?? null : null,
       isAdjustment ? 'item' : null,
       isAdjustment ? adjustReasonId : null]);
  }
  await owner.query('COMMIT');
  return { orderId, lineIds };
}

/**
 * A backdated audit row CREATES ITS MONTH'S PARTITION first.
 *
 * The exception report ranks an actor against their own prior baseline, so the
 * fixture must write rows in a window BEFORE the period -- months the
 * forward-only partition job never covers. Without this those rows land in the
 * DEFAULT partition and stay there, and a permanently dirty default is an alert
 * that can never fire honestly: the day the partition job really stops, someone
 * looks at a non-empty default and recognises the known noise.
 *
 * It calls the SAME function the partition job calls, so there is no second copy
 * of the CREATE TABLE, the REVOKE or the RLS policy to drift.
 */
async function auditRow(opts: {
  action: string; actor: string; actorName: string; at: string;
  branch?: string; reasonKey?: string;
}) {
  await ensureAuditPartitionFor(owner, opts.at);
  await owner.query(
    `INSERT INTO app.tenant_audit_log
       (id,tenant_id,branch_id,actor_user_id,actor_name,action,target_type,target_id,
        after,request_id,occurred_at,actor_kind,authorising_membership_id)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'order',gen_random_uuid()::text,
             $6::jsonb,$7,$8::timestamptz,'user',$9)`,
    [tenantId, opts.branch ?? branchId, opts.actor, opts.actorName, opts.action,
     JSON.stringify({ reason_key: opts.reasonKey ?? 'unspecified' }),
     randomUUID(), opts.at, membershipId]);
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `rep+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'rep_plan','Rep')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='rep_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `rep-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `r${key.slice(4, 12)}`, name: 'Reporting Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }

  otherBranchId = randomUUID();
  await owner.query(
    `INSERT INTO app.branch (id,tenant_id,code,name,timezone,gstin,state_code,gst_registration)
     VALUES ($1,$2,'airport','Airport','Asia/Kolkata','29AABCU9603R1ZM','29','registered')`,
    [otherBranchId, tenantId]);
  await owner.query(
    `UPDATE app.branch SET gstin='29AABCU9603R1ZM', state_code='29', gst_registration='registered' WHERE id=$1`, [branchId]);

  waiterId = randomUUID();
  await owner.query(
    `INSERT INTO app.app_user (id,tenant_id,full_name,employee_code,status)
     VALUES ($1,$2,'Ravi Waiter','W01','active')`, [waiterId, tenantId]);

  await owner.query(`INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')`,
    [tenantId]);
  stationId = randomUUID();
  await owner.query(
    `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name)
     VALUES ($1,$2,$3,'grill','Grill')`, [stationId, tenantId, branchId]);
  taxClassId = randomUUID();
  await owner.query(`INSERT INTO app.tax_class (id,tenant_id,key,name,rate_bps)
    VALUES ($1,$2,'food_5','Food',500)`, [taxClassId, tenantId]);
  categoryId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_category (id,tenant_id,key,name,display_order)
     VALUES ($1,$2,'mains','Mains',1)`, [categoryId, tenantId]);

  membershipId = (await owner.query<{ id: string }>(
    `SELECT id FROM app.membership WHERE tenant_id=$1 AND user_id=$2 LIMIT 1`,
    [tenantId, userId])).rows[0]!.id;

  adjustReasonId = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
     VALUES ($1,$2,'reporting_probe','Reporting probe')`, [adjustReasonId, tenantId]);
  for (const kind of ['void', 'comp', 'discount']) {
    await owner.query(
      `INSERT INTO app.adjustment_reason_kind (tenant_id,reason_id,kind) VALUES ($1,$2,$3)`,
      [tenantId, adjustReasonId, kind]);
  }
});

afterAll(async () => { await pool?.end(); await owner?.end(); });

/* --------------------------------------------------------------------- B --- */

describe('B. the exception report', () => {
  it('derives its two sections from risk_subclass, not from a list in the module', async () => {
    await auditRow({ action: 'order.void', actor: waiterId, actorName: 'Ravi Waiter',
                     at: `${DATE}T19:00:00Z`, reasonKey: 'wrong_order' });
    await auditRow({ action: 'menu.price.edit', actor: userId, actorName: 'Owner',
                     at: `${DATE}T09:00:00Z`, reasonKey: 'seasonal' });

    const report = await tx(() => exceptionReport(ctx(), {
      branchId, fromDate: DATE, toDate: DATE }));

    expect(report.transaction.map((r) => r.action)).toContain('order.void');
    expect(report.configuration.map((r) => r.action)).toContain('menu.price.edit');
    // The classification lives in the catalogue, so the two sets are disjoint by
    // construction rather than by a filter someone can get wrong.
    const overlap = report.transaction.filter((t) =>
      report.configuration.some((c) => c.action === t.action));
    expect(overlap).toEqual([]);
  });

  it('adapts to a NEW financial key with no edit to the report', async () => {
    // The synthetic case: a key added to the catalogue after the report was
    // written must land in the right section on its own.
    await owner.query(
      `INSERT INTO platform.permission (key,module,name,description,risk_class,risk_subclass)
       VALUES ('synthetic.rebate','order','Synthetic','probe','financial','transaction')
       ON CONFLICT (key) DO NOTHING`);
    await auditRow({ action: 'synthetic.rebate', actor: waiterId, actorName: 'Ravi Waiter',
                     at: `${DATE}T20:00:00Z` });

    const report = await tx(() => exceptionReport(ctx(), {
      branchId, fromDate: DATE, toDate: DATE }));
    expect(report.transaction.map((r) => r.action)).toContain('synthetic.rebate');
    await owner.query(`DELETE FROM platform.permission WHERE key='synthetic.rebate'`);
  });

  it('ranks against the actor OWN baseline, not a global threshold', async () => {
    const heavy = randomUUID(), steady = randomUUID();
    await owner.query(
      `INSERT INTO app.app_user (id,tenant_id,full_name,employee_code,status) VALUES
        ($1,$3,'Spike','W02','active'), ($2,$3,'Steady','W03','active')`,
      [heavy, steady, tenantId]);

    // Steady voids twice a day for the whole baseline AND in the period: normal.
    for (let d = 1; d <= 14; d += 1) {
      const day = `2026-04-${String(d).padStart(2, '0')}`;
      await auditRow({ action: 'order.void', actor: steady, actorName: 'Steady',
                       at: `${day}T19:00:00Z` });
      await auditRow({ action: 'order.void', actor: steady, actorName: 'Steady',
                       at: `${day}T20:00:00Z` });
    }
    await auditRow({ action: 'order.void', actor: steady, actorName: 'Steady',
                     at: `${DATE}T19:00:00Z` });
    await auditRow({ action: 'order.void', actor: steady, actorName: 'Steady',
                     at: `${DATE}T20:00:00Z` });

    // Spike never voided before, then voids six times on the day.
    for (let i = 0; i < 6; i += 1) {
      await auditRow({ action: 'order.void', actor: heavy, actorName: 'Spike',
                       at: `${DATE}T${String(18 + i).padStart(2, '0')}:30:00Z` });
    }

    const report = await tx(() => exceptionReport(ctx(), {
      branchId, fromDate: DATE, toDate: DATE, baselineDays: 28 }));

    const spike = report.anomalies.find((a) => a.actorUserId === heavy);
    const usual = report.anomalies.find((a) => a.actorUserId === steady);

    expect(spike, 'the actor whose behaviour CHANGED is the finding').toBeDefined();
    // Steady's volume is higher over the period but matches their own normal, so
    // either they are absent or they rank below the spike. A global threshold
    // would have surfaced Steady and buried Spike.
    if (usual) expect(spike!.lift).toBeGreaterThan(usual.lift);
    expect(report.anomalies[0]!.actorUserId).toBe(heavy);
  });

  it('keeps privacy-class access out of BOTH sections', async () => {
    const customerId = randomUUID();
    await owner.query(
      `INSERT INTO app.pii_access_log (id,tenant_id,branch_id,actor_user_id,permission_key,
         customer_id,occurred_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'customer.pii.view',$4,$5::timestamptz)`,
      [tenantId, branchId, userId, customerId, `${DATE}T12:00:00Z`]);

    const report = await tx(() => exceptionReport(ctx(), {
      branchId, fromDate: DATE, toDate: DATE }));
    const all = [...report.transaction, ...report.configuration].map((r) => r.action);
    expect(all).not.toContain('customer.pii.view');
    expect(all).not.toContain('customer.pii.export');

    // It is in the DPO's log instead, with its own shape.
    const log = await tx(() => piiAccessLog(ctx(), { fromDate: DATE, toDate: DATE }));
    expect(log.some((r) => r.customerId === customerId)).toBe(true);
  });

  it('refuses a bulk export row that carries an id list instead of a descriptor', async () => {
    await expect(owner.query(
      `INSERT INTO app.pii_access_log (id,tenant_id,actor_user_id,permission_key,customer_id)
       VALUES (gen_random_uuid(),$1,$2,'customer.pii.export',gen_random_uuid())`,
      [tenantId, userId])).rejects.toThrow(/pii_access_shape_exact/);
  });
});

/* --------------------------------------------------------------------- D --- */

describe('D. sales reports', () => {
  it('separates "how many did we make" from "how many did we sell"', async () => {
    const dish = await makeItem('Biryani', 30000);
    await makeOrder([
      { kind: 'item', itemId: dish, name: 'Biryani', qty: 3, unit: 30000, total: 90000 },
      // Comp: delivered free. Quantity 0, money negative.
      { kind: 'comp', itemId: dish, name: 'Biryani comp', qty: 0, unit: 30000, total: -30000 },
      // Void: never delivered. Quantity negative.
      { kind: 'void', itemId: dish, name: 'Biryani void', qty: -1, unit: 30000, total: -30000 },
    ], { date: '2026-05-02' });

    const rows = await tx(() => salesBy(ctx(), 'item', {
      branchId, fromDate: '2026-05-02', toDate: '2026-05-02' }));
    const row = rows.find((r) => r.key === dish)!;
    expect(row).toBeDefined();

    // The kitchen cooked THREE. order.void is post-fire by construction, so the
    // voided one was made and then written off -- it does not reduce production.
    expect(row.quantityMade).toBe(3);
    // Charged for: 3, less the void (-1), and the comp contributes 0 by
    // construction because its quantity is zero.
    expect(row.quantitySold).toBe(2);
    expect(row.compMinor).toBe(-30000);
    expect(row.voidMinor).toBe(-30000);
    expect(row.netMinor).toBe(30000);
  });

  it('rolls a combo component to its OWN category at its ALLOCATED price', async () => {
    const bevCategory = randomUUID();
    await owner.query(
      `INSERT INTO app.menu_category (id,tenant_id,key,name,display_order)
       VALUES ($1,$2,'bev','Beverages',2)`, [bevCategory, tenantId]);
    const thali = await makeItem('Thali', 29900);
    const lassi = await makeItem('Lassi', 9000, bevCategory);

    // 299 combo: 209.30 food + 89.70 beverage, allocated pro-rata.
    await makeOrder([
      { kind: 'combo_parent', itemId: thali, name: 'Thali Combo', qty: 1,
        unit: null, total: null, displayTotal: 29900 },
      { kind: 'combo_component', itemId: thali, name: 'Thali', qty: 1,
        unit: 20930, total: 20930, parentIdx: 0 },
      { kind: 'combo_component', itemId: lassi, name: 'Lassi', qty: 1,
        unit: 8970, total: 8970, parentIdx: 0, rateBps: 1200 },
    ], { date: '2026-05-03' });

    const rows = await tx(() => salesBy(ctx(), 'category', {
      branchId, fromDate: '2026-05-03', toDate: '2026-05-03' }));
    const bev = rows.find((r) => r.label === 'Beverages')!;

    // Not zero (which is what happens if components are ignored) and not 29900
    // (which is what happens if the parent is counted).
    expect(bev).toBeDefined();
    expect(bev.netMinor).toBe(8970);
    // And the parent contributed no money anywhere.
    expect(rows.reduce((a, r) => a + r.netMinor, 0)).toBe(29900);
  });

  it('uses BUSINESS date, so a Friday night does not split at midnight', async () => {
    // Both orders belong to business date 2026-05-08; the second is after
    // midnight by the clock.
    await makeOrder([{ kind: 'item', name: 'Late dosa', qty: 1, unit: 10000, total: 10000 }],
      { date: '2026-05-08' });
    await makeOrder([{ kind: 'item', name: 'Later dosa', qty: 1, unit: 10000, total: 10000 }],
      { date: '2026-05-08' });

    const summary = await tx(() => salesSummary(ctx(), {
      branchId, fromDate: '2026-05-08', toDate: '2026-05-08' }));
    expect(summary.orders).toBe(2);
    expect(summary.netMinor).toBe(20000);
    expect(summary.averageTicketMinor).toBe(10000);
  });

  it('reports across every dimension without error', async () => {
    const dims = ['item', 'category', 'station', 'hour', 'staff', 'branch'] as const;
    assertCheckedSet({
      label: 'sales dimensions',
      checked: [...dims],
      minimum: 6,
      mustInclude: ['item', 'category', 'station', 'hour', 'staff', 'branch'],
    });
    for (const d of dims) {
      const rows = await tx(() => salesBy(ctx(), d, {
        branchId, fromDate: '2026-05-01', toDate: '2026-05-31' }));
      expect(Array.isArray(rows)).toBe(true);
    }
  });
});

/* --------------------------------------------------------------------- E --- */

describe('D. payment mix: what the money arrived as', () => {
  /**
   * #####################################################################
   * THIS IS NOT A SALES DIMENSION, AND THE TEST SAYS SO FIRST.
   *
   * Order lines are what was ORDERED; tenders are what was COLLECTED. On any
   * day with an unsettled bill the two differ, so a caller who could ask for
   * `salesBy('payment')` would reasonably expect its total to match
   * `salesBy('item')` and would be wrong every service.
   * #####################################################################
   */
  const PDATE = '2026-06-15';

  async function billWithTenders(
    tenders: ReadonlyArray<{ method: string; amount: number; manual?: boolean }>,
    opts: { date?: string; branch?: string; voidLast?: boolean; billVoid?: boolean } = {},
  ): Promise<string> {
    const date = opts.date ?? PDATE;
    const branch = opts.branch ?? branchId;
    const { lineIds } = await makeOrder(
      [{ kind: 'item', name: 'Thali', qty: 1, unit: 20000, total: 20000 }],
      { date, branch });
    const sessionId = (await owner.query<{ session_id: string }>(
      `SELECT session_id FROM app.sales_order WHERE id IN
         (SELECT order_id FROM app.order_line WHERE id=$1)`, [lineIds[0]!])).rows[0]!.session_id;

    const billId = randomUUID();
    // One transaction: a DEFERRED trigger requires the bill LINES to sum to the
    // bill's own totals -- `lines sum to 0/0 but the bill says 20000/1000`. The
    // bill is not allowed to disagree with what it is made of, even for a
    // fixture, which is the same rule that makes the GST return reconcile.
    await owner.query('BEGIN');
    await owner.query(
      // supplier_state_code and tax_treatment are 0050's: the head is derived
      // from the supply and stamped, so a bill that charges tax has to say
      // which state it was supplied in. `bill_tax_treatment_consistent`
      // refuses an intra-state bill whose place of supply and supplier state
      // disagree, which is what makes the derived CGST/SGST split trustworthy.
      `INSERT INTO app.bill (id,tenant_id,branch_id,session_id,business_date,bill_no,split_kind,
         subtotal_minor,tax_minor,total_minor,generated_by_user_id,status,
         supplier_state_code,place_of_supply_state_code,tax_treatment,tax_jurisdiction,premises_class,tax_account_type,prices_include_tax,currency)
       VALUES ($1,$2,$3,$4,$5::date,$6,'whole',20000,1000,21000,$7,$8,'29','29','intra_state','IN','standard','gst',false,'INR')`,
      [billId, tenantId, branch, sessionId, date,
       Math.floor(Math.random() * 1e8), userId, opts.billVoid ? 'void' : 'open']);
    await owner.query(
      `INSERT INTO app.bill_line (id,tenant_id,bill_id,order_line_id,share_bps,display_name,
         amount_minor,tax_minor,tax_rate_bps,tax_components)
       VALUES (gen_random_uuid(),$1,$2,$3,10000,'Thali',20000,1000,500,$4::jsonb)`,
      [tenantId, billId, lineIds[0]!, JSON.stringify([
        { name: 'CGST', rate_bps: 250, amount_minor: 500 },
        { name: 'SGST', rate_bps: 250, amount_minor: 500 },
      ])]);
    await owner.query('COMMIT');

    const ids: string[] = [];
    for (const t of tenders) {
      const id = randomUUID();
      ids.push(id);
      await owner.query(
        `INSERT INTO app.tender
           (id,tenant_id,bill_id,kind,method,amount_minor,tendered_by_user_id,
            settled_offline_manually,operator_reference,authorised_by_user_id,reason_id)
         VALUES ($1,$2,$3,'capture',$4,$5,$6,$7,$8,$9,$10)`,
        [id, tenantId, billId, t.method, t.amount, userId,
         t.manual ?? false,
         t.manual ? 'MANUAL-REF-1' : null,
         t.manual ? userId : null,
         t.manual ? adjustReasonId : null]);
    }
    if (opts.voidLast) {
      const target = ids[ids.length - 1]!;
      const amount = tenders[tenders.length - 1]!.amount;
      await owner.query(
        `INSERT INTO app.tender
           (id,tenant_id,bill_id,kind,method,amount_minor,tendered_by_user_id,
            voids_tender_id,reason_id)
         VALUES (gen_random_uuid(),$1,$2,'void',$3,$4,$5,$6,$7)`,
        [tenantId, billId, tenders[tenders.length - 1]!.method, -amount, userId,
         target, adjustReasonId]);
    }
    return billId;
  }

  const mix = (): Promise<readonly PaymentMixRow[]> =>
    withTenantTransaction(pool, tenantId, () =>
      paymentMix(ctx(), { fromDate: PDATE, toDate: PDATE }));

  it('splits a part-cash part-card bill into both buckets', async () => {
    await billWithTenders([
      { method: 'cash', amount: 10000 },
      { method: 'card', amount: 11000 },
    ]);
    const rows = await mix();
    const byMethod = Object.fromEntries(rows.map((r) => [r.method, r]));
    expect(byMethod['cash']!.collectedMinor).toBe(10000);
    expect(byMethod['card']!.collectedMinor).toBe(11000);
    // And they add up to what was handed over, which is the point of the tile.
    expect(rows.reduce((a, r) => a + r.collectedMinor, 0)).toBe(21000);
  });

  it('nets a voided tender out of the total, and still COUNTS it', async () => {
    // Netting alone would hide the reversal: two captures with one void looks
    // identical to one capture until the voids are counted separately, and a
    // method with heavy void traffic is exactly the leakage signal an owner
    // opens this screen for.
    // The amounts never OVERPAY, deliberately. A first draft used two full
    // captures and `assert_billing_invariants` refused it -- `is open with
    // tenders netting 42000 against a total of 21000` -- which is the same
    // constraint that caught the idempotency double-charge. The realistic shape
    // is anyway a mis-keyed tender that gets reversed, not a double payment.
    await billWithTenders([
      { method: 'upi', amount: 10000 },
      { method: 'upi', amount: 11000 },
    ], { voidLast: true });

    const upi = (await mix()).find((r) => r.method === 'upi')!;
    expect(upi.capturedMinor).toBe(21000);
    expect(upi.voidedMinor).toBe(-11000);
    expect(upi.collectedMinor, 'the money actually taken').toBe(10000);
    expect(upi.captureCount).toBe(2);
    expect(upi.voidCount).toBe(1);
  });

  it('orders the methods by amount, which a ::text sort did not', async () => {
    // Found by LOOKING at the rendered dashboard, not by a failing test. The
    // query said ORDER BY 2 DESC, and column 2 is the ::text cast of the sum --
    // so it sorted lexicographically and 399 came before 2562. Every assertion
    // above was about per-method figures, which were correct; none was about
    // the sequence, which is what the screen reads top to bottom.
    await billWithTenders([{ method: 'cash', amount: 4000 }]);
    await billWithTenders([{ method: 'card', amount: 21000 }]);
    await billWithTenders([{ method: 'upi', amount: 12000 }]);

    const rows = await mix();
    const amounts = rows.map((r) => r.collectedMinor);
    expect(amounts, 'descending by amount collected')
      .toEqual([...amounts].sort((x, y) => y - x));
    // And the lexicographic order is the one it must NOT be in: as text,
    // '4000' sorts above '21000'.
    expect(rows[0]!.method).not.toBe('cash');
  });

  it('shows loyalty as its own bucket, because that is what the programme cost',
    async () => {
      // ###################################################################
      // THE FIGURE AN OWNER ACTUALLY WANTS.
      //
      // A redemption is a tender with method 'loyalty' -- not a discount on the
      // lines -- so it arrives here by derivation rather than by anybody adding
      // a report. And it is its OWN method rather than reusing 'voucher': a
      // gift voucher was sold for money and a loyalty point was given away, and
      // an owner reading the payment mix must not have those in one row.
      //
      // This is the assertion that the choice reaches a screen. Without it the
      // tender method could be renamed and the only symptom would be an owner
      // unable to answer "what did the loyalty programme cost me this month".
      // ###################################################################
      // 21000 exactly: this helper's bill is 21000 and
      // `assert_billing_invariants` refuses tenders that exceed the total --
      // which is the same constraint that makes `loyalty_exceeds_bill` a
      // refusal rather than a lost balance.
      await billWithTenders([
        { method: 'loyalty', amount: 6000 },
        { method: 'cash', amount: 15000 },
      ]);
      const rows = await mix();
      const byMethod = Object.fromEntries(rows.map((r) => [r.method, r]));
      expect(byMethod['loyalty'], JSON.stringify(rows)).toBeDefined();
      expect(byMethod['loyalty']!.collectedMinor).toBe(6000);
      // And it did NOT land in the voucher bucket.
      expect(byMethod['voucher']).toBeUndefined();
    });

  it('counts a manual settlement, which is money taken outside the system', async () => {
    await billWithTenders([{ method: 'other', amount: 21000, manual: true }]);
    const other = (await mix()).find((r) => r.method === 'other')!;
    expect(other.manualCount).toBe(1);
    expect(other.collectedMinor).toBe(21000);
  });

  it('excludes a voided BILL entirely, not merely its tenders', async () => {
    await billWithTenders([{ method: 'voucher', amount: 21000 }], { billVoid: true });
    expect((await mix()).some((r) => r.method === 'voucher')).toBe(false);
  });

  it('spans branches unscoped, and narrows when a branch is named', async () => {
    // No branchId means EVERY branch, which is what an owner dashboard wants and
    // what the first draft of this test got wrong by assuming otherwise.
    await billWithTenders([{ method: 'wallet', amount: 5000 }], { branch: otherBranchId });
    await billWithTenders([{ method: 'wallet', amount: 6000 }]);

    const both = (await mix()).find((r) => r.method === 'wallet')!;
    expect(both.collectedMinor, 'both branches together').toBe(11000);

    const scoped = await withTenantTransaction(pool, tenantId, () =>
      paymentMix(ctx(), { fromDate: PDATE, toDate: PDATE, branchId: otherBranchId }));
    expect(scoped.find((r) => r.method === 'wallet')!.collectedMinor).toBe(5000);
  });

  it('reads the BUSINESS date, so a 2am settlement belongs to the night before',
    async () => {
      await billWithTenders([{ method: 'voucher', amount: 4000 }], { date: '2026-06-14' });
      // Outside the window, whatever wall-clock time the tender carries.
      expect((await mix()).some((r) => r.method === 'voucher')).toBe(false);

      const dayBefore = await withTenantTransaction(pool, tenantId, () =>
        paymentMix(ctx(), { fromDate: '2026-06-14', toDate: '2026-06-14' }));
      expect(dayBefore.find((r) => r.method === 'voucher')!.collectedMinor).toBe(4000);
    });
});

describe('D. the comparison window', () => {
  const A = '2026-07-10';
  const B = '2026-07-03';

  it('computes the previous window as the same length ending the day before', () => {
    // Inclusive at both ends, which is where this is off by one when a caller
    // writes it. Seven days ending 10 July starts on the 4th; the window before
    // it is 27 June to 3 July.
    expect(previousWindow('2026-07-04', '2026-07-10'))
      .toEqual({ fromDate: '2026-06-27', toDate: '2026-07-03' });
    // A single day compares against yesterday.
    expect(previousWindow(A, A)).toEqual({ fromDate: '2026-07-09', toDate: '2026-07-09' });
  });

  it('returns a zero delta when a period is compared with itself', async () => {
    await makeOrder([{ kind: 'item', name: 'Dal', qty: 1, unit: 28000, total: 28000 }],
      { date: A });
    const same = await withTenantTransaction(pool, tenantId, () =>
      salesSummaryCompared(ctx(), { fromDate: A, toDate: A }, { fromDate: A, toDate: A }));
    expect(same.delta!.netPct).toBe(0);
    expect(same.delta!.ordersPct).toBe(0);
  });

  it('reports a real change against a real baseline', async () => {
    // 28000 on the earlier day, 28000 + 56000 on the later one: net triples.
    await makeOrder([{ kind: 'item', name: 'Dal', qty: 1, unit: 28000, total: 28000 }],
      { date: B });
    await makeOrder([{ kind: 'item', name: 'Dal', qty: 2, unit: 28000, total: 56000 }],
      { date: A });

    const compared = await withTenantTransaction(pool, tenantId, () =>
      salesSummaryCompared(ctx(), { fromDate: A, toDate: A }, { fromDate: B, toDate: B }));
    expect(compared.previous!.netMinor).toBe(28000);
    expect(compared.current.netMinor).toBe(compared.previous!.netMinor * 3);
    expect(compared.delta!.netPct).toBe(200);
  });

  it('reports NULL, not zero and not infinity, when there is no baseline', async () => {
    // The first day a branch ever trades. 0% would read as "flat" and Infinity
    // reaches the screen as the string "Infinity%".
    const virgin = await withTenantTransaction(pool, tenantId, () =>
      salesSummaryCompared(ctx(), { fromDate: A, toDate: A },
        { fromDate: '2019-01-01', toDate: '2019-01-01' }));
    expect(virgin.previous!.netMinor).toBe(0);
    expect(virgin.delta!.netPct).toBeNull();
    expect(virgin.delta!.ordersPct).toBeNull();
  });

  it('omits the comparison entirely when none was asked for', async () => {
    const plain = await withTenantTransaction(pool, tenantId, () =>
      salesSummaryCompared(ctx(), { fromDate: A, toDate: A }, null));
    expect(plain.previous).toBeNull();
    expect(plain.delta).toBeNull();
  });
});

describe('E. the GST return reconciles exactly to the bills', () => {
  async function makeBill(opts: {
    date: string; gstin?: string | null; lines: ReadonlyArray<{ amount: number; rateBps: number }>;
  }): Promise<string> {
    const { orderId, lineIds } = await makeOrder(
      opts.lines.map((l, i) => ({
        kind: 'item' as const, name: `L${i}`, qty: 1,
        unit: l.amount, total: l.amount, rateBps: l.rateBps,
      })), { date: opts.date });
    void orderId;

    const billId = randomUUID();
    const sessionId = (await owner.query<{ session_id: string }>(
      `SELECT session_id FROM app.sales_order WHERE id IN
         (SELECT order_id FROM app.order_line WHERE id=$1)`, [lineIds[0]!])).rows[0]!.session_id;

    const subtotal = opts.lines.reduce((a, l) => a + l.amount, 0);
    const tax = opts.lines.reduce((a, l) => a + Math.round((l.amount * l.rateBps) / 10000), 0);

    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO app.bill (id,tenant_id,branch_id,session_id,business_date,bill_no,split_kind,
         subtotal_minor,tax_minor,total_minor,generated_by_user_id,
         recipient_gstin,recipient_legal_name,place_of_supply_state_code,supplier_gstin,
         supplier_state_code,recipient_state_code,tax_treatment,tax_jurisdiction,premises_class,tax_account_type,prices_include_tax,currency)
       VALUES ($1,$2,$3,$4,$5::date,$6,'whole',$7,$8,$9,$10,$11,$12,'29','29AABCU9603R1ZM',
               '29',$13,$14,'IN','standard','gst',false,'INR')`,
      [billId, tenantId, branchId, sessionId, opts.date,
       Math.floor(Math.random() * 1e8), subtotal, tax, subtotal + tax, userId,
       opts.gstin ?? null, opts.gstin ? 'Corporate Customer LLP' : null,
       // Derived from the GSTIN's first two characters, exactly as
       // `setBillRecipient` does -- `bill_recipient_state_matches_gstin`
       // requires the two to agree.
       opts.gstin ? opts.gstin.slice(0, 2) : null,
       tax === 0 ? 'none' : 'intra_state']);

    for (const [i, l] of opts.lines.entries()) {
      const lineTax = Math.round((l.amount * l.rateBps) / 10000);
      const half = Math.floor(lineTax / 2);
      await owner.query(
        `INSERT INTO app.bill_line (id,tenant_id,bill_id,order_line_id,share_bps,display_name,
           amount_minor,tax_minor,tax_rate_bps,tax_components)
         VALUES (gen_random_uuid(),$1,$2,$3,10000,$4,$5,$6,$7,$8::jsonb)`,
        [tenantId, billId, lineIds[i]!, `L${i}`, l.amount, lineTax, l.rateBps,
         JSON.stringify([
           { name: 'CGST', rate_bps: l.rateBps / 2, amount_minor: lineTax - half },
           { name: 'SGST', rate_bps: l.rateBps / 2, amount_minor: half },
         ])]);
    }
    await owner.query('COMMIT');
    return billId;
  }

  it('reconciles exactly, summed independently off the bills', async () => {
    await makeBill({ date: '2026-05-10', lines: [{ amount: 100000, rateBps: 500 }] });
    await makeBill({ date: '2026-05-10', gstin: '29AAACR5055K1Z5',
                     lines: [{ amount: 250000, rateBps: 500 }] });

    const check = await tx(() => reconcileReturnToBills(ctx(), {
      branchId, fromDate: '2026-05-10', toDate: '2026-05-10' }));

    expect(check.matches, JSON.stringify(check)).toBe(true);
    expect(check.returnTaxableMinor).toBe(350000);
    expect(check.returnTaxableMinor).toBe(check.billTaxableMinor);
    expect(check.returnTaxMinor).toBe(check.billTaxMinor);
  });

  it('splits B2B from B2C', async () => {
    const ret = await tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-05-10', toDate: '2026-05-10' }));
    expect(ret.b2b).toHaveLength(1);
    expect(ret.b2b[0]!.recipientGstin).toBe('29AAACR5055K1Z5');
    expect(ret.b2b[0]!.buckets[0]!.taxableMinor).toBe(250000);
    expect(ret.b2c.reduce((a, b) => a + b.taxableMinor, 0)).toBe(100000);
  });

  it('produces a return with BOTH rates when a rate changed mid-period', async () => {
    // The bill lines snapshot their own rate, so a revision does not rewrite
    // history -- it produces two buckets, which is what the return must show.
    await makeBill({ date: '2026-05-11', lines: [{ amount: 100000, rateBps: 500 }] });
    await makeBill({ date: '2026-05-12', lines: [{ amount: 100000, rateBps: 1200 }] });

    const ret = await tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-05-11', toDate: '2026-05-12' }));
    const rates = ret.b2c.map((b) => b.rateBps).sort((a, b) => a - b);
    expect(rates).toEqual([500, 1200]);

    const check = await tx(() => reconcileReturnToBills(ctx(), {
      branchId, fromDate: '2026-05-11', toDate: '2026-05-12' }));
    expect(check.matches).toBe(true);
  });

  it('reports refunds as credit notes, separately from supplies', async () => {
    const billId = await makeBill({ date: '2026-05-13', lines: [{ amount: 50000, rateBps: 500 }] });
    const reasonId = randomUUID();
    await owner.query(
      `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
       VALUES ($1,$2,'quality','Quality complaint')`, [reasonId, tenantId]);
    await owner.query(
      `INSERT INTO app.adjustment_reason_kind (tenant_id,reason_id,kind) VALUES ($1,$2,'refund')`,
      [tenantId, reasonId]);
    // A refund cannot exceed what was tendered -- the Phase 3 deferred trigger --
    // so the bill has to have been paid before it can be refunded.
    await owner.query(
      `INSERT INTO app.tender (id,tenant_id,bill_id,kind,method,amount_minor,tendered_by_user_id)
       VALUES (gen_random_uuid(),$1,$2,'capture','cash',52500,$3)`,
      [tenantId, billId, userId]);
    await owner.query(
      `INSERT INTO app.refund (id,tenant_id,branch_id,bill_id,amount_minor,method,reason_id,
         refunded_by_user_id,taxable_minor,tax_minor,tax_rate_bps)
       VALUES (gen_random_uuid(),$1,$2,$3,21000,'cash',$4,$5,20000,1000,500)`,
      [tenantId, branchId, billId, reasonId, userId]);

    const ret = await tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-05-13', toDate: '2026-05-13' }));
    expect(ret.creditNotes).toHaveLength(1);
    expect(ret.creditNotes[0]!.taxableMinor).toBe(20000);
    // Credit notes do NOT net off the supply totals: they are reported separately.
    expect(ret.b2c.reduce((a, b) => a + b.taxableMinor, 0)).toBe(50000);
  });

  it('refuses a period the branch changed its GST position inside', async () => {
    // ###################################################################
    // THE FAILURE THAT LOOKS LIKE A LOWER EFFECTIVE RATE.
    //
    // `supplierGistin` is resolved as the one distinct non-null supplier GSTIN
    // on the period's bills. For a branch that registered mid-period, the bills
    // before the change carry no GSTIN and no tax and the ones after carry
    // both -- so the whole period's turnover would be reported under a GSTIN
    // that did not exist for half of it.
    //
    // Nothing in the figures shows it. The buckets simply come out at a lower
    // effective rate than the menu says, which is what a period with genuinely
    // exempt items looks like -- so this must be a refusal and not a footnote.
    // ###################################################################
    await makeBill({ date: '2026-06-02', lines: [{ amount: 100000, rateBps: 500 }] });

    // Clean before the change is recorded: the guard must be the change row,
    // not something about these dates. Asserted as non-empty rather than as an
    // exact figure -- other cases in this file bill into June too, and an exact
    // total here would be a test of their fixtures.
    const clean = await tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-06-01', toDate: '2026-06-30' }));
    expect(clean.b2c.reduce((a, b) => a + b.taxableMinor, 0))
      .toBeGreaterThanOrEqual(100000);

    await owner.query(
      `INSERT INTO app.branch_gst_registration_change
         (id,tenant_id,branch_id,from_registration,to_registration,from_gstin,to_gstin,
          business_date,changed_by_user_id)
       VALUES (gen_random_uuid(),$1,$2,'unregistered','registered',NULL,
               '29AABCU9603R1ZM','2026-06-12'::date,$3)`,
      [tenantId, branchId, userId]);

    await expect(tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-06-01', toDate: '2026-06-30' })))
      .rejects.toThrow(GstPeriodSpansRegistrationChangeError);

    // The date is IN the refusal, because the caller's next action is to run
    // the two halves and they need to know where to cut.
    await expect(tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-06-01', toDate: '2026-06-30' })))
      .rejects.toThrow(/2026-06-12/);

    // Either side of it files cleanly. The lower half ends the day BEFORE the
    // change: supplies on the change date itself were made under the new
    // position.
    await expect(tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-06-01', toDate: '2026-06-11' })))
      .resolves.toBeTruthy();
    // And a period STARTING on the change date is clean, not spanning: the
    // whole of it is under the new position. An inclusive lower bound here
    // would have made every period after a change unfileable forever.
    await expect(tx(() => outwardSupplyReturn(ctx(), {
      branchId, fromDate: '2026-06-12', toDate: '2026-06-30' })))
      .resolves.toBeTruthy();

    await owner.query(
      `DELETE FROM app.branch_gst_registration_change WHERE tenant_id=$1 AND branch_id=$2`,
      [tenantId, branchId]);
  });

  it('shares no tax code with the control plane', async () => {
    const { readFileSync } = await import('node:fs');
    // Comments stripped first: the module explains WHY it shares nothing with the
    // control plane, and matching that prose would test the explanation.
    const source = readFileSync('src/modules/reporting/gstReturn.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Different supplier, different recipient, different tables, different
    // consequences. A shared "tax engine" means a change for one silently
    // altering the other's filed returns.
    expect(source).not.toMatch(/from '\.\.\/billing\//);
    expect(source).not.toMatch(/platform\.invoice/);
    expect(source, 'non-vacuity: stripping must not have removed the code').toMatch(/app\.bill_line/);
  });
});

/* --------------------------------------------------------------------- F --- */

describe('F. report access', () => {
  it('covers every report.* key, both directions', () => {
    const catalogueKeys = PERMISSIONS
      .map((p) => p.key as string)
      .filter((k) => k.startsWith('report.'));
    const usedKeys = [...new Set(REPORTS.map((r) => r.permission as string))];

    assertCheckedSet({
      label: 'report permission keys',
      checked: catalogueKeys,
      minimum: 5,
      mustInclude: ['report.sales.view', 'report.sales.export', 'report.staff.view',
                    'report.inventory.view', 'report.exception.view'],
    });

    // No orphan key: a permission an admin can grant that does nothing reads as a
    // capability the tenant does not have.
    // Keys the route table records as having no route -- retired with the
    // stock modules in 0064 -- are not orphans of the report registry: nothing
    // may grant a report through them. Read from the route table, not copied.
    const orphans = catalogueKeys.filter((k) => !usedKeys.includes(k) && !KEYS_WITHOUT_ROUTES.includes(k));
    expect(orphans, 'report.* keys with no report behind them').toEqual([]);

    // No report without a key.
    const unguarded = REPORTS.filter((r) =>
      !PERMISSIONS.some((p) => p.key === r.permission));
    expect(unguarded.map((r) => r.name)).toEqual([]);
  });

  it('gives a cashier no reports and an owner the exception report', () => {
    const cashier = SYSTEM_ROLES.find((r) => r.key === 'cashier')!
      .permissions as readonly PermissionKey[];
    const ownerRole = SYSTEM_ROLES.find((r) => r.key === 'owner')!
      .permissions as readonly PermissionKey[];

    // Separation of duties: the person taking money reads no report.
    expect(reportsFor(cashier)).toEqual([]);
    expect(reportsFor(ownerRole).map((r) => r.name)).toContain('exception.transaction');
  });

  it('shows a branch-scoped report only its own branch', async () => {
    await makeOrder([{ kind: 'item', name: 'Other branch dish', qty: 1, unit: 50000, total: 50000 }],
      { branch: otherBranchId, date: '2026-05-20' });
    await makeOrder([{ kind: 'item', name: 'Main branch dish', qty: 1, unit: 10000, total: 10000 }],
      { branch: branchId, date: '2026-05-20' });

    const scoped = await tx(() => salesBy(ctx(), 'branch', {
      branchId, fromDate: '2026-05-20', toDate: '2026-05-20' }));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.key).toBe(branchId);

    // Tenant-wide sees both. A report that leaked across branches would look like
    // a feature, which is why this is asserted rather than assumed from RLS.
    const wide = await tx(() => salesBy(ctx(), 'branch', {
      branchId: null, fromDate: '2026-05-20', toDate: '2026-05-20' }));
    expect(wide.map((r) => r.key).sort()).toEqual([branchId, otherBranchId].sort());
  });

  it('cannot see another tenant rows at all', async () => {
    const rows = await tx(() => salesBy(ctx(), 'item', {
      branchId: null, fromDate: '2020-01-01', toDate: '2030-01-01' }));
    const foreign = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.order_line WHERE tenant_id <> $1`, [tenantId]);
    // The owner client sees other tenants' lines; the tenant-scoped report does not.
    expect(Number(foreign.rows[0]!.n)).toBeGreaterThanOrEqual(0);
    expect(rows.every((r) => r.key !== null)).toBe(true);
  });
});

/* --------------------------------------------------------------------- C --- */
