import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { escPos, networkTransport, parseAddress } from '../../src/modules/business-types/restaurant/kitchen/printTransport.js';

/**
 * The network transport against a REAL socket, not a mock of one: a local TCP
 * server stands in for the printer on 9100 and records the bytes it was sent.
 * The stored address must still pass the LAN-printer rule; `dial` only moves the
 * socket to the local fake once it has.
 */

const toLocal = (port: number) => networkTransport({ dial: () => ({ host: '127.0.0.1', port }) });

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

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

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((r) => server.close(r));
  return port;
}

describe('the network print transport', () => {
  it('sends the ticket text as ESC/POS to host:port', async () => {
    const printer = await fakePrinter();
    await toLocal(printer.port).send({
      printerId: 'p1', content: 'Grill   #4\n 2 x Paneer tikka',
      printer: { connectionKind: 'network', address: '192.168.1.50:9100' },
    });
    const bytes = await printer.received;
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(bytes.toString('utf8')).toContain('2 x Paneer tikka');
    expect(bytes.subarray(-3)).toEqual(Buffer.from([0x1d, 0x56, 0x00]));
    expect(bytes).toEqual(escPos('Grill   #4\n 2 x Paneer tikka'));
  });

  it('refuses a printer that is not on the network, so the job falls back', async () => {
    await expect(networkTransport().send({
      printerId: 'p2', content: 'x', printer: { connectionKind: 'usb', address: null },
    })).rejects.toThrow(/usb; the server can only reach network printers/);
  });

  it('refuses a network printer with no address', async () => {
    await expect(networkTransport().send({
      printerId: 'p3', content: 'x', printer: { connectionKind: 'network', address: null },
    })).rejects.toThrow(/has no address/);
  });

  it('fails -- never succeeds silently -- when nothing is listening', async () => {
    const port = await closedPort();
    await expect(toLocal(port).send({
      printerId: 'p4', content: 'x',
      printer: { connectionKind: 'network', address: '192.168.1.50' },
    })).rejects.toThrow(/192\.168\.1\.50:9100 .*ECONNREFUSED/);
  });

  it('gives up on a host that does not answer, instead of hanging the drain', async () => {
    // 10.255.255.1 is unroutable: a connect that never completes.
    await expect(networkTransport({ timeoutMs: 300 }).send({
      printerId: 'p5', content: 'x',
      printer: { connectionKind: 'network', address: '10.255.255.1:9100' },
    })).rejects.toThrow(/timed out|EHOSTUNREACH|ENETUNREACH/);
  });

  it('defaults the port to 9100 and refuses a nonsense address', () => {
    expect(parseAddress('192.168.0.50')).toEqual({ host: '192.168.0.50', port: 9100 });
    expect(parseAddress(' 10.0.0.7:9101 ')).toEqual({ host: '10.0.0.7', port: 9101 });
    expect(parseAddress('172.31.4.4:9109')).toEqual({ host: '172.31.4.4', port: 9109 });
    expect(() => parseAddress('192.168.0.50:70000')).toThrow(/not a printing port/);
    expect(() => parseAddress('')).toThrow(/Enter the printer's IP address/);
    expect(() => parseAddress('192.168.552.2s')).toThrow(/not an IP address/);
  });

  // Each of these, from a cloud host, reaches something that is not a printer.
  it.each([
    ['loopback', '127.0.0.1:9100', /not on a restaurant's local network/],
    ['public', '8.8.8.8:9100', /not on a restaurant's local network/],
    ['link-local metadata', '169.254.169.254:9100', /not on a restaurant's local network/],
    ['outside 172.16/12', '172.32.0.1:9100', /not on a restaurant's local network/],
    ['a hostname', 'redis:9100', /not an IP address/],
    ['a Redis port', '10.0.0.5:6379', /not a printing port/],
    ['a Postgres port', '192.168.1.5:5432', /not a printing port/],
    ['a leading-zero octet', '192.168.01.5:9100', /not a valid IP address/],
  ])('refuses %s before any connection is opened', async (_, address, reason) => {
    let dialled = false;
    const transport = networkTransport({ dial: (t) => { dialled = true; return t; } });
    await expect(transport.send({ printerId: 'p6', content: 'FLUSHALL', printer: { connectionKind: 'network', address } }))
      .rejects.toThrow(reason);
    expect(dialled).toBe(false);
  });
});
