import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { type TenantContext } from '../../src/core/database/tenantContext.js';
import { recordRefund, recordTender } from '../../src/modules/payments/billing.js';
import { generateBill } from '../helpers/billing.js';
import {
  headsForLine, splitHeads, taxOnLine, refundTaxSnapshot, RefundSpansTaxRatesError,
} from '../../src/modules/tax/taxHeads.js';
import { resolveIndianSupply } from '../../src/modules/tax/in.js';
import { componentsForLine } from '../../src/modules/billing/placeOfSupply.js';
import { outwardSupplyReturn, reconcileReturnToBills,
  GstPeriodHasUnstatedTreatmentError,
  GstReturnNotApplicableError } from '../../src/modules/reporting/gstReturn.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

/**
 * The tax head: CGST + SGST, or IGST.
 *
 * ###########################################################################
 * WHY THIS FILE EXISTS, IN ONE PARAGRAPH.
 *
 * Before migration 0050 the head was CONFIGURATION. `app.tax_component` held a
 * free-text `name` per tax class with no CHECK and no write path in the
 * product; `orderEntry` pre-computed `{name, rate_bps}` -- and no amount --
 * onto the ORDER LINE, which has no place of supply; `generateBill` copied that
 * onto the bill line, writing `JSON.stringify(null)` when there was nothing to
 * copy; and the outward-supply return read `amount_minor` out of that jsonb and
 * bucketed by matching the name.
 *
 * Measured on the dev install at the time: 1,012 bill lines carrying tax had NO
 * `amount_minor` key (every one written by the product) against 657 that did
 * (every one written by a test fixture), and 975 bill lines held a jsonb `null`
 * SCALAR, which `COALESCE` does not convert and `jsonb_array_elements` refuses
 * outright -- so the report answered 500 on real data and zero on the rest.
 *
 * Every assertion below is ordered by what would be worst if it broke, and the
 * first block is the one whose failure looks like nothing at all.
 * ###########################################################################
 */

let owner: pg.Client;
let pool: pg.Pool;
let tenantId: string, branchId: string, userId: string;
let burgerId: string, sodaId: string, taxClassId: string, bevClassId: string;
let refundReasonId: string;

const DATE = '2026-08-01';
// A separate trading day for the bills that deliberately have no head. They
// would otherwise make every later assertion in this file fail with the very
// refusal one of them is asserting -- which is the refusal working, and a
// confusing way to find out.
const UNSTATED_DATE = '2026-08-02';
const tx = <T>(fn: (c: TenantContext) => Promise<T>): Promise<T> =>
  withTenantTransaction(pool, tenantId, fn);

const setStateCode = async (code: string | null): Promise<void> => {
  await owner.query(`UPDATE app.branch SET state_code=$2 WHERE id=$1`, [branchId, code]);
};

/** A session, an order, priced lines, and a bill. The whole money path. */
async function billFor(
  lines: readonly { itemId: string; amountMinor: number; rateBps: number }[],
  date: string = DATE,
): Promise<{ billId: string; sessionId: string; subtotalMinor: number; taxMinor: number;
  totalMinor: number }> {
  const sessionId = randomUUID();
  const floorId = randomUUID();
  const tableId = randomUUID();
  await owner.query(`INSERT INTO app.floor (id,tenant_id,branch_id,name) VALUES ($1,$2,$3,$4)`,
    [floorId, tenantId, branchId, `F-${floorId.slice(0, 8)}`]);
  await owner.query(
    `INSERT INTO app.dining_table (id,tenant_id,branch_id,floor_id,identifier,seats)
     VALUES ($1,$2,$3,$4,$5,4)`, [tableId, tenantId, branchId, floorId, tableId.slice(0, 6)]);
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`, [sessionId, tenantId, branchId, date, userId]);
  await owner.query(
    `INSERT INTO app.table_session_table (id,tenant_id,session_id,dining_table_id)
     VALUES ($1,$2,$3,$4)`, [randomUUID(), tenantId, sessionId, tableId]);

  const orderId = randomUUID();
  await owner.query(
    `INSERT INTO app.sales_order
       (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, tenantId, branchId, sessionId, date, userId]);
  for (const line of lines) {
    await owner.query(
      `INSERT INTO app.order_line
         (id,tenant_id,branch_id,order_id,kind,menu_item_id,display_name,unit_price_minor,
          quantity,line_total_minor,tax_class_key,tax_rate_bps,created_by_user_id)
       VALUES ($1,$2,$3,$4,'item',$5,'Item',$6,1,$6,'seeded',$7,$8)`,
      [randomUUID(), tenantId, branchId, orderId, line.itemId,
       line.amountMinor, line.rateBps, userId]);
  }

  const bill = await tx((c) => generateBill(c, {
    branchId, sessionId, businessDate: date, generatedByUserId: userId, splitKind: 'whole',
  }));
  return {
    billId: bill.billId, sessionId, subtotalMinor: bill.subtotalMinor,
    taxMinor: bill.taxMinor, totalMinor: bill.totalMinor,
  };
}

