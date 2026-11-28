import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/database/unitOfWork.js';
import type { TenantContext } from '../../src/database/tenantContext.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import {
  addLine, editLine, removeLine,
  LineAlreadyFiredError, MenuItemNotOrderableError, ModifierNotPermittedError,
  GuestNoOutOfRangeError,
} from '../../src/modules/orders/orderEntry.js';
import { UnassignedGuestLinesError } from '../../src/modules/payments/billing.js';
import { generateBill } from '../helpers/billing.js';
import {
  voidLine, compLine, discountLine,
  DiscountExceedsAuthorityError, AdjustmentExceedsOriginalError, LineNotFiredError,
} from '../../src/modules/orders/adjustments.js';
import { openSession, closeSession, TableOccupiedError } from '../../src/modules/orders/session.js';
import {
  dayBit, resolveAvailability, resolveAvailabilityForBranch,
} from '../../src/modules/products/availability.js';

/**
 * The priced-document rule, run against the database rather than argued.
 *
 * Every prior instance of a wrong belief in this project was found by RUNNING
 * the thing: the reconciliation job that never set the GUC, the print verifier
 * that read a tenant table unscoped, the KDS probe built from a mental model.
 * This suite exists to make the order-entry path one that was run.
 */

let owner: pg.Client;
let pool: pg.Pool;
let tenantId: string;
let branchId: string;
let userId: string;
let floorId: string;
let taxClassId: string;
let dosaId: string;
let comboId: string;
let idliId: string;
let coffeeId: string;
let extraGheeId: string;
let foreignOptionId: string;
let voidReasonId: string;
let compReasonId: string;
let discountReasonId: string;

const FULL_AUTHORITY = { discountPercentCap: 100, discountAmountCap: null };

function tx<T>(fn: (c: TenantContext) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, tenantId, fn);
}

async function newTable(): Promise<string> {
  const tableId = randomUUID();
  await owner.query(
    `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
     VALUES ($1,$2,$3,$4,$5,4)`,
    [tableId, tenantId, branchId, floorId, tableId.slice(0, 6)],
  );
  return tableId;
}

async function openOrder(
  guestCount?: number,
): Promise<{ sessionId: string; orderId: string }> {
  const tableId = await newTable();
  return tx(async (c) => {
    const s = await openSession(c, {
      branchId, diningTableIds: [tableId],
      ...(guestCount === undefined ? {} : { guestCount }),
    }, userId);
    return { sessionId: s.sessionId, orderId: s.orderId };
  });
}

