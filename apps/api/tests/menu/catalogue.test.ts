import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/core/database/tenantContext.js';
import {
  allocateComboPrice,
  allocationBalances,
  AllocationImpossibleError,
} from '../../src/modules/menu/comboAllocation.js';
import { resolveAvailability, withinPeriod } from '../../src/modules/menu/availability.js';
import {
  assertListable,
  assertStationArchivable,
  StationStillRoutedError,
  UnroutableAtBranchError,
} from '../../src/modules/menu/routing.js';
import { keysInExceptionSection, riskSubclassOf } from '../../src/modules/authz/permissions.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;

let tenantId: string;
let branchId: string;
let foodTax: string;
let bevTax: string;
let burgerId: string;
let lassiId: string;
let comboId: string;

function ctx(): TenantContext {
  return peekTenantContext()!;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });

  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`,
    )
  ).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3)`,
    [superAdminId, `menu+${superAdminId}@platform.test`, roleId],
  );

  const planId = randomUUID();
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'menu_plan', 'Menu Plan')
     ON CONFLICT (key) DO NOTHING`,
    [planId],
  );
  const actualPlanId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.plan WHERE key = 'menu_plan'`)
  ).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, 1, 100000, 'INR', 'monthly', now()) ON CONFLICT (plan_id, version) DO NOTHING`,
    [randomUUID(), actualPlanId],
  );
  const planVersionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id = $1 AND version = 1`,
      [actualPlanId],
    )
  ).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `menu-${randomUUID()}`;
    const result = await provisionTenant(client, {
      idempotencyKey: key,
      slug: `m${key.slice(5, 13)}`,
      name: 'Menu Probe',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner',
      firstBranchName: 'Main',
      planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = result.tenantId;
    branchId = result.firstBranchId;
  } finally {
    client.release();
  }

  // Station vocabulary, then the branch's realisation of two of the three codes.
  await owner.query(
    `INSERT INTO app.station_code (tenant_id, code, name) VALUES
       ($1, 'grill', 'Grill'), ($1, 'cold', 'Cold Station'), ($1, 'tandoor', 'Tandoor')`,
    [tenantId],
  );
  await owner.query(
    `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name) VALUES
       ($1, $3, $4, 'grill', 'Grill'), ($2, $3, $4, 'cold', 'Cold')`,
    [randomUUID(), randomUUID(), tenantId, branchId],
  );

  foodTax = randomUUID();
  bevTax = randomUUID();
  await owner.query(
    `INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps) VALUES
       ($1, $3, 'food_5', 'Food 5%', 500), ($2, $3, 'beverage_12', 'Beverage 12%', 1200)`,
    [foodTax, bevTax, tenantId],
  );

  burgerId = randomUUID();
  lassiId = randomUUID();
  comboId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, station_code, price_minor)
     VALUES ($1, $3, 'burger', 'Burger', 'single', $4, 'grill', 21000),
            ($2, $3, 'lassi', 'Lassi', 'single', $5, 'cold', 9000)`,
    [burgerId, lassiId, tenantId, foodTax, bevTax],
  );
  await owner.query(
    `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, price_minor)
     VALUES ($1, $2, 'burger_combo', 'Burger Combo', 'combo', $3, 29900)`,
    [comboId, tenantId, foodTax],
  );
  await owner.query(
    `INSERT INTO app.combo_component (id, tenant_id, combo_item_id, kind, component_item_id, component_kind, display_order)
     VALUES ($1, $3, $4, 'fixed', $5, 'single', 1), ($2, $3, $4, 'fixed', $6, 'single', 2)`,
    [randomUUID(), randomUUID(), tenantId, comboId, burgerId, lassiId],
  );
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

/* ------------------------------------------------- allocation (problem B) --- */

describe('combo allocation is exact, always', () => {
  it('allocates pro-rata across components with different tax classes', () => {
    const lines = allocateComboPrice(29900, [
      { componentId: 'burger', listPriceMinor: 21000, quantity: 1 },
      { componentId: 'lassi', listPriceMinor: 9000, quantity: 1 },
    ]);
    expect(allocationBalances(29900, lines)).toBe(true);
    // 21000/30000 of 29900 = 20930; 9000/30000 = 8970.
    expect(lines).toEqual([
      { componentId: 'burger', allocatedMinor: 20930 },
      { componentId: 'lassi', allocatedMinor: 8970 },
    ]);
  });

  it('never loses or invents a minor unit, across a wide sweep', () => {
    // Naive rounding leaves 298.99 or 299.01. Over a month that is thousands of
    // one-paise discrepancies in a return that has to balance exactly.
    for (let price = 1; price <= 400; price += 1) {
      for (const split of [
        [1, 1, 1],
        [7, 11, 13],
        [1, 2, 3, 4, 5],
        [100, 3],
        [1],
      ]) {
        const lines = allocateComboPrice(
          price,
          split.map((v, i) => ({ componentId: `c${i}`, listPriceMinor: v, quantity: 1 })),
        );
        expect(allocationBalances(price, lines), `${price} over ${split.join('/')}`).toBe(true);
        expect(lines.every((l) => l.allocatedMinor >= 0)).toBe(true);
      }
    }
  });

  it('is deterministic: the same input always allocates the same way', () => {
    const input = [
      { componentId: 'a', listPriceMinor: 1000, quantity: 1 },
      { componentId: 'b', listPriceMinor: 1000, quantity: 1 },
      { componentId: 'c', listPriceMinor: 1000, quantity: 1 },
    ];
    // 100 over three equal parts: the remainder must land in a fixed place, not
    // wherever the sort happened to put it.
    const first = allocateComboPrice(100, input);
    for (let i = 0; i < 20; i += 1) expect(allocateComboPrice(100, input)).toEqual(first);
    expect(first.map((l) => l.allocatedMinor)).toEqual([34, 33, 33]);
  });

  it('respects quantity in the pro-rata basis', () => {
    const lines = allocateComboPrice(30000, [
      { componentId: 'naan', listPriceMinor: 5000, quantity: 2 },
      { componentId: 'curry', listPriceMinor: 20000, quantity: 1 },
    ]);
    expect(allocationBalances(30000, lines)).toBe(true);
    expect(lines[0]!.allocatedMinor).toBe(10000);
  });

  it('handles an all-free combo without dividing by zero', () => {
    const lines = allocateComboPrice(100, [
      { componentId: 'a', listPriceMinor: 0, quantity: 1 },
      { componentId: 'b', listPriceMinor: 0, quantity: 1 },
      { componentId: 'c', listPriceMinor: 0, quantity: 1 },
    ]);
    expect(allocationBalances(100, lines)).toBe(true);
  });

  it('refuses a combo with no components', () => {
    expect(() => allocateComboPrice(100, [])).toThrow(AllocationImpossibleError);
  });
});

/* ----------------------------------------------------- catalogue shape --- */

describe('the catalogue enforces its own rules', () => {
  it('refuses to nest a combo inside a combo', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.combo_component (id, tenant_id, combo_item_id, kind, component_item_id, component_kind)
         VALUES ($1, $2, $3, 'fixed', $4, 'single')`,
        [randomUUID(), tenantId, comboId, comboId],
      ),
    ).rejects.toThrow(/combo_component_item_fk/);
  });

  it('requires a single item to route and a combo not to', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, price_minor)
         VALUES ($1, $2, 'unrouted', 'Unrouted', 'single', $3, 100)`,
        [randomUUID(), tenantId, foodTax],
      ),
    ).rejects.toThrow(/routing_matches_kind/);

    await expect(
      owner.query(
        `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, station_code, price_minor)
         VALUES ($1, $2, 'routed_combo', 'Routed Combo', 'combo', $3, 'grill', 100)`,
        [randomUUID(), tenantId, foodTax],
      ),
    ).rejects.toThrow(/routing_matches_kind/);
  });

  it('uses an explicit discriminator on combo components, not nullness', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.combo_component (id, tenant_id, combo_item_id, kind)
         VALUES ($1, $2, $3, 'fixed')`,
        [randomUUID(), tenantId, comboId],
      ),
    ).rejects.toThrow(/combo_component_shape_exact/);
  });

  it('keeps menu_category free of statutory and operational meaning', async () => {
    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'menu_category'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    for (const forbidden of ['tax_class_id', 'station_code', 'price_minor', 'listed']) {
      expect(names, `menu_category must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('allows a negative modifier delta', async () => {
    const groupId = randomUUID();
    await owner.query(
      `INSERT INTO app.modifier_group (id, tenant_id, key, name, min_select, max_select)
       VALUES ($1, $2, 'cheese', 'Cheese', 0, 1)`,
      [groupId, tenantId],
    );
    const inserted = await owner.query<{ price_delta_minor: string }>(
      `INSERT INTO app.modifier_option (id, tenant_id, modifier_group_id, key, name, price_delta_minor)
       VALUES ($1, $2, $3, 'no_cheese', 'No cheese', -1000)
       RETURNING price_delta_minor::text`,
      [randomUUID(), tenantId, groupId],
    );
    expect(inserted.rows[0]!.price_delta_minor).toBe('-1000');
  });

  it('treats a NULL max_select as "the other bound binds"', async () => {
    const groupId = randomUUID();
    await owner.query(
      `INSERT INTO app.modifier_group (id, tenant_id, key, name, min_select, max_select)
       VALUES ($1, $2, 'toppings', 'Toppings', 1, NULL)`,
      [groupId, tenantId],
    );
    const row = await owner.query<{ min_select: number; max_select: number | null }>(
      `SELECT min_select, max_select FROM app.modifier_group WHERE id = $1`,
      [groupId],
    );
    expect(row.rows[0]).toEqual({ min_select: 1, max_select: null });

    await expect(
      owner.query(
        `INSERT INTO app.modifier_group (id, tenant_id, key, name, min_select, max_select)
         VALUES ($1, $2, 'bad', 'Bad', 3, 1)`,
        [randomUUID(), tenantId],
      ),
    ).rejects.toThrow(/bounds_ordered/);
  });
});

/* ----------------------------------- branch override direction (problem A) --- */

describe('branch overrides: listing and pricing are separate concerns', () => {
  it('lets a delisting exist with no opinion about price', async () => {
    // The whole point of the split: this row carries no pinned price copy and
    // takes no part in the catalogue-price cascade.
    await owner.query(
      `INSERT INTO app.branch_menu_listing (tenant_id, branch_id, menu_item_id, listed, delisted_reason)
       VALUES ($1, $2, $3, false, 'no fryer at this site')`,
      [tenantId, branchId, lassiId],
    );
    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'branch_menu_listing'`,
    );
    expect(columns.rows.map((r) => r.column_name)).not.toContain('catalogue_price_minor');
    await owner.query(`DELETE FROM app.branch_menu_listing WHERE tenant_id = $1`, [tenantId]);
  });

  it('permits an override that raises', async () => {
    await owner.query(
      `INSERT INTO app.branch_menu_price
         (tenant_id, branch_id, menu_item_id, price_minor, catalogue_price_minor)
       VALUES ($1, $2, $3, 25000, 21000)`,
      [tenantId, branchId, burgerId],
    );
    const row = await owner.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM app.branch_menu_price WHERE menu_item_id = $1`,
      [burgerId],
    );
    expect(row.rows[0]!.price_minor).toBe('25000');
  });

  it('refuses an override that lowers', async () => {
    // A lower branch price is an uncapped discount channel with no reason code.
    await expect(
      owner.query(
        `UPDATE app.branch_menu_price SET price_minor = 19000 WHERE menu_item_id = $1`,
        [burgerId],
      ),
    ).rejects.toThrow(/may_only_raise/);
  });

  it('aborts a catalogue rise that would strand an override below it', async () => {
    // ON UPDATE CASCADE rewrites every pinned copy and each row re-checks. Raising
    // the burger to 26000 leaves the 25000 airport override below catalogue.
    await expect(
      owner.query(`UPDATE app.menu_item SET price_minor = 26000 WHERE id = $1`, [burgerId]),
    ).rejects.toThrow(/may_only_raise/);

    // A rise that stays under the override cascades cleanly.
    await owner.query(`UPDATE app.menu_item SET price_minor = 22000 WHERE id = $1`, [burgerId]);
    const pinned = await owner.query<{ catalogue_price_minor: string }>(
      `SELECT catalogue_price_minor::text FROM app.branch_menu_price WHERE menu_item_id = $1`,
      [burgerId],
    );
    expect(pinned.rows[0]!.catalogue_price_minor, 'the pinned copy follows').toBe('22000');
  });
});

/* -------------------------------------------------------------- routing --- */

describe('station routing has no default fallback', () => {
  it('refuses to list an item routing to a code this branch lacks', async () => {
    const naanId = randomUUID();
    await owner.query(
      `INSERT INTO app.menu_item (id, tenant_id, key, name, kind, tax_class_id, station_code, price_minor)
       VALUES ($1, $2, 'naan', 'Naan', 'single', $3, 'tandoor', 4000)`,
      [naanId, tenantId, foodTax],
    );

    // A default station means food silently appears at the wrong counter.
    await expect(
      withTenantTransaction(pool, tenantId, () => assertListable(ctx(), branchId, naanId)),
    ).rejects.toThrow(UnroutableAtBranchError);

    await expect(
      withTenantTransaction(pool, tenantId, () => assertListable(ctx(), branchId, naanId)),
    ).rejects.toThrow(/tandoor.*does not have/);
  });

  it('accepts an item whose code the branch realises', async () => {
    await expect(
      withTenantTransaction(pool, tenantId, () => assertListable(ctx(), branchId, burgerId)),
    ).resolves.toBeUndefined();
  });

  it('accounts for codes reachable only through a modifier option', async () => {
    // "Add a lassi" on a thali is prepared where the thali is not.
    const groupId = randomUUID();
    await owner.query(
      `INSERT INTO app.modifier_group (id, tenant_id, key, name) VALUES ($1, $2, 'add_bread', 'Add bread')`,
      [groupId, tenantId],
    );
    await owner.query(
      `INSERT INTO app.modifier_option (id, tenant_id, modifier_group_id, key, name, station_code)
       VALUES ($1, $2, $3, 'add_naan', 'Add naan', 'tandoor')`,
      [randomUUID(), tenantId, groupId],
    );
    await owner.query(
      `INSERT INTO app.menu_item_modifier_group (tenant_id, menu_item_id, modifier_group_id)
       VALUES ($1, $2, $3)`,
      [tenantId, burgerId, groupId],
    );

    await expect(
      withTenantTransaction(pool, tenantId, () => assertListable(ctx(), branchId, burgerId)),
    ).rejects.toThrow(/tandoor/);

    await owner.query(
      `DELETE FROM app.menu_item_modifier_group WHERE tenant_id = $1 AND modifier_group_id = $2`,
      [tenantId, groupId],
    );
  });

  it('refuses to archive a station that listed items still route to', async () => {
    const grill = (
      await owner.query<{ id: string }>(
        `SELECT id FROM app.kitchen_station WHERE tenant_id = $1 AND code = 'grill'`,
        [tenantId],
      )
    ).rows[0]!.id;

    // The half that gets forgotten: the reverse direction.
    await expect(
      withTenantTransaction(pool, tenantId, () => assertStationArchivable(ctx(), grill)),
    ).rejects.toThrow(StationStillRoutedError);
    await expect(
      withTenantTransaction(pool, tenantId, () => assertStationArchivable(ctx(), grill)),
    ).rejects.toThrow(/Burger/);
  });

  it('permits archiving a station nothing routes to', async () => {
    const spare = randomUUID();
    await owner.query(`INSERT INTO app.station_code (tenant_id, code, name) VALUES ($1, 'pastry', 'Pastry')`, [tenantId]);
    await owner.query(
      `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name)
       VALUES ($1, $2, $3, 'pastry', 'Pastry')`,
      [spare, tenantId, branchId],
    );
    await expect(
      withTenantTransaction(pool, tenantId, () => assertStationArchivable(ctx(), spare)),
    ).resolves.toBeUndefined();
  });
});

/* --------------------------------------------------------- availability --- */

describe('availability is three concerns with a defined precedence', () => {
  const AT_0900 = new Date('2026-03-10T03:30:00Z'); // 09:00 IST, a Tuesday
  const AT_1101 = new Date('2026-03-10T05:31:00Z'); // 11:01 IST

  beforeAll(async () => {
    const periodId = randomUUID();
    await owner.query(
      `INSERT INTO app.service_period (id, tenant_id, key, name, days_of_week, starts_at, ends_at)
       VALUES ($1, $2, 'breakfast', 'Breakfast', 127, '07:00', '11:00')`,
      [periodId, tenantId],
    );
    await owner.query(
      `INSERT INTO app.menu_item_service_period (tenant_id, menu_item_id, service_period_id)
       VALUES ($1, $2, $3)`,
      [tenantId, lassiId, periodId],
    );
  });

  it('handles a period that wraps midnight', () => {
    expect(withinPeriod(23 * 60, 22 * 60, 2 * 60)).toBe(true);
    expect(withinPeriod(1 * 60, 22 * 60, 2 * 60)).toBe(true);
    expect(withinPeriod(12 * 60, 22 * 60, 2 * 60)).toBe(false);
  });

  it('is orderable inside its service period', async () => {
    const verdict = await withTenantTransaction(pool, tenantId, () =>
      resolveAvailability(ctx(), { branchId, menuItemId: lassiId, at: AT_0900 }),
    );
    expect(verdict.orderable).toBe(true);
  });

  it('is not orderable at 11:01 — and says why', async () => {
    // One boolean across all three concerns is what makes a POS wrong here.
    const verdict = await withTenantTransaction(pool, tenantId, () =>
      resolveAvailability(ctx(), { branchId, menuItemId: lassiId, at: AT_1101 }),
    );
    expect(verdict.orderable).toBe(false);
    expect(verdict.reason).toBe('out_of_service_hours');
    expect(verdict.availableFrom).toBe('07:00');
  });

  it('reports the most permanent reason when several apply', async () => {
    const business = await owner.query<{ d: string }>(
      `SELECT app.business_date(b.timezone, b.business_day_starts_at, $2::timestamptz)::text AS d
         FROM app.branch b WHERE b.tenant_id = $1 AND b.id = $3`,
      [tenantId, AT_1101.toISOString(), branchId],
    );
    await owner.query(
      `INSERT INTO app.branch_item_availability
         (tenant_id, branch_id, menu_item_id, business_date, state, source, set_by_user_id)
       SELECT $1, $2, $3, $4::date, 'sold_out', 'manual', u.id
         FROM app.app_user u WHERE u.tenant_id = $1 LIMIT 1`,
      [tenantId, branchId, lassiId, business.rows[0]!.d],
    );

    // Both out-of-hours and 86'd. "Sold out" implies come back later today, which
    // is wrong, so schedule wins.
    const verdict = await withTenantTransaction(pool, tenantId, () =>
      resolveAvailability(ctx(), { branchId, menuItemId: lassiId, at: AT_1101 }),
    );
    expect(verdict.reason).toBe('out_of_service_hours');

    // Delisting is more permanent still and outranks both.
    await owner.query(
      `INSERT INTO app.branch_menu_listing (tenant_id, branch_id, menu_item_id, listed)
       VALUES ($1, $2, $3, false)`,
      [tenantId, branchId, lassiId],
    );
    const delisted = await withTenantTransaction(pool, tenantId, () =>
      resolveAvailability(ctx(), { branchId, menuItemId: lassiId, at: AT_1101 }),
    );
    expect(delisted.reason).toBe('not_listed');

    await owner.query(`DELETE FROM app.branch_menu_listing WHERE tenant_id = $1`, [tenantId]);
  });

  it('derives the business date from branch timezone and day start, not UTC', async () => {
    // 01:30 IST on the 11th, with a 03:00 day start, is still the 10th's business.
    await owner.query(
      `UPDATE app.branch SET business_day_starts_at = '03:00' WHERE id = $1`,
      [branchId],
    );
    const result = await owner.query<{ d: string }>(
      `SELECT app.business_date(b.timezone, b.business_day_starts_at, $2::timestamptz)::text AS d
         FROM app.branch b WHERE b.id = $1`,
      [branchId, '2026-03-10T20:00:00Z'], // 01:30 IST on the 11th
    );
    expect(result.rows[0]!.d).toBe('2026-03-10');
    await owner.query(`UPDATE app.branch SET business_day_starts_at = '00:00' WHERE id = $1`, [branchId]);
  });

  it('treats absence as available and listed', async () => {
    const verdict = await withTenantTransaction(pool, tenantId, () =>
      resolveAvailability(ctx(), { branchId, menuItemId: burgerId, at: AT_1101 }),
    );
    // No listing row, no periods, no sold-out row: orderable.
    expect(verdict.orderable).toBe(true);
  });
});

/* ------------------------------------------------------- risk_subclass --- */

describe('the exception report has two sections, derived not enumerated', () => {
  it('gives every financial key a subclass and no other key one', async () => {
    const rows = await owner.query<{ key: string; risk_class: string; risk_subclass: string | null }>(
      `SELECT key, risk_class, risk_subclass FROM platform.permission ORDER BY key`,
    );
    assertCheckedSet({
      label: 'seeded permissions',
      checked: rows.rows.map((r) => r.key),
      minimum: 95,
      mustInclude: ['menu.price.edit', 'order.void', 'supplier.create'],
    });

    const wrong = rows.rows.filter(
      (r) => (r.risk_class === 'financial') !== (r.risk_subclass !== null),
    );
    expect(wrong).toEqual([]);
  });

  it('separates transaction exceptions from configuration changes', () => {
    const transaction = keysInExceptionSection('transaction');
    const configuration = keysInExceptionSection('configuration');

    expect(transaction).toContain('order.void');
    expect(transaction).toContain('payment.refund');
    // An owner scanning for till fraud should not page through menu edits.
    expect(configuration).toContain('menu.price.edit');
    expect(configuration).toContain('recipe.edit');
    expect(configuration).toContain('supplier.create');
    expect(transaction).not.toContain('menu.price.edit');

    expect(riskSubclassOf('menu.price.edit')).toBe('configuration');
    expect(riskSubclassOf('order.void')).toBe('transaction');
    expect(riskSubclassOf('branch.view')).toBeNull();
  });

  it('refuses a subclass on a non-financial key at the database', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform.permission (key, module, name, risk_class, risk_subclass)
         VALUES ('probe.bad.key', 'probe', 'Probe', 'escalation', 'transaction')`,
      ),
    ).rejects.toThrow(/financial_has_subclass/);
  });
});
