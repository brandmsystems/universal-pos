import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { planeGuard } from '../../src/middleware/security/planeGuards.js';
import { registerTenantRoute, resetRegistry } from '../../src/middleware/routeRegistry.js';
import { ERROR_CONTRACT, toErrorResponse } from '../../src/utils/errors/errors.js';
import { adminRoutes } from '../../src/routes/index.js';
import { reportHandlers } from '../../src/routes/handlers/reports.js';
import { isUnserved } from '../../src/routes/lookup.js';
import { ADMIN_RESOURCES } from '../../src/modules/businesses/adminResources.js';
import { ensureAuditPartitionFor } from '../../src/database/partitions.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import { planCache } from '../helpers/plans.js';

/**
 * The reporting, privacy and print surface, over HTTP.
 *
 * ###########################################################################
 * WHAT IS ASSERTED HERE THAT THE DOMAIN TESTS CANNOT ASSERT.
 *
 * tests/reporting/reports.test.ts already proves the FIGURES: the sign
 * convention, the combo allocation, the baseline ranking, the reconciliation.
 * None of that is repeated. What only exists at this layer is:
 *
 *   scope        the branch a report reads comes from the VERIFIED TOKEN. A
 *                report that took `?branchId=` would be scoped by a value the
 *                caller controls, and it would answer 200.
 *   logging      reading a report is not an event and must write no audit row;
 *                reading a person's phone number IS one and must write exactly
 *                one row of app.pii_access_log, attributed to the token's
 *                actor. Both halves are asserted -- one without the other
 *                proves nothing, because "no rows anywhere" satisfies half of
 *                it and "rows everywhere" satisfies the other.
 *   honesty      an export refuses a range it cannot serve completely rather
 *                than returning the part of it that exists.
 * ###########################################################################
 */

const KEY = 'report-surface-signing-key';

/**
 * ###########################################################################
 * THE ERROR CODES THIS SURFACE RAISES, AND WHY THEY ARE LISTED HERE.
 *
 * src/utils/errors/errors.ts is owned by the integration and does not carry these
 * mappings yet, so `toErrorResponse` would answer 500 internal_error for every
 * one of them -- which would make these assertions test the fallback instead of
 * the refusal. The overlay below stands in until ERROR_CONTRACT gains the
 * entries, and it is deliberately BELOW the real contract: once a code is
 * mapped for real, the real mapping is what answers and the overlay is dead.
 *
 * The last test in this file is what keeps the two honest -- for any code that
 * ERROR_CONTRACT already has, the status asserted here must be the status the
 * contract states. A drift between them fails rather than being papered over.
 * ###########################################################################
 */
const PROPOSED_STATUS: Readonly<Record<string, number>> = {
  report_range_invalid: 400,
  report_range_unservable: 422,
  report_branch_required: 400,
  report_dimension_unknown: 400,
  stock_count_required: 400,
  pii_subject_not_found: 404,
  pii_reason_required: 422,
  pii_export_too_wide: 422,
};

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let tenantId: string, branchId: string, otherBranchId: string, userId: string;
let waiterId: string, stationId: string, otherStationId: string;
let customerId: string, otherTenantCustomerId: string;
let taxClassId: string, categoryId: string;
let otherTenantId: string, otherTenantBranchId: string, otherTenantUserId: string;
let sessionId: string, orderId: string, mainLineId: string;
let otherBranchSessionId: string, otherBranchLineId: string;

const DAY_MS = 86_400_000;
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

/** A window entirely in the past, so every business date in it is closed. */
const FROM = day(-8);
const TO = day(-2);
const SALE_DATE = day(-5);
/** Past the branch's clock in every timezone, so it can never be a closed day. */
const OPEN_TO = day(1);

const RECIPIENT_GSTIN = '29AABCU9603R1ZM';
const SUPPLIER_GSTIN = '29AAACT2727Q1ZW';

function token(overrides: Record<string, unknown> = {}): string {
  return signToken(
    { sub: userId, tenant_id: tenantId, branch_id: branchId,
      exp: Math.floor(Date.now() / 1000) + 600, ...overrides },
    KEY,
  );
}

