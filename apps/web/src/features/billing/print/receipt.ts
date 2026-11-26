import { counterNumber, describePlace, localeForCurrency, minorExponent } from '@katkitchen/shared';
/**
 * The printed bill and its copies, laid out for the branch's printer.
 *
 * Every figure is the server's (`POST /pos/bill/:id/print`), and this file adds
 * nothing up -- the server sends each line's gross, the amount taken off it, the
 * tax total and the totals, and the paper shows them. The LAYOUT is the server's
 * too (0078): which printer, what paper, what the bill shows, which copies print
 * and when. One renderer serves the POS's print and preview and the admin's
 * Printing page, so what a manager approves is what prints.
 */

export interface PrintedLine {
  readonly quantity: number;
  readonly name: string;
  readonly rateMinor: number | null;
  readonly grossMinor: number;
  readonly addOns: readonly string[];
  readonly lessMinor: number;
  readonly lessLabel: string | null;
}

export type PrinterType = 'thermal' | 'laser' | 'inkjet';
export type PaperSize = 'thermal_58' | 'thermal_80' | 'thermal_112' | 'a5' | 'a4';
export type Orientation = 'portrait' | 'landscape';

/** Mirrors the API's `PrintLayout` (modules/payments/billPrint.ts). */
export interface PrintLayout {
  readonly printerName: string | null;
  readonly connection: string | null;
  readonly printerType: PrinterType;
  readonly paperSize: PaperSize;
  readonly orientation: Orientation;
  readonly marginMm: number;
  readonly fontSizePx: number;
  readonly show: {
    readonly logo: boolean;
    readonly details: boolean;
    readonly customer: boolean;
    readonly tax: boolean;
    readonly payments: boolean;
    /** The copy's name at the top (0080). Absent from an older API: shown, as before. */
    readonly copyLabel?: boolean;
  };
  readonly copies: { readonly customer: boolean; readonly kitchen: boolean; readonly counter: boolean };
  readonly autoPrint: boolean;
  /** The branch's headings (0088). Absent from an older API: the defaults. */
  readonly headings?: BillHeadings;
}

/**
 * What the customer and counter copies are headed, by how much of the bill is
 * paid (0088): nothing, some, or all of it (a receipt). Never a KOT's heading.
 */
export interface BillHeadings { readonly unpaid: string; readonly partPaid: string; readonly paid: string }

/** The headings of a branch that has not changed them -- the column defaults of 0088. */
export const DEFAULT_HEADINGS: BillHeadings = { unpaid: 'BILL', partPaid: 'PART PAID', paid: 'INVOICE' };

/** Room for " · COPY 12" beside it across a 2-inch roll. */
export const HEADING_MAX = 20;

/**
 * Why a heading cannot be saved, or null: the same rule as 0088's CHECK -- 1 to
 * 20 printable ASCII characters (a direct print is code page 437, where anything
 * else prints '?'), checked after trimming, which is what the page saves.
 */
export function headingProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Enter a heading.';
  if (t.length > HEADING_MAX) return `Keep it to ${HEADING_MAX} characters.`;
  if (!/^[ -~]+$/.test(t)) return 'Use English letters, digits, spaces and common punctuation only: the receipt printer cannot print other characters.';
  return null;
}

/** What a branch with no bill printer chosen prints on: the 3-inch roll every bill used before 0078. */
export const DEFAULT_LAYOUT: PrintLayout = {
  printerName: null, connection: null, printerType: 'thermal', paperSize: 'thermal_80', orientation: 'portrait',
  marginMm: 3, fontSizePx: 12,
  show: { logo: true, details: true, customer: true, tax: true, payments: true, copyLabel: true },
  copies: { customer: true, kitchen: true, counter: true },
  autoPrint: true,
  headings: DEFAULT_HEADINGS,
};

export const PRINTER_TYPES: readonly { readonly value: PrinterType; readonly label: string }[] = [
  { value: 'thermal', label: 'Thermal (receipt roll)' },
  { value: 'laser', label: 'Laser' },
  { value: 'inkjet', label: 'Inkjet' },
];

/**
 * Paper by printer type: a roll is a thermal printer's and only its; a sheet is everyone else's.
 *
 * `printableMm` is how wide a roll's print head reaches: narrower than the paper
 * (a 79-80 mm roll prints about 72 mm, 576 dots at 203 dpi), centred on it. These
 * are the common ESC/POS head widths, not one model's datasheet. A sheet's is null.
 */
