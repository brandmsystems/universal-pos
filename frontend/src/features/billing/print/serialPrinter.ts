import { escPosCopy } from './escpos.js';
import {
  PAPER, copyLines, printHtml, renderCopiesHtml, rollChars,
  type CopyPage, type PrintLayout, type PrintLine, type RenderOptions,
} from './receipt.js';

/**
 * The till's own receipt printer, written to directly over Web Serial: a USB
 * printer that shows up as a COM port, or a Bluetooth printer over Bluetooth
 * Classic's Serial Port Profile (SPP) -- the COM port Windows makes when it is
 * paired, or, in a Chrome that has it, the RFCOMM channel itself. Not Web
 * Bluetooth: that speaks BLE only, and a Bluetooth receipt printer is Classic.
 *
 * The server cannot reach these printers (printTransport refuses anything but
 * a network printer); this is the till reaching the printer it sits beside.
 * Nothing about a port leaves the browser: the port objects, the names and the
 * last-connected times are this browser's, never the restaurant's records.
 *
 * Web Serial cannot scan for printers. "Search" opens the browser's own
 * chooser, which lists what the browser can see (paired, or nearby on a
 * platform whose chooser scans); the page learns only the one port picked.
 *
 * A serial printer answers nothing: bytes accepted by the port is all anyone
 * can know. "Sent" never means "paper came out".
 */

/** Bluetooth Classic's Serial Port Profile: what a Bluetooth receipt printer offers. */
export const SPP_SERVICE = '00001101-0000-1000-8000-00805f9b34fb';

export interface SerialPortInfoLike {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
  readonly bluetoothServiceClassId?: number | string;
}

/** The slice of the Web Serial API used here (Chrome and Edge 89+). */
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly writable: WritableStream<Uint8Array> | null;
  forget?(): Promise<void>;
  getInfo?(): SerialPortInfoLike;
}
export interface SerialPortRequest {
  readonly filters?: readonly { readonly bluetoothServiceClassId?: string }[];
  readonly allowedBluetoothServiceClassIds?: readonly string[];
}
export interface SerialLike {
  requestPort(options?: SerialPortRequest): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
}

export type PrinterState =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'disconnected'; readonly message?: string }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'printing'; readonly copy: number; readonly of: number }
  | { readonly kind: 'error'; readonly message: string };

/** What the port says it is. A paired Bluetooth printer on Windows often shows only as a COM port. */
export type PortKind = 'bluetooth' | 'usb' | 'serial';

/** A port this browser was allowed to use. The id is stable across reloads of this browser only. */
export interface SavedPrinter {
  readonly id: string;
  readonly name: string;
  readonly kind: PortKind;
  readonly lastConnectedAt: string | null;
}

/**
 * One send to the printer. The id is the till's own, for the person and the
 * screen: nothing is stored on the server, and a retry is a new job that sends
 * only the copies the last one did not.
 */
export interface PrintJob {
  readonly id: string;
  readonly copies: number;
  readonly status: 'sending' | 'sent' | 'incomplete';
  readonly at: string;
  readonly message: string | null;
}

export interface PrintResult {
  readonly jobId: string;
  /** Indexes of the copies the printer did not take whole, in order; empty when all were sent. */
  readonly failed: readonly number[];
  readonly message: string | null;
}

/** Everything the printer panel shows, as one value that changes only when something did. */
export interface PrinterView {
  readonly state: PrinterState;
  readonly cuts: boolean;
  readonly saved: readonly SavedPrinter[];
  /** The port in use (open, opening, or dropped and waiting to be reopened); null after Disconnect. */
  readonly current: SavedPrinter | null;
  /** The one Reconnect would open: the port in use, else the last one connected. */
  readonly remembered: SavedPrinter | null;
  readonly lastJob: PrintJob | null;
  /** When this till last sent a whole print (every copy) to a printer. Kept across reloads. */
  readonly lastSuccessAt: string | null;
  /** The branch's bill printer connection, as the last bill this till printed said it. */
  readonly branchConnection: string | null;
}

