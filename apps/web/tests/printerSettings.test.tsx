import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Api } from '../src/services/api.js';
import { PrintedBill } from '../src/features/billing/admin/PrintedBill.js';

/**
 * The manager's printing settings: the type is chosen before the paper and
 * decides which paper is offered; a network printer is thermal; orientation
 * only exists on a sheet; at least one copy prints; and Save writes the printer
 * and the branch through the generic admin routes the columns are declared on.
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

// The row as GET /admin/branches really answers it -- including the columns this
// page must NOT send back (code, timezone, state_code, gst_registration, ...).
// The fixture once had only the page's own fields, so Save sending the whole row
// and being refused by the server was invisible here.
const BRANCH = {
  id: 'b1', code: 'MAIN', name: 'Main', timezone: 'Asia/Kolkata', status: 'active', business_day_starts_at: '03:00:00',
  gstin: null, state_code: null, gst_registration: 'unstated', phone: null, bill_address: null, bill_footer: 'Thanks',
  bill_printer_id: null as string | null, bill_show_logo: true, bill_show_details: true, bill_show_customer: true,
  bill_show_tax: true, bill_show_payments: true, bill_copy_customer: true, bill_copy_kitchen: true,
  bill_copy_counter: true, bill_auto_print: true, bill_show_copy_label: true,
  bill_heading_unpaid: 'BILL', bill_heading_part_paid: 'PART PAID', bill_heading_paid: 'INVOICE',
  // bigint columns cross the wire as strings.
  parcel_charge_default_minor: '0', parcel_charge_max_minor: '0', parcel_charge_tax_class_id: null as string | null,
  // Company details and how tax is charged (0083).
  email: null as string | null, bill_name: null as string | null,
  tax_enabled: true, tax_account_type: 'gst' as 'none' | 'gst' | 'vat' | 'others',
  tax_calculation_mode: 'forward' as 'forward' | 'reverse', tax_registration_no: null as string | null,
};
/** `editable` for branches as the server declares it (adminResources.ts, answered by GET /admin/branches). */
const EDITABLE = [
  'name', 'timezone', 'business_day_starts_at', 'phone', 'bill_address', 'bill_footer', 'bill_printer_id',
  'bill_show_logo', 'bill_show_details', 'bill_show_customer', 'bill_show_tax', 'bill_show_payments',
  'bill_copy_customer', 'bill_copy_kitchen', 'bill_copy_counter', 'bill_auto_print', 'bill_show_copy_label',
  'parcel_charge_default_minor', 'parcel_charge_max_minor', 'parcel_charge_tax_class_id', 'email', 'bill_name',
  'bill_heading_unpaid', 'bill_heading_part_paid', 'bill_heading_paid',
];
const TAX_CLASSES = [
  { id: 't5', name: 'GST 5%', rate_bps: 500, status: 'active' },
  { id: 't18', name: 'GST 18%', rate_bps: 1800, status: 'archived' },
];
const printer = (id: string, connection: string) => ({
  id, name: `${connection} printer`, connection_kind: connection, address: null, status: 'active',
  printer_type: 'thermal', paper_size: 'thermal_80', orientation: 'portrait', margin_mm: 3, font_size_px: 12,
});

async function open(
  branch = BRANCH, accounts: readonly string[] = ['none', 'gst', 'vat', 'others'],
): Promise<{ path: string; body: Record<string, unknown> }[]> {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const api = {
    get: async (path: string) => path.startsWith('/admin/printers')
      ? { rows: [printer('p-net', 'network'), printer('p-usb', 'usb')] }
      : path === '/admin/tax-classes' ? { rows: TAX_CLASSES }
        : path === '/admin/tax-splits' ? { jurisdiction: accounts.includes('gst') ? 'IN' : 'AE', accounts, rows: [] }
          : { rows: [branch] },
    postDetailed: async (path: string, body: Record<string, unknown>) => {
      writes.push({ path, body });
      return {};
    },
    patchDetailed: async (path: string, body: Record<string, unknown>) => {
      // As the server: one field it does not accept refuses the WHOLE write.
      const refused = path.startsWith('/admin/branches/') ? Object.keys(body).filter((k) => !EDITABLE.includes(k)) : [];
      if (refused.length > 0) throw new Error(`${refused.join(', ')} cannot be set on branches through this route.`);
      writes.push({ path, body });
      return {};
    },
  } as unknown as Api;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<PrintedBill api={api} restaurantName="Spice" />); });
  await settle();
  return writes;
}

