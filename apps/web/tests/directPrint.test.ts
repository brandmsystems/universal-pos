import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAYOUT, copyLines, printHtml, rollChars, type CopyPage, type PrintLayout, type PrintedBill,
} from '../src/features/billing/print/receipt.js';
import { encodeText, escPosCopy } from '../src/features/billing/print/escpos.js';
import { SPP_SERVICE, createReceiptPrinter, printsDirect, sendCopies } from '../src/features/billing/print/serialPrinter.js';
import { fakeSerial } from './fakeSerial.js';

vi.mock('../src/features/billing/print/receipt.js', async (original) => ({
  ...await original<typeof import('../src/features/billing/print/receipt.js')>(),
  printHtml: vi.fn(),
}));

/**
 * Direct printing to the till's own USB or Bluetooth receipt printer (Web
 * Serial). The paper says what the HTML bill says -- the server's figures and
 * labels, in fixed-width text -- and the printer service never re-sends
 * something on its own, never claims paper came out, and names every failure.
 */

afterEach(() => { vi.useRealTimers(); vi.mocked(printHtml).mockClear(); });

const DOC: PrintedBill = {
  kind: 'receipt', copyNo: 1, currency: 'INR', timezone: 'Asia/Kolkata', billNo: 42, businessDate: '2026-10-13',
  openedAt: '2026-10-13T10:00:00Z', billedAt: '2026-10-13T10:20:00Z', settledAt: '2026-10-13T10:25:00Z',
  printedAt: '2026-10-13T10:25:00Z', serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', covers: null,
  waiter: null, cashier: 'Asha',
  restaurant: { name: 'Spice Garden', legalName: null, address: '12 MG Road, Bengaluru', phone: '080 1234',
    gstin: '29ABCDE1234F1Z5', footer: 'Thank you, visit again' },
  lines: [
    { quantity: 2, name: 'Paneer Butter Masala with extra gravy and butter naan', rateMinor: 25000, grossMinor: 50000,
      addOns: ['Extra cheese'], lessMinor: 5000, lessLabel: 'Staff discount' },
    { quantity: 1, name: 'Masala Tea', rateMinor: 2000, grossMinor: 2000, addOns: [], lessMinor: 0, lessLabel: null },
  ],
  parcelChargeMinor: 1000, subtotalMinor: 48000, taxLabel: 'GST',
  taxes: [{ label: 'CGST 2.5%', amountMinor: 1200 }, { label: 'SGST 2.5%', amountMinor: 1200 }], taxMinor: 2400,
  totalMinor: 50400, roundOffMinor: 0, payableMinor: 50400,
  tenders: [{ method: 'cash', amountMinor: 50400, reference: null, cashReceivedMinor: 60000, changeMinor: 9600 }],
  paidMinor: 50400, outstandingMinor: 0,
};
const TICKET = { ticketText: 'SPICE GARDEN\nKOT #4\n 2 x Paneer Butter Masala\n      * less spicy' };
const BT: PrintLayout = { ...DEFAULT_LAYOUT, connection: 'bluetooth' };
const text = (lines: readonly { text: string }[]): string => lines.map((l) => l.text).join('\n');