/** What the browser's chooser is asked to list. */
export type SearchFor = 'bluetooth' | 'any';

export interface ReceiptPrinter {
  state(): PrinterState;
  view(): PrinterView;
  subscribe(listener: () => void): () => void;
  /** A port is in use on this till: bills for a USB or Bluetooth printer go to it. */
  hasPort(): boolean;
  cuts(): boolean;
  setCuts(on: boolean): void;
  /** Opens the browser's chooser. Must run from a tap. `bluetooth` lists Bluetooth SPP printers only. */
  connect(searchFor?: SearchFor): Promise<void>;
  /** Opens a port from the saved list, without asking. */
  select(id: string): Promise<void>;
  /** Opens the remembered port (else the first allowed one), without asking. False when there is none. */
  reconnect(): Promise<boolean>;
  /** On page load: reopens the remembered port, unless the person disconnected it. */
  restore(): Promise<void>;
  /** Closes the port. The browser's permission stays, so it stays in the saved list. */
  disconnect(): Promise<void>;
  /** Closes the port if it is in use and withdraws the browser's permission for it. */
  forget(id: string): Promise<void>;
  rename(id: string, name: string): void;
  /** Re-reads the ports this browser allowed (another tab may have added or forgotten one). */
  refresh(): Promise<void>;
  /** The branch's bill printer connection, from a bill's layout: what the panel offers to connect. */
  noteBranchConnection(connection: string | null): void;
  print(copies: readonly Uint8Array[]): Promise<PrintResult>;
  /** A short slip that proves the till reaches the printer. No bill, order or print is created. */
  testPrint(): Promise<PrintResult>;
  /**
   * Opens the link and sends ESC @ (initialise), which prints nothing. Proves the
   * port takes bytes; a serial printer cannot say more than that.
   */
  testConnection(): Promise<{ readonly ok: boolean; readonly message: string }>;
}

const BAUD = 9600; // ignored by a Bluetooth link; the usual default for a USB-serial one
const CHUNK = 512;
const CHUNK_TIMEOUT_MS = 10_000;
const CUT_KEY = 'katkitchen.printer.cuts';
const PREFS_KEY = 'katkitchen.printer.saved';
const NAME_MAX = 40;

class Timeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Words for each way the browser refuses, said as what to do next. */
export function describeSerialError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (error instanceof Timeout) return 'The printer stopped taking the receipt. Check it is on, has paper and is in range, then Retry.';
  if (name === 'SecurityError') return 'This browser blocked the printer. Allow serial ports for this site in the browser’s site settings, then Connect.';
  if (name === 'InvalidStateError') return 'The printer’s port is open in another program or tab. Close it there, then Connect.';
  if (name === 'NetworkError') return 'The printer did not answer. Check it is switched on, paired with this computer and in range, then Connect.';
  return 'The printer could not be reached. Check it is switched on and paired, then Connect.';
}

interface Prefs {
  /** The port last connected; Reconnect and a reload open it. */
  chosen: string | null;
  /** False once the person tapped Disconnect: a reload or a printer coming back does not reopen it. */
  auto: boolean;
  names: Record<string, string>;
  last: Record<string, string>;
  branchConnection: string | null;
  printed: string | null;
}

const NO_PREFS: Prefs = { chosen: null, auto: true, names: {}, last: {}, branchConnection: null, printed: null };
const INITIALISE = new Uint8Array([0x1b, 0x40]);

function portKind(info: SerialPortInfoLike): PortKind {
  if (info.bluetoothServiceClassId !== undefined) return 'bluetooth';
  if (info.usbVendorId !== undefined) return 'usb';
  return 'serial';
}

const hex = (n: number | undefined): string => (n ?? 0).toString(16).padStart(4, '0');

