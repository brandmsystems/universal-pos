import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADINGS, DEFAULT_LAYOUT, headingProblem, layoutCss, pageBox, papersFor, receiptTitle, rollContent, renderCopiesHtml, renderReceiptHtml, type PrintLayout, type PrintedBill,
} from '../src/features/billing/print/receipt.js';

/**
 * The printed bill shows the server's figures and adds nothing up: a line's
 * comp is the server's `lessMinor`, the totals are the server's totals. What
 * the paper calls itself -- BILL, INVOICE, REPRINT -- is the server's count.
 */

const DOC: PrintedBill = {
  kind: 'bill', copyNo: 1, currency: 'INR', timezone: 'Asia/Kolkata', billNo: 7,
  businessDate: '2026-10-02', openedAt: '2026-10-02T13:35:00Z', billedAt: '2026-10-02T15:11:00Z',
  settledAt: null, printedAt: '2026-10-02T15:12:00Z', serviceType: 'dine_in', tables: ['G01', 'G02'],
  parcelNo: null, pickupName: null, covers: 4, waiter: 'Ravi', cashier: 'Anu',
  restaurant: {
    name: 'Paragon <Grill>', legalName: null, address: '12 MG Road', phone: '+91 98450 12345',
    gstin: '29ABCDE1234F1Z5', footer: 'Thank you! Visit again',
  },
  lines: [
    { quantity: 2, name: 'Chicken Biryani', rateMinor: 28000, grossMinor: 56000, addOns: ['Extra Raita'], lessMinor: 0, lessLabel: null },
    { quantity: 1, name: 'Coke', rateMinor: 5000, grossMinor: 5000, addOns: [], lessMinor: 5000, lessLabel: 'Complimentary' },
  ],
  subtotalMinor: 56000,
  taxes: [{ label: 'CGST 2.5%', amountMinor: 1400 }, { label: 'SGST 2.5%', amountMinor: 1400 }],
  totalMinor: 58800,
  tenders: [],
  paidMinor: 0,
  outstandingMinor: 58800,
};

const card = (amountMinor: number) =>
  ({ method: 'card', amountMinor, reference: '1234', cashReceivedMinor: null, changeMinor: 0 });

describe('the printed bill', () => {
  it('says BILL, INVOICE, or that it is a reprint, as the server counted', () => {
    expect(receiptTitle({ kind: 'bill', copyNo: 1, paidMinor: 0 })).toBe('BILL');
    expect(receiptTitle({ kind: 'bill', copyNo: 1, paidMinor: 50000 })).toBe('PART PAID');
    expect(receiptTitle({ kind: 'bill', copyNo: 2, paidMinor: 50000 })).toBe('PART PAID · COPY 2');
    expect(receiptTitle({ kind: 'receipt', copyNo: 1, paidMinor: 58800 })).toBe('INVOICE');
    expect(receiptTitle({ kind: 'receipt', copyNo: 3, paidMinor: 58800 })).toBe('INVOICE · COPY 3');
  });

  it('carries the header, the lines, the tax heads and the totals', () => {
    const html = renderReceiptHtml(DOC);
    for (const text of ['12 MG Road', 'Tel: +91 98450 12345', 'GSTIN: 29ABCDE1234F1Z5', 'Bill No: 7',
      'Table G01 + G02', 'Covers: 4', 'Waiter: Ravi', 'Cashier: Anu', 'Chicken Biryani', '+ Extra Raita',
      '280.00', '560.00', 'Less: Complimentary', '-50.00', 'CGST 2.5%', '14.00', '588.00',
      'Thank you! Visit again']) {
      expect(html, text).toContain(text);
    }
    // Times in the branch's own zone: 13:35Z is 19:05 in Kolkata.
    expect(html).toContain('Start: 19:05');
    expect(html).toContain('End: 20:41');
  });

  it('an unpaid bill lists no payments and says UNPAID', () => {
    const html = renderReceiptHtml(DOC);
    expect(html).not.toContain('Paid by');
    expect(html).toContain('<div class="c title">UNPAID</div>');
    expect(html).toContain('BALANCE DUE');
  });

  it('a part-paid bill shows what was taken and the balance still due', () => {
    const html = renderReceiptHtml({ ...DOC, tenders: [card(50000)], paidMinor: 50000, outstandingMinor: 8800 });
    expect(html).toContain('Paid by Card (1234)');
    expect(html).toContain('Total paid');
    expect(html).toContain('<span>BALANCE DUE</span><span>88.00</span>');
    expect(html).toContain('<div class="c title">PARTIALLY PAID</div>');
  });

  it('a receipt shows each method, the cash note and the change, and PAID', () => {
    // ₹588 bill: card ₹300, then a ₹500 note pays the remaining ₹288.
    const html = renderReceiptHtml({
      ...DOC, kind: 'receipt', paidMinor: 58800, outstandingMinor: 0,
      tenders: [card(30000), { method: 'cash', amountMinor: 28800, reference: null, cashReceivedMinor: 50000, changeMinor: 21200 }],
    });
    for (const text of ['Paid by Card (1234)', 'Paid by Cash', 'Cash received', '500.00', 'Change returned', '212.00', '<div class="c title">PAID</div>']) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain('BALANCE DUE');
    expect(html).not.toContain('PARTIALLY');
  });

  it('escapes what a restaurant typed, so a name cannot become markup', () => {
    const html = renderReceiptHtml(DOC);
    expect(html).toContain('Paragon &lt;Grill&gt;');
    expect(html).not.toContain('<Grill>');
  });
});