/** Post-fire is the gate for every adjustment, so tests must cross it. */
async function fireLines(orderId: string): Promise<void> {
  await owner.query(
    `UPDATE app.order_line SET fired_at = now() WHERE tenant_id=$1 AND order_id=$2`,
    [tenantId, orderId],
  );
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 10 });

  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `oe+${superAdminId}@platform.test`, roleId]);
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1,'oe_plan','OE')
     ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='oe_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id, plan_id, version, price_minor, currency,
       billing_period, published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now())
     ON CONFLICT (plan_id, version) DO NOTHING`, [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `oe-${randomUUID()}`;
    const result = await provisionTenant(client, {
      idempotencyKey: key, slug: `e${key.slice(3, 11)}`, name: 'Order Entry Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = result.tenantId;
    branchId = result.firstBranchId;
    userId = result.ownerUserId;
  } finally {
    client.release();
  }
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);

  floorId = randomUUID();
  await owner.query(
    `INSERT INTO app.floor (id, tenant_id, branch_id, name) VALUES ($1,$2,$3,'Ground')`,
    [floorId, tenantId, branchId]);

  await owner.query(
    `INSERT INTO app.station_code (tenant_id, code, name)
     VALUES ($1,'grill','Grill'), ($1,'cold','Cold')`, [tenantId]);

  taxClassId = randomUUID();
  const bevTaxId = randomUUID();
  await owner.query(
    `INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps)
     VALUES ($1,$3,'food_5','Food 5%',500), ($2,$3,'bev_12','Beverage 12%',1200)`,
    [taxClassId, bevTaxId, tenantId]);
  // No tax_component rows, and no table to put them in: migration 0050 dropped
  // it. The class carries the RATE; the CGST/SGST split is derived per bill from
  // the place of supply by src/modules/tax/taxHeads.ts.

  dosaId = randomUUID(); idliId = randomUUID(); coffeeId = randomUUID(); comboId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, station_code, price_minor)
     VALUES ($1,$5,'dosa','Masala Dosa','single',$6,'grill',12000),
            ($2,$5,'idli','Idli','single',$6,'grill',8000),
            ($3,$5,'coffee','Filter Coffee','single',$7,'cold',5000),
            -- A combo carries NO station_code: routing is a property of the
            -- resolved component, and one combo can produce two KOT entries.
            ($4,$5,'tiffin','Tiffin Combo','combo',$6,NULL,15000)`,
    [dosaId, idliId, coffeeId, comboId, tenantId, taxClassId, bevTaxId]);

  await owner.query(
    `INSERT INTO app.combo_component
       (id, tenant_id, combo_item_id, combo_kind, kind, component_item_id, component_kind,
        quantity, display_order)
     VALUES ($1,$3,$4,'combo','fixed',$5,'single',1,1),
            ($2,$3,$4,'combo','fixed',$6,'single',1,2)`,
    [randomUUID(), randomUUID(), tenantId, comboId, idliId, coffeeId]);

  const groupId = randomUUID();
  const foreignGroupId = randomUUID();
  extraGheeId = randomUUID();
  foreignOptionId = randomUUID();
  await owner.query(
    `INSERT INTO app.modifier_group (id, tenant_id, key, name, min_select, max_select)
     VALUES ($1,$3,'extras','Extras',0,1), ($2,$3,'foreign','Foreign',0,1)`,
    [groupId, foreignGroupId, tenantId]);
  await owner.query(
    `INSERT INTO app.modifier_option
       (id, tenant_id, modifier_group_id, key, name, price_delta_minor, station_code)
     VALUES ($1,$3,$4,'extra_ghee','Extra ghee',3000,'grill'),
            ($2,$3,$5,'not_yours','Not yours',-9900,'grill')`,
    [extraGheeId, foreignOptionId, tenantId, groupId, foreignGroupId]);
  await owner.query(
    `INSERT INTO app.menu_item_modifier_group
       (tenant_id, menu_item_id, modifier_group_id, display_order)
     VALUES ($1,$2,$3,1)`, [tenantId, dosaId, groupId]);

  voidReasonId = randomUUID(); compReasonId = randomUUID(); discountReasonId = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id, tenant_id, key, name) VALUES
       ($1,$4,'burnt','Burnt'), ($2,$4,'goodwill','Goodwill'), ($3,$4,'loyalty','Loyalty')`,
    [voidReasonId, compReasonId, discountReasonId, tenantId]);
  await owner.query(
    `INSERT INTO app.adjustment_reason_kind (tenant_id, reason_id, kind) VALUES
       ($1,$2,'void'), ($1,$3,'comp'), ($1,$4,'discount')`,
    [tenantId, voidReasonId, compReasonId, discountReasonId]);
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

describe('the priced document', () => {
  it('snapshots price, name, tax class and RATE onto the line -- not a head', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 2 }, userId));

    const row = (await owner.query<Record<string, unknown>>(
      `SELECT display_name, unit_price_minor::text, quantity, line_total_minor::text,
              tax_class_key, tax_rate_bps, modifiers, menu_item_id
         FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, line.lineId])).rows[0]!;

    expect(row['display_name']).toBe('Masala Dosa');
    expect(row['unit_price_minor']).toBe('12000');
    expect(row['line_total_minor']).toBe('24000');
    expect(row['tax_class_key']).toBe('food_5');
    expect(row['tax_rate_bps']).toBe(500);
    // #####################################################################
    // THE RATE IS THE SNAPSHOT. THE HEAD IS NOT, AND MUST NOT BE.
    //
    // This test used to assert `[{CGST,250},{SGST,250}]` on the ORDER LINE, and
    // that assertion was the defect written down. An order line has no place of
    // supply -- no bill has been raised -- so a head computed here is a guess
    // that the bill then copied verbatim. `app.tax_component` supplied the
    // NAMES as tenant free text, and the outward-supply return matched those
    // names to bucket a statutory figure.
    //
    // Migration 0050 dropped the column. `bill_line.tax_components` carries the
    // head now, derived at bill time by `splitHeads` from this rate and the
    // stamped treatment, and asserted at COMMIT by
    // `bill_line_heads_match_treatment`.
    // #####################################################################
    const columns = (await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='app' AND table_name='order_line'`)).rows
      .map((r) => r.column_name);
    expect(columns, 'an order line cannot hold a head: it has no place of supply')
      .not.toContain('tax_components');
    // Kept as a reference for reporting joins, never read for a number.
    expect(row['menu_item_id']).toBe(dosaId);
  });

  it('keeps the snapshot when the catalogue price later changes', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));

    await owner.query(
      `UPDATE app.menu_item SET price_minor = 99000 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, dosaId]);
    try {
      const after = (await owner.query<{ unit_price_minor: string }>(
        `SELECT unit_price_minor::text FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
        [tenantId, line.lineId])).rows[0]!;
      // This is the whole point: catalogue price is mutable BECAUSE the bill
      // never dereferences it.
      expect(after.unit_price_minor).toBe('12000');
    } finally {
      await owner.query(
        `UPDATE app.menu_item SET price_minor = 12000 WHERE tenant_id=$1 AND id=$2`,
        [tenantId, dosaId]);
    }
  });

  it('snapshots MODIFIER DELTAS, which are prices and not configuration', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(
      c, { orderId, menuItemId: dosaId, quantity: 1, modifierOptionIds: [extraGheeId] }, userId));

    expect(line.unitPriceMinor).toBe(15000); // 12000 + 3000
    const row = (await owner.query<{ modifiers: { price_delta_minor: number; name: string }[] }>(
      `SELECT modifiers FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, line.lineId])).rows[0]!;
    expect(row.modifiers).toEqual([
      { option_id: extraGheeId, group_id: expect.any(String),
        name: 'Extra ghee', price_delta_minor: 3000 },
    ]);

    await owner.query(
      `UPDATE app.modifier_option SET price_delta_minor = 4000 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, extraGheeId]);
    try {
      const after = (await owner.query<{ modifiers: { price_delta_minor: number }[] }>(
        `SELECT modifiers FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
        [tenantId, line.lineId])).rows[0]!;
      expect(after.modifiers[0]!.price_delta_minor).toBe(3000);
    } finally {
      await owner.query(
        `UPDATE app.modifier_option SET price_delta_minor = 3000 WHERE tenant_id=$1 AND id=$2`,
        [tenantId, extraGheeId]);
    }
  });

  it('refuses a modifier option not attached to the item', async () => {
    const { orderId } = await openOrder();
    // The foreign option carries a -9900 delta, so accepting it would be an
    // uncapped discount with no reason code.
    await expect(tx((c) => addLine(
      c, { orderId, menuItemId: dosaId, quantity: 1, modifierOptionIds: [foreignOptionId] },
      userId))).rejects.toBeInstanceOf(ModifierNotPermittedError);
  });

  it('has no way for a caller to supply a price at all', () => {
    // The type has no money field. Stated as a test because the absence is the
    // control, and an absence is invisible in review.
    const request: Parameters<typeof addLine>[1] =
      { orderId: 'x', menuItemId: 'y', quantity: 1 };
    expect(Object.keys(request)).toEqual(['orderId', 'menuItemId', 'quantity']);
  });
});