function signature(port: SerialPortLike): string {
  let info: SerialPortInfoLike = {};
  try { info = port.getInfo?.() ?? {}; } catch { info = {}; }
  const kind = portKind(info);
  return kind === 'usb' ? `usb:${hex(info.usbVendorId)}:${hex(info.usbProductId)}` : kind;
}

function defaultName(id: string): string {
  if (id.startsWith('bluetooth')) return 'Bluetooth printer';
  if (id.startsWith('usb:')) {
    const [, vendor, product] = id.split(/[:#]/);
    return `USB printer ${vendor}:${product}`;
  }
  return 'Serial (COM) port';
}

/** Never wider than a 2-inch roll: a test slip must fit whatever is loaded. */
function testSlip(name: string, at: Date): PrintLine[] {
  return [
    { text: 'PRINTER TEST', centre: true, bold: true, tall: true },
    { text: name.slice(0, 32), centre: true },
    { text: at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }).slice(0, 32), centre: true },
    { text: '-'.repeat(32) },
    { text: 'This till can print here.' },
    { text: 'No bill or order was made.' },
  ];
}

export function createReceiptPrinter(
  serial: SerialLike | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  clock: { readonly now?: () => Date; readonly newId?: () => string } = {},
): ReceiptPrinter {
  const now = clock.now ?? (() => new Date());
  const newId = clock.newId ?? (() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `job-${Date.now()}-${Math.random().toString(16).slice(2)}`));

  let state: PrinterState = serial === null ? { kind: 'unsupported' } : { kind: 'disconnected' };
  let port: SerialPortLike | null = null;
  let open = false;
  let entries: { readonly id: string; readonly port: SerialPortLike }[] = [];
  let lastJob: PrintJob | null = null;
  let busy = false;
  /** Every write and every open/close runs one at a time, in order: two bills never interleave on paper. */
  let line: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const readCuts = (): boolean => { try { return storage?.getItem(CUT_KEY) === '1'; } catch { return false; } };
  let cuts = readCuts();
  let prefs: Prefs = (() => {
    try {
      const raw = storage?.getItem(PREFS_KEY);
      return raw ? { ...NO_PREFS, ...JSON.parse(raw) as Partial<Prefs> } : { ...NO_PREFS };
    } catch { return { ...NO_PREFS }; }
  })();
  const savePrefs = (): void => { try { storage?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* kept for this page only */ } };

  const idOf = (p: SerialPortLike): string => entries.find((e) => e.port === p)?.id ?? `${signature(p)}#0`;
  const describe = (id: string): SavedPrinter => ({
    id, name: prefs.names[id] ?? defaultName(id), kind: id.startsWith('bluetooth') ? 'bluetooth' : id.startsWith('usb:') ? 'usb' : 'serial',
    lastConnectedAt: prefs.last[id] ?? null,
  });

  let view: PrinterView = build();
  function build(): PrinterView {
    const saved = entries.map((e) => describe(e.id));
    const current = port === null ? null : saved.find((s) => s.id === idOf(port!)) ?? describe(idOf(port));
    const remembered = current ?? saved.find((s) => s.id === prefs.chosen) ?? null;
    return { state, cuts, saved, current, remembered, lastJob, lastSuccessAt: prefs.printed, branchConnection: prefs.branchConnection };
  }
  const emit = (): void => { view = build(); listeners.forEach((l) => l()); };
  const set = (next: PrinterState): void => { state = next; emit(); };

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = line.then(work, work);
    line = run.catch(() => undefined);
    return run;
  }

  async function refreshNow(): Promise<void> {
    if (serial === null) return;
    const ports = await serial.getPorts().catch(() => [] as SerialPortLike[]);
    const seen = new Map<string, number>();
    entries = ports.map((p) => {
      const base = signature(p);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { id: `${base}#${n}`, port: p };
    });
    emit();
  }

  async function ensureOpen(): Promise<void> {
    if (port === null) throw Object.assign(new Error('no port'), { name: 'NotFoundError' });
    if (open && port.writable !== null) return;
    try {
      await port.open({ baudRate: BAUD });
    } catch (error) {
      // Already open (this page opened it before a reload of the component): usable as it is.
      if (!(error instanceof Error && error.name === 'InvalidStateError' && port.writable !== null)) throw error;
    }
    open = true;
  }

  async function shut(): Promise<void> {
    open = false;
    try { await port?.close(); } catch { /* already closed or broken: either way it is shut */ }
  }

  /** Makes `chosen` the port in use and opens it. Runs inside the line. */
  async function use(chosen: SerialPortLike): Promise<void> {
    if (port !== null && port !== chosen) await shut();
    port = chosen;
    set({ kind: 'connecting' });
    try {
      await ensureOpen();
      const id = idOf(chosen);
      prefs = { ...prefs, chosen: id, auto: true, last: { ...prefs.last, [id]: now().toISOString() } };
      savePrefs();
      set({ kind: 'ready' });
    } catch (error) {
      set({ kind: 'error', message: describeSerialError(error) });
    }
  }

  /** One tap at a time: a second tap on Connect while the chooser is open is ignored, not queued. */
  async function once(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try { await enqueue(work); } finally { busy = false; }
  }

  serial?.addEventListener('disconnect', (event) => {
    if (event.target !== port) return;
    open = false;
    set({ kind: 'disconnected', message: 'The printer was disconnected.' });
  });
  // A remembered printer switched back on (or back in range) is reopened, unless the person disconnected it.
  serial?.addEventListener('connect', (event) => {
    void enqueue(async () => {
      await refreshNow();
      const target = event.target as SerialPortLike | null;
      if (target === null || !prefs.auto || open) return;
      if (target === port || (port === null && idOf(target) === prefs.chosen)) await use(target);
    });
  });

  async function printNow(copies: readonly Uint8Array[]): Promise<PrintResult> {
    const id = newId();
    const finish = (failed: readonly number[], message: string | null): PrintResult => {
      const at = now().toISOString();
      lastJob = { id, copies: copies.length, status: failed.length === 0 ? 'sent' : 'incomplete', at, message };
      if (failed.length === 0 && copies.length > 0) { prefs = { ...prefs, printed: at }; savePrefs(); }
      if (failed.length === 0) set({ kind: 'ready' }); else emit();
      return { jobId: id, failed, message };
    };
    if (port === null) {
      return finish(copies.map((_, i) => i), 'No printer is connected on this till. Connect it, then Retry.');
    }
    lastJob = { id, copies: copies.length, status: 'sending', at: now().toISOString(), message: null };
    for (let i = 0; i < copies.length; i += 1) {
      set({ kind: 'printing', copy: i + 1, of: copies.length });
      try {
        await ensureOpen();
      } catch {
        // Nothing of this copy was sent: one fresh attempt at the link (a
        // Bluetooth printer that dozed off reconnects on open) before giving up.
        await shut();
        try {
          await ensureOpen();
        } catch (error) {
          const message = describeSerialError(error);
          state = { kind: 'error', message };
          return finish(copies.slice(i).map((_, n) => i + n), message);
        }
      }
      try {
        await write(copies[i]!);
      } catch (error) {
        // Part of this copy may be on the paper. It is NOT re-sent here: a
        // retry is the person's decision, with the half copy in their hand.
        await shut();
        const message = `Copy ${i + 1} of ${copies.length} may be incomplete. ${describeSerialError(error)}`;
        state = { kind: 'error', message };
        return finish(copies.slice(i).map((_, n) => i + n), message);
      }
    }
    return finish([], null);
  }

  /** Writes one copy in chunks. Throws with how far it got: a copy cut short is not a copy sent. */
  async function write(bytes: Uint8Array): Promise<void> {
    const writable = port?.writable;
    if (!writable) throw Object.assign(new Error('not open'), { name: 'NetworkError' });
    const writer = writable.getWriter();
    try {
      for (let at = 0; at < bytes.length; at += CHUNK) {
        await withTimeout(writer.write(bytes.subarray(at, at + CHUNK)), CHUNK_TIMEOUT_MS);
      }
    } finally {
      writer.releaseLock();
    }
  }

  const printer: ReceiptPrinter = {
    state: () => state,
    view: () => view,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hasPort: () => port !== null,
    cuts: () => cuts,
    setCuts(on) {
      cuts = on;
      try { storage?.setItem(CUT_KEY, on ? '1' : '0'); } catch { /* kept for this page only */ }
      emit();
    },

    connect(searchFor = 'any') {
      return once(async () => {
        if (serial === null) return;
        const before = state;
        set({ kind: 'connecting' });
        const request: SerialPortRequest = searchFor === 'bluetooth'
          ? { filters: [{ bluetoothServiceClassId: SPP_SERVICE }], allowedBluetoothServiceClassIds: [SPP_SERVICE] }
          : { allowedBluetoothServiceClassIds: [SPP_SERVICE] };
        let chosen: SerialPortLike;
        try {
          try {
            chosen = await serial.requestPort(request);
          } catch (error) {
            // A browser without Bluetooth serial refuses the Bluetooth filter as an empty
            // filter (TypeError): ask again with the plain chooser, which lists COM ports.
            if (!(error instanceof TypeError)) throw error;
            chosen = await serial.requestPort();
          }
        } catch (error) {
          // The chooser closed with nothing picked: not a failure, the till is as it was.
          if (error instanceof Error && error.name === 'NotFoundError') {
            set(before.kind === 'connecting' ? { kind: 'disconnected' } : before);
            return;
          }
          set({ kind: 'error', message: describeSerialError(error) });
          return;
        }
        await refreshNow();
        await use(chosen);
      });
    },

    select(id) {
      return once(async () => {
        const entry = entries.find((e) => e.id === id);
        if (entry === undefined) { set({ kind: 'error', message: 'That printer is no longer allowed in this browser. Search for it again.' }); return; }
        await use(entry.port);
      });
    },

    async reconnect() {
      if (serial === null) return false;
      let found = false;
      await once(async () => {
        await refreshNow();
        const entry = (port !== null ? entries.find((e) => e.port === port) : undefined)
          ?? entries.find((e) => e.id === prefs.chosen) ?? entries[0];
        if (entry === undefined) return;
        found = true;
        if (port === entry.port) await shut();
        await use(entry.port);
      });
      return found;
    },

    async restore() {
      if (serial === null) return;
      await enqueue(refreshNow);
      if (prefs.auto && entries.length > 0) await printer.reconnect();
    },

    disconnect() {
      return once(async () => {
        await shut();
        port = null;
        prefs = { ...prefs, auto: false };
        savePrefs();
        set(serial === null ? { kind: 'unsupported' } : { kind: 'disconnected' });
      });
    },

    forget(id) {
      return once(async () => {
        const entry = entries.find((e) => e.id === id);
        if (entry === undefined) return;
        if (entry.port === port) { await shut(); port = null; state = { kind: 'disconnected' }; }
        try { await entry.port.forget?.(); } catch { /* the permission stays; it can still be forgotten in site settings */ }
        const { [id]: _name, ...names } = prefs.names;
        const { [id]: _last, ...last } = prefs.last;
        prefs = { ...prefs, names, last, chosen: prefs.chosen === id ? null : prefs.chosen };
        savePrefs();
        await refreshNow();
      });
    },

    rename(id, name) {
      const trimmed = name.trim().slice(0, NAME_MAX);
      const { [id]: _old, ...rest } = prefs.names;
      prefs = { ...prefs, names: trimmed === '' ? rest : { ...rest, [id]: trimmed } };
      savePrefs();
      emit();
    },

    refresh: () => enqueue(refreshNow),

    noteBranchConnection(connection) {
      if (prefs.branchConnection === connection) return;
      prefs = { ...prefs, branchConnection: connection };
      savePrefs();
      emit();
    },

    print: (copies) => enqueue(() => printNow(copies)),

    testPrint() {
      const name = view.current?.name ?? 'Receipt printer';
      return enqueue(() => printNow([escPosCopy(testSlip(name, now()), { cut: cuts })]));
    },

    testConnection() {
      return enqueue(async () => {
        if (port === null) return { ok: false, message: 'No printer is connected on this till. Connect it first.' };
        set({ kind: 'connecting' });
        try {
          try { await ensureOpen(); } catch { await shut(); await ensureOpen(); }
          await write(INITIALISE);
          set({ kind: 'ready' });
          return { ok: true, message: 'Connection OK: the printer took a command. Use Test print to check the paper.' };
        } catch (error) {
          await shut();
          const message = describeSerialError(error);
          set({ kind: 'error', message });
          return { ok: false, message };
        }
      });
    },
  };
  return printer;
}

