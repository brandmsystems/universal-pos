import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import pg from 'pg';
import { networkTransport } from '../../src/modules/business-types/restaurant/kitchen/printTransport.js';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import {
  printOnce, reclaimStale, verifyPrintDrain, requestReprint, renderTicket,
  branchPrintFailures, CLAIM_TIMEOUT_MS, type PrintTransport,
} from '../../src/modules/business-types/restaurant/kitchen/printWorker.js';
import { rollUpUsage } from '../../src/modules/metering/usageRollup.js';
import { PERMISSIONS } from '../../src/modules/authz/permissions.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let app: pg.Client;
let tenantId: string, branchId: string, userId: string;
let grillPrinter: string, coldPrinter: string, stationId: string;

const DATE = '2026-07-04';

/** Accepts everything. A real printer accepting bytes proves nothing either. */
const accepting: PrintTransport = { async send() { /* accepted */ } };
const refusing: PrintTransport = {
  async send() { throw new Error('ECONNREFUSED 10.0.0.7:9100'); },
};
function refusingOnly(printerId: string): PrintTransport {
  return {
    async send(p) {
      if (p.printerId === printerId) throw new Error('ECONNREFUSED 10.0.0.7:9100');
    },
  };
}
function capturing(): PrintTransport & { sent: { printerId: string; content: string }[] } {
  const sent: { printerId: string; content: string }[] = [];
  return { sent, async send(p) { sent.push(p); } };
}

async function makeKotWithJob(opts: { fallback?: boolean; maxAttempts?: number } = {}) {
  const sessionId = randomUUID(), orderId = randomUUID(), lineId = randomUUID();
  const fireId = randomUUID(), kotId = randomUUID(), jobId = randomUUID();

  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,$5)`, [sessionId, tenantId, branchId, DATE, userId]);
  await owner.query(
    `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6)`, [orderId, tenantId, branchId, sessionId, DATE, userId]);
  await owner.query(
    `INSERT INTO app.order_line (id,tenant_id,branch_id,order_id,kind,display_name,
       unit_price_minor,quantity,line_total_minor,created_by_user_id)
     VALUES ($1,$2,$3,$4,'item','Tandoori Chicken',30000,2,60000,$5)`,
    [lineId, tenantId, branchId, orderId, userId]);
  const fireNo = (await owner.query<{ n: string }>(
    `SELECT COALESCE(MAX(fire_no),0)+1 AS n FROM app.kot_fire
      WHERE tenant_id=$1 AND branch_id=$2 AND business_date=$3::date`,
    [tenantId, branchId, DATE])).rows[0]!.n;
  await owner.query(
    `INSERT INTO app.kot_fire (id,tenant_id,branch_id,order_id,business_date,fire_no,fired_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7)`,
    [fireId, tenantId, branchId, orderId, DATE, Number(fireNo), userId]);
  await owner.query(
    `INSERT INTO app.kot (id,tenant_id,branch_id,fire_id,station_id,business_date,sequence_no)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
    [kotId, tenantId, branchId, fireId, stationId, DATE, Number(fireNo)]);
  await owner.query(
    `INSERT INTO app.kot_line (id,tenant_id,kot_id,order_line_id,source,quantity,name_snapshot,note)
     VALUES ($1,$2,$3,$4,'item',2,'Tandoori Chicken','extra spicy')`,
    [randomUUID(), tenantId, kotId, lineId]);

  await owner.query(
    `INSERT INTO app.print_job (id,tenant_id,branch_id,kot_id,printer_id,fallback_printer_id,
       max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [jobId, tenantId, branchId, kotId, grillPrinter,
     opts.fallback ? coldPrinter : null, opts.maxAttempts ?? 2]);

  return { kotId, jobId };
}

async function jobRow(id: string) {
  const r = await owner.query<{
    status: string; attempts: number; used_fallback: boolean; origin: string;
    failure_reason: string | null; last_error: string | null;
    fallback_from_printer_id: string | null; reprint_of_job_id: string | null;
  }>(
    `SELECT status, attempts, used_fallback, origin, failure_reason, last_error,
            fallback_from_printer_id, reprint_of_job_id
       FROM app.print_job WHERE id=$1`, [id]);
  return r.rows[0]!;
}

/**
 * Runs fn through the APP client under a tenant GUC -- the posture production
 * uses. The owner client is exempt from RLS by table ownership, so calling a
 * tenant-table function with it exercises a more privileged path that merely
 * shares code, and the print worker crashed on every real run while its test
 * passed exactly that way.
 */
async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
    const result = await fn();
    await app.query('COMMIT');
    return result;
  } catch (error) {
    await app.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

const release = async (id: string) =>
  owner.query(`UPDATE app.print_job SET available_at = now() WHERE id=$1`, [id]);

/**
 * ###########################################################################
 * EVERY printOnce HERE IS SCOPED TO THIS TENANT, AND THAT IS NOT TIDINESS.
 *
 * `printOnce` with no `tenantIds` iterates EVERY tenant in the install and
 * opens two transactions per tenant -- `reclaimStale` and `claimBatch` -- even
 * for tenants with no queued job. So this file's runtime grew with the number
 * of tenants the whole suite had ever provisioned: at ~750 tenants it was
 * ~1,500 transactions per cycle, five cycles per test, and two tests failed
 * for reasons that looked like flakiness and were not:
 *
 *   - the terminal-failure test exceeded the 30s timeout
 *   - the backoff test read `available_at - now()` as NEGATIVE, because the
 *     3-second backoff had already elapsed during the scan that followed the
 *     write it was asserting on
 *
 * Neither is a defect in the worker's logic, and both would have come back for
 * everyone as the dev database aged. The scan cost itself is a real production
 * property and is recorded separately as a decision, not fixed here.
 * ###########################################################################
 */

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = new pg.Client({ connectionString: process.env['DATABASE_URL_APP']! });
  await app.connect();
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `prn+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'prn_plan','Prn')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='prn_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  await owner.query('BEGIN');
  const r = await provisionTenant(owner, {
    idempotencyKey: `prn-${randomUUID()}`, slug: `p${randomUUID().slice(0, 8)}`,
    name: 'Print Probe', currency: 'INR', timezone: 'Asia/Kolkata',
    ownerEmail: `prn-${randomUUID()}@o.test`, ownerName: 'Owner',
    firstBranchName: 'Main', planVersionId, taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  });
  await owner.query('COMMIT');
  tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;

  await owner.query(`INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')`,
    [tenantId]);
  stationId = randomUUID();
  await owner.query(
    `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name)
     VALUES ($1,$2,$3,'grill','Grill')`, [stationId, tenantId, branchId]);

  grillPrinter = randomUUID(); coldPrinter = randomUUID();
  await owner.query(
    `INSERT INTO app.printer (id,tenant_id,branch_id,name,connection_kind,address) VALUES
       ($1,$3,$4,'Grill Printer','network','10.0.0.7'),
       ($2,$3,$4,'Cold Printer','network','10.0.0.8')`,
    [grillPrinter, coldPrinter, tenantId, branchId]);
});