async function send(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  claims: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method, url: `/api/t${url}`,
    headers: {
      authorization: `Bearer ${token(claims)}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function countRows(table: string, predicate: string, args: unknown[]): Promise<number> {
  const result = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${predicate}`, args);
  return Number(result.rows[0]!.n);
}

async function makeTenant(
  planVersionId: string, superAdminId: string, label: string,
): Promise<{ tenantId: string; branchId: string; userId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `rs${label}-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `s${key.slice(3, 12)}`.toLowerCase(), name: `Report ${label}`,
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [r.ownerUserId]);
    return { tenantId: r.tenantId, branchId: r.firstBranchId, userId: r.ownerUserId };
  } finally { client.release(); }
}

/** A menu item in this tenant. Priced, because a sold line snapshots the price. */
async function makeItem(tenant: string, category: string, tax: string, name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_item (id,tenant_id,category_id,kind,key,name,price_minor,
       tax_class_id,station_code)
     VALUES ($1,$2,$3,'single',$4,$5,20000,$6,'grill')`,
    [id, tenant, category, `i${id.replace(/-/g, '').slice(0, 10)}`, name, tax]);
  return id;
}

/** One session, one order, one sold line, on a business date. */
async function makeSale(opts: {
  tenant: string; branch: string; user: string; itemId: string; name: string;
  lineTotal: number; date: string;
}): Promise<{ sessionId: string; orderId: string; lineId: string }> {
  const session = randomUUID(), order = randomUUID(), line = randomUUID();
  await owner.query(
    `INSERT INTO app.table_session
       (id,tenant_id,branch_id,business_date,guest_count,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,2,$5)`,
    [session, opts.tenant, opts.branch, opts.date, opts.user]);
  await owner.query(
    `INSERT INTO app.sales_order
       (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6)`,
    [order, opts.tenant, opts.branch, session, opts.date, opts.user]);
  await owner.query(
    `INSERT INTO app.order_line
       (id,tenant_id,branch_id,order_id,kind,menu_item_id,display_name,unit_price_minor,
        quantity,line_total_minor,tax_rate_bps,created_by_user_id)
     VALUES ($1,$2,$3,$4,'item',$5,$6,$7,1,$7,500,$8)`,
    [line, opts.tenant, opts.branch, order, opts.itemId, opts.name, opts.lineTotal, opts.user]);
  return { sessionId: session, orderId: order, lineId: line };
}

