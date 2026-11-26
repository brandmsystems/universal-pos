// UniversalPOS print agent.
//
// Runs on a computer in the restaurant and prints kitchen tickets to the Wi-Fi
// and Ethernet printers on the restaurant's network, which the hosted
// UniversalPOS server cannot reach. It connects OUT to the server and opens no
// port of its own.
//
//   node universalpos-print-agent.mjs            run (poll, print, report)
//   node universalpos-print-agent.mjs --check    one poll: show the printers and whether each answers, then exit
//   node universalpos-print-agent.mjs --version
//
// Configuration, from the environment or from agent.json beside this file:
//   UNIVERSALPOS_SERVER       the restaurant's UniversalPOS address, e.g. https://universalpos.example.com
//   UNIVERSALPOS_AGENT_TOKEN  the token shown once under Setup -> Printers -> Print agent
//
// Node 22 or newer. No dependencies.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
const SEND_TIMEOUT_MS = 5000;
const PROBE_EVERY_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const REMEMBERED_JOBS = 500;

// ---------------------------------------------------------------------------
// Where it may print. A copy of parsePrinterAddress (packages/shared): this
// file runs alone on a till, without the monorepo. The server checks first and
// is the authority; this is the second check, so a stolen or forged answer
// cannot point the agent at anything but a printer on the local network.
// tests/ops/printAgentScript.test.ts holds the two copies to the same answers.
// ---------------------------------------------------------------------------
const PORT_MIN = 9100;
const PORT_MAX = 9109;