describe('the copies as receipt-printer text', () => {
  it('fits the roll: 48 characters on 79-80 mm, 32 on 58 mm, none on a sheet', () => {
    expect(rollChars('thermal_80')).toBe(48);
    expect(rollChars('thermal_58')).toBe(32);
    expect(rollChars('a4')).toBeNull();
    for (const width of [32, 48]) {
      const [customer, kitchen, counter] = copyLines([
        { purpose: 'customer', bill: DOC }, { purpose: 'kitchen', ticket: TICKET, parcel: true, reprint: false },
        { purpose: 'counter', bill: DOC },
      ], DEFAULT_LAYOUT, width);
      for (const line of [...customer!, ...kitchen!, ...counter!]) expect(line.text.length).toBeLessThanOrEqual(width);
    }
  });

  it('says what the bill says: labels, parcel, items, add-ons, discount, parcel charge, tax, payment and change', () => {
    const [customer] = copyLines([{ purpose: 'customer', bill: DOC }], DEFAULT_LAYOUT, 48);
    const paper = text(customer!);
    expect(customer![0]).toMatchObject({ text: 'CUSTOMER', centre: true, bold: true, tall: true });
    expect(customer![1]).toMatchObject({ text: '*** PARCEL ***' });
    for (const expected of ['Spice Garden', 'GSTIN: 29ABCDE1234F1Z5', 'INVOICE', 'Bill No: 42', 'P-7', 'Paneer Butter',
      '+ Extra cheese', 'Less: Staff discount', '-50.00', 'Parcel charge', 'CGST 2.5%', 'Paid by Cash', 'Cash received',
      'Change returned', '96.00', 'PAID', 'Thank you, visit again']) {
      expect(paper).toContain(expected);
    }
    // A long item name wraps under itself; the amount stays on its first line, flush right.
    const first = customer!.find((l) => l.text.startsWith('2   '))!;
    expect(first.text.endsWith('500.00')).toBe(true);
    expect(paper).toMatch(/TOTAL\s+504\.00/);
  });

  it('the counter copy keeps the payments when the branch hides them, and leaves the footer to the customer', () => {
    const hidden = { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, payments: false } };
    const [customer, counter] = copyLines([{ purpose: 'customer', bill: DOC }, { purpose: 'counter', bill: DOC }], hidden, 48);
    expect(text(customer!)).not.toContain('Paid by Cash');
    expect(text(counter!)).toContain('Paid by Cash');
    expect(text(counter!)).not.toContain('Thank you');
    expect(counter![0]!.text).toBe('COUNTER');
  });

  it('a reprint says REPRINT even when the copy name is hidden; tax off prints no tax line', () => {
    const quiet = { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, copyLabel: false } };
    const [again] = copyLines([{ purpose: 'customer', bill: { ...DOC, copyNo: 2, taxLabel: null } }], quiet, 48);
    expect(again![0]!.text).toBe('REPRINT');
    expect(text(again!)).toContain('INVOICE · COPY 2');
    expect(text(again!)).not.toContain('CGST');
  });

  it('AED to the fils, with VAT included in the price', () => {
    const aed: PrintedBill = { ...DOC, currency: 'AED', timezone: 'Asia/Dubai', taxLabel: 'VAT', pricesIncludeTax: true,
      taxes: [{ label: 'VAT 5%', amountMinor: 2286 }], restaurant: { ...DOC.restaurant, gstin: null, taxNumber: { label: 'TRN', value: '100123456700003' } } };
    const paper = text(copyLines([{ purpose: 'customer', bill: aed }], DEFAULT_LAYOUT, 48)[0]!);
    expect(paper).toContain('TRN: 100123456700003');
    expect(paper).toContain('Taxable value');
    expect(paper).toContain('VAT 5% (included)');
    expect(paper).toContain('Prices include VAT');
    expect(paper).toContain('504.00');
  });

  it('the branch\'s heading (0088) heads both bill copies on the printer, in bold; the kitchen copy keeps its own', () => {
    const layout: PrintLayout = { ...BT, headings: { unpaid: 'RESTAURANT BILL', partPaid: 'PAYMENT DUE', paid: 'CASH RECEIPT' } };
    const set = (bill: PrintedBill): string[][] => copyLines([
      { purpose: 'customer', bill }, { purpose: 'kitchen', ticket: TICKET, parcel: true, reprint: false }, { purpose: 'counter', bill },
    ], layout, 32).map((lines) => lines.map((l) => l.text));
    const [customer, kitchen, counter] = set(DOC);
    expect(customer).toContain('CASH RECEIPT');
    expect(counter).toContain('CASH RECEIPT');
    expect(kitchen!.join('\n')).not.toContain('CASH RECEIPT');
    expect(copyLines([{ purpose: 'customer', bill: DOC }], layout, 48)[0]!.find((l) => l.text === 'CASH RECEIPT')).toMatchObject({ bold: true, centre: true });
    // A reprint on a 2-inch roll: the longest heading and its copy number still fit one line.
    const [again] = set({ ...DOC, copyNo: 12, kind: 'bill', paidMinor: 0, outstandingMinor: 50400, tenders: [], settledAt: null });
    expect(again![0]).toBe('CUSTOMER · REPRINT');
    expect(again).toContain('RESTAURANT BILL · COPY 12');
    const [partly] = set({ ...DOC, kind: 'bill', paidMinor: 20000, outstandingMinor: 30400, settledAt: null });
    expect(partly).toContain('PAYMENT DUE');
    expect(set(DOC)[0]).toContain('*** PARCEL ***');
    // ASCII, so code page 437 prints it as typed.
    expect([...encodeText('RESTAURANT BILL · COPY 12')].includes(0x3f)).toBe(false);
  });

  it('the kitchen copy is the server ticket text as it stands, under its label', () => {
    const [kitchen] = copyLines([{ purpose: 'kitchen', ticket: TICKET, parcel: false, reprint: true }], DEFAULT_LAYOUT, 48);
    expect(kitchen!.map((l) => l.text)).toEqual(['KITCHEN · REPRINT', ...TICKET.ticketText.split('\n')]);
  });
});