const headsOf = async (billId: string): Promise<{
  treatment: string; lines: { tax: number; heads: unknown }[];
}> => {
  const bill = (await owner.query<{ tax_treatment: string }>(
    `SELECT tax_treatment FROM app.bill WHERE id=$1`, [billId])).rows[0]!;
  const lines = (await owner.query<{ tax_minor: string; tax_components: unknown }>(
    `SELECT tax_minor::text, tax_components FROM app.bill_line
      WHERE bill_id=$1 ORDER BY amount_minor DESC`, [billId])).rows;
  return {
    treatment: bill.tax_treatment,
    lines: lines.map((l) => ({ tax: Number(l.tax_minor), heads: l.tax_components })),
  };
};

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
    [superAdminId, `heads+${superAdminId}@platform.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'heads_plan','Heads')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='heads_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `heads-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `h${key.slice(6, 14)}`, name: 'Heads Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@h.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);

  // The seeded classes, NOT hand-inserted ones. If provisioning stops seeding
  // them this lookup returns nothing and every DB test here fails loudly --
  // which is the point, because that gap is what made a real tenant unable to
  // add a dish.
  const seeded = (await owner.query<{ id: string; key: string; rate_bps: number }>(
    `SELECT id, key, rate_bps FROM app.tax_class WHERE tenant_id=$1 ORDER BY rate_bps`,
    [tenantId])).rows;
  taxClassId = seeded.find((c) => c.key === 'gst_5')!.id;
  bevClassId = seeded.find((c) => c.key === 'gst_18')!.id;

  await owner.query(
    `INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')
     ON CONFLICT DO NOTHING`, [tenantId]);
  burgerId = randomUUID(); sodaId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id,tenant_id,key,name,kind,tax_class_id,station_code,price_minor)
     VALUES ($1,$2,'burger','Burger','single',$3,'grill',10000),
            ($4,$2,'soda','Soda','single',$5,'grill',5000)`,
    [burgerId, tenantId, taxClassId, sodaId, bevClassId]);

  refundReasonId = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
     VALUES ($1,$2,'spoiled','Dish sent back')`, [refundReasonId, tenantId]);
  await owner.query(
    `INSERT INTO app.adjustment_reason_kind (tenant_id,reason_id,kind)
     VALUES ($1,$2,'refund')`, [tenantId, refundReasonId]);

  await setStateCode('29');
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

/* ------------------------------------------------------------------ A --- */