describe('combos', () => {
  it('writes a money-less parent over components that sum to it exactly', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: comboId, quantity: 1 }, userId));

    expect(line.kind).toBe('combo_parent');
    expect(line.displayTotalMinor).toBe(15000);
    expect(line.unitPriceMinor).toBeNull();

    const components = (await owner.query<{ line_total_minor: string; tax_class_key: string }>(
      `SELECT line_total_minor::text, tax_class_key FROM app.order_line
        WHERE tenant_id=$1 AND parent_line_id=$2 ORDER BY created_at`,
      [tenantId, line.lineId])).rows;

    expect(components).toHaveLength(2);
    const sum = components.reduce((a, c) => a + Number(c.line_total_minor), 0);
    // Exact, always. Thousands of one-paise discrepancies a month is a GST
    // return that does not balance.
    expect(sum).toBe(15000);
    // The components carry DIFFERENT tax classes, which is why a combo cannot be
    // taxed as an opaque unit.
    expect(new Set(components.map((c) => c.tax_class_key))).toEqual(
      new Set(['food_5', 'bev_12']));
  });

  it('re-allocates on a quantity edit rather than scaling the total', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: comboId, quantity: 1 }, userId));
    await tx((c) => editLine(c, { lineId: line.lineId, quantity: 3 }));

    const parent = (await owner.query<{ display_total_minor: string; quantity: number }>(
      `SELECT display_total_minor::text, quantity FROM app.order_line
        WHERE tenant_id=$1 AND id=$2`, [tenantId, line.lineId])).rows[0]!;
    expect(parent.display_total_minor).toBe('45000');

    const sum = (await owner.query<{ s: string }>(
      `SELECT COALESCE(sum(line_total_minor),0)::text AS s FROM app.order_line
        WHERE tenant_id=$1 AND parent_line_id=$2`, [tenantId, line.lineId])).rows[0]!.s;
    // Still exact after the edit. Scaling the old total with integer division
    // loses the remainder and the deferred trigger aborts at COMMIT.
    expect(sum).toBe('45000');
  });
});

describe('the pre-fire / post-fire boundary', () => {
  it('edits a line before the kitchen sees it', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 3 }, userId));
    await tx((c) => editLine(c, { lineId: line.lineId, quantity: 2 }));

    const row = (await owner.query<{ quantity: number; line_total_minor: string }>(
      `SELECT quantity, line_total_minor::text FROM app.order_line
        WHERE tenant_id=$1 AND id=$2`, [tenantId, line.lineId])).rows[0]!;
    expect(row.quantity).toBe(2);
    expect(row.line_total_minor).toBe('16000');

    // And no adjustment row was created. Forcing typo corrections into voids is
    // what makes the exception report unreadable.
    const adjustments = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.order_line
        WHERE tenant_id=$1 AND adjusts_line_id=$2`, [tenantId, line.lineId])).rows[0]!.n;
    expect(adjustments).toBe('0');
  });

  it('refuses an edit after the line has fired', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 1 }, userId));
    await fireLines(orderId);

    await expect(tx((c) => editLine(c, { lineId: line.lineId, quantity: 2 })))
      .rejects.toBeInstanceOf(LineAlreadyFiredError);
    await expect(tx((c) => removeLine(c, line.lineId)))
      .rejects.toBeInstanceOf(LineAlreadyFiredError);
  });

  it('refuses a VOID before the line has fired', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 1 }, userId));
    await expect(tx((c) => voidLine(
      c, { lineId: line.lineId, quantity: 1, reasonId: voidReasonId }, userId)))
      .rejects.toBeInstanceOf(LineNotFiredError);
  });
});

describe('adjustments are new rows and the sign is real', () => {
  it('void moves quantity NEGATIVE; comp leaves it at zero', async () => {
    const { orderId } = await openOrder();
    const dosa = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 2 }, userId));
    const idli = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 2 }, userId));
    await fireLines(orderId);

    await tx((c) => voidLine(c, { lineId: dosa.lineId, quantity: 1, reasonId: voidReasonId }, userId));
    await tx((c) => compLine(c, { lineId: idli.lineId, quantity: 1, reasonId: compReasonId }, userId));

    const rows = (await owner.query<{ kind: string; quantity: number; line_total_minor: string }>(
      `SELECT kind, quantity, line_total_minor::text FROM app.order_line
        WHERE tenant_id=$1 AND order_id=$2 AND adjusts_line_id IS NOT NULL
        ORDER BY kind`, [tenantId, orderId])).rows;

    const voided = rows.find((r) => r.kind === 'void')!;
    const comped = rows.find((r) => r.kind === 'comp')!;

    // "How many did we make" and "how many did we sell" separate exactly here.
    expect(voided.quantity).toBe(-1);
    expect(comped.quantity).toBe(0);
    expect(voided.line_total_minor).toBe('-12000');
    expect(comped.line_total_minor).toBe('-8000');

    // The original rows are untouched. Rule 9.
    const original = (await owner.query<{ quantity: number }>(
      `SELECT quantity FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, dosa.lineId])).rows[0]!;
    expect(original.quantity).toBe(2);
  });

  it('pins the adjustment to the price it adjusted', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);
    const adjId = await tx((c) => voidLine(
      c, { lineId: line.lineId, quantity: 1, reasonId: voidReasonId }, userId));

    const row = (await owner.query<{ adjusted_unit_price_minor: string; adjusted_kind: string }>(
      `SELECT adjusted_unit_price_minor::text, adjusted_kind FROM app.order_line
        WHERE tenant_id=$1 AND id=$2`, [tenantId, adjId])).rows[0]!;
    // Composite FK, so it cannot be re-derived from a live catalogue price.
    expect(row.adjusted_unit_price_minor).toBe('12000');
    expect(row.adjusted_kind).toBe('item');
  });

  it('refuses to void more than was ordered', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 2 }, userId));
    await fireLines(orderId);
    await tx((c) => voidLine(c, { lineId: line.lineId, quantity: 2, reasonId: voidReasonId }, userId));

    await expect(tx((c) => voidLine(
      c, { lineId: line.lineId, quantity: 1, reasonId: voidReasonId }, userId)))
      .rejects.toBeInstanceOf(AdjustmentExceedsOriginalError);
  });

  it('never touches stock', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 1 }, userId));
    await fireLines(orderId);
    const before = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.stock_movement WHERE tenant_id=$1`,
      [tenantId])).rows[0]!.n;

    await tx((c) => voidLine(c, { lineId: line.lineId, quantity: 1, reasonId: voidReasonId }, userId));

    const after = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.stock_movement WHERE tenant_id=$1`,
      [tenantId])).rows[0]!.n;
    // The kitchen consumed the ingredients when it started cooking. A void that
    // returned stock would corrupt inventory on every void.
    expect(after).toBe(before);
  });
});