const select = (label: string): HTMLSelectElement =>
  [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('select')!;
const choose = async (label: string, value: string): Promise<void> => {
  const element = select(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
};
const options = (label: string): string[] => [...select(label).options].map((o) => o.value);
const toggle = async (label: string): Promise<void> => {
  await act(async () => { host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!.click(); });
};
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

describe('printer settings', () => {
  it('with no bill printer, nothing printer-specific is offered and the 3-inch roll is previewed', async () => {
    await open();
    expect(host.textContent).toContain("This computer's print dialog (3-inch roll)");
    expect(host.textContent).not.toContain('1. Printer type');
    expect(host.textContent).toContain('3-inch roll (79–80 mm)');
  });

  it('a network printer is thermal only, and says it gets kitchen tickets from the server', async () => {
    await open();
    await choose('Bill printer', 'p-net');
    expect(options('1. Printer type')).toEqual(['thermal']);
    expect(options('2. Paper size')).toEqual(['thermal_58', 'thermal_80', 'thermal_112']);
    expect(host.textContent).toContain('Kitchen tickets are sent to this printer by the server');
    expect(host.textContent).not.toContain('Orientation');
  });

  it('a USB printer may be laser: then only sheets are offered, with an orientation; and no server printing is claimed', async () => {
    await open();
    await choose('Bill printer', 'p-usb');
    expect(host.textContent).toContain('The server cannot reach a USB or Bluetooth printer');
    expect(host.textContent).toContain('COM port Windows gives it when paired over Bluetooth — not a TCP/IP port');
    await choose('1. Printer type', 'laser');
    expect(options('2. Paper size')).toEqual(['a5', 'a4']);
    expect(select('2. Paper size').value).toBe('a4');
    expect(options('Orientation')).toEqual(['portrait', 'landscape']);
    await choose('Orientation', 'landscape');
    expect(host.textContent).toContain('A4 (210 × 297 mm) · landscape');
  });

  it('Save writes the printer, then the branch, with the choices made', async () => {
    const writes = await open();
    await choose('Bill printer', 'p-usb');
    await choose('1. Printer type', 'laser');
    await toggle('Tax breakdown (CGST / SGST)');
    await toggle('Kitchen copy');
    await toggle('Print automatically once an order is paid');
    await toggle('Copy name at the top (CUSTOMER / KITCHEN / COUNTER)');
    expect(host.textContent).toContain('A reprint still says REPRINT');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.map((w) => w.path)).toEqual(['/admin/printers/p-usb', '/admin/branches/b1']);
    expect(writes[0]!.body).toEqual({ printer_type: 'laser', paper_size: 'a4', orientation: 'portrait', margin_mm: 3, font_size_px: 12 });
    expect(writes[1]!.body).toMatchObject({
      bill_printer_id: 'p-usb', bill_show_tax: false, bill_copy_kitchen: false, bill_auto_print: false, bill_copy_customer: true,
      bill_show_copy_label: false,
    });
  });

  it('a parcel charge (0081): a maximum needs a tax rate, the usual charge stays within it, and Save writes paise', async () => {
    const writes = await open();
    const type = async (label: string, text: string): Promise<void> => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Most parcel charge"]')!.value).toBe('0.00');
    // Only live tax rates are offered.
    expect(options('Tax rate')).toEqual(['', 't5']);

    await type('Most parcel charge', '50');
    expect(host.textContent).toContain('Choose the tax rate for parcel charges');
    expect(button('Save').disabled).toBe(true);
    await choose('Tax rate', 't5');
    await type('Usual parcel charge', '60');
    expect(host.textContent).toContain('cannot be more than the most it may charge');
    expect(button('Save').disabled).toBe(true);
    await type('Usual parcel charge', '20.5');
    expect(host.textContent).toContain('The till fills in ₹20.50 and accepts up to ₹50.00.');
    expect(writes).toHaveLength(0);

    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.at(-1)!.body).toMatchObject({
      parcel_charge_default_minor: 2050, parcel_charge_max_minor: 5000, parcel_charge_tax_class_id: 't5',
    });
  });

  it('turning every copy off is refused before anything is sent', async () => {
    const writes = await open();
    await toggle('Customer bill');
    await toggle('Kitchen copy');
    await toggle('Counter copy');
    expect(host.textContent).toContain('Choose at least one copy.');
    expect(button('Save').disabled).toBe(true);
    expect(writes).toHaveLength(0);
  });

  const typeInto = async (label: string, text: string): Promise<void> => {
    const input = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('tax (0083): the two dropdowns and the switch, sent to their own route only when changed', async () => {
    const writes = await open();
    expect(options('Tax Calculation Mode in Sales')).toEqual(['forward', 'reverse']);
    expect(options('Tax Account Type')).toEqual(['none', 'gst', 'vat', 'others']);
    expect(select('Tax Account Type').value).toBe('gst');
    expect(host.querySelector('[role="switch"][aria-label="Tax enabled"]')!.getAttribute('aria-checked')).toBe('true');

    // Nothing changed: the tax route is not called at all.
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.map((w) => w.path)).toEqual(['/admin/branches/b1']);

    await choose('Tax Account Type', 'vat');
    await choose('Tax Calculation Mode in Sales', 'reverse');
    await typeInto('VAT registration number (TRN)', '100123456700003');
    expect(host.textContent).toContain('Prices include tax: 100 holds 4.76 at 5%.');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.slice(1).map((w) => w.path)).toEqual(['/admin/branches/b1/tax', '/admin/branches/b1']);
    expect(writes[1]!.body).toEqual({
      taxEnabled: true, taxAccountType: 'vat', taxCalculationMode: 'reverse', taxRegistrationNo: '100123456700003',
    });
  });

  it('a UAE restaurant is offered no GST, and switching tax off sends it off', async () => {
    const writes = await open({ ...BRANCH, tax_account_type: 'vat' }, ['none', 'vat', 'others']);
    expect(options('Tax Account Type')).toEqual(['none', 'vat', 'others']);
    await toggle('Tax enabled');
    expect(host.textContent).toContain('Off: no tax is charged and none is printed.');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes[0]).toEqual({ path: '/admin/branches/b1/tax', body: {
      taxEnabled: false, taxAccountType: 'vat', taxCalculationMode: 'forward', taxRegistrationNo: null,
    } });
  });

  it('company details: name, email and phone are saved with the branch, and only what is filled in is sent as text', async () => {
    const writes = await open();
    await typeInto('Name on the bill', 'Spice Garden LLC');
    await typeInto('Email', 'hello@spice.ae');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.at(-1)!.body).toMatchObject({ bill_name: 'Spice Garden LLC', email: 'hello@spice.ae', phone: null });
    // A GST branch shows its GSTIN read only: it is set with the GST position, not here.
    expect(host.textContent).toContain('Set with the branch\'s GST registration.');
  });
});