export const PAPER: Readonly<Record<PaperSize, {
  readonly label: string; readonly widthMm: number; readonly heightMm: number | null; readonly roll: boolean;
  readonly printableMm: number | null;
}>> = {
  thermal_58: { label: '2-inch roll (58 mm)', widthMm: 58, heightMm: null, roll: true, printableMm: 48 },
  thermal_80: { label: '3-inch roll (79–80 mm)', widthMm: 80, heightMm: null, roll: true, printableMm: 72 },
  thermal_112: { label: '4-inch roll (112 mm)', widthMm: 112, heightMm: null, roll: true, printableMm: 104 },
  a5: { label: 'A5 (148 × 210 mm)', widthMm: 148, heightMm: 210, roll: false, printableMm: null },
  a4: { label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297, roll: false, printableMm: null },
};

/**
 * Where content sits across a roll. The head cannot print the edges, so the side
 * margin is never less than half the unprintable width: content laid out wider
 * than the head loses its right edge -- the right-aligned amounts and totals.
 */
export function rollContent(paperSize: PaperSize, marginMm: number): { sideMarginMm: number; contentMm: number } {
  const paper = PAPER[paperSize];
  const edge = paper.printableMm === null ? 0 : (paper.widthMm - paper.printableMm) / 2;
  const sideMarginMm = Math.max(marginMm, edge);
  return { sideMarginMm, contentMm: paper.widthMm - 2 * sideMarginMm };
}

export function papersFor(type: PrinterType): readonly PaperSize[] {
  return (Object.keys(PAPER) as PaperSize[]).filter((size) => PAPER[size].roll === (type === 'thermal'));
}

/** The page's printable width and height in mm, orientation applied. Height is null on a roll. */
export function pageBox(layout: Pick<PrintLayout, 'paperSize' | 'orientation'>): { widthMm: number; heightMm: number | null } {
  const paper = PAPER[layout.paperSize];
  if (paper.heightMm === null || layout.orientation === 'portrait') return { widthMm: paper.widthMm, heightMm: paper.heightMm };
  return { widthMm: paper.heightMm, heightMm: paper.widthMm };
}

export interface PrintedBill {
  readonly kind: 'bill' | 'receipt';
  readonly copyNo: number;
  /** Absent from an API older than 0078: the 3-inch roll is assumed. */
  readonly layout?: PrintLayout;
  readonly restaurant: {
    readonly name: string;
    readonly legalName: string | null;
    readonly address: string | null;
    readonly phone: string | null;
    /** The outlet's email (0083). Absent from an older API. */
    readonly email?: string | null;
    readonly gstin: string | null;
    /** The registration printed, labelled GSTIN, TRN or Tax No. (0083). Absent from an older API: the GSTIN prints. */
    readonly taxNumber?: { readonly label: string; readonly value: string } | null;
    readonly footer: string;
  };
  /** Reverse mode (0083): the line amounts already include the tax shown. Absent from an older API. */
  readonly pricesIncludeTax?: boolean;
  /** 'GST', 'VAT' or 'Tax' -- or null when the bill charges no tax, and then no tax line prints. */
  readonly taxLabel?: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly billNo: number;
  readonly businessDate: string;
  readonly openedAt: string;
  readonly billedAt: string;
  readonly settledAt: string | null;
  readonly printedAt: string;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly tables: readonly string[];
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly covers: number | null;
  readonly waiter: string | null;
  readonly cashier: string | null;
  readonly lines: readonly PrintedLine[];
  /** A parcel's packing charge (0081), already inside `subtotalMinor`. Absent from an older API. */
  readonly parcelChargeMinor?: number;
  readonly subtotalMinor: number;
  readonly taxes: readonly { readonly label: string; readonly amountMinor: number }[];
  /** The bill's tax total, for a layout printing one tax line. Absent from an older API. */
  readonly taxMinor?: number;
  readonly totalMinor: number;
  /** To the nearest rupee (0082), printed as Round off. 0 or absent: no line. */
  readonly roundOffMinor?: number;
  /** What the customer pays: total + round off. Absent from an older API. */
  readonly payableMinor?: number;
  readonly tenders: readonly PrintedTender[];
  readonly paidMinor: number;
  readonly outstandingMinor: number;
}