/** A failed print job, which needs the fire and the ticket it belongs to. */
async function makeFailedPrintJob(opts: {
  branch: string; station: string; orderId: string; fireNo: number; reason: string;
}): Promise<string> {
  const printerId = randomUUID(), fireId = randomUUID(), kotId = randomUUID();
  const jobId = randomUUID();
  await owner.query(
    `INSERT INTO app.printer (id,tenant_id,branch_id,name,connection_kind,address)
     VALUES ($1,$2,$3,'Grill Printer','network','10.0.0.7')`,
    [printerId, tenantId, opts.branch]);
  await owner.query(
    `INSERT INTO app.kot_fire (id,tenant_id,branch_id,order_id,business_date,fire_no,
       fired_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7)`,
    [fireId, tenantId, opts.branch, opts.orderId, SALE_DATE, opts.fireNo, userId]);
  await owner.query(
    `INSERT INTO app.kot (id,tenant_id,branch_id,fire_id,station_id,business_date,sequence_no)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
    [kotId, tenantId, opts.branch, fireId, opts.station, SALE_DATE, opts.fireNo]);
  await owner.query(
    `INSERT INTO app.print_job
       (id,tenant_id,branch_id,kot_id,printer_id,status,attempts,max_attempts,failure_reason)
     VALUES ($1,$2,$3,$4,$5,'failed',4,4,$6)`,
    [jobId, tenantId, opts.branch, kotId, printerId, opts.reason]);
  return jobId;
}

/**
 * A bill and its line, in ONE transaction: `bill_invariants` and
 * `bill_line_invariants` are DEFERRABLE INITIALLY DEFERRED and fire at COMMIT,
 * so a bill inserted under autocommit is checked against an empty line set.
 */
async function makeBill(opts: {
  branch: string; session: string; orderLineId: string; billNo: number;
  taxable: number; cgst: number; sgst: number; b2b: boolean;
}): Promise<string> {
  const billId = randomUUID();
  const tax = opts.cgst + opts.sgst;
  await owner.query('BEGIN');
  await owner.query(
    `INSERT INTO app.bill
       (id,tenant_id,branch_id,session_id,business_date,bill_no,split_kind,
        subtotal_minor,tax_minor,total_minor,generated_by_user_id,
        recipient_gstin,recipient_legal_name,place_of_supply_state_code,supplier_gstin,
        supplier_state_code,recipient_state_code,tax_treatment,tax_jurisdiction,premises_class,tax_account_type,prices_include_tax,currency)
     VALUES ($1,$2,$3,$4,$5::date,$6,'whole',$7,$8,$9,$10,$11,$12,'29',$13,'29',$14,$15,'IN','standard','gst',false,'INR')`,
    [billId, tenantId, opts.branch, opts.session, SALE_DATE, opts.billNo,
     opts.taxable, tax, opts.taxable + tax, userId,
     opts.b2b ? RECIPIENT_GSTIN : null, opts.b2b ? 'Acme Foods Private Limited' : null,
     SUPPLIER_GSTIN,
     opts.b2b ? RECIPIENT_GSTIN.slice(0, 2) : null,
     tax === 0 ? 'none' : 'intra_state']);
  await owner.query(
    `INSERT INTO app.bill_line
       (id,tenant_id,bill_id,order_line_id,share_bps,display_name,amount_minor,
        tax_minor,tax_rate_bps,tax_components)
     VALUES ($1,$2,$3,$4,10000,'Biryani',$5,$6,500,$7::jsonb)`,
    [randomUUID(), tenantId, billId, opts.orderLineId, opts.taxable, tax,
     JSON.stringify([
       { name: 'CGST', rate_bps: 250, amount_minor: opts.cgst },
       { name: 'SGST', rate_bps: 250, amount_minor: opts.sgst },
     ])]);
  await owner.query('COMMIT');
  return billId;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);
  // The registrar writes an audit row at now() for the two PII routes. Without
  // this month's partition those land in the DEFAULT, which the per-file hook
  // refuses -- and rightly: a permanently dirty default is an alert nobody can
  // ever trust again.
  await ensureAuditPartitionFor(owner, new Date().toISOString());

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `rs+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'rs_plan','RS')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='rs_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const primary = await makeTenant(planVersionId, superAdminId, 'a');
  tenantId = primary.tenantId; branchId = primary.branchId; userId = primary.userId;

  // A SECOND TENANT with its own sales. Nothing this suite asks for may ever
  // reach it -- including the tenant-wide read, which is the widest one there is.
  const other = await makeTenant(planVersionId, superAdminId, 'b');
  otherTenantId = other.tenantId;
  otherTenantBranchId = other.branchId;
  otherTenantUserId = other.userId;

  otherBranchId = randomUUID();
  await owner.query(
    `INSERT INTO app.branch (id,tenant_id,code,name,timezone,gstin,state_code,gst_registration)
     VALUES ($1,$2,'airport','Airport','Asia/Kolkata',$3,'29','registered')`,
    [otherBranchId, tenantId, SUPPLIER_GSTIN]);
  await owner.query(
    `UPDATE app.branch SET gstin=$2, state_code='29', gst_registration='registered' WHERE id=$1`, [branchId, SUPPLIER_GSTIN]);

  waiterId = randomUUID();
  await owner.query(
    `INSERT INTO app.app_user (id,tenant_id,full_name,email,phone,employee_code,status)
     VALUES ($1,$2,'Ravi Waiter',$3,'+91 98200 11111','W01','active')`,
    [waiterId, tenantId, `ravi+${waiterId}@staff.test`]);

  // ###################################################################
  // THE REVEAL'S SUBJECT IS A CUSTOMER NOW, WHICH IS WHY THIS EXISTS.
  //
  // These tests used to reveal the WAITER through `/admin/customers/:id/contact`
  // -- not by mistake in the test, but because `src/modules/privacy/piiAccess.ts` said
  // in writing that it had no customer table to read and used `app_user`
  // instead. Migration 0049 created it, so the fixture is a diner.
  //
  // The phone is stored NORMALISED (digits, country code, no punctuation),
  // which is what `normalisePhone` produces and what the column's CHECK
  // demands. The reveal formats it back to `+91 98765 43210` on the way out.
  // ###################################################################
  customerId = randomUUID();
  await owner.query(
    `INSERT INTO app.customer (id,tenant_id,phone,display_name)
     VALUES ($1,$2,'919820011111','Priya Diner')`,
    [customerId, tenantId]);

  otherTenantCustomerId = randomUUID();
  await owner.query(
    `INSERT INTO app.customer (id,tenant_id,phone,display_name)
     VALUES ($1,$2,'919820022222','Other Tenant Diner')`,
    [otherTenantCustomerId, otherTenantId]);

  for (const tenant of [tenantId, otherTenantId]) {
    await owner.query(
      `INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')
       ON CONFLICT DO NOTHING`, [tenant]);
  }
  stationId = randomUUID();
  otherStationId = randomUUID();
  await owner.query(
    `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name)
     VALUES ($1,$2,$3,'grill','Grill (main)'), ($4,$2,$5,'grill','Grill (airport)')`,
    [stationId, tenantId, branchId, otherStationId, otherBranchId]);

  taxClassId = randomUUID();
  await owner.query(
    `INSERT INTO app.tax_class (id,tenant_id,key,name,rate_bps) VALUES ($1,$2,'food_5','Food',500)`,
    [taxClassId, tenantId]);
  categoryId = randomUUID();
  await owner.query(
    `INSERT INTO app.menu_category (id,tenant_id,key,name,display_order)
     VALUES ($1,$2,'mains','Mains',1)`, [categoryId, tenantId]);

  const biryani = await makeItem(tenantId, categoryId, taxClassId, 'Biryani');
  const airportBiryani = await makeItem(tenantId, categoryId, taxClassId, 'Airport Biryani');

  const mainSale = await makeSale({
    tenant: tenantId, branch: branchId, user: userId, itemId: biryani,
    name: 'Biryani', lineTotal: 40000, date: SALE_DATE });
  sessionId = mainSale.sessionId; orderId = mainSale.orderId; mainLineId = mainSale.lineId;

  const airportSale = await makeSale({
    tenant: tenantId, branch: otherBranchId, user: userId, itemId: airportBiryani,
    name: 'Airport Biryani', lineTotal: 70000, date: SALE_DATE });
  otherBranchSessionId = airportSale.sessionId;
  otherBranchLineId = airportSale.lineId;

  // The other tenant's own catalogue and sale, with a label nothing here may see.
  const otherTax = randomUUID(), otherCategory = randomUUID();
  await owner.query(
    `INSERT INTO app.tax_class (id,tenant_id,key,name,rate_bps) VALUES ($1,$2,'food_5','Food',500)`,
    [otherTax, otherTenantId]);
  await owner.query(
    `INSERT INTO app.menu_category (id,tenant_id,key,name,display_order)
     VALUES ($1,$2,'mains','Mains',1)`, [otherCategory, otherTenantId]);
  const otherItem = await makeItem(otherTenantId, otherCategory, otherTax, 'ANOTHER TENANT DOSA');
  await makeSale({
    tenant: otherTenantId, branch: otherTenantBranchId, user: otherTenantUserId,
    itemId: otherItem, name: 'ANOTHER TENANT DOSA', lineTotal: 999_999, date: SALE_DATE });

  await makeFailedPrintJob({
    branch: branchId, station: stationId, orderId,
    fireNo: 1, reason: 'grill printer offline' });
  await makeFailedPrintJob({
    branch: otherBranchId, station: otherStationId, orderId: airportSale.orderId,
    fireNo: 2, reason: 'airport printer jammed' });

  await makeBill({
    branch: branchId, session: sessionId, orderLineId: mainLineId, billNo: 1,
    taxable: 40000, cgst: 1000, sgst: 1000, b2b: true });
  await makeBill({
    branch: otherBranchId, session: otherBranchSessionId, orderLineId: otherBranchLineId,
    billNo: 1, taxable: 70000, cgst: 1750, sgst: 1750, b2b: false });

  resetRegistry();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const mapped = toErrorResponse(error);
    const code = (error as { code?: unknown }).code;
    // The real contract wins wherever it has an opinion; the overlay covers the
    // codes it does not carry yet. See PROPOSED_STATUS.
    if (mapped.body.error === 'internal_error' && typeof code === 'string'
        && code in PROPOSED_STATUS) {
      void reply.code(PROPOSED_STATUS[code]!)
        .send({ error: code, retryable: false, detail: mapped.body.detail });
      return;
    }
    void reply.code(mapped.status).send(mapped.body);
  });
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', KEY));
    for (const route of adminRoutes(reportHandlers())) {
      if (isUnserved(route.handler)) continue;
      registerTenantRoute(scope, { pool, entitlements: planCache() }, route);
    }
  }, { prefix: '/api/t' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

/* ------------------------------------------------------- the surface itself --- */

describe('the surface serves exactly the six routes it claims', () => {
  it('supplies every handler name the route table asks for, and no others', () => {
    assertCheckedSet({
      label: 'report handler names',
      checked: Object.keys(reportHandlers()),
      minimum: 6,
      mustInclude: ['salesReport', 'salesExport', 'staffReport',
                    'exceptionReport', 'gstReturn', 'printFailures'],
    });
    expect(Object.keys(reportHandlers())).toHaveLength(6);
  });

  it('leaves no report route on the stub', () => {
    const reportRoutes = adminRoutes(reportHandlers()).filter((route) =>
      route.url.startsWith('/admin/reports')
      // '/admin/print/' with the slash: '/admin/printers' is the CRUD resource
      // and belongs to another surface entirely.
      || route.url.startsWith('/admin/print/'));
    expect(reportRoutes).toHaveLength(6);
    const stubbed = reportRoutes.filter((r) => isUnserved(r.handler)).map((r) => r.url);
    expect(stubbed, 'a stubbed report answers 200 with {ok:true}').toEqual([]);
  });
});

/* ---------------------------------------------------- dashboard extras --- */

describe('the two dashboard reads are REACHABLE, which is the whole point', () => {
  /**
   * #######################################################################
   * WRITTEN, TESTED, AND JOINED TO NOTHING.
   *
   * `paymentMix` and `salesSummaryCompared` were built with gates in
   * tests/reporting/reports.test.ts and exposed by NO route -- the same shape
   * as `requireLease`, the raw-SQL gate and the fire claim before them: a
   * correct function with one caller, and that caller a test.
   *
   * These assertions go through the HTTP surface for that reason. A domain test
   * cannot tell you a route exists.
   * #######################################################################
   */
  it('omits both unless asked, so no existing caller pays for them', async () => {
    const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${TO}`);
    expect(result.status).toBe(200);
    // Null, not an empty array: "not asked for" and "none in the period" are
    // different answers and a dashboard renders them differently.
    expect(result.body['payments']).toBeNull();
    expect(result.body['comparison']).toBeNull();
  });

  it('serves the payment mix when asked', async () => {
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&payments=1`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(Array.isArray(result.body['payments'])).toBe(true);
  });

  it('serves the period before, computed in the domain rather than by the caller',
    async () => {
      const result = await send('GET',
        `/admin/reports/sales?from=${FROM}&to=${TO}&compare=previous`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const comparison = result.body['comparison'] as {
        window: { fromDate: string; toDate: string };
        previous: { netMinor: number };
        delta: { netPct: number | null };
      };
      // Same length, ending the day before this window starts.
      expect(comparison.window.toDate < FROM).toBe(true);
      expect(comparison.previous).not.toBeNull();
      // No trade in that window, so the delta has NO BASELINE and is null --
      // not 0, which would read as "flat", and not Infinity.
      expect(comparison.previous.netMinor).toBe(0);
      expect(comparison.delta.netPct).toBeNull();
    });

  it('accepts an explicit comparison window', async () => {
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&compareFrom=${FROM}&compareTo=${TO}`);
    expect(result.status).toBe(200);
    const comparison = result.body['comparison'] as { delta: { netPct: number | null } };
    // Compared with itself: flat, and that zero is real rather than a stand-in
    // for absence.
    expect(comparison.delta.netPct).toBe(0);
  });

  it('refuses half a comparison window instead of guessing the other half', async () => {
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&compareFrom=${FROM}`);
    // 400 rather than 422: the range is malformed, not semantically refused —
    // the status comes from ERROR_CONTRACT's entry for report_range_invalid.
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain('compareFrom and compareTo');
  });

  it('refuses a comparison mode it does not understand', async () => {
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&compare=lastyear`);
    expect(result.status).toBe(400);
    // Named, with what IS understood, because a silently ignored parameter is a
    // dashboard showing a comparison the owner did not ask for.
    expect(JSON.stringify(result.body)).toContain('compare=previous');
  });
});

/* -------------------------------------------------------------------- scope --- */

describe('every report is scoped to the branch on the token', () => {
  it('reads only the token branch when the token names one', async () => {
    const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${TO}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['branchId']).toBe(branchId);

    const dimensions = result.body['dimensions'] as Record<string, { label: string }[]>;
    const labels = dimensions['item']!.map((row) => row.label);
    expect(labels).toContain('Biryani');
    // The airport branch is in the SAME tenant, so nothing but the branch scope
    // keeps it out. This is the assertion a `?branchId=` parameter would break
    // while still answering 200.
    expect(labels).not.toContain('Airport Biryani');
    expect((result.body['summary'] as { netMinor: number }).netMinor).toBe(40000);
  });

  it('reads the whole tenant when the token names no branch, which is the admin session',
    async () => {
      const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${TO}`,
        undefined, { branch_id: null });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body['branchId']).toBeNull();

      const dimensions = result.body['dimensions'] as Record<string, { label: string }[]>;
      const labels = dimensions['item']!.map((row) => row.label);
      expect(labels).toContain('Biryani');
      expect(labels, 'a tenant-level session sees every branch, deliberately')
        .toContain('Airport Biryani');
      expect((result.body['summary'] as { netMinor: number }).netMinor).toBe(110000);
    });

  it('does NOT reach another tenant, even on the widest read there is', async () => {
    // The wider read is the dangerous one: a missing branch predicate is visible
    // in a total, a missing TENANT predicate is invisible until it is somebody
    // else's data on the screen.
    const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${TO}`,
      undefined, { branch_id: null });
    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain('ANOTHER TENANT DOSA');
    expect(serialised).not.toContain(otherTenantBranchId);
    // And the arithmetic agrees: 999999 would be unmistakable in the total.
    expect((result.body['summary'] as { netMinor: number }).netMinor).toBe(110000);
  });

  it('says on its face that a tenant-wide read has no single business-day clock',
    async () => {
      const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${TO}`,
        undefined, { branch_id: null });
      const caveats = result.body['caveats'] as { kind: string }[];
      expect(caveats.map((c) => c.kind)).toContain('branch_clock_unknown');
    });

  it('scopes the print failure list to the token branch', async () => {
    const result = await send('GET', '/admin/print/failures');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const failures = result.body['failures'] as { failureReason: string; stationName: string }[];
    expect(failures.map((f) => f.failureReason)).toEqual(['grill printer offline']);
    expect(failures[0]!.stationName).toBe('Grill (main)');
  });

  it('scopes the staff report to the token branch', async () => {
    const result = await send('GET', `/admin/reports/staff?from=${FROM}&to=${TO}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((result.body['summary'] as { netMinor: number }).netMinor).toBe(40000);
    // Labelled for the attribution it actually uses, rather than the one the
    // registry describes. See the delivery note on staff.activity.
    expect(result.body['attribution']).toBe('order_line.created_by_user_id');
  });

  it('refuses a per-branch report outright when the session names no branch', async () => {
    // Not "pick the first branch" and not "read them all": an outward-supply
    // return is filed per registration, and a print queue belongs to one kitchen.
    for (const url of [
      `/admin/reports/tax/outward-supply?from=${FROM}&to=${TO}`,
      `/admin/reports/sales/export?from=${FROM}&to=${TO}`,
      '/admin/print/failures',
    ]) {
      const result = await send('GET', url, undefined, { branch_id: null });
      expect(result.status, url).toBe(400);
      expect(result.body['error'], url).toBe('report_branch_required');
    }
  });
});

/* ------------------------------------------------------------- the range --- */

describe('a report states the range it covers, and the range is checked', () => {
  it('refuses an absent, reversed, impossible or unbounded range', async () => {
    const cases: readonly [string, string][] = [
      [`/admin/reports/sales`, 'no range at all'],
      [`/admin/reports/sales?from=${FROM}`, 'half a range'],
      [`/admin/reports/sales?from=${TO}&to=${FROM}`, 'reversed'],
      [`/admin/reports/sales?from=2026-02-30&to=2026-03-01`, 'not a calendar day'],
      [`/admin/reports/sales?from=last-tuesday&to=${TO}`, 'not a date'],
      [`/admin/reports/sales?from=2020-01-01&to=${TO}`, 'wider than the limit'],
    ];
    for (const [url, why] of cases) {
      const result = await send('GET', url);
      expect(result.status, why).toBe(400);
      expect(result.body['error'], why).toBe('report_range_invalid');
    }
  });

  it('refuses an unknown dimension rather than dropping it', async () => {
    // Dropping it silently is the failure: the section is missing and the report
    // reads as though there was nothing in it.
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&dimensions=item,invented`);
    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('report_dimension_unknown');
  });

  it('serves only the dimensions asked for', async () => {
    const result = await send('GET',
      `/admin/reports/sales?from=${FROM}&to=${TO}&dimensions=item,staff`);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body['dimensions'] as object).sort()).toEqual(['item', 'staff']);
  });

});