describe('the three copies of a confirmed order (Basic)', () => {
  const ticket = { ticketText: 'SPICE\nKOT #4\nDINE-IN D-3\nKitchen: Main\n 2 x Veg Thali\n      * less spicy' };
  const pages = (doc: PrintedBill, reprint = false) => renderCopiesHtml([
    { purpose: 'customer', bill: doc },
    { purpose: 'kitchen', ticket, parcel: doc.serviceType === 'parcel', reprint },
    { purpose: 'counter', bill: doc },
  ]);

  it('one page per copy, each labelled with its purpose, in order', () => {
    const html = pages(DOC);
    expect(html.match(/class="page /g)).toHaveLength(3);
    const order = ['>CUSTOMER<', '>KITCHEN<', '>COUNTER<']
      .map((label) => html.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A planned set is copy 1: neither bill copy says REPRINT.
    expect(html).not.toContain('REPRINT');
  });

  it('the kitchen copy is the kitchen ticket itself: order number, items, quantities and notes, no money', () => {
    const kitchen = renderCopiesHtml([{ purpose: 'kitchen', ticket, parcel: false, reprint: false }]);
    for (const text of ['KOT #4', 'DINE-IN D-3', ' 2 x Veg Thali', '* less spicy']) expect(kitchen).toContain(text);
    expect(kitchen).not.toContain('TOTAL');
  });

  it('the customer copy carries the bill: order, items, quantities and the totals', () => {
    const html = pages(DOC);
    const customer = html.slice(html.indexOf('>CUSTOMER<'), html.indexOf('>KITCHEN<'));
    for (const text of ['Bill No: 7', 'Chicken Biryani', 'TOTAL', '588.00']) expect(customer).toContain(text);
  });

  it('a parcel says PARCEL on every copy; a dine-in on none', () => {
    const parcel = pages({ ...DOC, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', covers: null });
    expect(parcel.match(/class="parcel">PARCEL</g)).toHaveLength(3);
    expect(pages(DOC)).not.toContain('class="parcel"');
  });

  it('a reprint says so on the copy that was reprinted', () => {
    expect(renderCopiesHtml([{ purpose: 'kitchen', ticket, parcel: false, reprint: true }])).toContain('KITCHEN · REPRINT');
    expect(renderCopiesHtml([{ purpose: 'customer', bill: { ...DOC, copyNo: 2 } }])).toContain('CUSTOMER · REPRINT');
  });

  it('with the copy name hidden (0080): no CUSTOMER / KITCHEN / COUNTER -- but REPRINT and PARCEL still print', () => {
    const hidden = { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, copyLabel: false } };
    const parcelDoc: PrintedBill = { ...DOC, layout: hidden, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', covers: null };
    const set = renderCopiesHtml([
      { purpose: 'customer', bill: parcelDoc },
      { purpose: 'kitchen', ticket, parcel: true, reprint: false },
      { purpose: 'counter', bill: parcelDoc },
    ]);
    for (const name of ['>CUSTOMER<', '>KITCHEN<', '>COUNTER<', 'class="copy"']) expect(set, name).not.toContain(name);
    expect(set.match(/class="parcel">PARCEL</g)).toHaveLength(3);
    // A reprint must never pass for the first copy, name or no name.
    const reprinted = renderCopiesHtml([
      { purpose: 'customer', bill: { ...DOC, layout: hidden, copyNo: 2 } },
      { purpose: 'kitchen', ticket, parcel: false, reprint: true },
    ]);
    expect(reprinted.match(/class="copy">REPRINT</g)).toHaveLength(2);
    expect(reprinted).not.toContain('CUSTOMER');
    // An older API that sends no copyLabel prints the name, as before.
    const older = { ...DEFAULT_LAYOUT, show: { logo: true, details: true, customer: true, tax: true, payments: true } };
    expect(renderCopiesHtml([{ purpose: 'customer', bill: { ...DOC, layout: older } }])).toContain('>CUSTOMER<');
  });
});

describe('print formats and what the bill shows (0078)', () => {
  const layout = (over: Partial<PrintLayout> = {}): PrintLayout => ({ ...DEFAULT_LAYOUT, ...over });

  it('a printer type offers only its own paper: rolls for thermal, sheets for laser and inkjet', () => {
    expect(papersFor('thermal')).toEqual(['thermal_58', 'thermal_80', 'thermal_112']);
    expect(papersFor('laser')).toEqual(['a5', 'a4']);
    expect(papersFor('inkjet')).toEqual(['a5', 'a4']);
  });

  it('a roll is as long as the bill, its content inside the print head (a 79-80 mm roll prints 72 mm)', () => {
    for (const [size, width, body, side] of [['thermal_58', 58, 48, 5], ['thermal_80', 80, 72, 4], ['thermal_112', 112, 104, 4]] as const) {
      const css = layoutCss(layout({ paperSize: size }));
      expect(css).toContain(`size: ${width}mm auto; margin: 3mm ${side}mm`);
      expect(css).toContain(`width: ${body}mm`);
      expect(css).toContain('"Courier New"');
    }
  });

  it('a roll margin wider than the print head\'s own edge is kept; a narrower one is widened to it', () => {
    expect(rollContent('thermal_80', 0)).toEqual({ sideMarginMm: 4, contentMm: 72 });
    expect(rollContent('thermal_80', 6)).toEqual({ sideMarginMm: 6, contentMm: 68 });
    expect(rollContent('a4', 5)).toEqual({ sideMarginMm: 5, contentMm: 200 });
    // The preview draws the content where the head prints it, not flush left.
    expect(layoutCss(layout({ paperSize: 'thermal_80' }))).toContain('@media screen { body { margin: 3mm 4mm; } }');
    expect(layoutCss(layout({ printerType: 'laser', paperSize: 'a4' }))).not.toContain('@media screen');
  });

  it('on a roll the copies run on one strip, parted by a tear line; on a sheet each copy has its own page', () => {
    for (const size of ['thermal_58', 'thermal_80', 'thermal_112'] as const) {
      const css = layoutCss(layout({ paperSize: size }));
      expect(css, size).not.toContain('break-before: page');
      expect(css, size).not.toContain('page-break-before');
      expect(css, size).toContain('.page + .page { margin-top: 4mm; padding-top: 1mm; border-top: 1px dashed #000; }');
      expect(css, size).toContain('content: "tear here"');
    }
    for (const size of ['a5', 'a4'] as const) {
      const css = layoutCss(layout({ printerType: 'laser', paperSize: size }));
      expect(css, size).toContain('.page + .page { break-before: page; page-break-before: always; }');
      expect(css, size).not.toContain('tear here');
    }
  });

  it('a sheet is the sheet in its orientation, with the printer\'s margin and font', () => {
    const a4 = layoutCss(layout({ printerType: 'laser', paperSize: 'a4', orientation: 'landscape', marginMm: 10, fontSizePx: 14 }));
    expect(a4).toContain('size: A4 landscape; margin: 10mm');
    expect(a4).toContain('font: 14px/1.35 Arial');
    expect(layoutCss(layout({ printerType: 'inkjet', paperSize: 'a5' }))).toContain('size: A5 portrait');
    expect(pageBox({ paperSize: 'a4', orientation: 'landscape' })).toEqual({ widthMm: 297, heightMm: 210 });
    expect(pageBox({ paperSize: 'thermal_80', orientation: 'portrait' })).toEqual({ widthMm: 80, heightMm: null });
  });

  it('the bill\'s own layout decides the page; an older API with none prints the 3-inch roll', () => {
    expect(renderReceiptHtml(DOC)).toContain('size: 80mm auto');
    expect(renderReceiptHtml({ ...DOC, layout: layout({ paperSize: 'thermal_58' }) })).toContain('size: 58mm auto');
  });

  it('turned off: no logo, no address or phone, no customer name, one Tax line, no payments on the customer copy', () => {
    const doc: PrintedBill = {
      ...DOC, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', taxMinor: 2800,
      tenders: [card(58800)], paidMinor: 58800, outstandingMinor: 0, kind: 'receipt',
      layout: layout({ show: { logo: false, details: false, customer: false, tax: false, payments: false } }),
    };
    const html = renderCopiesHtml([{ purpose: 'customer', bill: doc }], { logoUrl: '/logo.png' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('12 MG Road');
    expect(html).not.toContain('Rahul');
    expect(html).not.toContain('CGST');
    expect(html).toContain('<span>Tax</span><span>28.00</span>');
    expect(html).not.toContain('Paid by Card');
    // The GSTIN always prints: it is what makes the paper a tax invoice.
    expect(html).toContain('GSTIN: 29ABCDE1234F1Z5');
  });

  it('turned on: the logo, the customer name and the payments print', () => {
    const doc: PrintedBill = { ...DOC, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul',
      tenders: [card(58800)], paidMinor: 58800, outstandingMinor: 0, kind: 'receipt', layout: DEFAULT_LAYOUT };
    const html = renderCopiesHtml([{ purpose: 'customer', bill: doc }], { logoUrl: '/logo.png' });
    expect(html).toContain('<img class="logo" src="/logo.png"');
    expect(html).toContain('Rahul');
    expect(html).toContain('Paid by Card');
  });

  it('a parcel charge (0081) prints under the items and above the Sub Total it is part of, on the customer and counter copies', () => {
    const doc: PrintedBill = {
      ...DOC, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', covers: null,
      parcelChargeMinor: 2000, subtotalMinor: 58000,
      taxes: [{ label: 'CGST 2.5%', amountMinor: 1450 }, { label: 'SGST 2.5%', amountMinor: 1450 }],
      totalMinor: 60900, outstandingMinor: 60900,
    };
    const html = renderCopiesHtml([{ purpose: 'customer', bill: doc }, { purpose: 'counter', bill: doc }]);
    expect(html.match(/<span>Parcel charge<\/span><span>20\.00<\/span>/g)).toHaveLength(2);
    const once = renderReceiptHtml(doc);
    expect(once.indexOf('Parcel charge')).toBeGreaterThan(once.indexOf('Chicken Biryani'));
    expect(once.indexOf('Parcel charge')).toBeLessThan(once.indexOf('Sub Total'));
    // The server's figures, printed as given: nothing here adds the charge in.
    expect(once).toContain('<span>Sub Total</span><span>580.00</span>');
    expect(once).toContain('609.00');
    // None, or an API older than 0081: no line at all.
    expect(renderReceiptHtml(DOC)).not.toContain('Parcel charge');
    expect(renderReceiptHtml({ ...doc, parcelChargeMinor: 0 })).not.toContain('Parcel charge');
  });

  it('a card round-off prints under its payment, so the paid figures still reconcile', () => {
    const doc: PrintedBill = { ...DOC, totalMinor: 26250, outstandingMinor: 0, paidMinor: 26250, kind: 'receipt',
      tenders: [{ method: 'card', amountMinor: 26300, reference: null, cashReceivedMinor: null, changeMinor: 0, roundingMinor: 50 }] };
    const html = renderReceiptHtml(doc);
    expect(html).toContain('Paid by Card');
    expect(html).toContain('263.00');
    expect(html).toContain('Round off</span><span>0.50');
    expect(renderReceiptHtml({ ...doc, tenders: [card(26250)] })).not.toContain('Round off');
  });

  it('a bill paid to the nearest rupee prints TOTAL, Round off and NET PAYABLE; one without prints TOTAL alone', () => {
    const rounded = renderReceiptHtml({ ...DOC, totalMinor: 26449, roundOffMinor: -49, payableMinor: 26400, outstandingMinor: 26400 });
    expect(rounded).toContain('<span>TOTAL</span><span>264.49</span>');
    expect(rounded).toContain('<span>Round off</span><span>-0.49</span>');
    expect(rounded).toContain('<span>NET PAYABLE</span><span>264.00</span>');
    expect(rounded.indexOf('Round off')).toBeLessThan(rounded.indexOf('NET PAYABLE'));
    const up = renderReceiptHtml({ ...DOC, totalMinor: 26750, roundOffMinor: 50, payableMinor: 26800 });
    expect(up).toContain('<span>Round off</span><span>0.50</span>');
    expect(up).toContain('<span>NET PAYABLE</span><span>268.00</span>');
    const plain = renderReceiptHtml({ ...DOC, roundOffMinor: 0, payableMinor: DOC.totalMinor });
    expect(plain).not.toContain('NET PAYABLE');
    expect(plain).not.toContain('Round off');
  });

  it('the counter copy always carries the payments, and leaves the logo and footer to the customer', () => {
    const doc: PrintedBill = { ...DOC, tenders: [card(58800)], paidMinor: 58800, outstandingMinor: 0, kind: 'receipt',
      layout: layout({ show: { ...DEFAULT_LAYOUT.show, payments: false } }) };
    const counter = renderCopiesHtml([{ purpose: 'counter', bill: doc }], { logoUrl: '/logo.png' });
    expect(counter).toContain('Paid by Card');
    expect(counter).not.toContain('<img');
    expect(counter).not.toContain('Thank you! Visit again');
  });
});

describe('the printed bill, by how tax is charged (0083)', () => {
  const show = (doc: PrintedBill, tax = true): string =>
    renderReceiptHtml({ ...doc, layout: { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, tax } } });
  // A UAE bill, VAT 5% inside the prices: 588.00 holds 28.00, taxable 560.00.
  const VAT: PrintedBill = {
    ...DOC, currency: 'AED', pricesIncludeTax: true, taxLabel: 'VAT',
    restaurant: { ...DOC.restaurant, gstin: null, email: 'hello@spice.ae', taxNumber: { label: 'TRN', value: '100123456700003' } },
    subtotalMinor: 56000, taxes: [{ label: 'VAT 5%', amountMinor: 2800 }], taxMinor: 2800, totalMinor: 58800,
  };

  it('reverse: the taxable value, the VAT as included, the TRN and the email -- and no GSTIN', () => {
    const html = show(VAT);
    for (const text of ['TRN: 100123456700003', 'hello@spice.ae', 'Taxable value', 'VAT 5% (included)', 'Prices include VAT']) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain('GSTIN');
    expect(html).not.toContain('Sub Total');
    // One line when the branch prints no breakdown: still the bill's own figure, still included.
    expect(show(VAT, false)).toContain('VAT (included)');
  });

  it('forward GST is the bill it always was: Sub Total, the heads, the GSTIN', () => {
    const html = show({ ...DOC, pricesIncludeTax: false, taxLabel: 'GST', restaurant: { ...DOC.restaurant, taxNumber: { label: 'GSTIN', value: '29ABCDE1234F1Z5' } } });
    for (const text of ['Sub Total', 'CGST 2.5%', 'SGST 2.5%', 'GSTIN: 29ABCDE1234F1Z5']) expect(html, text).toContain(text);
    expect(html).not.toContain('(included)');
    expect(html).not.toContain('Prices include');
  });

  it('tax off or NONE prints no tax line at all, even where the branch asks for one line', () => {
    const none: PrintedBill = { ...DOC, taxLabel: null, taxes: [], taxMinor: 0, totalMinor: 56000, restaurant: { ...DOC.restaurant, gstin: null, taxNumber: null } };
    for (const html of [show(none), show(none, false)]) {
      expect(html).not.toMatch(/>Tax</);
      expect(html).not.toContain('CGST');
      expect(html).not.toContain('GSTIN');
    }
  });

  it('only configured details print: no email, no number, no phone line when they are not set', () => {
    const bare = show({ ...DOC, restaurant: { ...DOC.restaurant, phone: null, email: null, gstin: null, taxNumber: null } });
    expect(bare).not.toContain('Tel:');
    expect(bare).not.toMatch(/[a-z]@[a-z]/);
    expect(bare).not.toContain('GSTIN');
    // An API older than 0083 sends no taxNumber: the GSTIN still prints.
    expect(show(DOC)).toContain('GSTIN: 29ABCDE1234F1Z5');
  });
});

describe('bill headings (0088): the branch\'s words, the server\'s choice of which', () => {
  const ticket = { ticketText: 'SPICE\nKOT #4\nDINE-IN D-3\n 2 x Veg Thali' };
  const CUSTOM = { unpaid: 'RESTAURANT BILL', partPaid: 'PAYMENT DUE', paid: 'TAX INVOICE' };
  const withHeadings = (doc: PrintedBill, headings = CUSTOM): PrintedBill => ({ ...doc, layout: { ...DEFAULT_LAYOUT, headings } });
  const paid: Partial<PrintedBill> = { kind: 'receipt', settledAt: '2026-10-02T15:12:00Z', tenders: [card(58800)], paidMinor: 58800, outstandingMinor: 0 };
  const part: Partial<PrintedBill> = { tenders: [card(50000)], paidMinor: 50000, outstandingMinor: 8800 };
  const title = (html: string): string[] => [...html.matchAll(/<div class="c title">([^<]*)<\/div>/g)].map((m) => m[1]!)
    .filter((t) => !['UNPAID', 'PARTIALLY PAID', 'PAID'].includes(t));

  it('the defaults are what every branch printed before: BILL, PART PAID, INVOICE', () => {
    expect(DEFAULT_HEADINGS).toEqual({ unpaid: 'BILL', partPaid: 'PART PAID', paid: 'INVOICE' });
    expect(DEFAULT_LAYOUT.headings).toEqual(DEFAULT_HEADINGS);
    // An older API sends no headings: the defaults print.
    const { headings: _gone, ...older } = DEFAULT_LAYOUT;
    expect(title(renderReceiptHtml({ ...DOC, layout: older }))).toEqual(['BILL']);
    expect(title(renderReceiptHtml({ ...DOC, ...part, layout: older }))).toEqual(['PART PAID']);
    expect(title(renderReceiptHtml({ ...DOC, ...paid, layout: older }))).toEqual(['INVOICE']);
  });

  it('unpaid, part-paid and fully paid each print their own heading, with COPY n on a counted reprint', () => {
    expect(receiptTitle({ kind: 'bill', copyNo: 1, paidMinor: 0 }, CUSTOM)).toBe('RESTAURANT BILL');
    expect(receiptTitle({ kind: 'bill', copyNo: 1, paidMinor: 1 }, CUSTOM)).toBe('PAYMENT DUE');
    expect(receiptTitle({ kind: 'receipt', copyNo: 1, paidMinor: 58800 }, CUSTOM)).toBe('TAX INVOICE');
    expect(receiptTitle({ kind: 'receipt', copyNo: 12, paidMinor: 58800 }, CUSTOM)).toBe('TAX INVOICE · COPY 12');
    expect(title(renderReceiptHtml(withHeadings(DOC)))).toEqual(['RESTAURANT BILL']);
    expect(title(renderReceiptHtml(withHeadings({ ...DOC, ...part })))).toEqual(['PAYMENT DUE']);
    expect(title(renderReceiptHtml(withHeadings({ ...DOC, ...paid })))).toEqual(['TAX INVOICE']);
    // The print frame's own title follows it too.
    expect(renderReceiptHtml(withHeadings({ ...DOC, ...paid }))).toContain('<title>TAX INVOICE 7</title>');
  });

  it('heads the CUSTOMER and BILLING COUNTER copies, never the kitchen ticket; REPRINT and PARCEL still print', () => {
    const parcel = withHeadings({ ...DOC, ...paid, copyNo: 2, serviceType: 'parcel', tables: [], parcelNo: 7, pickupName: 'Rahul', covers: null });
    const html = renderCopiesHtml([
      { purpose: 'customer', bill: parcel },
      { purpose: 'kitchen', ticket, parcel: true, reprint: true },
      { purpose: 'counter', bill: parcel },
    ]);
    expect(title(html)).toEqual(['TAX INVOICE · COPY 2', 'TAX INVOICE · COPY 2']);
    const kitchen = html.slice(html.indexOf('KITCHEN · REPRINT'), html.indexOf('COUNTER · REPRINT'));
    expect(kitchen).not.toContain('TAX INVOICE');
    expect(kitchen).toContain('KOT #4');
    for (const label of ['CUSTOMER · REPRINT', 'KITCHEN · REPRINT', 'COUNTER · REPRINT']) expect(html, label).toContain(label);
    expect(html.match(/class="parcel">PARCEL</g)).toHaveLength(3);
  });

  it('the layout passed for the set heads the copies, as the paper does', () => {
    const html = renderCopiesHtml([{ purpose: 'customer', bill: DOC }], { layout: { ...DEFAULT_LAYOUT, headings: CUSTOM } });
    expect(title(html)).toEqual(['RESTAURANT BILL']);
  });

  it('what a manager typed is escaped, so a heading cannot become markup', () => {
    const html = renderReceiptHtml(withHeadings(DOC, { ...CUSTOM, unpaid: '<b>BILL</b> & CO' }));
    expect(title(html)).toEqual(['&lt;b&gt;BILL&lt;/b&gt; &amp; CO']);
    expect(html).not.toContain('<b>BILL</b>');
  });

  it('a heading left blank (mid-typing on the settings page) prints the default, never nothing', () => {
    expect(receiptTitle({ kind: 'receipt', copyNo: 1, paidMinor: 1 }, { ...CUSTOM, paid: '   ' })).toBe('INVOICE');
  });

  it('the save rule matches 0088\'s CHECK: 1 to 20 printable ASCII characters, trimmed', () => {
    for (const good of ['BILL', 'TAX INVOICE', 'CASH RECEIPT', 'PAYMENT RECEIPT', 'RESTAURANT BILL', 'Bill #1 (A&B)', 'X'.repeat(20), '  INVOICE  ']) {
      expect(headingProblem(good), good).toBeNull();
    }
    expect(headingProblem('')).toBe('Enter a heading.');
    expect(headingProblem('   ')).toBe('Enter a heading.');
    expect(headingProblem('X'.repeat(21))).toBe('Keep it to 20 characters.');
    for (const bad of ['ரசீது', 'FACTURE\u00e9', 'TAX\nINVOICE', 'BILL \u20b9']) expect(headingProblem(bad), bad).toMatch(/^Use English letters/);
  });
});