export interface PrintedTender {
  readonly method: string;
  /** Applied to the bill; negative for a void. */
  readonly amountMinor: number;
  readonly reference: string | null;
  /** The note handed over, when recorded. Change is received minus applied. */
  readonly cashReceivedMinor: number | null;
  readonly changeMinor: number;
  /** Paise over the bill to reach a whole rupee (card/UPI): round-off, not sales. Absent from an older API. */
  readonly roundingMinor?: number;
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function amount(minor: number, currency: string): string {
  const exponent = minorExponent(currency);
  return new Intl.NumberFormat(localeForCurrency(currency), { minimumFractionDigits: exponent, maximumFractionDigits: exponent })
    .format(minor / 10 ** exponent);
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
    .format(new Date(iso));
}

function day(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone })
    .format(new Date(iso));
}

const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', other: 'Other' };

/**
 * The paid heading (INVOICE unless the branch changed it) is printed only once
 * the bill is paid in full -- the server decides `kind` from the bill's status
 * (`receipt`, its name in the API). A bill printed after some money was taken
 * has its own heading (PART PAID), so nobody can mistake it for proof of full
 * payment. The words are the branch's (0088); which one, and COPY n, are the
 * server's. A blank heading (being typed on the settings page) falls back to
 * the default rather than printing nothing.
 */
export function receiptTitle(doc: Pick<PrintedBill, 'kind' | 'copyNo' | 'paidMinor'>, headings: BillHeadings = DEFAULT_HEADINGS): string {
  const [text, fallback] = doc.kind === 'receipt' ? [headings.paid, DEFAULT_HEADINGS.paid]
    : doc.paidMinor > 0 ? [headings.partPaid, DEFAULT_HEADINGS.partPaid] : [headings.unpaid, DEFAULT_HEADINGS.unpaid];
  const base = text.trim() === '' ? fallback : text.trim();
  return doc.copyNo > 1 ? `${base} · COPY ${doc.copyNo}` : base;
}

const headingsOf = (layout: PrintLayout): BillHeadings => layout.headings ?? DEFAULT_HEADINGS;

/** Which of the three copies a page is (Basic POS): said at the top of the paper, in words. */
export type CopyPurpose = 'customer' | 'kitchen' | 'counter';

export const COPY_LABEL: Record<CopyPurpose, string> = {
  customer: 'CUSTOMER',
  kitchen: 'KITCHEN',
  counter: 'COUNTER',
};

/**
 * The page CSS for a layout. A roll is as wide as the roll and as long as the
 * bill, its content inside the print head's reach; a sheet is the sheet, in its
 * orientation. The font and margin are the printer's settings; the headings
 * scale with the font.
 */