describe('bill headings (0088)', () => {
  const input = (label: string): HTMLInputElement =>
    [...host.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === label)!.querySelector('input')!;
  const type = async (label: string, text: string): Promise<void> => {
    const element = input(label);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  // The preview is the till's own renderer in a frame; its heading is the first title that is not a payment status.
  const previewTitle = (): string => {
    const html = host.querySelector('iframe')!.getAttribute('srcdoc') ?? (host.querySelector('iframe') as HTMLIFrameElement).srcdoc;
    return [...html.matchAll(/<div class="c title">([^<]*)<\/div>/g)].map((m) => m[1]!)
      .filter((t) => !['UNPAID', 'PARTIALLY PAID', 'PAID'].includes(t))[0]!;
  };
  const example = async (label: string): Promise<void> => {
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!.click(); });
  };
  const heading = (row: Record<string, unknown>) =>
    [row['bill_heading_unpaid'], row['bill_heading_part_paid'], row['bill_heading_paid']];

  it('shows the saved headings, and previews each one on an unpaid, part-paid and paid example', async () => {
    await open({ ...BRANCH, bill_heading_paid: 'CASH RECEIPT' });
    expect([input('Unpaid bill').value, input('Part-paid bill').value, input('Fully paid bill').value])
      .toEqual(['BILL', 'PART PAID', 'CASH RECEIPT']);
    expect(previewTitle()).toBe('CASH RECEIPT');
    await example('Unpaid');
    expect(previewTitle()).toBe('BILL');
    await example('Part paid');
    expect(previewTitle()).toBe('PART PAID');
    expect(host.querySelector('iframe')!.getAttribute('srcdoc')).toContain('BALANCE DUE');
  });

  it('the preview follows the typing, on the example that heading is for', async () => {
    await open();
    await type('Unpaid bill', 'RESTAURANT BILL');
    expect(previewTitle()).toBe('RESTAURANT BILL');
    await type('Fully paid bill', 'TAX INVOICE');
    expect(previewTitle()).toBe('TAX INVOICE');
    await act(async () => { button('PAYMENT RECEIPT').click(); });
    expect(input('Fully paid bill').value).toBe('PAYMENT RECEIPT');
    expect(previewTitle()).toBe('PAYMENT RECEIPT');
  });

  it('a heading the printer cannot print is refused before anything is sent', async () => {
    const writes = await open();
    await type('Part-paid bill', 'ரசீது');
    expect(host.textContent).toContain('Use English letters, digits, spaces and common punctuation only');
    expect(button('Save').disabled).toBe(true);
    await type('Part-paid bill', '');
    expect(host.textContent).toContain('Enter a heading.');
    expect(button('Save').disabled).toBe(true);
    // Blank while typing: the preview still prints the default rather than nothing.
    expect(previewTitle()).toBe('PART PAID');
    expect(input('Unpaid bill').maxLength).toBe(20);
    expect(writes).toHaveLength(0);
  });

  it('Save sends the three headings trimmed; Reset to default puts back BILL, PART PAID and INVOICE', async () => {
    const writes = await open({ ...BRANCH, bill_heading_unpaid: 'RESTAURANT BILL', bill_heading_paid: 'TAX INVOICE' });
    await type('Part-paid bill', '  PAYMENT DUE ');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(writes.at(-1)!.path).toBe('/admin/branches/b1');
    expect(heading(writes.at(-1)!.body)).toEqual(['RESTAURANT BILL', 'PAYMENT DUE', 'TAX INVOICE']);

    expect(button('Reset to default').disabled).toBe(false);
    await act(async () => { button('Reset to default').click(); });
    expect([input('Unpaid bill').value, input('Part-paid bill').value, input('Fully paid bill').value])
      .toEqual(['BILL', 'PART PAID', 'INVOICE']);
    expect(button('Reset to default').disabled).toBe(true);
    await act(async () => { button('Save').click(); });
    await settle();
    expect(heading(writes.at(-1)!.body)).toEqual(['BILL', 'PART PAID', 'INVOICE']);
  });

  it('a branch row from an older API, with no headings, shows and saves the defaults', async () => {
    const { bill_heading_unpaid: _a, bill_heading_part_paid: _b, bill_heading_paid: _c, ...older } = BRANCH;
    const writes = await open(older as typeof BRANCH);
    expect([input('Unpaid bill').value, input('Part-paid bill').value, input('Fully paid bill').value])
      .toEqual(['BILL', 'PART PAID', 'INVOICE']);
    expect(previewTitle()).toBe('INVOICE');
    await act(async () => { button('Save').click(); });
    await settle();
    expect(heading(writes.at(-1)!.body)).toEqual(['BILL', 'PART PAID', 'INVOICE']);
  });
});