describe('ESC/POS bytes', () => {
  it('code page 437: ASCII as is, the middle dot and accents mapped, rupee as Rs, other scripts as ?', () => {
    expect(encodeText('Tea 20.00')).toEqual([...'Tea 20.00'].map((c) => c.charCodeAt(0)));
    expect(encodeText('·')).toEqual([0xfa]);
    expect(encodeText('café')).toEqual([0x63, 0x61, 0x66, 0x82]);
    expect(encodeText('₹5')).toEqual([0x52, 0x73, 0x35]);
    expect(encodeText('ā')).toEqual([0x61]);
    expect(encodeText('شاي')).toEqual([0x3f, 0x3f, 0x3f]);
  });

  it('initialises, sets the code page, styles each line, and cuts only when told to', () => {
    const lines = [{ text: 'CUSTOMER', centre: true, bold: true, tall: true }, { text: 'Tea' }];
    const plain = [...escPosCopy(lines, { cut: false })];
    expect(plain.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x00]);
    expect(plain.slice(5, 14)).toEqual([0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x01]);
    expect(plain.slice(-3)).toEqual([0x1b, 0x64, 0x05]);
    expect(plain.join(',')).not.toContain([0x1d, 0x56].join(','));
    expect([...escPosCopy(lines, { cut: true })].slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });
});

