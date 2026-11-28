import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { planCache } from '../helpers/plans.js';
import { buildServer } from '../../src/server/app.js';
import { resetRegistry } from '../../src/middleware/routeRegistry.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { allRoutes } from '../../src/routes/index.js';
import { isUnserved, mergeHandlers } from '../../src/routes/lookup.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { syncHandlers } from '../../src/routes/handlers/sync.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { staffHandlers } from '../../src/routes/handlers/staff.js';
import { reportHandlers } from '../../src/routes/handlers/reports.js';
import { crmHandlers } from '../../src/routes/handlers/crm.js';
import { planHandlers } from '../../src/routes/handlers/plan.js';
import { setupHandlers } from '../../src/routes/handlers/setup.js';
import { accessHandlers } from '../../src/routes/handlers/access.js';
import { platformHandlers } from '../../src/routes/handlers/platform.js';
import { authHandlers } from '../../src/routes/handlers/auth.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { ensureStandardPlans } from '../../src/modules/platform/planCatalogue.js';
import { printOnce, type PrintTransport } from '../../src/modules/business-types/restaurant/kitchen/printWorker.js';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The local print agent on the real assembly: a manager issues it, it polls
 * /api/agent/poll with its own token, takes its branch's kitchen tickets as
 * ESC/POS bytes, reports what happened, and stops at its next poll once revoked.
 */

const KEY = 'print-agent-signing-key-long-enough-for-hs256';
const DATE = '2026-11-11';

let db: pg.Client;
let appClient: pg.Client;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: FastifyInstance;
let rep: string;
let proVersion: string;

interface Restaurant {
  tenantId: string; slug: string; token: string; branchA: string; branchB: string; userId: string;
  station: string; printer: string; fallback: string; usb: string; elsewhere: string;
}
let r: Restaurant;
let other: Restaurant;

async function http(method: string, url: string, token: string | null, payload?: unknown) {
  const response = await app.inject({
    method: method as never, url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}),
    },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}
const poll = (token: string, report: unknown = {}) => http('POST', '/api/agent/poll', token, report);
const at = (url: string, branchId: string): string => `${url}?branchId=${branchId}`;

