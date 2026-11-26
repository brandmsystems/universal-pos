import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parsePrinterAddress } from '@katkitchen/shared';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { AUTHENTICABLE_TENANT_STATUSES } from '../auth/preAuthTenant.js';
import { escPos } from './printTransport.js';
import { claimBatch, heldJob, jobPayload, markAccepted, recordFailure } from './printWorker.js';

/**
 * The local print agent, server side.
 *
 * ###########################################################################
 * THE AGENT IS A SECOND CLAIMANT ON THE SAME QUEUE, NOT A SECOND QUEUE.
 *
 * A program on a computer in the restaurant polls `POST /api/agent/poll`. Each
 * poll reports what it did with the jobs it held, then claims the next ones --
 * with `claimBatch`, `jobPayload`, `markAccepted` and `recordFailure`, the
 * worker's own functions. Attempts, backoff, fallback and the FALLBACK COPY
 * banner are therefore the worker's, unchanged.
 *
 * The server renders the ticket and sends ESC/POS BYTES: the agent has no
 * ticket layout of its own to drift from the one the worker prints.
 *
 * The agent connects OUT. Nothing listens in the restaurant, and the agent is
 * told to print only to its own branch's network printers, at addresses the
 * server checked -- never to an address a request carried.
 * ###########################################################################
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 10;
/** How long the agent waits between polls when there is nothing to do. */
export const AGENT_POLL_MS = 2000;
/** Seen within this long, an agent shows as online. */
export const AGENT_ONLINE_MS = 30_000;

export interface PrintAgentIdentity {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
}

const claimant = (agent: PrintAgentIdentity): string => `agent:${agent.id}`;
const hashOf = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

export class PrintAgentTokenInvalidError extends Error {
  readonly statusCode = 401;
  readonly code = 'print_agent_token_invalid';
  constructor() {
    super('this print agent token is unknown, revoked, or for a restaurant that cannot sign in; set the agent up again');
    this.name = 'PrintAgentTokenInvalidError';
  }
}

export class PrintAgentUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'print_agent_unknown';
  constructor() {
    super('no such print agent at this branch');
    this.name = 'PrintAgentUnknownError';
  }
}

export class PrintAgentInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'print_agent_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'PrintAgentInvalidError';
  }
}

export class TestPrintRefusedError extends Error {
  readonly statusCode = 409;
  readonly code = 'test_print_refused';
  constructor(detail: string) {
    super(detail);
    this.name = 'TestPrintRefusedError';
  }
}

/**
 * The token is `<restaurant-slug>.<secret>`, the setup-code shape: the slug says
 * whose agent rows to look in, and only the secret is hashed and stored. Every
 * refusal is one answer -- unknown, revoked and a locked restaurant all mean the
 * same thing to the person at the agent: set it up again.
 *
 * Runs inside the caller's transaction and SETS the tenant GUC: a request that
 * names its restaurant only through a verified secret has no other source.
 */
