/**
 * Where a network (Wi-Fi or Ethernet LAN) receipt printer is: an IPv4 address on
 * the restaurant's own network and a raw-printing port.
 *
 * ONE rule for the setup form (live feedback), the save path and the print
 * worker, which checks again before every connection -- the send is the
 * authority, because rows saved before this rule existed are still read.
 *
 * Narrow on purpose. The worker writes raw bytes, including dish names a manager
 * typed, to whatever it is pointed at. Hosted in the cloud, a "private" address
 * reaches the host's own internal services (a Redis on 6379 reads plain text as
 * commands), so the address is limited to the three private IPv4 ranges -- never
 * loopback, link-local or a public address -- and the port to the raw-printing
 * range 9100-9109. A hostname is refused: what it resolves to is decided later,
 * by someone else.
 */

export const PRINTER_DEFAULT_PORT = 9100;
export const PRINTER_PORT_MIN = 9100;
export const PRINTER_PORT_MAX = 9109;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function privateIpv4Problem(ip: string): string | null {
  const m = IPV4.exec(ip);
  if (!m) return `"${ip}" is not an IP address like 192.168.1.50. Use the address printed on the printer's self-test slip.`;
  const parts = m.slice(1, 5).map((p) => (p.length > 1 && p.startsWith('0') ? Number.NaN : Number(p)));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return `"${ip}" is not a valid IP address.`;
  const [a, b] = parts as [number, number, number, number];
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return lan ? null : `${ip} is not on a restaurant's local network. A printer's address starts 192.168., 10. or 172.16.–172.31.`;
}

/** The port alone, as typed: empty means the default. */
export function printerPortProblem(port: string): string | null {
  const t = port.trim();
  if (t === '') return null;
  if (!/^\d{1,5}$/.test(t)) return 'The port is a number, usually 9100.';
  const n = Number(t);
  return n >= PRINTER_PORT_MIN && n <= PRINTER_PORT_MAX ? null
    : `Port ${n} is not a printing port. Receipt printers take raw print data on ${PRINTER_PORT_MIN}–${PRINTER_PORT_MAX}, usually 9100.`;
}

/** `host[:port]` as stored on `app.printer.address`. */
export function parsePrinterAddress(address: string): { host: string; port: number } | { problem: string } {
  const t = address.trim();
  const m = /^([^:]*)(?::(.*))?$/.exec(t);
  const host = (m?.[1] ?? '').trim();
  const portText = m?.[2];
  if (host === '') return { problem: 'Enter the printer\'s IP address.' };
  const hostProblem = privateIpv4Problem(host);
  if (hostProblem !== null) return { problem: hostProblem };
  if (portText !== undefined) {
    if (portText.trim() === '') return { problem: 'The port after ":" is empty.' };
    const portProblem = printerPortProblem(portText);
    if (portProblem !== null) return { problem: portProblem };
  }
  return { host, port: portText === undefined ? PRINTER_DEFAULT_PORT : Number(portText.trim()) };
}

export function printerAddressProblem(address: string): string | null {
  const parsed = parsePrinterAddress(address);
  return 'problem' in parsed ? parsed.problem : null;
}

/** The stored form: the default port is written out, so the list shows where tickets go. */
export function printerAddress(host: string, port: string): string {
  return `${host.trim()}:${port.trim() === '' ? PRINTER_DEFAULT_PORT : Number(port.trim())}`;
}