async function restaurant(name: string): Promise<Restaurant> {
  const slug = `agent-${randomUUID().slice(0, 8)}`;
  const email = `manager@${slug}.test`;
  const now = Math.floor(Date.now() / 1000);
  const made = await http('POST', '/api/platform/tenants',
    signToken({ sub: rep, platform_role: 'sales', iat: now, exp: now + 600 }, KEY), {
      slug, name, currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: email, ownerName: 'Agent Manager',
      firstBranchName: 'Main', planVersionId: proVersion, taxJurisdiction: 'IN', address: '1 Test Road, Pune',
    });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await http('POST', '/api/auth/invite/accept', null, { token: made.body['inviteToken'], password: 'agent-manager-2026' });
  const login = await http('POST', `/api/auth/${slug}/login`, null, { email, password: 'agent-manager-2026' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const tenantId = made.body['tenantId'] as string;
  const token = login.body['accessToken'] as string;
  const branchA = (await db.query<{ id: string }>(`SELECT id FROM app.branch WHERE tenant_id = $1`, [tenantId])).rows[0]!.id;
  const second = await http('POST', '/api/t/admin/branches', token, {
    code: 'B2', name: 'Second', timezone: 'Asia/Kolkata', business_day_starts_at: '04:00', gst_registration: 'unregistered',
  });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  const userId = (await db.query<{ id: string }>(`SELECT id FROM app.app_user WHERE tenant_id = $1 AND email = $2`, [tenantId, email])).rows[0]!.id;

  const station = randomUUID();
  await db.query(`INSERT INTO app.station_code (tenant_id, code, name) VALUES ($1, 'grill', 'Grill')`, [tenantId]);
  await db.query(`INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name) VALUES ($1, $2, $3, 'grill', 'Grill')`,
    [station, tenantId, branchA]);
  const [printer, fallback, usb, elsewhere] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.query(
    `INSERT INTO app.printer (id, tenant_id, branch_id, name, connection_kind, address) VALUES
       ($1, $5, $6, 'Grill printer', 'network', '192.168.1.50:9100'),
       ($2, $5, $6, 'Fry printer', 'network', '192.168.1.51'),
       ($3, $5, $6, 'Counter USB', 'usb', NULL),
       ($4, $5, $7, 'Second branch printer', 'network', '192.168.2.50:9100')`,
    [printer, fallback, usb, elsewhere, tenantId, branchA, second.body['id']]);
  return { tenantId, slug, token, branchA, branchB: second.body['id'] as string, userId, station, printer, fallback, usb, elsewhere };
}

/** A fired kitchen ticket with its print job, written as the owner. */
async function ticket(of: Restaurant, opts: { printer?: string; fallback?: string | null; branch?: string; maxAttempts?: number } = {}): Promise<string> {
  const branch = opts.branch ?? of.branchA;
  const [session, order, line, fire, kot, job] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.query(`INSERT INTO app.table_session (id, tenant_id, branch_id, business_date, opened_by_user_id)
                  VALUES ($1, $2, $3, $4::date, $5)`, [session, of.tenantId, branch, DATE, of.userId]);
  await db.query(`INSERT INTO app.sales_order (id, tenant_id, branch_id, session_id, business_date, created_by_user_id)
                  VALUES ($1, $2, $3, $4, $5::date, $6)`, [order, of.tenantId, branch, session, DATE, of.userId]);
  await db.query(`INSERT INTO app.order_line (id, tenant_id, branch_id, order_id, kind, display_name, unit_price_minor, quantity, line_total_minor, created_by_user_id)
                  VALUES ($1, $2, $3, $4, 'item', 'Paneer Tikka', 25000, 2, 50000, $5)`, [line, of.tenantId, branch, order, of.userId]);
  const fireNo = Number((await db.query<{ n: string }>(
    `SELECT COALESCE(MAX(fire_no), 0) + 1 AS n FROM app.kot_fire WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date`,
    [of.tenantId, branch, DATE])).rows[0]!.n);
  await db.query(`INSERT INTO app.kot_fire (id, tenant_id, branch_id, order_id, business_date, fire_no, fired_by_user_id)
                  VALUES ($1, $2, $3, $4, $5::date, $6, $7)`, [fire, of.tenantId, branch, order, DATE, fireNo, of.userId]);
  let station = of.station;
  if (branch !== of.branchA) {
    station = randomUUID();
    await db.query(`INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name) VALUES ($1, $2, $3, 'grill', 'Grill')`,
      [station, of.tenantId, branch]);
  }
  await db.query(`INSERT INTO app.kot (id, tenant_id, branch_id, fire_id, station_id, business_date, sequence_no)
                  VALUES ($1, $2, $3, $4, $5, $6::date, $7)`, [kot, of.tenantId, branch, fire, station, DATE, fireNo]);
  await db.query(`INSERT INTO app.kot_line (id, tenant_id, kot_id, order_line_id, source, quantity, name_snapshot, note)
                  VALUES ($1, $2, $3, $4, 'item', 2, 'Paneer Tikka', 'less spicy')`, [randomUUID(), of.tenantId, kot, line]);
  await db.query(`INSERT INTO app.print_job (id, tenant_id, branch_id, kot_id, printer_id, fallback_printer_id, max_attempts)
                  VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [job, of.tenantId, branch, kot, opts.printer ?? of.printer, opts.fallback === undefined ? of.fallback : opts.fallback, opts.maxAttempts ?? 2]);
  return job;
}

async function job(id: string) {
  return (await db.query<{ status: string; attempts: number; used_fallback: boolean; claimed_by: string | null; last_error: string | null }>(
    `SELECT status, attempts, used_fallback, claimed_by, last_error FROM app.print_job WHERE id = $1`, [id])).rows[0]!;
}

async function issue(of: Restaurant, name = 'Till PC'): Promise<{ id: string; token: string }> {
  const issued = await http('POST', at('/api/t/admin/print-agents', of.branchA), of.token, { name });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return { id: issued.body['id'] as string, token: issued.body['token'] as string };
}

type Work = { jobs: { id: string; printerId: string; host: string; port: number; bytes: string }[]; printers: { id: string; host: string; port: number; testPrint: string | null }[] };

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
  appClient = new pg.Client({ connectionString: process.env['DATABASE_URL_APP']! });
  await appClient.connect();
  await seedPermissionCatalogue(db);
  await seedPlatformAuthz(db);
  const salesRole = (await db.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'sales'`)).rows[0]!.id;
  rep = randomUUID();
  await db.query(`INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
                  VALUES ($1, $2, 'argon2id$stub', 'Agent Rep', $3)`, [rep, `agent+${rep}@platform.test`, salesRole]);
  proVersion = (await ensureStandardPlans(db, rep)).get('pro')!;

  appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 6 });
  ownerPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 2 });
  resetRegistry();
  const handlers = mergeHandlers(
    posHandlers(), syncHandlers(), adminHandlers(), staffHandlers(),
    reportHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    platformHandlers(KEY), authHandlers(KEY));
  const routes = allRoutes(handlers).filter((x) => !isUnserved(x.handler));
  app = buildServer({ pool: appPool, ownerPool, jwtKey: KEY, routes, entitlements: planCache('pro') },
    new Set(routes.map((x) => `${x.method} ${x.url}`)));
  await app.ready();

  r = await restaurant('Agent Kitchen');
  other = await restaurant('Other Kitchen');
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await appClient?.end();
  await db?.end();
});

