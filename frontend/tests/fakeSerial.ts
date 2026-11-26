import type { SerialLike, SerialPortInfoLike, SerialPortLike, SerialPortRequest } from '../src/features/billing/print/serialPrinter.js';

/**
 * A Web Serial port that keeps what it was sent. `failOnCopy` makes the port
 * drop the link on the first chunk of that copy (1-based, counted by the ESC @
 * every copy starts with), once; `hang` makes every write wait forever;
 * `openFails` refuses that many opens; `choose` is how the browser's chooser
 * answers (a port, or an error name); `info` is what the port says it is;
 * `others` are further ports this browser already allowed; `noBluetoothFilter`
 * refuses a Bluetooth filter the way a browser without Bluetooth serial does;
 * `allowed: false` is a printer this browser has not been granted until it is picked.
 */
export function fakeSerial(options: {
  failOnCopy?: number; hang?: boolean; openFails?: number; choose?: string; info?: SerialPortInfoLike;
  others?: SerialPortLike[]; noBluetoothFilter?: boolean; allowed?: boolean;
} = {}): SerialLike & {
  port: SerialPortLike & { opens: number; closes: number; forgotten: boolean };
  requests: (SerialPortRequest | undefined)[];
  bytes(): number[];
  copies(): string[];
  disconnect(): void;
  reconnect(): void;
} {
  const sent: number[] = [];
  let copiesStarted = 0;
  let failOnCopy = options.failOnCopy ?? 0;
  let openFails = options.openFails ?? 0;
  let writable: WritableStream<Uint8Array> | null = null;
  const listeners: { type: string; listener: (event: Event) => void }[] = [];
  const requests: (SerialPortRequest | undefined)[] = [];
  let allowed = options.allowed ?? true;
  const fire = (type: string): void => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: port });
    listeners.filter((l) => l.type === type).forEach((l) => l.listener(event));
  };

  const port = {
    opens: 0,
    closes: 0,
    forgotten: false,
    get writable() { return writable; },
    async open() {
      if (openFails > 0) { openFails -= 1; throw Object.assign(new Error('Failed to open serial port.'), { name: 'NetworkError' }); }
      port.opens += 1;
      writable = new WritableStream<Uint8Array>({
        write(chunk) {
          if (chunk[0] === 0x1b && chunk[1] === 0x40) {
            copiesStarted += 1;
            if (copiesStarted === failOnCopy) {
              failOnCopy = 0;
              copiesStarted -= 1;
              throw Object.assign(new Error('The device has been lost.'), { name: 'NetworkError' });
            }
          }
          if (options.hang) return new Promise<void>(() => undefined);
          sent.push(...chunk);
          return undefined;
        },
      });
    },
    async close() { port.closes += 1; writable = null; },
    async forget() { port.forgotten = true; },
    getInfo: () => options.info ?? { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' },
  };

  return {
    port,
    requests,
    async requestPort(request) {
      requests.push(request);
      if (options.noBluetoothFilter && request?.filters !== undefined) throw new TypeError('A filter must provide a property to filter by.');
      if (options.choose !== undefined) throw Object.assign(new Error(options.choose), { name: options.choose });
      allowed = true;
      return port;
    },
    async getPorts() { return [...(port.forgotten || !allowed ? [] : [port]), ...(options.others ?? [])]; },
    addEventListener(type, listener) { listeners.push({ type, listener }); },
    bytes: () => sent,
    copies() {
      const text = String.fromCharCode(...sent);
      return text.split('\x1b@').filter((c) => c !== '');
    },
    disconnect: () => fire('disconnect'),
    reconnect: () => fire('connect'),
  };
}