export async function authenticatePrintAgent(client: pg.ClientBase, token: string): Promise<PrintAgentIdentity> {
  const dot = token.indexOf('.');
  const slug = dot > 0 ? token.slice(0, dot) : '';
  const secret = dot > 0 ? token.slice(dot + 1) : '';
  if (slug === '' || secret.length < 32) throw new PrintAgentTokenInvalidError();
  const tenant = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM platform.tenant WHERE id = platform.tenant_id_for_slug($1)`, [slug]);
  const row = tenant.rows[0];
  if (!row || !AUTHENTICABLE_TENANT_STATUSES.includes(row.status)) throw new PrintAgentTokenInvalidError();
  await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', row.id]);
  const found = await client.query<{ id: string; branch_id: string; name: string }>(
    `SELECT id, branch_id, name FROM app.print_agent
      WHERE tenant_id = $1 AND token_hash = $2 AND status = 'active'`,
    [row.id, hashOf(secret)],
  );
  const agent = found.rows[0];
  if (!agent) throw new PrintAgentTokenInvalidError();
  return { id: agent.id, tenantId: row.id, branchId: agent.branch_id, name: agent.name };
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

export interface AgentReport {
  readonly version?: unknown;
  /** False on `--check`: report and read the printers, take no tickets. */
  readonly claim?: unknown;
  readonly jobs?: unknown;
  readonly printers?: unknown;
  readonly testPrints?: unknown;
}

export interface AgentJob {
  readonly id: string;
  readonly printerId: string;
  readonly host: string;
  readonly port: number;
  /** ESC/POS, base64. */
  readonly bytes: string;
}

export interface AgentPrinter {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Present when a manager asked for a test print: the slip to send, base64. */
  readonly testPrint: string | null;
}

export interface AgentWork {
  readonly agent: { readonly id: string; readonly name: string };
  readonly jobs: readonly AgentJob[];
  readonly printers: readonly AgentPrinter[];
  readonly pollAfterMs: number;
}

interface Outcome { readonly id: string; readonly ok: boolean; readonly error: string | null }

/** The agent's report, read defensively: anything malformed is dropped, never thrown on. */
function outcomes(value: unknown, okKey: 'ok' | 'reachable'): Outcome[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Outcome[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const id = e['id'];
    const ok = e[okKey];
    if (typeof id !== 'string' || !UUID.test(id) || typeof ok !== 'boolean') return [];
    const error = typeof e['error'] === 'string' && e['error'].trim() !== '' ? e['error'].trim().slice(0, 300) : null;
    return [{ id, ok, error: ok ? null : (error ?? 'no reason given') }];
  });
}

function slip(printerName: string, agentName: string, at: Date): string {
  return [
    'PRINTER TEST',
    printerName.slice(0, 32),
    at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    '-'.repeat(32),
    'KatKitchen print agent:',
    agentName.slice(0, 32),
    'No order was made.',
  ].join('\n');
}

/**
 * One poll, in the registrar's transaction: record the results the agent
 * brought, then hand it the next work. The printing itself happens on the
 * agent, outside any transaction -- the worker's rule, for the worker's reason.
 */
export async function pollPrintAgent(
  client: pg.ClientBase,
  agent: PrintAgentIdentity,
  report: AgentReport,
): Promise<AgentWork> {
  const version = typeof report.version === 'string' ? report.version.slice(0, 40) : null;
  await client.query(
    `UPDATE app.print_agent SET last_seen_at = now(), agent_version = COALESCE($2, agent_version)
      WHERE tenant_id = $1 AND id = $3`,
    [agent.tenantId, version, agent.id],
  );

  // 1. Jobs it held. A result for a job it no longer holds (reclaimed after a
  //    long stall, already reported) changes nothing.
  for (const result of outcomes(report.jobs, 'ok')) {
    const job = await heldJob(client, result.id, claimant(agent));
    if (job === null) continue;
    if (result.ok) await markAccepted(client, job.id);
    else await recordFailure(client, job, `print agent "${agent.name}": ${result.error}`);
  }

  // 2. What it saw of each printer, and the test prints it ran -- at its branch only.
  for (const probe of outcomes(report.printers, 'reachable')) {
    await client.query(
      `UPDATE app.printer
          SET reach_checked_at = now(), reachable = $3, reach_error = $4
        WHERE tenant_id = $1 AND branch_id = $2 AND id = $5 AND connection_kind = 'network'`,
      [agent.tenantId, agent.branchId, probe.ok, probe.error, probe.id],
    );
  }
  for (const test of outcomes(report.testPrints, 'ok')) {
    await client.query(
      `UPDATE app.printer
          SET test_print_requested_at = NULL,
              test_printed_at = CASE WHEN $3 THEN now() ELSE test_printed_at END,
              test_print_error = $4
        WHERE tenant_id = $1 AND branch_id = $2 AND id = $5 AND test_print_requested_at IS NOT NULL`,
      [agent.tenantId, agent.branchId, test.ok, test.error, test.id],
    );
  }

  // 3. The next jobs. One whose printer the agent cannot or must not reach is
  //    failed HERE, never handed out: the same refusal the worker's transport
  //    makes, so it walks to the fallback the same way.
  const jobs: AgentJob[] = [];
  const claimed = report.claim === false ? [] : await claimBatch(client, { workerId: claimant(agent), batchSize: BATCH, scope: { by: 'agent', branchId: agent.branchId } });
  for (const job of claimed) {
    const { target, content, printer } = await jobPayload(client, job);
    const refusal = printer.connectionKind !== 'network'
      ? `printer ${target} is ${printer.connectionKind}; the print agent prints only to Wi-Fi and Ethernet printers`
      : printer.address === null ? `printer ${target} has no address`
        : (() => { const parsed = parsePrinterAddress(printer.address); return 'problem' in parsed ? `printer address "${printer.address}" refused: ${parsed.problem}` : null; })();
    if (refusal !== null) {
      await recordFailure(client, job, refusal);
      continue;
    }
    const { host, port } = parsePrinterAddress(printer.address!) as { host: string; port: number };
    jobs.push({ id: job.id, printerId: target, host, port, bytes: escPos(content).toString('base64') });
  }

  // 4. The printers to watch: its branch's network printers at an allowed address.
  const rows = await client.query<{ id: string; name: string; address: string | null; test: boolean }>(
    `SELECT id, name, address, test_print_requested_at IS NOT NULL AS test
       FROM app.printer
      WHERE tenant_id = $1 AND branch_id = $2 AND connection_kind = 'network' AND status = 'active'
      ORDER BY name`,
    [agent.tenantId, agent.branchId],
  );
  const now = new Date();
  const printers = rows.rows.flatMap((p): AgentPrinter[] => {
    const parsed = p.address === null ? null : parsePrinterAddress(p.address);
    if (parsed === null || 'problem' in parsed) return [];
    return [{
      id: p.id, name: p.name, host: parsed.host, port: parsed.port,
      testPrint: p.test ? escPos(slip(p.name, agent.name, now)).toString('base64') : null,
    }];
  });

  return { agent: { id: agent.id, name: agent.name }, jobs, printers, pollAfterMs: AGENT_POLL_MS };
}

// ---------------------------------------------------------------------------
// The manager's side
// ---------------------------------------------------------------------------

export interface PrintAgentRow {
  readonly id: string;
  readonly branch_id: string;
  readonly name: string;
  readonly status: string;
  readonly issued_at: string;
  readonly last_seen_at: string | null;
  readonly agent_version: string | null;
  readonly online: boolean;
}

export async function listPrintAgents(context: TenantContext, branchId: string | null): Promise<{ agents: readonly PrintAgentRow[]; onlineWithinMs: number }> {
  const result = await context.client.query<PrintAgentRow>(
    `SELECT id, branch_id, name, status, issued_at::text, last_seen_at::text, agent_version,
            (status = 'active' AND last_seen_at > now() - ($3 || ' milliseconds')::interval) AS online
       FROM app.print_agent
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) AND status = 'active'
      ORDER BY issued_at`,
    [context.tenantId, branchId, String(AGENT_ONLINE_MS)],
  );
  return { agents: result.rows, onlineWithinMs: AGENT_ONLINE_MS };
}

/**
 * Issues an agent and its token. The token is in this answer and nowhere else:
 * only its hash is stored, and the audit row is written from the AGENT ROW, not
 * from this result.
 */
export async function issuePrintAgent(
  context: TenantContext,
  params: { branchId: string | null; name: unknown; issuedByUserId: string },
): Promise<{ id: string; name: string; branchId: string; token: string }> {
  if (params.branchId === null) throw new PrintAgentInvalidError('Choose the branch whose printers this agent prints to.');
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (name.length < 1 || name.length > 60) throw new PrintAgentInvalidError('Name the agent after the computer it runs on, up to 60 characters.');
  const branch = await context.client.query<{ ok: boolean }>(
    `SELECT true AS ok FROM app.branch WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [context.tenantId, params.branchId]);
  if (!branch.rows[0]) throw new PrintAgentInvalidError('That branch is not an active branch of this restaurant.');
  const slug = await context.client.query<{ slug: string }>(
    `SELECT slug::text AS slug FROM platform.tenant WHERE id = $1`, [context.tenantId]);

  const secret = randomBytes(32).toString('base64url');
  const id = randomUUID();
  await context.client.query(
    `INSERT INTO app.print_agent (id, tenant_id, branch_id, name, token_hash, issued_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, context.tenantId, params.branchId, name, hashOf(secret), params.issuedByUserId],
  );
  return { id, name, branchId: params.branchId, token: `${slug.rows[0]!.slug}.${secret}` };
}

export async function revokePrintAgent(
  context: TenantContext,
  params: { id: string; branchId: string | null; revokedByUserId: string },
): Promise<{ id: string; status: 'revoked' }> {
  if (!UUID.test(params.id)) throw new PrintAgentUnknownError();
  const result = await context.client.query(
    `UPDATE app.print_agent
        SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $4
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR branch_id = $3) AND status = 'active'`,
    [context.tenantId, params.id, params.branchId, params.revokedByUserId],
  );
  if ((result.rowCount ?? 0) === 0) throw new PrintAgentUnknownError();
  // Jobs it still held go back to the queue now, not after the claim timeout.
  await context.client.query(
    `UPDATE app.print_job SET status = 'pending', claimed_at = NULL, claimed_by = NULL
      WHERE tenant_id = $1 AND status = 'claimed' AND claimed_by = $2`,
    [context.tenantId, `agent:${params.id}`],
  );
  return { id: params.id, status: 'revoked' };
}

/** Asks the branch's print agent to print a test slip on this printer at its next poll. */
export async function requestTestPrint(
  context: TenantContext,
  params: { printerId: string; branchId: string | null },
): Promise<{ id: string; requested: true }> {
  if (!UUID.test(params.printerId)) throw new TestPrintRefusedError('No such printer.');
  const found = await context.client.query<{ branch_id: string; connection_kind: string; address: string | null; status: string }>(
    `SELECT branch_id, connection_kind, address, status FROM app.printer
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR branch_id = $3)
      FOR UPDATE`,
    [context.tenantId, params.printerId, params.branchId]);
  const printer = found.rows[0];
  if (!printer || printer.status !== 'active') throw new TestPrintRefusedError('No such printer.');
  if (printer.connection_kind !== 'network') {
    throw new TestPrintRefusedError('Only a Wi-Fi or Ethernet printer prints a test through the print agent. Test a USB or Bluetooth printer from the till.');
  }
  const parsed = printer.address === null ? { problem: 'It has no IP address.' } : parsePrinterAddress(printer.address);
  if ('problem' in parsed) throw new TestPrintRefusedError(`Fix the printer's address first. ${parsed.problem}`);
  const agent = await context.client.query<{ ok: boolean }>(
    `SELECT true AS ok FROM app.print_agent WHERE tenant_id = $1 AND branch_id = $2 AND status = 'active' LIMIT 1`,
    [context.tenantId, printer.branch_id]);
  if (!agent.rows[0]) throw new TestPrintRefusedError('Set up the print agent at this branch first: it is what reaches this printer.');
  await context.client.query(
    `UPDATE app.printer SET test_print_requested_at = now(), test_print_error = NULL WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, params.printerId]);
  return { id: params.printerId, requested: true };
}