/* ----------------------------------------------------- the export refusal --- */

describe('an export refuses a range it cannot serve completely', () => {
  it('refuses a range that reaches into a business day still trading', async () => {
    // THE FAILURE THIS EXISTS FOR: an export taken at 6pm covering "today" is a
    // partial file that reads as a complete one, and it will not match itself
    // when it is run again tomorrow. Nothing on its face would say so.
    const result = await send('GET', `/admin/reports/sales/export?from=${FROM}&to=${OPEN_TO}`);
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(result.body['error']).toBe('report_range_unservable');
    expect(String(result.body['detail'])).toContain('still');
  });

  it('serves the same range when every day in it is closed', async () => {
    // The other half: the refusal must not be a blanket one, or the export is
    // simply broken and the test above proves nothing.
    const result = await send('GET', `/admin/reports/sales/export?from=${FROM}&to=${TO}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['rowCount']).toBe(1);
    expect(result.body['dimension']).toBe('item');
    expect((result.body['rows'] as { label: string }[])[0]!.label).toBe('Biryani');
  });

  it('applies the same rule to the tax return, which is filed', async () => {
    const result = await send('GET',
      `/admin/reports/tax/outward-supply?from=${FROM}&to=${OPEN_TO}`);
    expect(result.status).toBe(422);
    expect(result.body['error']).toBe('report_range_unservable');
  });

  it('shows the open day on the SCREEN, where a live figure is what was asked for',
    async () => {
      // A viewing report is allowed to include it -- "sales so far today" is a
      // real question -- but it says which day is still moving.
      const result = await send('GET', `/admin/reports/sales?from=${FROM}&to=${OPEN_TO}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const caveats = result.body['caveats'] as { kind: string }[];
      expect(caveats.map((c) => c.kind)).toContain('open_business_date');
    });
});

/* ------------------------------------------------------------ the tax return --- */

describe('the outward-supply return', () => {
  it('reconciles to the bills it came from, and is scoped to the branch', async () => {
    const result = await send('GET',
      `/admin/reports/tax/outward-supply?from=${FROM}&to=${TO}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['branchId']).toBe(branchId);

    const reconciliation = result.body['reconciliation'] as {
      matches: boolean; billTaxableMinor: number; returnTaxableMinor: number;
    };
    // 40000, not 110000: the airport branch's bill is in the same tenant.
    expect(reconciliation.billTaxableMinor).toBe(40000);
    expect(reconciliation.returnTaxableMinor).toBe(40000);
    expect(reconciliation.matches, 'a return that does not reconcile must not be filed')
      .toBe(true);

    const b2b = result.body['b2b'] as { recipientGstin: string }[];
    expect(b2b.map((s) => s.recipientGstin)).toEqual([RECIPIENT_GSTIN]);
  });

  it('never presents itself as ready to file while its rules are unreviewed', async () => {
    const result = await send('GET',
      `/admin/reports/tax/outward-supply?from=${FROM}&to=${TO}`);
    expect(result.body['awaitingReview'], 'a screen must not be able to show this as final')
      .toBe(true);
    const caveats = result.body['caveats'] as { kind: string; detail: string }[];
    expect(caveats.map((c) => c.kind)).toContain('place_of_supply_unreviewed');
    // `recipient_snapshot_never_written` was retired by migration 0050 and it
    // had to be: half of it was already false (supplier_gstin has been written
    // since phase 9) and the other half stopped being true when
    // POST /pos/bill/:id/recipient arrived. A caveat that overstates the gap is
    // as misleading as one that understates it -- a filer reading "no write path
    // populates recipient_gstin" would discount a B2B section that is now real.
    expect(caveats.map((c) => c.kind)).not.toContain('recipient_snapshot_never_written');
    expect(caveats.map((c) => c.kind)).toContain('b2b_capture_may_be_off');
    expect(caveats.map((c) => c.kind)).toContain('printed_heads_may_predate_0050');
  });
});

/* ------------------------------------------------ reading is not an event --- */

describe('a report writes no audit row, and the PII routes write the privacy log', () => {
  it('records nothing at all for a report read', async () => {
    const auditBefore = await countRows('app.tenant_audit_log', 'tenant_id=$1', [tenantId]);
    const piiBefore = await countRows('app.pii_access_log', 'tenant_id=$1', [tenantId]);

    for (const url of [
      `/admin/reports/sales?from=${FROM}&to=${TO}`,
      `/admin/reports/sales/export?from=${FROM}&to=${TO}`,
      `/admin/reports/staff?from=${FROM}&to=${TO}`,
      `/admin/reports/exception?from=${FROM}&to=${OPEN_TO}`,
      `/admin/reports/tax/outward-supply?from=${FROM}&to=${TO}`,
      '/admin/print/failures',
    ]) {
      const result = await send('GET', url);
      expect(result.status, url).toBe(200);
    }

    // Reading a report is not an event. Six reads, no rows, in EITHER log.
    expect(await countRows('app.tenant_audit_log', 'tenant_id=$1', [tenantId]))
      .toBe(auditBefore);
    expect(await countRows('app.pii_access_log', 'tenant_id=$1', [tenantId]))
      .toBe(piiBefore);
  });

});

describe('staff contact details stay out of the generic list', () => {
  it('leaves the generic users list without the email column', () => {
    // The reason this surface exists at all: the generic CRUD handler cannot
    // write app.pii_access_log, so it does not return the field. If that ever
    // changes, these two routes stop being the only way the column leaves.
    expect(ADMIN_RESOURCES['users']!.columns).not.toContain('email');
    expect(ADMIN_RESOURCES['users']!.columns).not.toContain('phone');
  });
});

/* ---------------------------------------------------------- the contract --- */

describe('the refusals this surface raises are real refusals', () => {
  it('agrees with ERROR_CONTRACT wherever the contract already carries the code', () => {
    // The overlay at the top of this file is scaffolding for codes the contract
    // does not carry yet. This is what stops it drifting from the real one once
    // they land: a disagreement fails here rather than being masked by the
    // overlay never firing.
    const drift: string[] = [];
    for (const [code, status] of Object.entries(PROPOSED_STATUS)) {
      const mapping = ERROR_CONTRACT[code];
      if (mapping && mapping.status !== status) {
        drift.push(`${code}: contract says ${mapping.status}, this suite asserts ${status}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('never answers a named refusal as 500 internal_error', async () => {
    // The fallback is correct and it must not be what carries this surface --
    // the defect that put 41 named domain refusals behind "internal error, do
    // not retry" was exactly this shape.
    const result = await send('GET', '/admin/reports/sales?from=nonsense&to=nonsense');
    expect(result.body['error']).not.toBe('internal_error');
    expect(result.status).toBeLessThan(500);
  });
});