let shared: ReceiptPrinter | null = null;

/** This page's printer. Web Serial needs Chrome or Edge, and HTTPS or localhost. */
export function receiptPrinter(): ReceiptPrinter {
  if (shared === null) {
    const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { serial?: SerialLike });
    const supported = nav?.serial !== undefined && typeof window !== 'undefined' && window.isSecureContext;
    let storage: Storage | null = null;
    try { storage = typeof localStorage === 'undefined' ? null : localStorage; } catch { storage = null; }
    shared = createReceiptPrinter(supported ? nav!.serial! : null, storage);
    void shared.restore();
  }
  return shared;
}

/**
 * Bills for a USB or Bluetooth printer on a roll go straight to the printer
 * when this till has one connected; everything else -- a network printer, a
 * sheet printer, a till with no printer chosen -- prints through the dialog,
 * as before. A network printer is never written to from here.
 */
/**
 * The mobile or tablet view: a touch screen with no hover, or a screen
 * narrower than the POS's desktop layout (Tailwind `lg`, 1024 px). A
 * touchscreen laptop at full width is still a desktop.
 */
export function isHandheld(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse) and (hover: none), (max-width: 1023.98px)').matches;
}

/**
 * On a desktop, only when the branch's bill printer IS this till's USB or
 * Bluetooth printer. On a phone or tablet, whenever this device has a receipt
 * printer connected and the paper is a roll: a handheld has no useful print
 * dialog, and the printer in its hand is the one meant. A sheet never does.
 */