describe('A. the head is derived from the supply, and the database agrees', () => {
  it('writes CGST and SGST that SUM to the line tax, at half the rate each', async () => {
    const bill = await billFor([{ itemId: burgerId, amountMinor: 30000, rateBps: 500 }]);
    const { treatment, lines } = await headsOf(bill.billId);

    expect(treatment).toBe('intra_state');
    expect(bill.taxMinor).toBe(1500);
    expect(lines[0]!.heads).toEqual([
      { name: 'CGST', rate_bps: 250, amount_minor: 750 },
      { name: 'SGST', rate_bps: 250, amount_minor: 750 },
    ]);
  });

  it('sends the odd paisa to CGST, so the two still sum to what was charged', async () => {
    // 333 at 5% is 16.65 paisa, rounded to 17. Halved that is 8.5, and there is
    // no half paisa: 9 to CGST, 8 to SGST. The alternative -- rounding each
    // half independently -- gives 9 and 9, and the bill then collects 18 paisa
    // under two heads while its own tax column says 17. Every reconciliation a
    // return is built on compares those two numbers.
    const bill = await billFor([{ itemId: burgerId, amountMinor: 333, rateBps: 500 }]);
    const { lines } = await headsOf(bill.billId);
    expect(bill.taxMinor).toBe(17);
    expect(lines[0]!.heads).toEqual([
      { name: 'CGST', rate_bps: 250, amount_minor: 9 },
      { name: 'SGST', rate_bps: 250, amount_minor: 8 },
    ]);
  });

  it('carries NO head on a zero-rated line beside a taxed one', async () => {
    // An exempt dish next to a taxable one is ordinary. A head of zero would
    // print a line of tax on a bill that has none of it.
    const bill = await billFor([
      { itemId: burgerId, amountMinor: 20000, rateBps: 500 },
      { itemId: sodaId, amountMinor: 10000, rateBps: 0 },
    ]);
    const { lines } = await headsOf(bill.billId);
    expect(bill.taxMinor).toBe(1000);
    expect(lines[0]!.heads).toEqual([
      { name: 'CGST', rate_bps: 250, amount_minor: 500 },
      { name: 'SGST', rate_bps: 250, amount_minor: 500 },
    ]);
    expect(lines[1]!.heads).toEqual([]);
  });

  it('writes an ARRAY and never a jsonb null scalar, however empty', async () => {
    // ###################################################################
    // THE REGRESSION THAT BROKE THE STATUTORY REPORT ON REAL DATA.
    //
    // `generateBill` wrote `JSON.stringify(line.tax_components ?? null)`. For a
    // line whose order line had no components that is the STRING "null", stored
    // as a jsonb null SCALAR -- not SQL NULL, and not an empty array. 975 live
    // rows.
    //
    // `COALESCE(x, '[]'::jsonb)` does not convert one into the other, so
    // `jsonb_array_elements` raised "cannot extract elements from a scalar" and
    // GET /admin/reports/tax/outward-supply answered 500 for any branch that
    // had ever raised a bill through the product.
    // ###################################################################
    const bill = await billFor([{ itemId: sodaId, amountMinor: 10000, rateBps: 0 }]);
    const types = (await owner.query<{ t: string | null }>(
      `SELECT jsonb_typeof(tax_components) AS t FROM app.bill_line WHERE bill_id=$1`,
      [bill.billId])).rows.map((r) => r.t);
    expect(types).toEqual(['array']);
    expect(types).not.toContain('null');
  });

  it('refuses at COMMIT a line whose heads contradict the bill treatment', async () => {
    // The synthetic violation. `bill_line_heads_match_treatment` is DEFERRABLE
    // INITIALLY DEFERRED, so this has to reach COMMIT to be refused -- and
    // reaching COMMIT is exactly what a nightly check would not have done: the
    // paper would already be with the customer.
    const bill = await billFor([{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }]);
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE app.bill_line
          SET tax_components = '[{"name":"IGST","rate_bps":500,"amount_minor":1000}]'::jsonb
        WHERE bill_id=$1`, [bill.billId]);
    await expect(owner.query('COMMIT'))
      .rejects.toThrow(/bill_line_heads_match_treatment/);
    await owner.query('ROLLBACK').catch(() => undefined);
  });

  it('refuses heads that do not sum to the line tax, which is the silent one', async () => {
    const bill = await billFor([{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }]);
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE app.bill_line
          SET tax_components = '[{"name":"CGST","rate_bps":250,"amount_minor":500},
                                 {"name":"SGST","rate_bps":250,"amount_minor":499}]'::jsonb
        WHERE bill_id=$1`, [bill.billId]);
    await expect(owner.query('COMMIT'))
      .rejects.toThrow(/heads sum to 999/);
    await owner.query('ROLLBACK').catch(() => undefined);
  });

  it('is not vacuous: a jsonb null scalar cannot defeat the assertion', async () => {
    // The trigger normalises a scalar to `[]` before asserting, so writing the
    // shape that used to slip through is now caught as "no heads for a taxed
    // line" rather than skipped.
    const bill = await billFor([{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }]);
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE app.bill_line SET tax_components = 'null'::jsonb WHERE bill_id=$1`,
      [bill.billId]);
    await expect(owner.query('COMMIT'))
      .rejects.toThrow(/bill_line_heads_match_treatment/);
    await owner.query('ROLLBACK').catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ B --- */

describe('B. the treatment records what is known, and refuses to guess', () => {
  it('says `none` when no tax was charged, whatever the branch', () => {
    expect(resolveIndianSupply({
      supplierStateCode: '29', placeOfSupplyStateCode: '29', taxChargedMinor: 0,
    }).treatment).toBe('none');
  });

  it('says `unstated` when tax was charged and no state was ever recorded', () => {
    // NOT `intra_state`. The obvious guess is the wrong one for the reason
    // migration 0037 sets out in capitals: credit claimed under the wrong head
    // is disallowed, so the amount would be right and the document worthless.
    expect(resolveIndianSupply({
      supplierStateCode: null, placeOfSupplyStateCode: null, taxChargedMinor: 100,
    }).treatment).toBe('unstated');
  });

  it('says `inter_state` the moment the place of supply differs', () => {
    expect(resolveIndianSupply({
      supplierStateCode: '29', placeOfSupplyStateCode: '27', taxChargedMinor: 100,
    }).treatment).toBe('inter_state');
    expect(headsForLine('IN', 'inter_state', 20000, 500))
      .toEqual([{ name: 'IGST', rate_bps: 500, amount_minor: 1000 }]);
  });

  it('keeps the place of supply on an untaxed bill rather than blanking it', () => {
    // Where a branch trades is a fact about the place, and the place of supply
    // is that state whether or not tax is charged on it -- the same reasoning
    // that keeps the state code when a branch DEREGISTERS.
    expect(resolveIndianSupply({
      supplierStateCode: '29', placeOfSupplyStateCode: '29', taxChargedMinor: 0,
    }).placeOfSupplyStateCode).toBe('29');
  });

  it('stamps `unstated` on a real bill at a branch with no state code', async () => {
    await setStateCode(null);
    try {
      const bill = await billFor(
        [{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }], UNSTATED_DATE);
      const { treatment, lines } = await headsOf(bill.billId);
      expect(treatment).toBe('unstated');
      expect(bill.taxMinor).toBe(1000);
      // No head, because none is known. The trigger skips these deliberately:
      // asserting anything about them would be inventing the missing fact.
      expect(lines[0]!.heads).toEqual([]);
    } finally { await setStateCode('29'); }
  });

  it('refuses to file a period containing one, and names the money', async () => {
    await setStateCode(null);
    try {
      await billFor(
        [{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }], UNSTATED_DATE);
    } finally { await setStateCode('29'); }

    await expect(tx((c) => outwardSupplyReturn(c, {
      branchId, fromDate: UNSTATED_DATE, toDate: UNSTATED_DATE,
    }))).rejects.toThrow(GstPeriodHasUnstatedTreatmentError);
  });

  it('refuses to file INDIA\'S return for a bill raised under another regime', async () => {
    // ###################################################################
    // THE DANGEROUS OUTCOME HERE IS A SUCCESS, NOT AN ERROR.
    //
    // Everything in gstReturn.ts is the Indian statutory return: GSTR-1's B2B
    // and B2C tables, CGST/SGST/IGST, place of supply as a state code. Run
    // against a bill raised under another regime, every query still executes,
    // nothing matches `tax_treatment = 'intra_state'`, and the caller is handed
    // a clean NIL RETURN for a regime the restaurant is not in. Nothing raises.
    //
    // Read off the BILL and not off the tenant, which is why this test can
    // exist at all: a synthetic foreign bill is enough, and no live
    // configuration read had to be smuggled into the reporting layer to make
    // the guard work. `tests/reporting/snapshotOnly.test.ts` refused the first
    // version, which read the tenant's current jurisdiction.
    // ###################################################################
    const FOREIGN_DATE = '2026-08-04';
    // A REAL bill with real tax and real heads, then RESTAMPED to another
    // jurisdiction. A zero-amount bill would prove the mechanism and not the
    // danger: what has to be shown is that money exists in the period and the
    // Indian return still comes out empty, which is the nil return this
    // refusal exists to prevent.
    const bill = await billFor(
      [{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }], FOREIGN_DATE);
    await owner.query(
      `INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
       VALUES ('ZQ','Testland','declared','999') ON CONFLICT (code) DO NOTHING`);
    // `declared` is the honest status -- nobody has written Testland's rules,
    // which is exactly the tenant this guard protects. Restamping is possible
    // only because no tender exists: `deny_tendered_bill_mutation` freezes the
    // jurisdiction along with the rest of the tax identity at the first tender.
    await owner.query(
      `UPDATE app.bill SET tax_jurisdiction='ZQ' WHERE tenant_id=$1 AND id=$2`,
      [tenantId, bill.billId]);

    try {
      // Proof that the danger is real: without the guard this period reports
      // nothing, because no line matches an Indian treatment bucket.
      expect(bill.taxMinor).toBe(1000);

      await expect(tx((c) => outwardSupplyReturn(c, {
        branchId, fromDate: FOREIGN_DATE, toDate: FOREIGN_DATE,
      }))).rejects.toThrow(/Testland|ZQ/);
      // And it says WHY, because whoever reads it is deciding whether to file.
      await expect(tx((c) => outwardSupplyReturn(c, {
        branchId, fromDate: FOREIGN_DATE, toDate: FOREIGN_DATE,
      }))).rejects.toThrow(/nil return/);

      // WORTH RECORDING: `bill_tax_treatment_consistent` still names India's
      // four treatments as literals, which is why this bill keeps an Indian
      // treatment while carrying a foreign jurisdiction. It is the last
      // India-shaped constraint on this table, and widening it means turning a
      // CHECK into a trigger that reads platform.tax_treatment. Deferred
      // deliberately: no second jurisdiction has treatments yet, so widening it
      // now would be guessing at their names. The refusal above does not depend
      // on it -- it reads the jurisdiction alone.
    } finally {
      // Restamped back rather than deleted: a leftover ZQ bill would refuse
      // every later return whose period includes this date, and a leftover ZQ
      // jurisdiction row would fail the catalogue gate in
      // tests/tax/jurisdiction.test.ts, which asserts the seeded rows against
      // the constant in BOTH directions.
      await owner.query(
        `UPDATE app.bill SET tax_jurisdiction='IN' WHERE tenant_id=$1 AND id=$2`,
        [tenantId, bill.billId]);
      await owner.query(`DELETE FROM platform.tax_jurisdiction WHERE code='ZQ'`);
    }
  });
});

/* ------------------------------------------------------------------ C --- */

describe('C. the two planes split a rate identically, and are asserted to', () => {
  it('agrees with the control plane on every rate either can carry', () => {
    // ###################################################################
    // TWO COPIES, ONE ASSERTION.
    //
    // `src/modules/billing/placeOfSupply.ts` splits OUR rate when WE invoice a tenant;
    // this module splits THEIRS when they bill a diner. `gstReturn.ts` states
    // the argument for keeping them apart: different supplier registrations,
    // different recipients, different tables, and a change made for one must
    // not silently alter the other's filed returns.
    //
    // The ARITHMETIC is nonetheless the same arithmetic, and two copies of it
    // are two things that can drift. So the drift fails a test instead of
    // appearing in one plane's returns and not the other's.
    // ###################################################################
    const rates = [0, 100, 250, 500, 1200, 1800, 2800, 10000];
    const amounts = [1, 7, 99, 333, 1000, 12345, 999999];
    for (const rateBps of rates) {
      for (const taxableMinor of amounts) {
        for (const treatment of ['intra_state', 'inter_state'] as const) {
          const mine = headsForLine('IN', treatment, taxableMinor, rateBps);
          const theirs = componentsForLine(treatment, taxableMinor, rateBps);
          // Theirs always emits a component, even at zero; ours omits it,
          // because a zero head printed on a bill is a line of tax that is not
          // there. Compared where both speak.
          if (taxOnLine(taxableMinor, rateBps) === 0) {
            expect(mine, `${treatment} ${taxableMinor}@${rateBps}`).toEqual([]);
            continue;
          }
          expect(
            mine.map((h) => ({ name: h.name, rateBps: h.rate_bps, amountMinor: h.amount_minor })),
            `${treatment} ${taxableMinor}@${rateBps}`,
          ).toEqual(theirs.map((c) => ({
            name: c.name, rateBps: c.rateBps, amountMinor: c.amountMinor,
          })));
        }
      }
    }
  });

  it('SPLITS an odd rate now, where it used to refuse one', () => {
    // ###################################################################
    // THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACED.
    //
    // It used to read: `headsForLine('intra_state', 10000, 501)` throws
    // TaxRateDoesNotHalveError, and `tax_class_rate_halves` refuses 501 on the
    // way in. Both were correct for India and wrong for the product the owner
    // is shipping -- California's combined rate is 7.25%, which is 725 basis
    // points, odd, lawful, and refused outright by the old CHECK.
    //
    // A head is now a SHARE of the rate, allocated by largest remainder. So an
    // odd rate splits: 725 halves to 363 and 362 in the printed rate, and the
    // AMOUNTS -- which are what must sum -- sum exactly.
    // ###################################################################
    const odd = headsForLine('IN', 'intra_state', 10000, 501);
    expect(odd.map((h) => h.name)).toEqual(['CGST', 'SGST']);
    expect(odd.reduce((a, h) => a + h.amount_minor, 0)).toBe(taxOnLine(10000, 501));

    // And at a genuinely uneven share count -- three heads at 7.25%, the shape
    // that motivated deleting the constraint. Asserted through splitHeads with
    // India's own two heads, because a second jurisdiction's catalogue does not
    // exist yet; what is asserted is the ARITHMETIC being share-based rather
    // than a halving.
    const us = splitHeads('IN', 'intra_state', 725, 725);
    expect(us.reduce((a, h) => a + h.amount_minor, 0)).toBe(725);

    expect(splitHeads('IN', 'inter_state', 501, 501))
      .toEqual([{ name: 'IGST', rate_bps: 501, amount_minor: 501 }]);
  });

  it('ACCEPTS an odd rate at the tax class, where the CHECK used to refuse it', async () => {
    // The inverse of the previous gate, and deliberately kept as a test rather
    // than deleted: a re-added `tax_class_rate_halves` would silently take
    // 7.25% away again, and this is the assertion that would notice.
    // ROLLED BACK, deliberately. A 7.25% row left in the install is permanent:
    // 0052's DOWN migration refuses to re-add `tax_class_rate_halves` while a
    // rate that violates it exists, so a leftover fixture row would quietly
    // change what the migration can do for everyone afterwards. A test may
    // prove the write is accepted; it may not decide that.
    const id = randomUUID();
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO app.tax_class (id,tenant_id,key,name,rate_bps)
         VALUES ($1,$2,$3,'Combined 7.25%',725)`,
        [id, tenantId, `odd_rate_${id.slice(0, 8)}`]);
      const back = await owner.query<{ rate_bps: number }>(
        `SELECT rate_bps FROM app.tax_class WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      expect(back.rows[0]!.rate_bps).toBe(725);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('still refuses an odd rate on the CONTROL plane, and that is not drift', () => {
    // ###################################################################
    // THE TWO PLANES NOW DIVERGE FOR ODD RATES. DELIBERATELY.
    //
    // `componentsForLine` splits OUR rate when WE invoice a tenant. We are
    // registered in India and invoice in rupees under Indian GST, so our own
    // rate is always even and the halving is exactly right there. Widening it
    // would be adding a jurisdiction seam to a plane that has one jurisdiction.
    //
    // The sweep above asserts the two agree on every rate EITHER can carry,
    // which is the even ones. This asserts the divergence is the deliberate
    // one and not something that rotted: the control plane refuses, by name.
    // ###################################################################
    expect(() => componentsForLine('intra_state', 10000, 501)).toThrow();
  });
});

/* ------------------------------------------------------------------ D --- */

describe('D. a refund reverses tax, and says how much', () => {
  it('divides BACK out of a tax-inclusive amount, not on top of it', () => {
    // 1050 handed back on a 5% bill is 1000 of value and 50 of tax. Computing
    // it as amount x rate / 10000 gives 52.5 -- the tax on the tax -- which
    // over-reverses every refund by a quarter of a percent and reads exactly
    // like rounding.
    const snap = refundTaxSnapshot({
      billSubtotalMinor: 20000, billTaxMinor: 1000,
      billTotalMinor: 21000, rates: [500], amountMinor: 1050,
    });
    expect(snap.taxableMinor).toBe(1000);
    expect(snap.taxMinor).toBe(50);
    expect(snap.taxableMinor + snap.taxMinor).toBe(1050);
  });

  it('reverses the document itself on a full refund', () => {
    const snap = refundTaxSnapshot({
      billSubtotalMinor: 20000, billTaxMinor: 1000,
      billTotalMinor: 21000, rates: [500], amountMinor: 21000,
    });
    expect(snap).toMatchObject({
      taxableMinor: 20000, taxMinor: 1000, rateBps: 500, reverseBillHeads: true,
    });
  });

  it('refuses a PART refund of a bill carrying two rates, naming them', () => {
    // The refund records an amount, not which lines came back, so how much tax
    // it reverses is genuinely unknown. Apportioning pro-rata is a convention
    // that decides how much output tax is reclaimed -- same posture as
    // MixedCurrencyPeriodError.
    expect(() => refundTaxSnapshot({
      billSubtotalMinor: 30000, billTaxMinor: 1600,
      billTotalMinor: 31600, rates: [500, 1800], amountMinor: 5000,
    })).toThrow(RefundSpansTaxRatesError);
    expect(() => refundTaxSnapshot({
      billSubtotalMinor: 30000, billTaxMinor: 1600,
      billTotalMinor: 31600, rates: [500, 1800], amountMinor: 5000,
    })).toThrow(/5%, 18%/);
  });

  it('allows the FULL refund of that same mixed-rate bill', () => {
    // Unambiguous: everything came back, so everything reverses. `rateBps` is
    // null because there is no single rate, which is why 0050 widened
    // `refund_tax_snapshot_complete` to accept a stated head set instead.
    const snap = refundTaxSnapshot({
      billSubtotalMinor: 30000, billTaxMinor: 1600,
      billTotalMinor: 31600, rates: [500, 1800], amountMinor: 31600,
    });
    expect(snap.rateBps).toBeNull();
    expect(snap.reverseBillHeads).toBe(true);
  });

  it('writes the snapshot on a real refund, which nothing used to do', async () => {
    // ###################################################################
    // 0039 ADDED FOUR COLUMNS HERE AND NO WRITE PATH FILLED THEM.
    //
    // 101 refunds existed in the dev install and 47 carried a snapshot -- all
    // 47 written by test fixtures. So every credit note in the outward-supply
    // return reported zero tax reversed, which leaves the output tax standing
    // on a supply the restaurant refunded.
    // ###################################################################
    const bill = await billFor([{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }]);
    await tx((c) => recordTender(c, {
      billId: bill.billId, method: 'cash',
      amountMinor: bill.totalMinor, tenderedByUserId: userId,
    }));
    await tx((c) => recordRefund(c, {
      billId: bill.billId, branchId, amountMinor: 1050, method: 'cash',
      reasonId: refundReasonId, refundedByUserId: userId,
    }));

    const row = (await owner.query<{
      taxable_minor: string | null; tax_minor: string | null;
      tax_rate_bps: number | null; tax_components: unknown;
    }>(
      `SELECT taxable_minor::text, tax_minor::text, tax_rate_bps, tax_components
         FROM app.refund WHERE bill_id=$1`, [bill.billId])).rows[0]!;
    expect(row.taxable_minor).toBe('1000');
    expect(row.tax_minor).toBe('50');
    expect(row.tax_rate_bps).toBe(500);
    expect(row.tax_components).toEqual([
      { name: 'CGST', rate_bps: 250, amount_minor: 25 },
      { name: 'SGST', rate_bps: 250, amount_minor: 25 },
    ]);
  });
});

/* ------------------------------------------------------------------ E --- */

describe('E. the return files what the paper says', () => {
  it('reconciles, and its printed heads match the derived ones', async () => {
    const bill = await billFor([{ itemId: burgerId, amountMinor: 40000, rateBps: 500 }]);
    const check = await tx((c) => reconcileReturnToBills(c, {
      branchId, fromDate: DATE, toDate: DATE,
    }));

    expect(check.matches, 'a return that does not reconcile must not be filed').toBe(true);
    // ###################################################################
    // THE ONE INDEPENDENT ASSERTION LEFT.
    //
    // Since the heads are derived from tax_treatment and tax_minor,
    // cgst + sgst = tax_minor holds by arithmetic and `matches` can no longer
    // disagree about the total. What it CAN still catch is the paper: whether
    // the figures being filed are the ones the customer was handed. The
    // components were written at bill time by `splitHeads`; these buckets are
    // computed now.
    // ###################################################################
    expect(check.printedHeadsMinor).toBe(check.returnTaxMinor);
    expect(check.printedHeadsMatch).toBe(true);
    expect(bill.taxMinor).toBeGreaterThan(0);
  });

  it('buckets by TREATMENT and place of supply, because a period may hold both', async () => {
    const ret = await tx((c) => outwardSupplyReturn(c, {
      branchId, fromDate: DATE, toDate: DATE,
    }));
    const treatments = new Set(ret.b2c.map((b) => b.treatment));
    expect(treatments.has('intra_state')).toBe(true);
    for (const bucket of ret.b2c) {
      if (bucket.treatment === 'intra_state') {
        expect(bucket.placeOfSupplyStateCode).toBe('29');
        // Never IGST on an intra-state bucket, whatever the rate.
        expect(bucket.igstMinor).toBe(0);
        if (bucket.rateBps > 0) {
          expect(bucket.cgstMinor + bucket.sgstMinor).toBeGreaterThan(0);
        } else {
          // A NIL-RATED bucket on a taxable bill, and it belongs in the return:
          // an exempt dish is a supply with a value and no tax, which GSTR-1
          // reports as such. Zero heads here is the figure, not a gap.
          expect(bucket.cgstMinor + bucket.sgstMinor).toBe(0);
          expect(bucket.taxableMinor).toBeGreaterThan(0);
        }
      }
    }
  });

  it('survives a bill line holding the old jsonb null scalar', async () => {
    // ###################################################################
    // THE 500 THAT WAS THE REAL DEFECT, ASSERTED AS FIXED.
    //
    // 975 live rows hold a jsonb `null` scalar. The report's own query, run
    // verbatim against a real branch, raised "cannot extract elements from a
    // scalar". Every reader normalises with `jsonb_typeof(...) = 'array'` now,
    // and those rows will be there until they age out of every open period.
    //
    // Written with the trigger disabled, because the trigger correctly refuses
    // this shape -- the point is that the READER survives history it cannot
    // refuse retroactively.
    // ###################################################################
    const SCALAR_DATE = '2026-08-03';
    const bill = await billFor(
      [{ itemId: burgerId, amountMinor: 20000, rateBps: 500 }], SCALAR_DATE);
    await owner.query(`ALTER TABLE app.bill_line DISABLE TRIGGER bill_line_heads_match_treatment`);
    try {
      await owner.query(
        `UPDATE app.bill_line SET tax_components='null'::jsonb WHERE bill_id=$1`,
        [bill.billId]);
      const ret = await tx((c) => outwardSupplyReturn(c, {
        branchId, fromDate: SCALAR_DATE, toDate: SCALAR_DATE,
      }));
      // It returns rather than raising, and the derived heads are unaffected --
      // they come from the treatment, not from the jsonb.
      expect(ret.totals.cgstMinor + ret.totals.sgstMinor).toBeGreaterThan(0);
      // And the printed-heads check now DISAGREES, which is the honest report
      // of a document that says nothing about its own heads.
      const check = await tx((c) => reconcileReturnToBills(c, {
        branchId, fromDate: SCALAR_DATE, toDate: SCALAR_DATE,
      }));
      expect(check.matches).toBe(true);
      expect(check.printedHeadsMatch).toBe(false);
    } finally {
      await owner.query(
        `ALTER TABLE app.bill_line ENABLE TRIGGER bill_line_heads_match_treatment`);
      // One transaction. `bill_invariants` is deferred and per row, so deleting
      // the lines in their own statement leaves a bill whose lines sum to zero
      // and whose figures do not -- which it correctly refuses.
      await owner.query('BEGIN');
      await owner.query(`DELETE FROM app.bill_line WHERE bill_id=$1`, [bill.billId]);
      await owner.query(`DELETE FROM app.bill WHERE id=$1`, [bill.billId]);
      await owner.query('COMMIT');
    }
  });
});

/* ------------------------------------------------------------------ F --- */

describe('F. the composition dealer, who is registered and may not collect', () => {
  const COMP_DATE = '2026-08-20';
  const GSTIN = '29AABCU9603R1ZM';

  const setPosition = async (
    position: string, gstin: string | null,
  ): Promise<void> => {
    await owner.query(
      `UPDATE app.branch SET gst_registration=$2, gstin=$3 WHERE id=$1`,
      [branchId, position, gstin]);
  };

  afterEach(async () => { await setPosition('unstated', null); });

  it('charges the diner nothing, while HOLDING a GSTIN', async () => {
    // ###################################################################
    // THE ASSERTION THE WHOLE POSITION EXISTS FOR.
    //
    // A composition taxable person pays 5% of turnover to the government out of
    // its own pocket and is FORBIDDEN to collect a paisa from a customer. It
    // holds a GSTIN, which is exactly why the old three-value vocabulary got it
    // wrong: `branch_registered_iff_gstin` forced such a shop to answer
    // `registered`, the menu tax class went onto every line, and it collected
    // GST it may not collect.
    // ###################################################################
    await setPosition('composition', GSTIN);
    // rateBps 0, because that is what `resolveOrderableItem` produces at such a
    // branch -- and `order_line_tax_requires_registration` refuses anything
    // else, which is the backstop asserted two cases below. The SUPPRESSION
    // itself is asserted in tests/ops/orderEntry.test.ts against the real
    // addLine; what this case is about is what the BILL then says.
    const bill = await billFor(
      [{ itemId: burgerId, amountMinor: 30000, rateBps: 0 }], COMP_DATE);

    expect(bill.taxMinor).toBe(0);
    // The PRICE is untouched. Suppressing on unit_price_minor instead would be a
    // discount nobody authorised -- the same argument as the unregistered
    // branch.
    expect(bill.subtotalMinor).toBe(30000);
    expect(bill.totalMinor).toBe(30000);

    const { treatment, lines } = await headsOf(bill.billId);
    expect(treatment).toBe('none');
    expect(lines[0]!.heads).toEqual([]);

    const stamped = (await owner.query<{
      supplier_gst_registration: string; supplier_gstin: string | null;
    }>(
      `SELECT supplier_gst_registration, supplier_gstin FROM app.bill WHERE id=$1`,
      [bill.billId])).rows[0]!;
    // BOTH facts on the document: the position AND the number. A bill of supply
    // shows the GSTIN even though no tax is collected on it, and the pair is
    // what proves the paper was lawful rather than a misconfiguration.
    expect(stamped.supplier_gst_registration).toBe('composition');
    expect(stamped.supplier_gstin).toBe(GSTIN);
  });

  it('is not vacuous: the same branch and dish DOES charge tax when registered',
    async () => {
      // Without this, the test above passes for a fixture that simply never had
      // a rate -- which is how a suppression test proves nothing.
      await setPosition('registered', GSTIN);
      const bill = await billFor(
        [{ itemId: burgerId, amountMinor: 30000, rateBps: 500 }], COMP_DATE);
      expect(bill.taxMinor).toBe(1500);
      expect((await headsOf(bill.billId)).treatment).toBe('intra_state');
    });

  it('cannot hold the position without a number, in either direction', async () => {
    await expect(setPosition('composition', null))
      .rejects.toThrow(/branch_gstin_iff_position_holds_one/);
    await expect(setPosition('unregistered', GSTIN))
      .rejects.toThrow(/branch_gstin_iff_position_holds_one/);
  });

  it('refuses a taxed line at the database, naming the position', async () => {
    // 0048's trigger said "is not GST-registered", which about a composition
    // branch is simply false -- it is registered. The refusal has to name what
    // is actually true or the person reading it goes looking for a GSTIN that
    // is already there.
    await setPosition('composition', GSTIN);
    const sessionId = randomUUID();
    const orderId = randomUUID();
    await owner.query(
      `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
       VALUES ($1,$2,$3,$4,$5)`, [sessionId, tenantId, branchId, COMP_DATE, userId]);
    await owner.query(
      `INSERT INTO app.sales_order
         (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, tenantId, branchId, sessionId, COMP_DATE, userId]);

    await expect(owner.query(
      `INSERT INTO app.order_line
         (id,tenant_id,branch_id,order_id,kind,display_name,unit_price_minor,
          quantity,line_total_minor,tax_rate_bps,created_by_user_id)
       VALUES (gen_random_uuid(),$1,$2,$3,'item','Smuggled',6000,1,6000,500,$4)`,
      [tenantId, branchId, orderId, userId]))
      .rejects.toThrow(/is a composition taxable person and may not collect tax/);
  });

  it('refuses to produce an outward-supply return for the period', async () => {
    // ###################################################################
    // THE WRONG FORM, FILLED IN CORRECTLY.
    //
    // A composition period's buckets all come out at zero, so this report would
    // produce something that reads as a lawful nil GSTR-1. It is not a nil
    // return -- a composition taxable person does not file GSTR-1 at all. It
    // declares turnover on CMP-08 quarterly and GSTR-4 annually.
    // ###################################################################
    await setPosition('composition', GSTIN);
    await billFor([{ itemId: burgerId, amountMinor: 30000, rateBps: 0 }], COMP_DATE);

    await expect(tx((c) => outwardSupplyReturn(c, {
      branchId, fromDate: COMP_DATE, toDate: COMP_DATE,
    }))).rejects.toThrow(GstReturnNotApplicableError);
    await expect(tx((c) => outwardSupplyReturn(c, {
      branchId, fromDate: COMP_DATE, toDate: COMP_DATE,
    }))).rejects.toThrow(/CMP-08/);
  });

  it('reads the period from the DOCUMENTS, not from what the branch is today',
    async () => {
      // A shop that left the scheme in April must still not be handed a GSTR-1
      // for March. The refusal reads `bill.supplier_gst_registration`, which is
      // a snapshot; asking the branch would answer a question about last
      // quarter with this quarter's facts.
      await setPosition('composition', GSTIN);
      await billFor([{ itemId: burgerId, amountMinor: 10000, rateBps: 0 }], COMP_DATE);
      await setPosition('registered', GSTIN);

      await expect(tx((c) => outwardSupplyReturn(c, {
        branchId, fromDate: COMP_DATE, toDate: COMP_DATE,
      }))).rejects.toThrow(GstReturnNotApplicableError);
    });
});
