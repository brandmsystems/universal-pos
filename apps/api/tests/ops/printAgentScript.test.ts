import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePrinterAddress } from '@universalpos/shared';

/**
 * The print agent program (apps/print-agent), which runs alone on a till
 * without the monorepo -- so it carries its own copy of the address rule, and
 * this file holds that copy to the shared one.
 */

interface AgentModule {
  VERSION: string;
  allowedTarget(host: string, port: number): string | null;
  sendBytes(host: string, port: number, bytes: Buffer, opts?: { timeoutMs?: number; connect?: typeof net.createConnection }): Promise<void>;
  createAgent(options: {
    server: string; token: string;
    fetchImpl: (url: URL, init: { body: string; headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
    send?: (host: string, port: number, bytes: Buffer) => Promise<void>;
    check?: (host: string, port: number) => Promise<void>;
    now?: () => number;
    log?: (line: string) => void;
  }): { pollOnce(opts?: { claim?: boolean }): Promise<unknown>; pending: Record<string, unknown[]> };
}

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../print-agent/universalpos-print-agent.mjs');
const load = async (): Promise<AgentModule> => (await import(pathToFileURL(SCRIPT).href)) as AgentModule;

const servers: net.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });

async function fakePrinter(): Promise<{ port: number; received: Promise<Buffer> }> {
  let deliver!: (b: Buffer) => void;
  const received = new Promise<Buffer>((r) => { deliver = r; });
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => deliver(Buffer.concat(chunks)));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, received };
}

describe('the agent program\'s copy of the address rule', () => {
  // Every case the shared rule distinguishes, plus a synthetic edge of each range.
  const CASES: [string, number][] = [
    ['192.168.1.50', 9100], ['10.0.0.7', 9101], ['172.16.0.1', 9109], ['172.31.255.255', 9100],
    ['172.15.0.1', 9100], ['172.32.0.1', 9100], ['192.169.0.1', 9100], ['11.0.0.1', 9100],
    ['127.0.0.1', 9100], ['169.254.169.254', 9100], ['8.8.8.8', 9100], ['0.0.0.0', 9100],
    ['192.168.1.50', 9099], ['192.168.1.50', 9110], ['10.0.0.5', 6379], ['192.168.1.5', 5432],
    ['192.168.01.5', 9100], ['192.168.1.256', 9100], ['printer.local', 9100], ['redis', 9100], ['', 9100],
  ];

  it('agrees with parsePrinterAddress on every case', async () => {
    const agent = await load();
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    for (const [host, port] of CASES) {
      const shared = parsePrinterAddress(`${host}:${port}`);
      expect(agent.allowedTarget(host, port) === null, `${host}:${port}`).toBe(!('problem' in shared));
    }
  });

  it('refuses before connecting, and sends to an allowed one', async () => {
    const agent = await load();
    let connected = 0;
    const connect = ((opts: net.NetConnectOpts) => { connected += 1; return net.createConnection(opts); }) as typeof net.createConnection;
    await expect(agent.sendBytes('8.8.8.8', 9100, Buffer.from('x'), { connect })).rejects.toThrow(/refused: .*not on a restaurant/);
    await expect(agent.sendBytes('10.0.0.5', 6379, Buffer.from('FLUSHALL'), { connect })).rejects.toThrow(/not a printing port/);
    expect(connected).toBe(0);

    const printer = await fakePrinter();
    const local = ((_: net.NetConnectOpts) => net.createConnection({ host: '127.0.0.1', port: printer.port })) as typeof net.createConnection;
    await agent.sendBytes('192.168.1.50', 9100, Buffer.from([0x1b, 0x40, 0x41]), { connect: local });
    expect(await printer.received).toEqual(Buffer.from([0x1b, 0x40, 0x41]));
  });
});