describe('discount authority is a cap, not a key', () => {
  it('refuses a percentage above the cap', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);

    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 30 },
      { discountPercentCap: 10, discountAmountCap: null }, userId)))
      .rejects.toBeInstanceOf(DiscountExceedsAuthorityError);
  });

  it('holds the percentage cap against an ABSOLUTE amount too', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);

    // 6000 of 12000 is 50%, well past a 10% cap. Without this the amount form
    // would be a way around the authority -- the same shape as a lower branch
    // price being an uncapped discount channel.
    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, amountMinor: 6000 },
      { discountPercentCap: 10, discountAmountCap: null }, userId)))
      .rejects.toBeInstanceOf(DiscountExceedsAuthorityError);
  });

  it('a role with the DEFAULT cap of zero can discount nothing', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);

    // New keys default deny; so does discount authority.
    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 1 },
      { discountPercentCap: 0, discountAmountCap: null }, userId)))
      .rejects.toBeInstanceOf(DiscountExceedsAuthorityError);
  });

  it('applies BOTH ceilings when both are set', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);

    // 50% of 12000 = 6000, inside the percentage cap but past the absolute one.
    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 50 },
      { discountPercentCap: 100, discountAmountCap: 5000 }, userId)))
      .rejects.toBeInstanceOf(DiscountExceedsAuthorityError);
  });

  it('a NULL amount cap does not mean unlimited -- the percentage still binds', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);

    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 40 },
      { discountPercentCap: 25, discountAmountCap: null }, userId)))
      .rejects.toBeInstanceOf(DiscountExceedsAuthorityError);

    // ...and inside the cap it succeeds, so the test is not vacuous.
    const id = await tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 25 },
      { discountPercentCap: 25, discountAmountCap: null }, userId));
    const row = (await owner.query<{ line_total_minor: string; quantity: number }>(
      `SELECT line_total_minor::text, quantity FROM app.order_line
        WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0]!;
    expect(row.line_total_minor).toBe('-3000');
    expect(row.quantity).toBe(0);
  });

  it('refuses a discount that would take the line below zero', async () => {
    const { orderId } = await openOrder();
    const line = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    await fireLines(orderId);
    await tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, percent: 100 },
      FULL_AUTHORITY, userId));

    await expect(tx((c) => discountLine(
      c, { lineId: line.lineId, reasonId: discountReasonId, amountMinor: 1 },
      FULL_AUTHORITY, userId))).rejects.toBeInstanceOf(AdjustmentExceedsOriginalError);
  });
});

describe('sessions', () => {
  it('derives the business date from the branch, never from the caller', async () => {
    const { sessionId } = await openOrder();
    const row = (await owner.query<{ business_date: string }>(
      `SELECT business_date::text FROM app.table_session WHERE tenant_id=$1 AND id=$2`,
      [tenantId, sessionId])).rows[0]!;
    const expected = (await owner.query<{ d: string }>(
      `SELECT app.business_date(b.timezone, b.business_day_starts_at, now())::text AS d
         FROM app.branch b WHERE b.tenant_id=$1 AND b.id=$2`,
      [tenantId, branchId])).rows[0]!.d;
    expect(row.business_date).toBe(expected);
  });

  it('refuses to seat a second party on an occupied table', async () => {
    const tableId = await newTable();
    await tx((c) => openSession(c, { branchId, diningTableIds: [tableId] }, userId));
    await expect(tx((c) => openSession(c, { branchId, diningTableIds: [tableId] }, userId)))
      .rejects.toBeInstanceOf(TableOccupiedError);
  });

  it('closes a session that owes nothing', async () => {
    const { sessionId } = await openOrder();
    await tx((c) => closeSession(c, sessionId, userId));
    const row = (await owner.query<{ status: string }>(
      `SELECT status FROM app.table_session WHERE tenant_id=$1 AND id=$2`,
      [tenantId, sessionId])).rows[0]!;
    expect(row.status).toBe('closed');
  });
});

describe('availability is re-checked at write time', () => {
  it('refuses an item that is 86ed, and names the reason', async () => {
    const { orderId } = await openOrder();
    const businessDate = (await owner.query<{ d: string }>(
      `SELECT app.business_date(b.timezone, b.business_day_starts_at, now())::text AS d
         FROM app.branch b WHERE b.tenant_id=$1 AND b.id=$2`,
      [tenantId, branchId])).rows[0]!.d;

    await owner.query(
      `INSERT INTO app.branch_item_availability
         (tenant_id, branch_id, menu_item_id, business_date, state, source, set_by_user_id)
       VALUES ($1,$2,$3,$4::date,'sold_out','manual',$5)`,
      [tenantId, branchId, coffeeId, businessDate, userId]);
    try {
      const error = await tx((c) => addLine(
        c, { orderId, menuItemId: coffeeId, quantity: 1 }, userId)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MenuItemNotOrderableError);
      // The reason travels, because "sold out" and "available from 07:00" send
      // the waiter to different places.
      expect((error as MenuItemNotOrderableError).reason).toBe('sold_out');
    } finally {
      await owner.query(
        `DELETE FROM app.branch_item_availability
          WHERE tenant_id=$1 AND menu_item_id=$2`, [tenantId, coffeeId]);
    }
  });

  it('refuses a delisted item even though the board may still cache it', async () => {
    const { orderId } = await openOrder();
    await owner.query(
      `INSERT INTO app.branch_menu_listing
         (tenant_id, branch_id, menu_item_id, listed, delisted_reason, updated_by_user_id)
       VALUES ($1,$2,$3,false,'not sold here',$4)`,
      [tenantId, branchId, coffeeId, userId]);
    try {
      const error = await tx((c) => addLine(
        c, { orderId, menuItemId: coffeeId, quantity: 1 }, userId)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MenuItemNotOrderableError);
      expect((error as MenuItemNotOrderableError).reason).toBe('not_listed');
    } finally {
      await owner.query(
        `DELETE FROM app.branch_menu_listing WHERE tenant_id=$1 AND menu_item_id=$2`,
        [tenantId, coffeeId]);
    }
  });
});

describe('the two availability resolvers cannot drift', () => {
  /**
   * The board read needs a verdict per item and cannot issue N queries, so it
   * has a set-based resolver. That is exactly the shape that becomes a second
   * copy of the rule -- and it already had: the first version omitted
   * `days_of_week`, so a weekday-only item read as available on a Sunday.
   *
   * So they are asserted to agree, item by item, over a fixture built to make
   * all three reasons fire. Agreement on production seed data would be evidence
   * about the seed, not about the rule.
   */
  it('agrees item by item across every unavailability reason', async () => {
    const businessDate = (await owner.query<{ d: string }>(
      `SELECT app.business_date(b.timezone, b.business_day_starts_at, now())::text AS d
         FROM app.branch b WHERE b.tenant_id=$1 AND b.id=$2`,
      [tenantId, branchId])).rows[0]!.d;

    // sold out
    await owner.query(
      `INSERT INTO app.branch_item_availability
         (tenant_id, branch_id, menu_item_id, business_date, state, source, set_by_user_id)
       VALUES ($1,$2,$3,$4::date,'sold_out','manual',$5)`,
      [tenantId, branchId, coffeeId, businessDate, userId]);
    // delisted
    await owner.query(
      `INSERT INTO app.branch_menu_listing
         (tenant_id, branch_id, menu_item_id, listed, delisted_reason, updated_by_user_id)
       VALUES ($1,$2,$3,false,'nope',$4)`,
      [tenantId, branchId, idliId, userId]);
    // Out of hours because of the DAY MASK, which is the bit the copy dropped.
    // The period runs 00:00-23:59 so the time window can never be the reason --
    // if the mask were ignored this item would read as available, which is
    // exactly the Sunday bug.
    const everyOtherDay = 127 - dayBit(new Date());
    const periodId = randomUUID();
    await owner.query(
      `INSERT INTO app.service_period
         (id, tenant_id, branch_id, key, name, days_of_week, starts_at, ends_at)
       VALUES ($1,$2,$3,'breakfast','Breakfast',$4,'00:00','23:59')`,
      [periodId, tenantId, branchId, everyOtherDay]);
    await owner.query(
      `INSERT INTO app.menu_item_service_period (tenant_id, menu_item_id, service_period_id)
       VALUES ($1,$2,$3)`, [tenantId, dosaId, periodId]);

    try {
      const checked: string[] = [];
      await tx(async (c) => {
        const bulk = await resolveAvailabilityForBranch(c, { branchId });
        for (const menuItemId of [dosaId, idliId, coffeeId, comboId]) {
          const single = await resolveAvailability(c, { branchId, menuItemId });
          expect(bulk.get(menuItemId), menuItemId).toEqual(single);
          checked.push(menuItemId);
        }
        // Non-vacuity: the fixture must actually exercise all three reasons,
        // or the agreement is agreement about nothing.
        const reasons = new Set(
          [...bulk.values()].map((v) => v.reason).filter((r) => r !== undefined));
        expect(reasons).toEqual(
          new Set(['not_listed', 'out_of_service_hours', 'sold_out']));
      });
      expect(checked).toHaveLength(4);
    } finally {
      await owner.query(
        `DELETE FROM app.menu_item_service_period WHERE tenant_id=$1 AND service_period_id=$2`,
        [tenantId, periodId]);
      await owner.query(
        `DELETE FROM app.service_period WHERE tenant_id=$1 AND id=$2`, [tenantId, periodId]);
      await owner.query(
        `DELETE FROM app.branch_menu_listing WHERE tenant_id=$1 AND menu_item_id=$2`,
        [tenantId, idliId]);
      await owner.query(
        `DELETE FROM app.branch_item_availability WHERE tenant_id=$1 AND menu_item_id=$2`,
        [tenantId, coffeeId]);
    }
  });
});

/* ------------------------------------------------------- guests on lines --- */

describe('a line can belong to a guest, which is what by_guest splits need', () => {
  /**
   * #######################################################################
   * NOTHING IN THE PRODUCT SET THIS, SO by_guest REFUSED 100% OF THE TIME.
   *
   * `app.order_line.guest_no` existed. `generateBill` implemented the split.
   * `UnassignedGuestLinesError` refused correctly while any line was
   * unassigned. The split screen was built. And no write path anywhere set the
   * column, so the refusal could never be satisfied -- a whole flow that was
   * correct end to end and unreachable.
   *
   * `guestCount` stays OPTIONAL on the session deliberately. Requiring it in
   * the domain would break a takeaway, which nobody has decided about; the
   * decision to always ask belongs to the till screen. What the domain does is
   * refuse a guest number it cannot check, with a message that says what to do.
   * #######################################################################
   */
  it('stores the guest a line was keyed for', async () => {
    const { orderId } = await openOrder(4);
    const line = await tx((c) =>
      addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo: 3 }, userId));

    const row = (await owner.query<{ guest_no: number | null }>(
      `SELECT guest_no FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
      [tenantId, line.lineId])).rows[0]!;
    expect(row.guest_no).toBe(3);
  });

  it('leaves a shared line unassigned, because a shared starter belongs to nobody',
    async () => {
      const { orderId } = await openOrder(4);
      const line = await tx((c) =>
        addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
      const row = (await owner.query<{ guest_no: number | null }>(
        `SELECT guest_no FROM app.order_line WHERE tenant_id=$1 AND id=$2`,
        [tenantId, line.lineId])).rows[0]!;
      // Null is the ANSWER, not the absence of one: the split refuses until a
      // human decides, rather than attributing the papad to whoever keyed first.
      expect(row.guest_no).toBeNull();
    });

  it('refuses a guest who is not at the table', async () => {
    // The column's CHECK only requires > 0, so guest 9 at a table of four would
    // store perfectly and then be unsplittable to anybody -- a refusal at bill
    // time, in front of the customer, instead of at the tap.
    const { orderId } = await openOrder(4);
    await expect(tx((c) =>
      addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo: 9 }, userId)))
      .rejects.toThrow(GuestNoOutOfRangeError);
  });

  it('refuses guest zero and a fractional guest', async () => {
    const { orderId } = await openOrder(4);
    for (const guestNo of [0, -1, 1.5]) {
      await expect(tx((c) =>
        addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo }, userId)),
      ).rejects.toThrow(GuestNoOutOfRangeError);
    }
  });

  it('refuses a guest number when the table was opened with no cover count',
    async () => {
      const { orderId } = await openOrder();
      await expect(tx((c) =>
        addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo: 1 }, userId)))
        .rejects.toThrow(/opened without a guest count/);
    });

  it('puts the guest on the combo COMPONENTS, which are what a split sums',
    async () => {
      const { orderId } = await openOrder(2);
      const added = await tx((c) =>
        addLine(c, { orderId, menuItemId: comboId, quantity: 1, guestNo: 2 }, userId));

      const rows = await owner.query<{ kind: string; guest_no: number | null }>(
        `SELECT kind, guest_no FROM app.order_line
          WHERE tenant_id=$1 AND (id=$2 OR parent_line_id=$2) ORDER BY kind`,
        [tenantId, added.lineId]);
      expect(rows.rows.length).toBeGreaterThan(1);
      // Parent AND components. A guest on the parent alone would split a thali
      // to nobody, because the money lives on the components.
      for (const row of rows.rows) {
        expect(row.guest_no, `${row.kind} must carry the guest`).toBe(2);
      }
    });

  it('SPLITS BY GUEST, which is the flow that could not be performed at all',
    async () => {
      const { sessionId, orderId } = await openOrder(2);
      await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo: 1 }, userId));
      await tx((c) => addLine(c, { orderId, menuItemId: idliId, quantity: 1, guestNo: 2 }, userId));

      const businessDate = (await owner.query<{ d: string }>(
        `SELECT business_date::text AS d FROM app.table_session WHERE tenant_id=$1 AND id=$2`,
        [tenantId, sessionId])).rows[0]!.d;

      const first = await tx((c) => generateBill(c, {
        branchId, sessionId, businessDate, generatedByUserId: userId,
        splitKind: 'by_guest', guestNos: [1] }));
      expect(first.lineCount).toBe(1);
      expect(first.subtotalMinor).toBeGreaterThan(0);

      const second = await tx((c) => generateBill(c, {
        branchId, sessionId, businessDate, generatedByUserId: userId,
        splitKind: 'by_guest', guestNos: [2] }));
      expect(second.lineCount).toBe(1);
      // Two guests, two bills, and neither pays for the other's dish.
      expect(second.subtotalMinor).not.toBe(0);
    });

  it('still refuses the split while ANY line belongs to nobody', async () => {
    // The refusal survives, which is the point: it was never wrong, it was
    // unsatisfiable. A shared line must be decided, not defaulted.
    const { sessionId, orderId } = await openOrder(2);
    await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1, guestNo: 1 }, userId));
    await tx((c) => addLine(c, { orderId, menuItemId: coffeeId, quantity: 1 }, userId));

    const businessDate = (await owner.query<{ d: string }>(
      `SELECT business_date::text AS d FROM app.table_session WHERE tenant_id=$1 AND id=$2`,
      [tenantId, sessionId])).rows[0]!.d;

    await expect(tx((c) => generateBill(c, {
      branchId, sessionId, businessDate, generatedByUserId: userId,
      splitKind: 'by_guest', guestNos: [1] })))
      .rejects.toThrow(UnassignedGuestLinesError);
  });
});