afterAll(async () => { await app?.end(); await owner?.end(); });

describe('the production transport, end to end through the worker', () => {
  it('delivers a fired ticket to the network printer at its address', async () => {
    let deliver!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => { deliver = r; });
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => deliver(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const printer = randomUUID();
      await owner.query(
        `INSERT INTO app.printer (id,tenant_id,branch_id,name,connection_kind,address)
         VALUES ($1,$2,$3,$4,'network',$5)`,
        [printer, tenantId, branchId, `Pass ${printer.slice(0, 6)}`, '192.168.0.77:9100']);
      const { jobId } = await makeKotWithJob();
      await owner.query(`UPDATE app.print_job SET printer_id = $2 WHERE id = $1`, [jobId, printer]);

      // The stored address passes the LAN-printer rule; the socket goes to the local fake.
      await printOnce(app, { tenantIds: [tenantId], transport: networkTransport({ dial: () => ({ host: '127.0.0.1', port }) }) });

      expect((await received).toString('utf8')).toContain(' 2 x Tandoori Chicken');
      expect((await jobRow(jobId)).status).toBe('accepted');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('refuses a USB printer it cannot reach, so the job walks to its fallback', async () => {
    const usb = randomUUID();
    await owner.query(
      `INSERT INTO app.printer (id,tenant_id,branch_id,name,connection_kind)
       VALUES ($1,$2,$3,$4,'usb')`, [usb, tenantId, branchId, `Usb ${usb.slice(0, 6)}`]);
    const { jobId } = await makeKotWithJob({ fallback: true, maxAttempts: 1 });
    await owner.query(`UPDATE app.print_job SET printer_id = $2 WHERE id = $1`, [jobId, usb]);

    await printOnce(app, { tenantIds: [tenantId], transport: networkTransport() });

    const row = await jobRow(jobId);
    expect(row.used_fallback).toBe(true);
    expect(row.last_error).toMatch(/usb; the server can only reach network printers/);
  });

  it('refuses a row saved before the address rule (a Redis port), so it never connects and the job walks to its fallback', async () => {
    const legacy = randomUUID();
    await owner.query(
      `INSERT INTO app.printer (id,tenant_id,branch_id,name,connection_kind,address)
       VALUES ($1,$2,$3,$4,'network','10.0.0.5:6379')`, [legacy, tenantId, branchId, `Old ${legacy.slice(0, 6)}`]);
    const { jobId } = await makeKotWithJob({ fallback: true, maxAttempts: 1 });
    await owner.query(`UPDATE app.print_job SET printer_id = $2 WHERE id = $1`, [jobId, legacy]);

    // Other jobs in this tenant are dialled too; none may reach the network, and
    // the legacy row's address must never be among them.
    const dialled: string[] = [];
    await printOnce(app, { tenantIds: [tenantId], transport: networkTransport({
      dial: (t) => { dialled.push(`${t.host}:${t.port}`); throw new Error('test: no network'); },
    }) });

    expect(dialled).not.toContain('10.0.0.5:6379');
    const row = await jobRow(jobId);
    expect(row.used_fallback).toBe(true);
    expect(row.last_error).toMatch(/refused: Port 6379 is not a printing port/);
  });
});

/* ------------------------------------------------------------ decision 2 --- */

describe('C. print success is not confirmable', () => {
  it('records ACCEPTED, never "printed"', async () => {
    const { jobId } = await makeKotWithJob();
    await printOnce(app, { tenantIds: [tenantId], transport: accepting });

    const row = await jobRow(jobId);
    // The device took the bytes. Whether paper came out is not something it can
    // tell us, and the state is named for what we actually know.
    expect(row.status).toBe('accepted');

    const statuses = (await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname='print_job_status_known'`)).rows[0]!.def;
    assertCheckedSet({
      label: 'print job statuses',
      checked: [...statuses.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!),
      minimum: 4,
      mustInclude: ['pending', 'claimed', 'accepted', 'failed'],
    });
    expect(statuses, 'no state may imply confirmation').not.toMatch(/'printed'/);
  });

  it('leaves the KDS as the channel, so a failed print is a degradation', async () => {
    const { kotId, jobId } = await makeKotWithJob();
    for (let i = 0; i < 3; i += 1) { await release(jobId); await printOnce(app, { tenantIds: [tenantId], transport: refusing }); }

    expect((await jobRow(jobId)).status).toBe('failed');
    // The ticket is still live for the kitchen. Paper is the redundancy, not the
    // channel -- which is why a print failure does not stop the fire.
    const kot = await owner.query<{ state: string }>(
      `SELECT state FROM app.kot WHERE id=$1`, [kotId]);
    expect(kot.rows[0]!.state).not.toBe('cancelled');
  });
});

/* ------------------------------------------------------------ decision 3 --- */

describe('C. fallback is marked on the paper', () => {
  it('escalates to the fallback printer and says so on the ticket', async () => {
    const { jobId } = await makeKotWithJob({ fallback: true, maxAttempts: 2 });
    const transport = capturing();

    // Primary refuses until exhausted, then the fallback accepts.
    for (let i = 0; i < 2; i += 1) {
      await release(jobId);
      await printOnce(app, { tenantIds: [tenantId], transport: refusingOnly(grillPrinter) });
    }
    const afterFallback = await jobRow(jobId);
    expect(afterFallback.used_fallback).toBe(true);
    expect(afterFallback.fallback_from_printer_id).toBe(grillPrinter);
    // The budget resets: the new printer gets its own attempts.
    expect(afterFallback.attempts).toBe(0);

    await release(jobId);
    await printOnce(app, { tenantIds: [tenantId], transport });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.printerId, 'the fallback printer receives it').toBe(coldPrinter);
    // Better than nothing ONLY if it says where it should have gone: otherwise a
    // cook at the wrong station silently starts work nobody is expecting.
    expect(transport.sent[0]!.content).toMatch(/FALLBACK COPY/);
    expect(transport.sent[0]!.content).toMatch(/INTENDED FOR: GRILL PRINTER/);
  });

  it('renders no fallback banner on an ordinary ticket', () => {
    const plain = renderTicket(
      { origin: 'fire', usedFallback: false },
      { stationName: 'Grill', sequenceNo: 42, localReference: null,
        lines: [{ name: 'Naan', quantity: 2, note: null }] },
      null,
    );
    expect(plain).not.toMatch(/FALLBACK/);
    expect(plain).toMatch(/Grill {3}#42/);
  });

  it('falls back to the device-local reference when no sequence is assigned', () => {
    // An offline fire has no server sequence; the paper still carries something
    // a human can read aloud.
    const offline = renderTicket(
      { origin: 'fire', usedFallback: false },
      { stationName: 'Grill', sequenceNo: null, localReference: 'L-ab12cd34-7',
        lines: [{ name: 'Naan', quantity: 1, note: null }] },
      null,
    );
    expect(offline).toMatch(/L-ab12cd34-7/);
  });

  it('fails terminally naming BOTH printers when the fallback fails too', async () => {
    const { jobId } = await makeKotWithJob({ fallback: true, maxAttempts: 2 });
    for (let i = 0; i < 5; i += 1) { await release(jobId); await printOnce(app, { tenantIds: [tenantId], transport: refusing }); }

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    // The manager walking to the printer needs to know what to check.
    expect(row.failure_reason).toMatch(/Grill Printer/);
    expect(row.failure_reason).toMatch(/Cold Printer/);
  });
});

/* ------------------------------------------------------------ decision 1 --- */

describe('C. a reprint is a new job, not a retry', () => {
  it('creates a separate row attributed to the requester', async () => {
    const { jobId } = await makeKotWithJob();
    await printOnce(app, { tenantIds: [tenantId], transport: accepting });

    const { jobId: reprintId } = await asApp(() =>
      requestReprint(app, { tenantId, jobId, byUserId: userId }));

    const original = await jobRow(jobId);
    const reprint = await jobRow(reprintId);

    // Three reprints are three rows at one attempt each, not one row at three
    // attempts. Otherwise a kitchen that reprints looks like failing hardware.
    expect(original.attempts).toBe(0);
    expect(reprint.origin).toBe('reprint');
    expect(reprint.reprint_of_job_id).toBe(jobId);
    expect(reprint.status).toBe('pending');
  });

  it('marks the reprint on the paper, so it is not read as a second order', async () => {
    const { jobId } = await makeKotWithJob();
    await printOnce(app, { tenantIds: [tenantId], transport: accepting });
    const { jobId: reprintId } = await asApp(() =>
      requestReprint(app, { tenantId, jobId, byUserId: userId }));

    const transport = capturing();
    await release(reprintId);
    await printOnce(app, { tenantIds: [tenantId], transport });
    const sent = transport.sent.find((s) => s.content.includes('REPRINT'));
    expect(sent, 'a second copy on the pass must not read as a second order').toBeDefined();
    expect(sent!.content).toMatch(/NOT A NEW ORDER/);
  });

  it('refuses an unattributed reprint at the schema level', async () => {
    const { kotId } = await makeKotWithJob();
    await expect(owner.query(
      `INSERT INTO app.print_job (id,tenant_id,branch_id,kot_id,printer_id,origin)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'reprint')`,
      [tenantId, branchId, kotId, grillPrinter]))
      .rejects.toThrow(/reprint_attributed/);
  });

  it('has its own permission key', () => {
    const key = PERMISSIONS.find((p) => p.key === 'kot.reprint');
    expect(key, 'who asked for another copy must be attributable').toBeDefined();
    // Not financial: no money moves, and the control is that it is RECORDED and
    // distinguishable from a retry, not that it is restricted.
    expect((key as { riskClass?: string }).riskClass).toBeUndefined();
  });
});

/* -------------------------------------------------------- worker posture --- */

describe('C. the worker posture matches the outbox', () => {
  it('retries with backoff before giving up', async () => {
    const { jobId } = await makeKotWithJob({ maxAttempts: 4 });

    // Anchored to a timestamp taken BEFORE the attempt, not to `now()` after
    // it. The worker writes `available_at = now() + 3s * 2^attempts`, and its
    // `now()` is at or after this one -- so this bound holds however long the
    // assertion takes to run. Comparing against a later `now()` measured the
    // test's own latency and went negative on a slower machine.
    const t0 = (await owner.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0]!.t;

    await printOnce(app, { tenantIds: [tenantId], transport: refusing });

    const backoff = await owner.query<{ seconds: string }>(
      `SELECT EXTRACT(EPOCH FROM (available_at - $2::timestamptz))::text AS seconds
         FROM app.print_job WHERE id=$1`, [jobId, t0]);
    // First failure: attempts was 0, so the interval is 3s * 2^0.
    expect(Number(backoff.rows[0]!.seconds)).toBeGreaterThanOrEqual(3);
    expect((await jobRow(jobId)).last_error).toMatch(/ECONNREFUSED/);
  });

  it('reclaims a claim held by a dead worker', async () => {
    const { jobId } = await makeKotWithJob();
    await owner.query(
      `UPDATE app.print_job
          SET status='claimed', claimed_at = now() - interval '1 hour', claimed_by='dead'
        WHERE id=$1`, [jobId]);
    // Through the APP client, in the worker's own posture. Calling it with the
    // owner would pass by bypassing RLS, and would never have caught that the
    // check itself needs a tenant scope.
    expect(await verifyPrintDrain(app, { tenantIds: [tenantId] }))
      .toContainEqual(`${jobId} (held by dead)`);

    // The claim is not a held lock: a transaction open across a network
    // printer's timeout blocks the queue behind it.
    //
    // reclaimStale reads app.print_job, so it runs INSIDE a tenant scope like
    // everything else that touches a tenant table -- the worker wraps it per
    // tenant for exactly this reason.
    await app.query('BEGIN');
    await app.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
    const reclaimedCount = await reclaimStale(app);
    await app.query('COMMIT');
    expect(reclaimedCount).toBeGreaterThanOrEqual(1);
    expect((await jobRow(jobId)).status).toBe('pending');
  });

  it('leaves no stranded claim after a cycle', async () => {
    await makeKotWithJob();
    await printOnce(app, { tenantIds: [tenantId], transport: accepting });
    expect(await verifyPrintDrain(app, { tenantIds: [tenantId] })).toEqual([]);
    expect(CLAIM_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });

  it('runs as katkitchen_app under a per-job GUC, never the owner', async () => {
    const who = await app.query<{ u: string; bypass: boolean }>(
      `SELECT current_user AS u, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`);
    expect(who.rows[0]).toEqual({ u: 'katkitchen_app', bypass: false });

    const code = readFileSync('src/modules/business-types/restaurant/kitchen/printWorker.ts', 'utf8');
    expect(code).toMatch(/DATABASE_URL_APP/);
    expect(code).not.toMatch(/DATABASE_URL_OWNER/);
    expect(code).toMatch(/set_config\(\$1, \$2, true\)/);
  });

  it('does not widen the fire-transaction boundary', () => {
    const fire = readFileSync('src/modules/business-types/restaurant/kitchen/fire.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // The ROW is created in the fire transaction; the ATTEMPT is not. A paper jam
    // must never be in the critical path of the till.
    expect(fire).toMatch(/INSERT INTO app\.print_job/);
    expect(fire).not.toMatch(/printOnce|PrintTransport|\.send\(/);
  });
});

/* ----------------------------------------------------------- visibility --- */

describe('C. failures are visible in the right place', () => {
  it('shows a failed job on the BRANCH screen with what to check', async () => {
    const { jobId } = await makeKotWithJob({ maxAttempts: 1 });
    await printOnce(app, { tenantIds: [tenantId], transport: refusing });

    const failures = await asApp(() => branchPrintFailures(app, { tenantId, branchId }));
    const hit = failures.find((f) => f.jobId === jobId);
    expect(hit, 'the manager standing twenty feet away is the audience').toBeDefined();
    expect(hit!.printerName).toBe('Grill Printer');
    expect(hit!.stationName).toBe('Grill');
    expect(hit!.failureReason).toMatch(/ECONNREFUSED/);
  });

  it('sends only an AGGREGATE rate to the platform, through usage_counter', async () => {
    // Printer health is a WALL-CLOCK concern, not a trading-day one: a printer
    // does not care when the restaurant's day rolls over. So the metric keys off
    // created_at, and the rollup date is today rather than the KOT's business
    // date.
    const today = new Date().toISOString().slice(0, 10);
    await rollUpUsage(app, { asOfDate: today, tenantIds: [tenantId] });

    const metrics = await owner.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM platform.usage_counter
        WHERE tenant_id=$1 AND as_of_date=$2::date AND metric LIKE 'print.%'
        ORDER BY metric`, [tenantId, today]);

    assertCheckedSet({
      label: 'print metrics crossing the boundary',
      checked: metrics.rows.map((m) => m.metric),
      minimum: 2,
      mustInclude: ['print.jobs.failed', 'print.jobs.total'],
    });
    expect(Number(metrics.rows.find((m) => m.metric === 'print.jobs.total')!.value))
      .toBeGreaterThan(0);
    expect(Number(metrics.rows.find((m) => m.metric === 'print.jobs.failed')!.value))
      .toBeGreaterThan(0);
  });

  it('keeps per-job detail out of the control plane entirely', () => {
    // A superadmin cannot change the paper. Per-job detail is the branch's; only
    // two integers a day cross the boundary. Same distinction as
    // inventory.negative.
    const offenders: string[] = [];
    for (const dir of [
      // The control plane: platform, its outbox delivery (notifications) and
      // subscription billing. A new control-plane module must be added here.
      'src/modules/platform', 'src/modules/notifications', 'src/modules/billing',
    ]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const code = readFileSync(`${dir}/${file}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (code.includes('app.print_job')) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
