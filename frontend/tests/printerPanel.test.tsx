import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrinterConnection } from '../src/features/billing/print/PrinterConnection.js';
import { createReceiptPrinter, type ReceiptPrinter } from '../src/features/billing/print/serialPrinter.js';
import { fakeSerial } from './fakeSerial.js';

/**
 * The till's printer panel: what it offers depends on the branch's bill printer
 * (set elsewhere, shown here read only), the browser, and the state of the
 * printer -- and every button runs the printer service, never a second path.
 */

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(printer: ReceiptPrinter, connection: string | null): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<PrinterConnection printer={printer} connection={connection} />));
  await settle();
}

const buttons = (): string[] => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!found) throw new Error(`no button "${name}" in ${buttons().join(' | ')}`);
  return found as HTMLButtonElement;
};
const click = async (name: string): Promise<void> => { act(() => button(name).click()); await settle(); };

describe('the printer panel', () => {
  it('a browser without Web Serial says so, names iPhone, and offers nothing to press', async () => {
    await mount(createReceiptPrinter(null, null), 'bluetooth');
    expect(host.textContent).toContain('iPhone and iPad browsers cannot');
    expect(buttons()).toEqual([]);
  });

  it('a Bluetooth branch: Search, connect, test print, disconnect -- the printer stays saved', async () => {
    const serial = fakeSerial({ allowed: false });
    const printer = createReceiptPrinter(serial, null);
    await mount(printer, 'bluetooth');
    expect(host.textContent).toContain('Disconnected');
    expect(host.textContent).toContain('This branch prints bills on: Bluetooth');
    expect(buttons()).toEqual(['Search Bluetooth devices']);

    await click('Search Bluetooth devices');
    expect(serial.requests[0]?.filters).toBeDefined();
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).toContain('Bluetooth printer');
    expect(host.querySelector('select')?.textContent).toContain('Bluetooth printer · Bluetooth · in use');

    await click('Test print');
    expect(serial.copies()[0]).toContain('PRINTER TEST');
    expect(host.textContent).toMatch(/Last print .* 1 copy sent/);

    await click('Disconnect');
    expect(host.textContent).toContain('Disconnected');
    expect(serial.port.forgotten).toBe(false);
    expect(buttons()).toContain('Connect');
    await click('Connect');
    expect(host.textContent).toContain('Connected');
  });

  it('a USB branch offers the port chooser without the Bluetooth filter', async () => {
    const serial = fakeSerial({ info: { usbVendorId: 1, usbProductId: 2 }, allowed: false });
    await mount(createReceiptPrinter(serial, null), 'usb');
    expect(buttons()).toEqual(['Choose a USB printer']);
    await click('Choose a USB printer');
    expect(serial.requests[0]).toEqual({ allowedBluetoothServiceClassIds: [expect.any(String)] });
  });

  it('a printer this browser already allowed is listed, and Connect opens it without a chooser', async () => {
    const serial = fakeSerial();
    await mount(createReceiptPrinter(serial, null), 'bluetooth');
    expect(host.querySelector('select')?.textContent).toContain('Bluetooth printer · Bluetooth');
    expect(host.textContent).toContain('Not connected on this till yet.');
    await click('Connect');
    expect(serial.requests).toEqual([]);
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).toMatch(/Last connected/);
  });

  it('a network branch has nothing to connect on the till', async () => {
    await mount(createReceiptPrinter(fakeSerial(), null), 'network');
    expect(host.textContent).toContain('Nothing to connect on this till');
    expect(buttons()).toEqual([]);
  });

  it('a dropped printer shows the error and offers Reconnect; Forget removes it from the list', async () => {
    const serial = fakeSerial({ openFails: 1, allowed: false });
    const printer = createReceiptPrinter(serial, null);
    await mount(printer, null);
    await click('Search Bluetooth devices');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('switched on, paired');
    await click('Reconnect');
    expect(host.textContent).toContain('Connected');

    await click('Forget this printer');
    expect(serial.port.forgotten).toBe(true);
    expect(host.querySelector('select')).toBeNull();
    expect(host.textContent).toContain('Disconnected');
  });
});