/* ---------------------------------------------- the branch's GST position --- */

/**
 * ###########################################################################
 * WHAT AN UNREGISTERED RESTAURANT CHARGES, AND WHERE THAT IS DECIDED.
 *
 * A restaurant below the GST threshold is not entitled to collect a paisa of
 * GST, and until migration 0048 this system charged it anyway: the rate came
 * from the menu item's tax class and nothing anywhere asked whether the place
 * was registered. `app.branch.gstin` existed, was nullable, and was read by
 * nothing that decided money.
 *
 * The suppression had to go in the LINE SNAPSHOT rather than at bill time. That
 * is the whole reason these tests live in this file and not in the billing one:
 * `generateBill` sums the per-line tax, so a suppression applied to the bill
 * total would make `bill.tax_minor` disagree with the sum of its own lines, and
 * that reconciliation is what a GST return is built on.
 *
 * Four things are asserted, and the first is the most important:
 *
 *   1. AN UNSTATED BRANCH BEHAVES EXACTLY AS BEFORE. Every branch in every
 *      existing deployment has a null GSTIN, so had `unregistered` been
 *      inferred from that null, this migration would have taken the tax off
 *      every live bill on the day it ran. The control comes first.
 *   2. An unregistered branch resolves an EXPLICIT 0, not a null. Null already
 *      means "no tax class configured", which is a setup gap; a report that
 *      cannot tell the two apart cannot find either.
 *   3. Combo COMPONENTS are suppressed too. They carry the money, and they are
 *      resolved by two other queries -- a suppression that reached only
 *      `resolveOrderableItem` would leave every thali fully taxed.
 *   4. The database refuses a taxed line at an unregistered branch outright, so
 *      a write path added later cannot reintroduce the bug quietly.
 * ###########################################################################
 */