describe('the receipt printer', () => {
  it('without Web Serial it is unsupported and nothing prints directly', () => {
    const printer = createReceiptPrinter(null, null);
    expect(printer.state().kind).toBe('unsupported');
    expect(printsDirect(BT, printer)).toBe(false);
  });

  it('a phone or tablet prints a roll to its connected printer whatever the branch states; a desktop and a sheet do not', async () => {
    const printer = createReceiptPrinter(fakeSerial(), null);
    const unset = { ...DEFAULT_LAYOUT, connection: null };
    const network = { ...DEFAULT_LAYOUT, connection: 'network' };
    const a4 = { ...BT, printerType: 'laser' as const, paperSize: 'a4' as const };
    expect(printsDirect(unset, printer, true)).toBe(false); // no port yet
    await printer.connect();
    expect(printsDirect(unset, printer, true)).toBe(true);
    expect(printsDirect(network, printer, true)).toBe(true);
    expect(printsDirect(a4, printer, true)).toBe(false);
    expect(printsDirect(unset, printer, false)).toBe(false);
    expect(printsDirect(network, printer, false)).toBe(false);
    expect(printsDirect(BT, printer, false)).toBe(true);
  });

  it('connects to the chosen port; a closed chooser is not an error', async () => {
    const cancelled = createReceiptPrinter(fakeSerial({ choose: 'NotFoundError' }), null);
    await cancelled.connect();
    expect(cancelled.state()).toEqual({ kind: 'disconnected' });

    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    expect(printer.state().kind).toBe('ready');
    expect(serial.port.opens).toBe(1);
  });

  it('names a blocked permission and a printer that does not answer', async () => {
    const blocked = createReceiptPrinter(fakeSerial({ choose: 'SecurityError' }), null);
    await blocked.connect();
    expect(blocked.state()).toMatchObject({ kind: 'error', message: expect.stringContaining('site settings') });

    const asleep = createReceiptPrinter(fakeSerial({ openFails: 1 }), null);
    await asleep.connect();
    expect(asleep.state()).toMatchObject({ kind: 'error', message: expect.stringContaining('switched on, paired') });
  });

  it('reopens a port this browser already allowed, without asking; disconnect keeps it saved, forget removes it', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    expect(await printer.reconnect()).toBe(true);
    expect(printer.state().kind).toBe('ready');
    await printer.disconnect();
    expect(serial.port.forgotten).toBe(false);
    expect(printer.hasPort()).toBe(false);
    expect(printer.view().saved).toHaveLength(1);
    expect(await printer.reconnect()).toBe(true);
    expect(printer.state().kind).toBe('ready');
    await printer.forget(printer.view().saved[0]!.id);
    expect(serial.port.forgotten).toBe(true);
    expect(printer.hasPort()).toBe(false);
    expect(printer.view().saved).toHaveLength(0);
    expect(await printer.reconnect()).toBe(false);
  });

  it('a printer that dozed off is reopened once before a copy is sent', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    serial.disconnect();
    expect(printer.state()).toMatchObject({ kind: 'disconnected', message: 'The printer was disconnected.' });
    const result = await printer.print([escPosCopy([{ text: 'A' }], { cut: false })]);
    expect(result).toMatchObject({ failed: [], message: null });
    expect(serial.port.opens).toBe(2);
    expect(printer.state().kind).toBe('ready');
  });

  it('a copy dropped part-way is reported with every copy after it, and is never re-sent on its own', async () => {
    const serial = fakeSerial({ failOnCopy: 2 });
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    const copies = ['ONE', 'TWO', 'THREE'].map((t) => escPosCopy([{ text: t }], { cut: false }));
    const result = await printer.print(copies);
    expect(result.failed).toEqual([1, 2]);
    expect(result.message).toContain('Copy 2 of 3 may be incomplete');
    expect(serial.copies()).toHaveLength(1);
    expect(printer.state().kind).toBe('error');

    expect(await printer.print(result.failed.map((i) => copies[i]!))).toMatchObject({ failed: [], message: null });
    expect(serial.copies().map((c) => c.match(/ONE|TWO|THREE/)?.[0])).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('a printer that stops taking data times out rather than hanging the till', async () => {
    vi.useFakeTimers();
    const printer = createReceiptPrinter(fakeSerial({ hang: true }), null);
    await printer.connect();
    const sending = printer.print([escPosCopy([{ text: 'A' }], { cut: false })]);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await sending).toMatchObject({ failed: [0], message: expect.stringContaining('stopped taking the receipt') });
  });

  it('with no port chosen, print sends nothing and says to connect', async () => {
    const printer = createReceiptPrinter(fakeSerial(), null);
    expect(await printer.print([new Uint8Array([1])])).toMatchObject({ failed: [0], message: expect.stringContaining('Connect') });
  });

  it('remembers the cutter switch for this browser', () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
    createReceiptPrinter(fakeSerial(), storage).setCuts(true);
    expect(createReceiptPrinter(fakeSerial(), storage).cuts()).toBe(true);
  });
});

describe('sendCopies: the one way the till prints copies', () => {
  const pages: CopyPage[] = [{ purpose: 'customer', bill: DOC }, { purpose: 'counter', bill: DOC }];

  it('a network printer, a sheet, or a till with no port prints through the dialog and writes nothing to a port', async () => {
    const serial = fakeSerial();
    const connected = createReceiptPrinter(serial, null);
    await connected.connect();
    for (const layout of [{ ...DEFAULT_LAYOUT, connection: 'network' }, { ...BT, printerType: 'laser' as const, paperSize: 'a4' as const }]) {
      expect(await sendCopies(pages, layout, {}, connected)).toEqual({ via: 'dialog' });
    }
    expect(await sendCopies(pages, BT, {}, createReceiptPrinter(fakeSerial(), null))).toEqual({ via: 'dialog' });
    expect(vi.mocked(printHtml)).toHaveBeenCalledTimes(3);
    expect(serial.bytes()).toHaveLength(0);
  });

  it('a connected USB or Bluetooth printer on a roll gets the copies, cut as this till says', async () => {
    for (const connection of ['usb', 'bluetooth']) {
      const serial = fakeSerial();
      const printer = createReceiptPrinter(serial, null);
      await printer.connect();
      printer.setCuts(true);
      expect(await sendCopies(pages, { ...DEFAULT_LAYOUT, connection }, {}, printer)).toMatchObject({ via: 'printer', failed: [], message: null });
      expect(serial.copies()).toHaveLength(2);
      expect(serial.bytes().slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x03]);
    }
    expect(vi.mocked(printHtml)).not.toHaveBeenCalled();
  });

  it('answers with the pages that did not print, so a retry resends exactly those', async () => {
    const printer = createReceiptPrinter(fakeSerial({ failOnCopy: 2 }), null);
    await printer.connect();
    const outcome = await sendCopies(pages, BT, {}, printer);
    expect(outcome).toMatchObject({ via: 'printer', failed: [pages[1]] });
  });
});