describe('the agent\'s poll cycle', () => {
  type Answer = { status?: number; jobs?: unknown[]; printers?: unknown[] };
  function server(answers: Answer[]) {
    const reports: Record<string, unknown>[] = [];
    const fetchImpl = async (_url: URL, init: { body: string; headers: Record<string, string> }) => {
      reports.push(JSON.parse(init.body) as Record<string, unknown>);
      expect(init.headers['authorization']).toBe('Bearer t.secret');
      const a = answers.shift() ?? {};
      const status = a.status ?? 200;
      if (status === 0) throw new TypeError('fetch failed');
      return { status, ok: status < 400, json: async () => ({ agent: { name: 'Till' }, jobs: a.jobs ?? [], printers: a.printers ?? [], pollAfterMs: 2000 }) };
    };
    return { reports, fetchImpl };
  }
  const job = (id: string) => ({ id, printerId: 'p', host: '192.168.1.50', port: 9100, bytes: Buffer.from('ticket').toString('base64') });
  const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it('prints what it is handed and reports it at the next poll; a failure is reported with its reason', async () => {
    const { createAgent } = await load();
    const { reports, fetchImpl } = server([{ jobs: [job(ID(1)), job(ID(2))] }, {}]);
    const sent: string[] = [];
    const agent = createAgent({ server: 'https://k.test', token: 't.secret', fetchImpl, log: () => undefined,
      send: async (_h, _p, bytes) => { if (sent.length === 1) { sent.push('x'); throw new Error('ECONNREFUSED'); } sent.push(bytes.toString()); },
      check: async () => undefined });
    await agent.pollOnce();
    await agent.pollOnce();
    expect(sent[0]).toBe('ticket');
    expect(reports[1]!['jobs']).toEqual([{ id: ID(1), ok: true }, { id: ID(2), ok: false, error: 'ECONNREFUSED' }]);
  });

  it('a report the server never received is sent again, and a job handed back is not printed twice', async () => {
    const { createAgent } = await load();
    const { reports, fetchImpl } = server([{ jobs: [job(ID(3))] }, { status: 0 }, { jobs: [job(ID(3))] }, {}]);
    let prints = 0;
    const agent = createAgent({ server: 'https://k.test', token: 't.secret', fetchImpl, log: () => undefined,
      send: async () => { prints += 1; }, check: async () => undefined });
    await agent.pollOnce();
    await expect(agent.pollOnce()).rejects.toThrow('fetch failed');
    await agent.pollOnce();
    await agent.pollOnce();
    expect(prints).toBe(1);
    expect(reports[2]!['jobs']).toEqual([{ id: ID(3), ok: true }]);
    expect(reports[3]!['jobs']).toEqual([{ id: ID(3), ok: true }]);
  });

  it('a revoked token stops it, as a fatal error', async () => {
    const { createAgent } = await load();
    const { fetchImpl } = server([{ status: 401 }]);
    const agent = createAgent({ server: 'https://k.test', token: 't.secret', fetchImpl, log: () => undefined });
    await expect(agent.pollOnce()).rejects.toMatchObject({ fatal: true });
  });

  it('checks each printer every 30 s, and sends a test print when asked', async () => {
    const { createAgent } = await load();
    const printer = { id: ID(4), name: 'Grill', host: '192.168.1.50', port: 9100, testPrint: null as string | null };
    const { reports, fetchImpl } = server([
      { printers: [{ ...printer, testPrint: Buffer.from('TEST').toString('base64') }] }, { printers: [printer] }, { printers: [printer] }, {},
    ]);
    let t = 100_000;
    const sent: string[] = [];
    const agent = createAgent({ server: 'https://k.test', token: 't.secret', fetchImpl, now: () => t, log: () => undefined,
      send: async (_h, _p, b) => { sent.push(b.toString()); }, check: async () => { throw new Error('ETIMEDOUT'); } });
    await agent.pollOnce();
    await agent.pollOnce();
    t += 30_000;
    await agent.pollOnce();
    await agent.pollOnce();
    expect(sent).toEqual(['TEST']);
    expect(reports[1]).toMatchObject({ testPrints: [{ id: ID(4), ok: true }], printers: [{ id: ID(4), reachable: false, error: 'ETIMEDOUT' }] });
    expect(reports[2]!['printers']).toEqual([]);
    expect(reports[3]!['printers']).toEqual([{ id: ID(4), reachable: false, error: 'ETIMEDOUT' }]);
  });
});