export function allowedTarget(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port)) return 'no address';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return `${host} is not an IP address`;
  const parts = m.slice(1, 5).map((p) => (p.length > 1 && p.startsWith('0') ? Number.NaN : Number(p)));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return `${host} is not a valid IP address`;
  const [a, b] = parts;
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!lan) return `${host} is not on a restaurant's local network`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is not a printing port`;
  return null;
}

// ---------------------------------------------------------------------------
// The printer side: raw bytes over TCP, which is what port 9100 speaks.
// "Sent" means the printer took the bytes and the connection closed cleanly;
// no printer on 9100 can say whether paper came out.
// ---------------------------------------------------------------------------
export function sendBytes(host, port, bytes, { timeoutMs = SEND_TIMEOUT_MS, connect = net.createConnection } = {}) {
  return new Promise((resolve, reject) => {
    const refused = allowedTarget(host, port);
    if (refused !== null) { reject(new Error(`refused: ${refused}`)); return; }
    const socket = connect({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`${host}:${port} did not answer within ${timeoutMs / 1000} s`)));
    socket.once('error', (error) => finish(new Error(`${host}:${port} ${error.code ?? error.message}`)));
    socket.once('connect', () => { socket.end(bytes, () => finish()); });
  });
}

/** Opens and closes a connection, sending nothing: whether the printer answers. */
export function probe(host, port, { timeoutMs = SEND_TIMEOUT_MS, connect = net.createConnection } = {}) {
  return sendBytes(host, port, Buffer.alloc(0), { timeoutMs, connect });
}

// ---------------------------------------------------------------------------
// One cycle: report what was done, take the next work, do it.
// ---------------------------------------------------------------------------
export function createAgent({ server, token, fetchImpl = fetch, send = sendBytes, check = probe, now = Date.now, log = console.log }) {
  const pending = { jobs: [], printers: [], testPrints: [] };
  // Jobs already sent: if a report is lost and the server hands one back, it is
  // reported again rather than printed twice.
  const sent = new Map();
  let lastProbe = 0;

  async function pollOnce({ claim = true } = {}) {
    const report = { version: VERSION, claim, ...pending };
    const response = await fetchImpl(new URL('/api/agent/poll', server), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (response.status === 401) {
      const error = new Error('The server refused this agent token: it is unknown or was revoked. Set the agent up again with a new token.');
      error.fatal = true;
      throw error;
    }
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const work = await response.json();
    // The report reached the server; only now is it forgotten.
    pending.jobs = []; pending.printers = []; pending.testPrints = [];

    for (const job of work.jobs ?? []) {
      if (sent.has(job.id)) { pending.jobs.push({ id: job.id, ok: true }); continue; }
      try {
        await send(job.host, job.port, Buffer.from(job.bytes, 'base64'));
        sent.set(job.id, now());
        if (sent.size > REMEMBERED_JOBS) sent.delete(sent.keys().next().value);
        pending.jobs.push({ id: job.id, ok: true });
        log(`printed ticket ${job.id.slice(0, 8)} on ${job.host}:${job.port}`);
      } catch (error) {
        pending.jobs.push({ id: job.id, ok: false, error: error.message });
        log(`ticket ${job.id.slice(0, 8)} did not print on ${job.host}:${job.port}: ${error.message}`);
      }
    }

    for (const printer of work.printers ?? []) {
      if (printer.testPrint) {
        try {
          await send(printer.host, printer.port, Buffer.from(printer.testPrint, 'base64'));
          pending.testPrints.push({ id: printer.id, ok: true });
          log(`test print sent to ${printer.name} (${printer.host}:${printer.port})`);
        } catch (error) {
          pending.testPrints.push({ id: printer.id, ok: false, error: error.message });
        }
      }
    }

    if (claim && now() - lastProbe >= PROBE_EVERY_MS) {
      lastProbe = now();
      for (const printer of work.printers ?? []) {
        try {
          await check(printer.host, printer.port);
          pending.printers.push({ id: printer.id, reachable: true });
        } catch (error) {
          pending.printers.push({ id: printer.id, reachable: false, error: error.message });
        }
      }
    }
    return work;
  }

  return { pollOnce, pending };
}

function config() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.json'), 'utf8'));
  } catch { /* no file: the environment only */ }
  const server = process.env.UNIVERSALPOS_SERVER ?? file.server;
  const token = process.env.UNIVERSALPOS_AGENT_TOKEN ?? file.token;
  if (!server || !token) {
    console.error('Set UNIVERSALPOS_SERVER and UNIVERSALPOS_AGENT_TOKEN, or put {"server": "...", "token": "..."} in agent.json beside this file.');
    process.exit(2);
  }
  return { server, token };
}

async function main(args) {
  if (args.includes('--version')) { console.log(VERSION); return; }
  const { server, token } = config();

  if (args.includes('--check')) {
    // claim: false -- a check takes no tickets, so it can never leave one held
    // and unreported. It reports what it saw of each printer in a second poll.
    const agent = createAgent({ server, token, log: () => undefined });
    const work = await agent.pollOnce({ claim: false });
    console.log(`Connected to ${server} as print agent "${work.agent.name}".`);
    if (work.printers.length === 0) console.log('No Wi-Fi or Ethernet printers are set up at this branch.');
    for (const printer of work.printers) {
      const answer = await probe(printer.host, printer.port).then(
        () => { agent.pending.printers.push({ id: printer.id, reachable: true }); return 'answers'; },
        (e) => { agent.pending.printers.push({ id: printer.id, reachable: false, error: e.message }); return `does NOT answer (${e.message})`; });
      console.log(`  ${printer.name} at ${printer.host}:${printer.port} ${answer}`);
    }
    await agent.pollOnce({ claim: false });
    return;
  }

  console.log(`UniversalPOS print agent ${VERSION}: polling ${server}`);
  const agent = createAgent({ server, token });
  let backoff = 1000;
  for (;;) {
    let wait;
    try {
      const work = await agent.pollOnce();
      backoff = 1000;
      wait = work.jobs.length > 0 ? 0 : work.pollAfterMs ?? 2000;
    } catch (error) {
      if (error.fatal) { console.error(error.message); process.exit(3); }
      console.error(`could not reach the server: ${error.message}; trying again in ${backoff / 1000} s`);
      wait = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
}