describe('finding, keeping and sharing the printer', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const kept = new Map<string, string>();
    return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } };
  };

  it('Search Bluetooth asks the chooser for SPP printers; the plain chooser still allows them', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect('bluetooth');
    await printer.connect('any');
    expect(serial.requests).toEqual([
      { filters: [{ bluetoothServiceClassId: SPP_SERVICE }], allowedBluetoothServiceClassIds: [SPP_SERVICE] },
      { allowedBluetoothServiceClassIds: [SPP_SERVICE] },
    ]);
    expect(printer.view().current).toMatchObject({ kind: 'bluetooth', name: 'Bluetooth printer' });
  });

  it('a browser that refuses the Bluetooth filter gets the plain chooser rather than an error', async () => {
    const serial = fakeSerial({ noBluetoothFilter: true, info: {} });
    const printer = createReceiptPrinter(serial, null);
    await printer.connect('bluetooth');
    expect(serial.requests).toHaveLength(2);
    expect(serial.requests[1]).toBeUndefined();
    expect(printer.state().kind).toBe('ready');
    expect(printer.view().current).toMatchObject({ kind: 'serial', name: 'Serial (COM) port' });
  });

  it('lists every allowed port; a saved one is opened by choice, and remembered with when', async () => {
    const usb = fakeSerial({ info: { usbVendorId: 0x0416, usbProductId: 0x5011 } }).port;
    const serial = fakeSerial({ others: [usb] });
    const storage = memory();
    const printer = createReceiptPrinter(serial, storage, { now: () => new Date('2026-11-10T09:30:00Z') });
    await printer.refresh();
    expect(printer.view().saved.map((s) => [s.kind, s.name])).toEqual([
      ['bluetooth', 'Bluetooth printer'], ['usb', 'USB printer 0416:5011'],
    ]);
    const usbId = printer.view().saved[1]!.id;
    await printer.select(usbId);
    expect(usb.opens).toBe(1);
    expect(serial.port.opens).toBe(0);
    expect(printer.view().current).toMatchObject({ id: usbId, lastConnectedAt: '2026-11-10T09:30:00.000Z' });

    // Reopening the page opens the same one, not the first in the list.
    const again = createReceiptPrinter(serial, storage);
    await again.restore();
    expect(again.view().current?.id).toBe(usbId);
    expect(usb.opens).toBe(2);
  });

  it('a printer the person disconnected is not reopened by a reload or by coming back on', async () => {
    const serial = fakeSerial();
    const storage = memory();
    const printer = createReceiptPrinter(serial, storage);
    await printer.connect();
    await printer.disconnect();
    expect(serial.port.closes).toBe(1);

    const reloaded = createReceiptPrinter(serial, storage);
    await reloaded.restore();
    expect(reloaded.hasPort()).toBe(false);
    serial.reconnect();
    await reloaded.refresh();
    expect(reloaded.hasPort()).toBe(false);
    expect(serial.port.opens).toBe(1);
  });

  it('a printer that drops and comes back on is reopened by itself', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    serial.disconnect();
    expect(printer.state().kind).toBe('disconnected');
    serial.reconnect();
    await printer.refresh();
    expect(printer.state().kind).toBe('ready');
    expect(serial.port.opens).toBe(2);
  });

  it('a name given on this till is kept, and an empty one goes back to the default', async () => {
    const storage = memory();
    const printer = createReceiptPrinter(fakeSerial(), storage);
    await printer.connect();
    const id = printer.view().current!.id;
    printer.rename(id, '  Counter printer  ');
    const reloaded = createReceiptPrinter(fakeSerial(), storage);
    await reloaded.refresh();
    expect(reloaded.view().saved[0]!.name).toBe('Counter printer');
    reloaded.rename(id, ' ');
    expect(reloaded.view().saved[0]!.name).toBe('Bluetooth printer');
  });

  it('two prints at once go one after the other: their bytes never interleave', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    const long = (t: string): Uint8Array => escPosCopy(Array.from({ length: 60 }, () => ({ text: t.repeat(30) })), { cut: false });
    const [a, b] = await Promise.all([printer.print([long('A'), long('A')]), printer.print([long('B')])]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(serial.copies().map((c) => (c.includes('AAAA') ? 'A' : '') + (c.includes('BBBB') ? 'B' : ''))).toEqual(['A', 'A', 'B']);
  });

  it('a second tap on Search while the chooser is open is ignored, not a second chooser', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await Promise.all([printer.connect('bluetooth'), printer.connect('bluetooth')]);
    expect(serial.requests).toHaveLength(1);
  });

  it('every print is a job with its own id; sent only once every byte was taken', async () => {
    let n = 0;
    const printer = createReceiptPrinter(fakeSerial({ failOnCopy: 2 }), null, { newId: () => `job-${(n += 1)}` });
    await printer.connect();
    const copy = escPosCopy([{ text: 'X' }], { cut: false });
    const first = await printer.print([copy, copy]);
    expect(first).toMatchObject({ jobId: 'job-1', failed: [1] });
    expect(printer.view().lastJob).toMatchObject({ id: 'job-1', copies: 2, status: 'incomplete' });
    const retry = await printer.print([copy]);
    expect(retry).toMatchObject({ jobId: 'job-2', failed: [] });
    expect(printer.view().lastJob).toMatchObject({ id: 'job-2', copies: 1, status: 'sent', message: null });
  });

  it('a test slip goes to the connected printer, fits a 2-inch roll, and makes nothing else', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    expect(await printer.testPrint()).toMatchObject({ failed: [] });
    const slip = serial.copies()[0]!;
    expect(slip).toContain('PRINTER TEST');
    expect(slip).toContain('Bluetooth printer');
    expect(vi.mocked(printHtml)).not.toHaveBeenCalled();
  });

  it('a test slip with no printer connected is refused by name and sends nothing', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    expect(await printer.testPrint()).toMatchObject({ failed: [0], message: expect.stringContaining('Connect') });
    expect(serial.bytes()).toHaveLength(0);
  });

  it('sendCopies notes the branch connection so the POS panel knows what to look for', async () => {
    const storage = memory();
    const printer = createReceiptPrinter(fakeSerial(), storage);
    await sendCopies([{ purpose: 'customer', bill: DOC }], { ...DEFAULT_LAYOUT, connection: 'usb' }, {}, printer);
    expect(createReceiptPrinter(fakeSerial(), storage).view().branchConnection).toBe('usb');
  });
});