export function printsDirect(layout: PrintLayout, printer: ReceiptPrinter, handheld: boolean = isHandheld()): boolean {
  if (!PAPER[layout.paperSize].roll || !printer.hasPort()) return false;
  return layout.connection === 'usb' || layout.connection === 'bluetooth' || handheld;
}

export type CopiesOutcome =
  | { readonly via: 'dialog' }
  | { readonly via: 'printer'; readonly jobId: string; readonly failed: readonly CopyPage[]; readonly message: string | null };

/**
 * The one way the till prints copies. Takes copies already fetched, so a retry
 * resends these same pages: no new bill print, ticket, order or payment.
 */
export async function sendCopies(
  pages: readonly CopyPage[], layout: PrintLayout, options: RenderOptions = {}, printer: ReceiptPrinter = receiptPrinter(),
): Promise<CopiesOutcome> {
  printer.noteBranchConnection(layout.connection);
  const width = rollChars(layout.paperSize);
  if (!printsDirect(layout, printer) || width === null) {
    printHtml(renderCopiesHtml(pages, { ...options, layout }));
    return { via: 'dialog' };
  }
  const bytes = copyLines(pages, layout, width).map((lines) => escPosCopy(lines, { cut: printer.cuts() }));
  const result = await printer.print(bytes);
  return { via: 'printer', jobId: result.jobId, failed: result.failed.map((i) => pages[i]!), message: result.message };
}
