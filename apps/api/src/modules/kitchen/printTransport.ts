import net from 'node:net';
import { parsePrinterAddress } from '@katkitchen/shared';
import type { PrintTransport } from './printWorker.js';

/**
 * Raw ESC/POS over TCP (port 9100) -- what every networked kitchen printer speaks.
 *
 * Only a NETWORK printer is reachable from the server. A USB or Bluetooth printer
 * hangs off a device in the restaurant, so the send REFUSES rather than pretending:
 * the refusal is what walks the job to its fallback printer, and a silent success
 * would mark the ticket accepted and lose it.
 *
 * The stored address is checked against `parsePrinterAddress` before EVERY
 * connection, not only when it was saved: rows written before the rule existed
 * are still read, and the worker writes raw bytes -- dish names a manager typed
 * -- to whatever it is pointed at. Private IPv4 and ports 9100-9109 only.
 *
 * "Accepted" still means the socket took the bytes and closed cleanly. Whether
 * paper came out is not something a printer on 9100 can tell anyone.
 */

const INIT = Buffer.from([0x1b, 0x40]);
const FEED_AND_CUT = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]);

export function escPos(content: string): Buffer {
  return Buffer.concat([INIT, Buffer.from(`${content}\n`, 'utf8'), FEED_AND_CUT]);
}

export class PrinterAddressRefusedError extends Error {
  constructor(address: string, problem: string) {
    super(`printer address "${address}" refused: ${problem}`);
    this.name = 'PrinterAddressRefusedError';
  }
}

export function parseAddress(address: string): { host: string; port: number } {
  const parsed = parsePrinterAddress(address);
  if ('problem' in parsed) throw new PrinterAddressRefusedError(address, parsed.problem);
  return parsed;
}

/**
 * `dial` is where the socket really goes, after the address passed the check.
 * Identity in production; a test points it at a local fake printer. It can only
 * redirect an address that was already allowed, never widen which are.
 */
type Dial = (target: { host: string; port: number }) => { host: string; port: number };

export function networkTransport(options: { timeoutMs?: number; dial?: Dial } = {}): PrintTransport {
  const timeoutMs = options.timeoutMs ?? 5000;
  const dial = options.dial ?? ((target) => target);
  return {
    async send({ printerId, content, printer }) {
      if (!printer) throw new Error(`printer ${printerId}: connection unknown`);
      if (printer.connectionKind !== 'network') {
        throw new Error(`printer ${printerId} is ${printer.connectionKind}; the server can only reach network printers`);
      }
      if (!printer.address) throw new Error(`printer ${printerId} has no address`);
      const allowed = parseAddress(printer.address);
      const { host, port } = dial(allowed);
      const bytes = escPos(content);

      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error); else resolve();
        };
        const where = `${allowed.host}:${allowed.port}`;
        socket.setTimeout(timeoutMs, () => finish(new Error(`${where} timed out after ${timeoutMs}ms`)));
        socket.once('error', (error) => finish(new Error(`${where} ${error.message}`)));
        socket.once('connect', () => {
          socket.end(bytes, () => finish());
        });
      });
    },
  };
}
