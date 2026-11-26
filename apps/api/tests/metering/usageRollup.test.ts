import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { rollUpUsage, verifyRollup, METRICS } from '../../src/modules/metering/usageRollup.js';
import { quotaBreachesForPlan } from '../../src/modules/billing/scheduledChange.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
/** The rollup runs as the APPLICATION role, under RLS. That is the point. */
let app: pg.Client;
let superAdminId: string, planVersionId: string, smallPlanVersionId: string;
let tenantA: string, tenantB: string, branchA: string, userA: string;

const DATE = '2026-06-15';
/** Scoped so this suite's global job cannot block another suite's teardown. */
let SCOPE: string[];

async function makeTenant(name: string): Promise<{ tenantId: string; branchId: string; userId: string }> {
  const key = `use-${randomUUID()}`;
  await owner.query('BEGIN');
  const r = await provisionTenant(owner, {
    idempotencyKey: key, slug: `u${key.slice(4, 12)}`, name,
    currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
    ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
    taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  });
  await owner.query('COMMIT');
  return { tenantId: r.tenantId, branchId: r.firstBranchId, userId: r.ownerUserId };
}

async function makeOrder(tenantId: string, branchId: string, userId: string, date: string) {
  const sessionId = randomUUID(), orderId = randomUUID();
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,$5)`, [sessionId, tenantId, branchId, date, userId]);
  await owner.query(
    `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6)`, [orderId, tenantId, branchId, sessionId, date, userId]);
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = new pg.Client({ connectionString: process.env['DATABASE_URL_APP']! });
  await app.connect();

  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `use+${superAdminId}@p.test`, roleId]);

  for (const [key, limits] of [
    ['use_big', { branches: 10, 'orders.created': 10000 }],
    ['use_small', { branches: 1, 'orders.created': 5 }],
  ] as const) {
    await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,$2,$2)
      ON CONFLICT (key) DO NOTHING`, [randomUUID(), key]);
    const planId = (await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan WHERE key=$1`, [key])).rows[0]!.id;
    await owner.query(
      `INSERT INTO platform.plan_version
         (id,plan_id,version,price_minor,currency,billing_period,published_at,limits)
       VALUES ($1,$2,1,100000,'INR','monthly',now(),$3::jsonb)
       ON CONFLICT (plan_id,version) DO NOTHING`,
      [randomUUID(), planId, JSON.stringify(limits)]);
    const vid = (await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;
    if (key === 'use_big') planVersionId = vid; else smallPlanVersionId = vid;
  }

  const a = await makeTenant('Usage A');
  tenantA = a.tenantId; branchA = a.branchId; userA = a.userId;
  tenantB = (await makeTenant('Usage B')).tenantId;
  SCOPE = [tenantA, tenantB];
});

afterAll(async () => { await app?.end(); await owner?.end(); });

describe('A. the usage rollup', () => {
  it('writes every declared metric for every active tenant', async () => {
    const result = await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });

    expect(result.failures, JSON.stringify(result.failures)).toEqual([]);
    expect(result.tenantsProcessed).toBeGreaterThanOrEqual(2);
    expect(result.rowsWritten).toBe(result.tenantsProcessed * METRICS.length);

    // The postcondition is asserted against the DATABASE, not against what the
    // loop believes it did.
    expect(await verifyRollup(app, { asOfDate: DATE, tenantIds: SCOPE })).toEqual([]);
  });

  it('counts orders on the BUSINESS date, not around it', async () => {
    for (let i = 0; i < 3; i += 1) await makeOrder(tenantA, branchA, userA, DATE);
    await makeOrder(tenantA, branchA, userA, '2026-06-16');

    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });
    const row = await owner.query<{ value: string; metric_kind: string }>(
      `SELECT value::text, metric_kind FROM platform.usage_counter
        WHERE tenant_id=$1 AND metric='orders.created' AND as_of_date=$2::date`,
      [tenantA, DATE]);
    expect(Number(row.rows[0]!.value)).toBe(3);
    expect(row.rows[0]!.metric_kind).toBe('flow');
  });

  it('is idempotent: a retry recomputes rather than double-counting', async () => {
    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });
    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });
    const row = await owner.query<{ value: string; n: string }>(
      `SELECT max(value)::text AS value, count(*)::text AS n
         FROM platform.usage_counter
        WHERE tenant_id=$1 AND metric='orders.created' AND as_of_date=$2::date`,
      [tenantA, DATE]);
    // Re-adding a day's orders to itself is invisible in the number, which is
    // exactly why this is asserted rather than assumed.
    expect(Number(row.rows[0]!.value)).toBe(3);
    expect(Number(row.rows[0]!.n)).toBe(1);
  });

  it('keeps tenants separate, because it runs under RLS and not as the owner', async () => {
    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });
    const b = await owner.query<{ value: string }>(
      `SELECT value::text FROM platform.usage_counter
        WHERE tenant_id=$1 AND metric='orders.created' AND as_of_date=$2::date`,
      [tenantB, DATE]);
    // Tenant B has no orders. An owner-run rollup with a missing predicate would
    // report tenant A's three here; under RLS the worst a bug does is count zero.
    expect(Number(b.rows[0]!.value)).toBe(0);

    const who = await app.query<{ u: string; bypass: boolean }>(
      `SELECT current_user AS u, rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = current_user`);
    expect(who.rows[0]).toEqual({ u: 'katkitchen_app', bypass: false });
  });

  it('reports a missing period rather than exiting quietly', async () => {
    const missing = await verifyRollup(app, { asOfDate: '2026-06-20', tenantIds: SCOPE });
    expect(missing.length).toBeGreaterThan(0);
    // Named per tenant/metric so an operator knows what did not run.
    expect(missing[0]).toMatch(/^[0-9a-f-]{36}:[a-z._]+$/);
  });

  it('refuses a metric nobody declared', async () => {
    // Denied until justified: a new metric must be declared in
    // platform.usage_metric with its kind before a counter row can exist.
    await expect(owner.query(
      `INSERT INTO platform.usage_counter (tenant_id,metric,metric_kind,as_of_date,value)
       VALUES ($1,'invented.metric','level',$2::date,1)`, [tenantA, DATE]))
      .rejects.toThrow(/usage_counter_metric_fk/);
  });

  it('refuses a metric written under the wrong kind', async () => {
    // The pair is pinned, so a flow cannot be written as a level and then read
    // as the latest value.
    await expect(owner.query(
      `INSERT INTO platform.usage_counter (tenant_id,metric,metric_kind,as_of_date,value)
       VALUES ($1,'orders.created','level',$2::date,1)`, [tenantA, '2026-07-01']))
      .rejects.toThrow(/usage_counter_metric_fk/);
  });

  it('declares every metric it writes, both directions', async () => {
    const declared = await owner.query<{ metric: string; metric_kind: string }>(
      `SELECT metric, metric_kind FROM platform.usage_metric ORDER BY metric`);
    const declaredNames = declared.rows.map((r) => r.metric);

    assertCheckedSet({
      label: 'declared usage metrics',
      checked: declaredNames,
      minimum: 4,
      mustInclude: ['branches', 'users', 'orders.created', 'storage_bytes'],
    });

    // No metric written by the job that is not declared...
    expect(METRICS.map((m) => m.metric).filter((m) => !declaredNames.includes(m))).toEqual([]);
    // ...and no declared metric the job never writes, which would leave a
    // permanent hole in verifyRollup and fail the job forever.
    const written = new Set(METRICS.map((m) => m.metric));
    expect(declaredNames.filter((m) => !written.has(m))).toEqual([]);

    // And the kinds agree between the code and the table.
    const byName = new Map(declared.rows.map((r) => [r.metric, r.metric_kind]));
    expect(METRICS.filter((m) => byName.get(m.metric) !== m.kind)).toEqual([]);
  });
});

describe('A. the quota check now has something to read', () => {
  it('BLOCKS a downgrade that would leave the tenant over a LEVEL limit', async () => {
    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });
    // Usage A has one branch; the small plan allows one. Add a second.
    await owner.query(
      `INSERT INTO app.branch (id,tenant_id,code,name,timezone,gst_registration)
       VALUES (gen_random_uuid(),$1,'second','Second','Asia/Kolkata','unstated')`, [tenantA]);
    await rollUpUsage(app, { asOfDate: DATE, tenantIds: SCOPE });

    const breaches = await quotaBreachesForPlan(owner, {
      tenantId: tenantA, planVersionId: smallPlanVersionId });
    expect(breaches.find((b) => b.metric === 'branches'))
      .toEqual({ metric: 'branches', current: 2, allowed: 1 });
  });

  it('SUMS a flow across the period instead of reading one day', async () => {
    // Three orders a day for three days against a limit of five a month. Reading
    // the latest row alone reports 3 and passes; summing reports 9 and blocks.
    for (const date of ['2026-06-13', '2026-06-14']) {
      for (let i = 0; i < 3; i += 1) await makeOrder(tenantA, branchA, userA, date);
      await rollUpUsage(app, { asOfDate: date, tenantIds: SCOPE });
    }

    const daily = await owner.query<{ value: string }>(
      `SELECT value::text FROM platform.usage_counter
        WHERE tenant_id=$1 AND metric='orders.created' AND as_of_date='2026-06-14'`,
      [tenantA]);
    expect(Number(daily.rows[0]!.value)).toBe(3);

    // A long window so the fixture dates are inside it.
    const breaches = await quotaBreachesForPlan(owner, {
      tenantId: tenantA, planVersionId: smallPlanVersionId, periodDays: 4000 });
    const orders = breaches.find((b) => b.metric === 'orders.created');
    expect(orders, 'a flow must be summed, not read as its latest day').toBeDefined();
    expect(orders!.current).toBeGreaterThanOrEqual(9);
    expect(orders!.allowed).toBe(5);
  });
});

describe('A. the plane boundary', () => {
  it('lets nothing but a metric name and an integer cross upward', async () => {
    const columns = await owner.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='platform' AND table_name='usage_counter' ORDER BY column_name`);

    assertCheckedSet({
      label: 'usage_counter columns',
      checked: columns.rows.map((c) => c.column_name),
      minimum: 6,
      mustInclude: ['tenant_id', 'metric', 'metric_kind', 'as_of_date', 'value', 'recorded_at'],
    });

    // THE POINT: there is no column an item name, a customer or a row id could
    // travel in. A leak would require a migration, not a mistake.
    const freeText = columns.rows.filter(
      (c) => c.data_type === 'jsonb' || /name|label|detail|payload|note/.test(c.column_name));
    expect(freeText).toEqual([]);
  });

  it('keeps the control plane out of the fine-grained tenant tables', () => {
    // The rollup is the ONE place that reads them, and it lives outside
    // modules/platform, modules/notifications and modules/billing precisely so this assertion stays simple.
    const FINE_GRAINED = ['app.sales_order', 'app.order_line', 'app.bill_line',
                          'app.tender', 'app.stock_movement', 'app.kot_line'];
    const offenders: string[] = [];

    for (const dir of [
      // The control plane: platform, its outbox delivery (notifications) and
      // subscription billing. A new control-plane module must be added here.
      'src/modules/platform', 'src/modules/notifications', 'src/modules/billing',
    ]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const code = readFileSync(`${dir}/${file}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        for (const table of FINE_GRAINED) {
          if (code.includes(table)) offenders.push(`${dir}/${file}: ${table}`);
        }
      }
    }
    expect(offenders, 'the control plane never queries the orders table').toEqual([]);

    // Non-vacuity: the scan must actually have read something.
    expect(readdirSync('src/modules/billing').filter((f) => f.endsWith('.ts')).length)
      .toBeGreaterThanOrEqual(5);
  });

  it('runs the rollup as the app role, never the owner', () => {
    const code = readFileSync('src/modules/metering/usageRollup.ts', 'utf8');
    // Under RLS the worst a predicate bug can do is count nothing. As the owner
    // it could merge two tenants into one number, silently.
    expect(code).toMatch(/DATABASE_URL_APP/);
    expect(code).not.toMatch(/DATABASE_URL_OWNER/);
    expect(code).toMatch(/set_config\(\$1, \$2, true\)/);
  });
});