describe('issuing an agent', () => {
  it('hands out the token once and stores only its hash; the list never carries either', async () => {
    const agent = await issue(other);
    expect(agent.token.startsWith(`${other.slug}.`)).toBe(true);
    const secret = agent.token.slice(other.slug.length + 1);
    const row = (await db.query<{ token_hash: string; branch_id: string }>(
      `SELECT token_hash, branch_id FROM app.print_agent WHERE id = $1`, [agent.id])).rows[0]!;
    expect(row.token_hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(row.branch_id).toBe(other.branchA);
    const listed = await http('GET', at('/api/t/admin/print-agents', other.branchA), other.token);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(JSON.stringify(listed.body)).not.toContain(row.token_hash);
    // The audit row names the action and carries no image of the agent row.
    const audit = (await db.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM app.tenant_audit_log WHERE tenant_id = $1 AND action = 'print_agent.issued'`, [other.tenantId])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(row.token_hash);
  });

  it('needs a branch and a name', async () => {
    const noBranch = await http('POST', '/api/t/admin/print-agents', r.token, { name: 'Till' });
    expect(noBranch.status).toBe(400);
    expect(noBranch.body['error']).toBe('print_agent_invalid');
    const noName = await http('POST', at('/api/t/admin/print-agents', r.branchA), r.token, { name: ' ' });
    expect(noName.body['error']).toBe('print_agent_invalid');
  });
});

describe('the agent plane is its own', () => {
  it('refuses a missing, malformed, unknown or other-restaurant token with one answer', async () => {
    const forged = `${r.slug}.${'x'.repeat(43)}`;
    for (const token of [null, 'nonsense', forged, `no-such-restaurant.${'y'.repeat(43)}`]) {
      const answer = await poll(token as string);
      expect(answer.status, String(token)).toBe(401);
      expect(answer.body['error'], String(token)).toBe('print_agent_token_invalid');
    }
  });

  it('a manager JWT is not an agent token, and an agent token is not a tenant JWT', async () => {
    const agent = await issue(other, 'Plane probe');
    expect((await poll(other.token)).body['error']).toBe('print_agent_token_invalid');
    const onTenant = await http('GET', at('/api/t/admin/print-agents', other.branchA), agent.token);
    expect(onTenant.status).toBe(401);
  });
});

describe('printing through the agent', () => {
  let agent: { id: string; token: string };
  let mine: string;
  let otherBranch: string;
  let theirs: string;

  it('while a branch has an agent, the server worker leaves its jobs alone', async () => {
    mine = await ticket(r);
    otherBranch = await ticket(r, { branch: r.branchB, printer: r.elsewhere, fallback: null });
    theirs = await ticket(other);
    agent = await issue(r);
    const sent: string[] = [];
    const transport: PrintTransport = { async send(p) { sent.push(p.printerId); } };
    await appClient.query('SELECT 1');
    await printOnce(appClient, { tenantIds: [r.tenantId], transport });
    expect((await job(mine)).status).toBe('pending');
    // The second branch has no agent, so the server still drains it.
    expect((await job(otherBranch)).status).toBe('accepted');
    expect(sent).toEqual([r.elsewhere]);
  });

  it('a poll claims its own branch only, and carries the rendered ticket as ESC/POS bytes to the stored address', async () => {
    const work = await poll(agent.token);
    expect(work.status, JSON.stringify(work.body)).toBe(200);
    const jobs = (work.body as unknown as Work).jobs;
    expect(jobs.map((j) => j.id)).toEqual([mine]);
    expect(jobs[0]).toMatchObject({ printerId: r.printer, host: '192.168.1.50', port: 9100 });
    const bytes = Buffer.from(jobs[0]!.bytes, 'base64');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(bytes.toString('utf8')).toContain('2 x Paneer Tikka');
    expect(bytes.toString('utf8')).toContain('* less spicy');
    expect(await job(mine)).toMatchObject({ status: 'claimed', claimed_by: `agent:${agent.id}` });
    expect((await job(theirs)).status).toBe('pending');
    const seen = (await db.query<{ last_seen_at: string | null }>(`SELECT last_seen_at FROM app.print_agent WHERE id = $1`, [agent.id])).rows[0]!;
    expect(seen.last_seen_at).not.toBeNull();
  });

  it('a success marks the job accepted; a result for a job it does not hold changes nothing', async () => {
    const answer = await poll(agent.token, { jobs: [{ id: mine, ok: true }, { id: theirs, ok: true }, { id: randomUUID(), ok: false, error: 'x' }, { id: 'not-a-uuid', ok: true }] });
    expect(answer.status).toBe(200);
    expect((await job(mine)).status).toBe('accepted');
    expect((await job(theirs)).status).toBe('pending');
  });

  it('a failure is the worker\'s failure: attempts, then the fallback printer, named on the error', async () => {
    const failing = await ticket(r, { maxAttempts: 1 });
    const first = (await poll(agent.token)).body as unknown as Work;
    expect(first.jobs.map((j) => j.id)).toEqual([failing]);
    // Falling back makes the job available at once, so the poll that reports the
    // failure is handed the same job again, now aimed at the fallback printer.
    const fallback = (await poll(agent.token, { jobs: [{ id: failing, ok: false, error: 'connect ETIMEDOUT 192.168.1.50:9100' }] })).body as unknown as Work;
    const after = await job(failing);
    expect(after).toMatchObject({ status: 'claimed', used_fallback: true, attempts: 0 });
    expect(after.last_error).toContain('primary printer exhausted: print agent "Till PC": connect ETIMEDOUT');
    expect(fallback.jobs[0]).toMatchObject({ id: failing, printerId: r.fallback, host: '192.168.1.51', port: 9100 });
    expect(Buffer.from(fallback.jobs[0]!.bytes, 'base64').toString('utf8')).toContain('*** FALLBACK COPY ***');
    await poll(agent.token, { jobs: [{ id: failing, ok: true }] });
    expect((await job(failing)).status).toBe('accepted');
  });

  it('a job for a USB printer or a refused address is failed on the server and never handed out', async () => {
    const usb = await ticket(r, { printer: r.usb, fallback: null, maxAttempts: 1 });
    const legacy = randomUUID();
    await db.query(`INSERT INTO app.printer (id, tenant_id, branch_id, name, connection_kind, address)
                    VALUES ($1, $2, $3, 'Old printer', 'network', '10.0.0.5:6379')`, [legacy, r.tenantId, r.branchA]);
    const bad = await ticket(r, { printer: legacy, fallback: null, maxAttempts: 1 });
    const work = (await poll(agent.token)).body as unknown as Work;
    expect(work.jobs).toEqual([]);
    expect(work.printers.map((p) => p.id)).not.toContain(legacy);
    expect((await job(usb)).last_error).toContain('prints only to Wi-Fi and Ethernet printers');
    expect((await job(bad)).last_error).toContain('Port 6379 is not a printing port');
    expect((await job(bad)).status).toBe('failed');
    await db.query(`UPDATE app.printer SET status = 'archived' WHERE id = $1`, [legacy]);
  });

  it('reports what it saw of each printer, at its own branch only', async () => {
    await poll(agent.token, { printers: [
      { id: r.printer, reachable: true },
      { id: r.fallback, reachable: false, error: 'ECONNREFUSED' },
      { id: r.elsewhere, reachable: false, error: 'not mine' },
    ] });
    const rows = (await db.query<{ id: string; reachable: boolean | null; reach_error: string | null }>(
      `SELECT id, reachable, reach_error FROM app.printer WHERE id = ANY($1)`, [[r.printer, r.fallback, r.elsewhere]])).rows;
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(by[r.printer]).toMatchObject({ reachable: true, reach_error: null });
    expect(by[r.fallback]).toMatchObject({ reachable: false, reach_error: 'ECONNREFUSED' });
    expect(by[r.elsewhere]).toMatchObject({ reachable: null });
    const listed = await http('GET', at('/api/t/admin/printers', r.branchA), r.token);
    expect(JSON.stringify(listed.body)).toContain('ECONNREFUSED');
  });

  it('a test print is asked for on the admin, sent at the next poll, and reported back', async () => {
    const usbRefused = await http('POST', at(`/api/t/admin/printers/${r.usb}/test-print`, r.branchA), r.token, {});
    expect(usbRefused.status).toBe(409);
    expect(usbRefused.body['error']).toBe('test_print_refused');
    const asked = await http('POST', at(`/api/t/admin/printers/${r.printer}/test-print`, r.branchA), r.token, {});
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const work = (await poll(agent.token)).body as unknown as Work;
    const slip = work.printers.find((p) => p.id === r.printer)!.testPrint!;
    expect(Buffer.from(slip, 'base64').toString('utf8')).toContain('PRINTER TEST');
    expect(work.printers.find((p) => p.id === r.fallback)!.testPrint).toBeNull();
    await poll(agent.token, { testPrints: [{ id: r.printer, ok: true }] });
    const row = (await db.query<{ test_print_requested_at: string | null; test_printed_at: string | null }>(
      `SELECT test_print_requested_at, test_printed_at FROM app.printer WHERE id = $1`, [r.printer])).rows[0]!;
    expect(row.test_print_requested_at).toBeNull();
    expect(row.test_printed_at).not.toBeNull();
  });

  it('a test print at a branch with no agent says to set one up', async () => {
    const refused = await http('POST', at(`/api/t/admin/printers/${r.elsewhere}/test-print`, r.branchB), r.token, {});
    expect(refused.status).toBe(409);
    expect(refused.body['message'] ?? refused.body['detail']).toEqual(expect.stringContaining('Set up the print agent'));
  });

  it('another restaurant\'s agent cannot settle or see this restaurant\'s jobs', async () => {
    const intruder = await issue(other, 'Intruder');
    const held = await ticket(r);
    const work = (await poll(agent.token)).body as unknown as Work;
    expect(work.jobs.map((j) => j.id)).toEqual([held]);
    const theirsWork = (await poll(intruder.token, { jobs: [{ id: held, ok: false, error: 'sabotage' }] })).body as unknown as Work;
    expect(theirsWork.jobs.map((j) => j.id)).toEqual([theirs]);
    expect(await job(held)).toMatchObject({ status: 'claimed', claimed_by: `agent:${agent.id}`, attempts: 0 });
    await poll(agent.token, { jobs: [{ id: held, ok: true }] });
  });

  it('a check (claim: false) reads the printers and takes no ticket', async () => {
    const waiting = await ticket(r);
    const work = (await poll(agent.token, { claim: false })).body as unknown as Work;
    expect(work.jobs).toEqual([]);
    expect(work.printers.map((p) => p.id)).toContain(r.printer);
    expect((await job(waiting)).status).toBe('pending');
    await db.query(`UPDATE app.print_job SET status = 'failed', failure_reason = 'test cleanup' WHERE id = $1`, [waiting]);
  });

  it('the agent program itself, against this server and a printer on a socket: the ticket arrives and is reported', async () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../print-agent/universalpos-print-agent.mjs');
    const { createAgent, sendBytes } = await import(pathToFileURL(script).href) as {
      createAgent: (o: Record<string, unknown>) => { pollOnce(): Promise<unknown> };
      sendBytes: (h: string, p: number, b: Buffer, o: { connect: typeof net.createConnection }) => Promise<void>;
    };
    let deliver!: (b: Buffer) => void;
    const received = new Promise<Buffer>((done) => { deliver = done; });
    const printer = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => deliver(Buffer.concat(chunks)));
    });
    await new Promise<void>((done) => printer.listen(0, '127.0.0.1', done));
    const local = (() => net.createConnection({ host: '127.0.0.1', port: (printer.address() as net.AddressInfo).port })) as unknown as typeof net.createConnection;
    try {
      const fired = await ticket(r);
      const fetchImpl = async (url: URL, init: { body: string; headers: Record<string, string> }) => {
        const response = await app.inject({ method: 'POST', url: url.pathname, headers: init.headers, payload: init.body });
        return { status: response.statusCode, ok: response.statusCode < 400, json: async () => response.json() };
      };
      const program = createAgent({
        server: 'https://restaurant.example', token: agent.token, fetchImpl, log: () => undefined,
        send: (h: string, p: number, b: Buffer) => sendBytes(h, p, b, { connect: local }), check: async () => undefined,
      });
      await program.pollOnce();
      expect((await received).toString('utf8')).toContain('2 x Paneer Tikka');
      expect((await job(fired)).status).toBe('claimed');
      await program.pollOnce();
      expect((await job(fired)).status).toBe('accepted');
    } finally {
      await new Promise((done) => printer.close(done));
    }
  });

  it('revoked, it is refused at its next poll and the jobs it held go back to the queue', async () => {
    const held = await ticket(r);
    expect(((await poll(agent.token)).body as unknown as Work).jobs.map((j) => j.id)).toEqual([held]);
    const revoked = await http('DELETE', at(`/api/t/admin/print-agents/${agent.id}`, r.branchA), r.token);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(await job(held)).toMatchObject({ status: 'pending', claimed_by: null });
    const refused = await poll(agent.token);
    expect(refused.status).toBe(401);
    expect(refused.body['error']).toBe('print_agent_token_invalid');
    // With no active agent left, the branch is the server worker's again.
    const sent: string[] = [];
    await printOnce(appClient, { tenantIds: [r.tenantId], transport: { async send(p) { sent.push(p.printerId); } } });
    expect((await job(held)).status).toBe('accepted');
  });
});