describe('the branch GST position decides whether a line carries tax', () => {
  const setPosition = async (
    registration: 'registered' | 'composition' | 'unregistered' | 'unstated',
    gstin: string | null,
  ): Promise<void> => {
    await owner.query(
      `UPDATE app.branch SET gst_registration=$2, gstin=$3,
              state_code = CASE WHEN $3::text IS NULL THEN state_code ELSE substring($3,1,2) END
        WHERE tenant_id=$1 AND id=$4`,
      [tenantId, registration, gstin, branchId]);
  };

  // Restored after every case. The branch is shared with the rest of the file
  // and a leaked 'unregistered' would silently zero the tax assertions above --
  // which would look like those tests passing.
  afterEach(async () => { await setPosition('unstated', null); });

  const rateOf = async (lineId: string): Promise<{
    rate: number | null; classKey: string | null;
  }> => {
    const row = (await owner.query<{
      tax_rate_bps: number | null; tax_class_key: string | null;
    }>(
      `SELECT tax_rate_bps, tax_class_key FROM app.order_line
        WHERE tenant_id=$1 AND id=$2`, [tenantId, lineId])).rows[0]!;
    return { rate: row.tax_rate_bps, classKey: row.tax_class_key };
  };

  it('leaves an unstated branch charging exactly what it charged before', async () => {
    // The no-money-moved assertion, and the reason `unstated` exists as a third
    // value rather than being folded into `unregistered`.
    const { orderId } = await openOrder();
    const dosa = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));
    const coffee = await tx((c) =>
      addLine(c, { orderId, menuItemId: coffeeId, quantity: 1 }, userId));

    expect((await rateOf(dosa.lineId)).rate).toBe(500);
    expect((await rateOf(coffee.lineId)).rate).toBe(1200);
  });

  it('resolves an explicit 0 rate for a COMPOSITION branch, which holds a GSTIN',
    async () => {
      // ###################################################################
      // THE CASE THE THREE-VALUE VOCABULARY GOT WRONG.
      //
      // A composition taxable person pays 5% of turnover itself and may not
      // collect a paisa from a diner. It HOLDS a GSTIN -- which is why
      // `branch_registered_iff_gstin` forced it to answer `registered` before
      // migration 0051, putting the menu tax class onto every line.
      //
      // So the question this CASE asks is not "is there a registration" but
      // "may this position collect tax", and a reviewer scanning for the former
      // would have waved the defect through.
      // ###################################################################
      await setPosition('composition', '29AABCU9603R1ZM');
      const { orderId } = await openOrder();
      const dosa = await tx((c) =>
        addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));

      const snapshot = await rateOf(dosa.lineId);
      expect(snapshot.rate).toBe(0);
      // The class key SURVIVES here too: which rate would have applied is still
      // a fact about the dish, and it is what makes the branch billable the day
      // it crosses the composition threshold and registers normally.
      expect(snapshot.classKey).toBe('food_5');
    });

  it('resolves an explicit 0 rate when unregistered', async () => {
    await setPosition('unregistered', null);
    const { orderId } = await openOrder();
    const dosa = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));

    const snapshot = await rateOf(dosa.lineId);
    // 0, NOT null. The distinction is the point: null is a missing tax class.
    expect(snapshot.rate).toBe(0);
    // The class key SURVIVES. Which class would have applied is still a fact
    // about the item, and it is what makes the branch billable the moment it
    // registers -- dropping it would leave nothing to restore.
    expect(snapshot.classKey).toBe('food_5');
  });

  it('does not touch the price, only the tax', async () => {
    // An unregistered restaurant charges the menu price. If suppression had been
    // applied to `unit_price_minor` instead, the dosa would have got cheaper --
    // which is a discount nobody authorised, not a tax position.
    await setPosition('unregistered', null);
    const { orderId } = await openOrder();
    const dosa = await tx((c) => addLine(c, { orderId, menuItemId: dosaId, quantity: 2 }, userId));
    expect(dosa.lineTotalMinor).toBe(dosa.unitPriceMinor! * 2);
  });

  it('suppresses every combo component, not just the item path', async () => {
    await setPosition('unregistered', null);
    const { orderId } = await openOrder();
    const combo = await tx((c) =>
      addLine(c, { orderId, menuItemId: comboId, quantity: 1 }, userId));

    expect(combo.componentLineIds.length).toBe(2);
    for (const componentId of combo.componentLineIds) {
      const snapshot = await rateOf(componentId);
      expect(snapshot.rate, 'a component carries the money, so it carries the suppression')
        .toBe(0);
    }
    // And the control: the same combo at a registered branch keeps the two
    // DIFFERENT rates its components declare, which is the case a single
    // combo-level rate would have flattened.
    await setPosition('registered', '29AABCU9603R1ZM');
    const { orderId: second } = await openOrder();
    const taxed = await tx((c) =>
      addLine(c, { orderId: second, menuItemId: comboId, quantity: 1 }, userId));
    const rates = new Set<number | null>();
    for (const componentId of taxed.componentLineIds) {
      rates.add((await rateOf(componentId)).rate);
    }
    expect([...rates].sort((a, b) => Number(a) - Number(b))).toEqual([500, 1200]);
  });

  it('charges again the moment the branch registers, without touching old lines', async () => {
    await setPosition('unregistered', null);
    const { orderId } = await openOrder();
    const untaxed = await tx((c) =>
      addLine(c, { orderId, menuItemId: dosaId, quantity: 1 }, userId));

    await setPosition('registered', '29AABCU9603R1ZM');
    const { orderId: after } = await openOrder();
    const taxed = await tx((c) =>
      addLine(c, { orderId: after, menuItemId: dosaId, quantity: 1 }, userId));

    expect((await rateOf(taxed.lineId)).rate).toBe(500);
    // The old line does NOT move. It is a snapshot, and a reprint of the bill it
    // belongs to must show what the customer was actually charged.
    expect((await rateOf(untaxed.lineId)).rate).toBe(0);
  });

  it('refuses a taxed line at an unregistered branch even on a hand-written insert',
    async () => {
      // ###################################################################
      // THE SYNTHETIC VIOLATION.
      //
      // The three query sites above give the good answer. This asserts the
      // BACKSTOP: an INSERT that bypasses all of them is refused by the
      // database. Without it, the next write path -- a delivery-channel
      // importer, an offline replay, a bulk insert -- would collect tax at a
      // branch with no registration to remit it under, and every test in this
      // file would still pass.
      // ###################################################################
      await setPosition('unregistered', null);
      const { orderId } = await openOrder();

      await expect(owner.query(
        `INSERT INTO app.order_line
           (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
            unit_price_minor, quantity, line_total_minor, tax_class_key, tax_rate_bps,
            created_by_user_id)
         VALUES ($1,$2,$3,$4,'item',$5,'Smuggled Dosa',6000,1,6000,'food_5',500,$6)`,
        [randomUUID(), tenantId, branchId, orderId, dosaId, userId]))
        .rejects.toThrow(/order_line_tax_requires_registration/);

      // And the same insert at 0 bps is accepted, so the trigger is refusing the
      // tax rather than the write.
      await expect(owner.query(
        `INSERT INTO app.order_line
           (id, tenant_id, branch_id, order_id, kind, menu_item_id, display_name,
            unit_price_minor, quantity, line_total_minor, tax_class_key, tax_rate_bps,
            created_by_user_id)
         VALUES ($1,$2,$3,$4,'item',$5,'Lawful Dosa',6000,1,6000,'food_5',0,$6)`,
        [randomUUID(), tenantId, branchId, orderId, dosaId, userId]))
        .resolves.toBeTruthy();
    });
});