export function layoutCss(layout: PrintLayout): string {
  const box = pageBox(layout);
  const roll = PAPER[layout.paperSize].roll;
  const margin = layout.marginMm;
  const across = rollContent(layout.paperSize, margin);
  const size = roll ? `${box.widthMm}mm auto` : `${layout.paperSize.toUpperCase()} ${layout.orientation}`;
  const f = layout.fontSizePx;
  return `
  @page { size: ${size}; margin: ${roll ? `${margin}mm ${across.sideMarginMm}mm` : `${margin}mm`}; }
  * { box-sizing: border-box; }
  body { margin: 0; width: ${roll ? `${across.contentMm}mm` : 'auto'}; font: ${f}px/1.35 ${roll ? '"Courier New", ui-monospace, monospace' : 'Arial, "Helvetica Neue", sans-serif'}; color: #000; background: #fff; overflow-wrap: anywhere; }${roll ? `
  @media screen { body { margin: ${margin}mm ${across.sideMarginMm}mm; } }` : ''}
  .sheet { max-width: ${roll ? 'none' : '170mm'}; margin: 0 auto; }
  .c { text-align: center; }
  .logo { display: block; margin: 0 auto 4px; max-width: 60%; max-height: ${roll ? 18 : 24}mm; object-fit: contain; }
  .name { font-size: ${Math.round(f * 1.5)}px; font-weight: 700; letter-spacing: 1px; }
  .title { font-size: ${Math.round(f * 1.17)}px; font-weight: 700; margin: 2px 0; }
  .copy { border: 2px solid #000; padding: 2px 4px; font-size: ${f + 1}px; font-weight: 700; text-align: center; margin-bottom: 4px; }
  .parcel { background: #000; color: #fff; padding: 2px 4px; font-size: ${f + 2}px; font-weight: 700; text-align: center; margin-bottom: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rule { border-top: 1px dashed #000; margin: 5px 0; }
  .pair { display: flex; justify-content: space-between; gap: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 700; border-bottom: 1px dashed #000; padding-bottom: 2px; }
  td { vertical-align: top; padding: 1px 0; }
  .q { width: 2.4em; }
  .n { text-align: right; white-space: nowrap; padding-left: 6px; }
  th.n { text-align: right; }
  .sub td { font-size: ${f - 1}px; }
  .total { font-size: ${Math.round(f * 1.25)}px; font-weight: 700; }
  .kitchen pre { font-size: ${f + 1}px; font-weight: 700; }
  pre { margin: 0; font: inherit; font-family: "Courier New", ui-monospace, monospace; white-space: pre-wrap; }
  ${roll
    // A roll has no pages: the copies run on one strip, one straight after the
    // other, parted by a tear line. A page break here made the driver feed a
    // whole paper length (or a new sheet) for every copy.
    ? `.page + .page { margin-top: 4mm; padding-top: 1mm; border-top: 1px dashed #000; }
  .page + .page::before { content: "tear here"; display: block; text-align: center; font-size: ${f - 2}px; margin-bottom: 3mm; }`
    : '.page + .page { break-before: page; page-break-before: always; }'}
`;
}

function copyLabel(purpose: CopyPurpose | null, reprint: boolean, showName: boolean): string {
  // Hiding the NAME never hides REPRINT: that word is what stops a second copy
  // passing for the first.
  return purpose === null ? '' : showName ? `${COPY_LABEL[purpose]}${reprint ? ' · REPRINT' : ''}` : reprint ? 'REPRINT' : '';
}

/** The purpose banner (short: it heads a 2-inch roll), and PARCEL on every copy of a parcel. */
function banners(purpose: CopyPurpose | null, parcel: boolean, reprint: boolean, showName = true): string {
  const label = copyLabel(purpose, reprint, showName);
  return (label === '' ? '' : `<div class="copy">${label}</div>`)
    + (parcel ? '<div class="parcel">PARCEL</div>' : '');
}

/**
 * The rows a bill prints, decided once for the page and the receipt printer
 * alike: the two lay them out differently and must never disagree on what
 * they say.
 */
interface Row { readonly label: string; readonly minor: number; readonly indent?: boolean }

function placeOf(doc: PrintedBill, show: PrintLayout['show']): string {
  const place = { ...doc, pickupName: show.customer ? doc.pickupName : null };
  return counterNumber(place) !== null
    ? describePlace(place)
    : `Table ${doc.tables.length === 0 ? '-' : doc.tables.join(' + ')}`;
}

/**
 * One line when the branch prints no breakdown -- the bill's own total, never a
 * sum made here. An API older than 0078 sends no total: the heads print. A bill
 * that charges no tax (0083) prints no tax line at all. Reverse mode marks each
 * as included: the prices above already hold it.
 */
function taxRows(doc: PrintedBill, show: PrintLayout['show']): Row[] {
  if (doc.taxLabel === null) return [];
  const included = doc.pricesIncludeTax === true ? ' (included)' : '';
  return !show.tax && doc.taxMinor !== undefined
    ? [{ label: `${doc.taxLabel ?? 'Tax'}${included}`, minor: doc.taxMinor }]
    : doc.taxes.map((t) => ({ label: `${t.label}${included}`, minor: t.amountMinor }));
}

/**
 * Payments print once any were taken, so a part-paid table sees what is left.
 * Change is the server's (received minus applied). A round-off is printed under
 * the payment it came with, so the paid amount and the bill still reconcile.
 */
function tenderRows(doc: PrintedBill, counter: boolean, show: PrintLayout['show']): Row[] | null {
  if (doc.tenders.length === 0 || !(show.payments || counter)) return null;
  return [...doc.tenders.flatMap((t): Row[] => {
    const label = METHOD[t.method] ?? t.method;
    const rows: Row[] = [{
      label: t.amountMinor < 0 ? `Void ${label}` : `Paid by ${label}${t.reference ? ` (${t.reference})` : ''}`,
      minor: t.amountMinor,
    }];
    if ((t.roundingMinor ?? 0) > 0) rows.push({ label: 'Round off', minor: t.roundingMinor ?? 0, indent: true });
    if (t.cashReceivedMinor !== null && t.changeMinor !== 0) {
      rows.push({ label: 'Cash received', minor: t.cashReceivedMinor, indent: true },
        { label: 'Change returned', minor: t.changeMinor, indent: true });
    }
    return rows;
  }), { label: 'Total paid', minor: doc.paidMinor }];
}

function taxNumberOf(r: PrintedBill['restaurant']): { label: string; value: string } | null {
  return r.taxNumber !== undefined ? r.taxNumber : r.gstin ? { label: 'GSTIN', value: r.gstin } : null;
}

function statusOf(doc: PrintedBill): string {
  return doc.outstandingMinor <= 0 ? 'PAID' : doc.paidMinor > 0 ? 'PARTIALLY PAID' : 'UNPAID';
}

/** Where the logo comes from (the restaurant's public logo URL), or none. */
export interface RenderOptions { readonly logoUrl?: string | null }

function page(title: string, layout: PrintLayout, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${layoutCss(layout)}</style></head><body>${body}</body></html>`;
}

/** The whole page, self-contained, for a print frame or a preview frame. */
export function renderReceiptHtml(doc: PrintedBill, options: RenderOptions = {}): string {
  const layout = doc.layout ?? DEFAULT_LAYOUT;
  return page(escape(`${receiptTitle(doc, headingsOf(layout))} ${doc.billNo}`), layout,
    `<div class="page sheet">${receiptBody(doc, null, layout, options)}</div>`);
}

/** One kitchen ticket as the kitchen gets it: the server's own `renderTicket` text, never re-composed here. */
export interface KitchenTicketCopy { readonly ticketText: string }

export type CopyPage =
  | { readonly purpose: 'customer' | 'counter'; readonly bill: PrintedBill }
  | { readonly purpose: 'kitchen'; readonly ticket: KitchenTicketCopy; readonly parcel: boolean; readonly reprint: boolean };

/**
 * The copies, one page each, in one print dialog. The bill's figures and the
 * kitchen ticket's lines are the server's; this only labels and lays them out.
 * The paper is the layout of the bill among them (the branch's), or `layout`.
 */
export function renderCopiesHtml(pages: readonly CopyPage[], options: RenderOptions & { readonly layout?: PrintLayout } = {}): string {
  const fromBill = pages.find((p): p is Extract<CopyPage, { bill: PrintedBill }> => p.purpose !== 'kitchen')?.bill.layout;
  const layout = options.layout ?? fromBill ?? DEFAULT_LAYOUT;
  const body = pages.map((p) => p.purpose === 'kitchen'
    ? `<div class="page sheet kitchen">${banners('kitchen', p.parcel, p.reprint, layout.show.copyLabel !== false)}<pre>${escape(p.ticket.ticketText)}</pre></div>`
    : `<div class="page sheet">${receiptBody(p.bill, p.purpose, layout, options)}</div>`).join('');
  return page('Order copies', layout, body);
}

/**
 * The customer copy follows the branch's show settings. The counter copy is the
 * counter's record: it always carries the payments and the cashier, and leaves
 * the logo and the footer message to the customer's copy.
 */
function receiptBody(doc: PrintedBill, purpose: CopyPurpose | null, layout: PrintLayout, options: RenderOptions): string {
  const r = doc.restaurant;
  const counter = purpose === 'counter';
  const show = layout.show;
  const money = (minor: number): string => amount(minor, doc.currency);
  const where = placeOf(doc, show);
  const end = doc.settledAt ?? doc.billedAt;

  const pair = (left: string, right: string): string =>
    `<div class="pair"><span>${left}</span><span>${right}</span></div>`;

  const rows = doc.lines.map((line) => {
    const main = `<tr><td class="q">${line.quantity}</td><td>${escape(line.name)}</td>`
      + `<td class="n">${line.rateMinor === null ? '' : money(line.rateMinor)}</td>`
      + `<td class="n">${money(line.grossMinor)}</td></tr>`;
    const addOns = line.addOns.map((a) => `<tr class="sub"><td></td><td colspan="3">+ ${escape(a)}</td></tr>`).join('');
    const less = line.lessMinor === 0 ? ''
      : `<tr class="sub"><td></td><td colspan="2">Less: ${escape(line.lessLabel ?? 'Discount')}</td>`
        + `<td class="n">-${money(line.lessMinor)}</td></tr>`;
    return main + addOns + less;
  }).join('');

  const included = doc.pricesIncludeTax === true;
  const taxName = doc.taxLabel ?? 'Tax';
  const row = (x: Row): string => pair(`${x.indent ? '&nbsp;&nbsp;' : ''}${escape(x.label)}`, money(x.minor));
  const taxes = taxRows(doc, show).map(row).join('');
  const taxNumber = taxNumberOf(r);
  const paid = tenderRows(doc, counter, show);
  const tenders = paid === null ? '' : `<div class="rule"></div>${paid.map(row).join('')}`;
  const status = statusOf(doc);
  const balance = doc.outstandingMinor > 0
    ? `<div class="pair total"><span>BALANCE DUE</span><span>${money(doc.outstandingMinor)}</span></div>` : '';
  const logo = show.logo && !counter && options.logoUrl ? `<img class="logo" src="${escape(options.logoUrl)}" alt="">` : '';
  const details = show.details
    ? `${r.legalName && r.legalName !== r.name ? `<div class="c">${escape(r.legalName)}</div>` : ''}
${r.address ? `<div class="c">${escape(r.address)}</div>` : ''}
${r.phone ? `<div class="c">Tel: ${escape(r.phone)}</div>` : ''}
${r.email ? `<div class="c">${escape(r.email)}</div>` : ''}`
    : '';

  return `${banners(purpose, doc.serviceType === 'parcel', doc.copyNo > 1, show.copyLabel !== false)}
${logo}
<div class="c name">${escape(r.name)}</div>
${details}
${taxNumber ? `<div class="c">${escape(taxNumber.label)}: ${escape(taxNumber.value)}</div>` : ''}
<div class="rule"></div>
<div class="c title">${escape(receiptTitle(doc, headingsOf(layout)))}</div>
${pair(`Bill No: ${doc.billNo}`, `Date: ${day(doc.billedAt, doc.timezone)}`)}
${pair(escape(where), doc.covers !== null ? `Covers: ${doc.covers}` : '')}
${pair(`Start: ${clock(doc.openedAt, doc.timezone)}`, `End: ${clock(end, doc.timezone)}`)}
${doc.waiter ? pair(`Waiter: ${escape(doc.waiter)}`, '') : ''}
${doc.cashier ? pair(`Cashier: ${escape(doc.cashier)}`, '') : ''}
<div class="rule"></div>
<table><thead><tr><th class="q">Qty</th><th>Item</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="rule"></div>
${(doc.parcelChargeMinor ?? 0) > 0 ? pair('Parcel charge', money(doc.parcelChargeMinor ?? 0)) : ''}
${pair(included && doc.taxLabel !== null ? 'Taxable value' : 'Sub Total', money(doc.subtotalMinor))}
${taxes}
${included && doc.taxLabel !== null ? `<div class="c" style="font-size:10px">Prices include ${escape(taxName)}</div>` : ''}
<div class="rule"></div>
${(doc.roundOffMinor ?? 0) !== 0
  ? `${pair('TOTAL', money(doc.totalMinor))}${pair('Round off', money(doc.roundOffMinor ?? 0))}
<div class="pair total"><span>NET PAYABLE</span><span>${money(doc.payableMinor ?? doc.totalMinor)}</span></div>`
  : `<div class="pair total"><span>TOTAL</span><span>${money(doc.totalMinor)}</span></div>`}
${tenders}
${balance}
<div class="c title">${status}</div>
<div class="rule"></div>
${r.footer && !counter ? `<div class="c">${escape(r.footer)}</div>` : ''}
<div class="c" style="font-size:10px;margin-top:4px">Printed ${day(doc.printedAt, doc.timezone)} ${clock(doc.printedAt, doc.timezone)}</div>`;
}

/** One line of a copy as a receipt printer gets it: fixed-width text, no markup. */
export interface PrintLine {
  readonly text: string;
  readonly centre?: boolean;
  readonly bold?: boolean;
  /** Double height: the width is unchanged, so a padded line still fits. */
  readonly tall?: boolean;
}

/** Characters across a roll in the printer's standard font (12 dots wide at 203 dpi), or null on a sheet. */
export function rollChars(paperSize: PaperSize): number | null {
  const head = PAPER[paperSize].printableMm;
  return head === null ? null : Math.floor((head * 8) / 12);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    for (let piece = word; piece !== '';) {
      const room = line === '' ? width : width - line.length - 1;
      if (piece.length <= room) { line = line === '' ? piece : `${line} ${piece}`; piece = ''; continue; }
      if (line !== '') { out.push(line); line = ''; continue; }
      out.push(piece.slice(0, width));
      piece = piece.slice(width);
    }
  }
  if (line !== '') out.push(line);
  return out.length === 0 ? [''] : out;
}

/** Left and right on one line, the right flush; on two when they do not both fit. */
function pairText(left: string, right: string, width: number): string[] {
  if (right === '') return wrap(left, width);
  if (left.length + right.length + 1 <= width) return [`${left}${' '.repeat(width - left.length - right.length)}${right}`];
  return [...wrap(left, width), right.padStart(width)];
}

/**
 * The copies as receipt-printer lines, one list per copy, `width` characters
 * across. The same rows as `renderCopiesHtml` -- the server's figures, the
 * branch's show settings, the copy labels -- laid out in fixed-width text. The
 * logo is left off: a text line cannot carry it. The kitchen copy is the
 * server's ticket text as it stands.
 */
export function copyLines(pages: readonly CopyPage[], layout: PrintLayout, width: number): PrintLine[][] {
  return pages.map((p) => {
    const head = bannerLines(p.purpose, p.purpose === 'kitchen' ? p.parcel : p.bill.serviceType === 'parcel',
      p.purpose === 'kitchen' ? p.reprint : p.bill.copyNo > 1, layout.show.copyLabel !== false, width);
    return p.purpose === 'kitchen'
      ? [...head, ...p.ticket.ticketText.split('\n').flatMap((t) => (t.length <= width ? [t] : wrap(t, width)))
        .map((text) => ({ text, bold: true }))]
      : [...head, ...receiptLines(p.bill, p.purpose, layout, width)];
  });
}

function bannerLines(purpose: CopyPurpose | null, parcel: boolean, reprint: boolean, showName: boolean, width: number): PrintLine[] {
  const label = copyLabel(purpose, reprint, showName);
  return [
    ...(label === '' ? [] : [{ text: label, centre: true, bold: true, tall: true }]),
    ...(parcel ? [{ text: '*** PARCEL ***', centre: true, bold: true, tall: true }] : []),
  ].flatMap((l) => wrap(l.text, width).map((text) => ({ ...l, text })));
}

function receiptLines(doc: PrintedBill, purpose: CopyPurpose, layout: PrintLayout, width: number): PrintLine[] {
  const r = doc.restaurant;
  const counter = purpose === 'counter';
  const show = layout.show;
  const money = (minor: number): string => amount(minor, doc.currency);
  const out: PrintLine[] = [];
  const centre = (text: string, style: Omit<PrintLine, 'text'> = {}): void => {
    for (const t of wrap(text, width)) out.push({ ...style, text: t, centre: true });
  };
  const pair = (left: string, right: string, style: Omit<PrintLine, 'text'> = {}): void => {
    for (const t of pairText(left, right, width)) out.push({ ...style, text: t });
  };
  const row = (x: Row): void => pair(`${x.indent ? '  ' : ''}${x.label}`, money(x.minor));
  const rule = (): void => { out.push({ text: '-'.repeat(width) }); };
  const end = doc.settledAt ?? doc.billedAt;
  const included = doc.pricesIncludeTax === true && doc.taxLabel !== null;

  centre(r.name, { bold: true, tall: true });
  if (show.details) {
    if (r.legalName && r.legalName !== r.name) centre(r.legalName);
    if (r.address) centre(r.address);
    if (r.phone) centre(`Tel: ${r.phone}`);
    if (r.email) centre(r.email);
  }
  const taxNumber = taxNumberOf(r);
  if (taxNumber) centre(`${taxNumber.label}: ${taxNumber.value}`);
  rule();
  centre(receiptTitle(doc, headingsOf(layout)), { bold: true });
  pair(`Bill No: ${doc.billNo}`, `Date: ${day(doc.billedAt, doc.timezone)}`);
  pair(placeOf(doc, show), doc.covers !== null ? `Covers: ${doc.covers}` : '');
  pair(`Start: ${clock(doc.openedAt, doc.timezone)}`, `End: ${clock(end, doc.timezone)}`);
  if (doc.waiter) pair(`Waiter: ${doc.waiter}`, '');
  if (doc.cashier) pair(`Cashier: ${doc.cashier}`, '');
  rule();

  // Qty, item, rate, amount: the number columns as wide as their widest figure,
  // the item name in what is left, wrapping under itself.
  const rates = doc.lines.map((l) => (l.rateMinor === null ? '' : money(l.rateMinor)));
  const grosses = doc.lines.map((l) => money(l.grossMinor));
  const qtyW = Math.max(4, ...doc.lines.map((l) => String(l.quantity).length + 1));
  const amountW = Math.max(6, ...grosses.map((g) => g.length)) + 1;
  const rateW = Math.max(4, ...rates.map((g) => g.length)) + 1;
  const keepRate = width - qtyW - amountW - rateW >= 10;
  const nameW = width - qtyW - amountW - (keepRate ? rateW : 0);
  out.push({ text: `${'Qty'.padEnd(qtyW)}${'Item'.padEnd(nameW)}${keepRate ? 'Rate'.padStart(rateW) : ''}${'Amount'.padStart(amountW)}`, bold: true });
  doc.lines.forEach((line, i) => {
    const names = wrap(line.name, nameW - 1);
    names.forEach((name, n) => out.push({
      text: n === 0
        ? `${String(line.quantity).padEnd(qtyW)}${name.padEnd(nameW)}${keepRate ? rates[i]!.padStart(rateW) : ''}${grosses[i]!.padStart(amountW)}`
        : `${''.padEnd(qtyW)}${name}`,
    }));
    for (const a of line.addOns) for (const t of wrap(`+ ${a}`, width - qtyW)) out.push({ text: `${''.padEnd(qtyW)}${t}` });
    if (line.lessMinor !== 0) pair(`${''.padEnd(qtyW)}Less: ${line.lessLabel ?? 'Discount'}`, `-${money(line.lessMinor)}`);
  });
  rule();

  if ((doc.parcelChargeMinor ?? 0) > 0) pair('Parcel charge', money(doc.parcelChargeMinor ?? 0));
  pair(included ? 'Taxable value' : 'Sub Total', money(doc.subtotalMinor));
  taxRows(doc, show).forEach(row);
  if (included) centre(`Prices include ${doc.taxLabel ?? 'Tax'}`);
  rule();
  if ((doc.roundOffMinor ?? 0) !== 0) {
    pair('TOTAL', money(doc.totalMinor));
    pair('Round off', money(doc.roundOffMinor ?? 0));
    pair('NET PAYABLE', money(doc.payableMinor ?? doc.totalMinor), { bold: true, tall: true });
  } else {
    pair('TOTAL', money(doc.totalMinor), { bold: true, tall: true });
  }
  const paid = tenderRows(doc, counter, show);
  if (paid !== null) { rule(); paid.forEach(row); }
  if (doc.outstandingMinor > 0) pair('BALANCE DUE', money(doc.outstandingMinor), { bold: true, tall: true });
  centre(statusOf(doc), { bold: true });
  rule();
  if (r.footer && !counter) centre(r.footer);
  centre(`Printed ${day(doc.printedAt, doc.timezone)} ${clock(doc.printedAt, doc.timezone)}`);
  return out;
}

/**
 * Prints any of the copies above from a hidden frame, so the Billing screen
 * stays where it is, one dialog for all of them. Waits (briefly)
 * for a logo to load first: a print taken before the image arrives prints a
 * blank box where the logo should be.
 */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const target = frame.contentDocument;
  if (target === null) { frame.remove(); return; }
  target.open();
  target.write(html);
  target.close();
  const images = [...target.images].filter((image) => !image.complete);
  const loaded = Promise.all(images.map((image) => new Promise<void>((done) => {
    image.addEventListener('load', () => done(), { once: true });
    image.addEventListener('error', () => done(), { once: true });
  })));
  void Promise.race([loaded, new Promise((done) => setTimeout(done, 1500))]).then(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  });
}