describe('testing the link and remembering the last good print', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const kept = new Map<string, string>();
    return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } };
  };

  it('Test connection sends ESC @ and nothing else: no paper, no job', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    expect(await printer.testConnection()).toMatchObject({ ok: true });
    expect([...serial.bytes()]).toEqual([0x1b, 0x40]);
    expect(printer.view().lastJob).toBeNull();
    expect(printer.state().kind).toBe('ready');
  });

  it('Test connection with no printer is refused by name and sends nothing', async () => {
    const serial = fakeSerial();
    const printer = createReceiptPrinter(serial, null);
    expect(await printer.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('Connect') });
    expect(serial.bytes()).toHaveLength(0);
  });

  it('Test connection on a printer that will not open reports the error', async () => {
    const serial = fakeSerial({ openFails: 3, allowed: false });
    const printer = createReceiptPrinter(serial, null);
    await printer.connect();
    expect(await printer.testConnection()).toMatchObject({ ok: false });
    expect(printer.state().kind).toBe('error');
  });

  it('the last successful print is a whole print, kept across a reload; an incomplete one does not count', async () => {
    const storage = memory();
    let t = Date.parse('2026-11-11T10:00:00Z');
    const clock = { now: () => new Date(t) };
    const printer = createReceiptPrinter(fakeSerial({ failOnCopy: 2 }), storage, clock);
    await printer.connect();
    const copy = escPosCopy([{ text: 'X' }], { cut: false });
    await printer.print([copy, copy]);
    expect(printer.view().lastSuccessAt).toBeNull();
    t += 60_000;
    await printer.print([copy]);
    expect(printer.view().lastSuccessAt).toBe('2026-11-11T10:01:00.000Z');
    expect(createReceiptPrinter(fakeSerial(), storage).view().lastSuccessAt).toBe('2026-11-11T10:01:00.000Z');
  });
});
