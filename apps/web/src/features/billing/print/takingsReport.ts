import { describePlace } from '@katkitchen/shared';
import { formatMinor, minorFrom, unitsFromMinor } from '../../../lib/money.js';
import { METHOD_LABEL } from '../billing/PaymentPanel.js';
import { rollContent } from './receipt.js';

/**
 * My takings: the till's own X-read (GET /pos/my-takings), and the ONE shape
 * the screen, the thermal print, the Excel file and the PDF are all drawn from.
 * Every figure is the server's; this file labels and lays them out, and adds
 * nothing up.
 */

export type TakingsPeriod = 'day' | 'week' | 'month';

/** What a summary covers: a named period, or a From/To range of business dates. */
export type TakingsRange = TakingsPeriod | 'custom';

export const PERIOD_LABEL: Record<TakingsRange, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', custom: 'Custom' };

/** As `TILL_RANGE_MAX_DAYS` in tillSummary.ts: the server refuses a longer range too. */
export const RANGE_MAX_DAYS = 366;

/**
 * Why a From/To pair cannot be asked for, in words for the screen, or null.
 * `today` is the till's business date when known (a named period ends on it);
 * the server checks all of this again and is the authority.
 */
export function rangeProblem(from: string, to: string, today: string | null): string | null {
  if (from === '' || to === '') return 'Choose both a From and a To date.';
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Enter the dates as day, month and year.';
  if (start > end) return 'The From date must be on or before the To date.';
  if (today !== null && to > today) return 'The To date cannot be after today.';
  if ((end - start) / 86_400_000 + 1 > RANGE_MAX_DAYS) return `Choose a range of at most ${RANGE_MAX_DAYS} days.`;
  return null;
}

/** As `tillSummary` in apps/api/src/modules/reporting/tillSummary.ts answers it. */
export interface TakingsSummary {
  readonly period: TakingsRange;
  readonly fromDate: string;
  readonly toDate: string;
  readonly bills: readonly {
    readonly billId: string; readonly billNo: number; readonly businessDate: string; readonly billedAt: string;
    readonly serviceType: 'dine_in' | 'parcel'; readonly seating: 'table' | 'counter';
    readonly parcelNo: number | null; readonly pickupName: string | null;
    readonly subtotalMinor: number; readonly taxMinor: number; readonly totalMinor: number; readonly collectedMinor: number;
    /** To the nearest rupee (0082), and what the customer pays. Absent from an older API. */
    readonly roundOffMinor?: number; readonly payableMinor?: number;
  }[];
  readonly items: readonly { readonly name: string; readonly quantity: number; readonly amountMinor: number }[];
  readonly methods: readonly { readonly method: string; readonly payments: number; readonly amountMinor: number }[];
  readonly totals: {
    readonly bills: number; readonly payments: number; readonly salesMinor: number;
    readonly taxMinor: number; readonly collectedMinor: number;
    readonly roundOffMinor?: number; readonly payableMinor?: number;
  };
}

/** A cell: text, or money kept as minor units so each output can render it its own way. */
export type Cell = string | number | { readonly minor: number };

export interface Section {
  readonly title: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  /** Column indexes that are money or counts, aligned right. */
  readonly right: readonly number[];
  readonly empty: string;
}

export interface TakingsReport {
  readonly title: string;
  readonly subtitle: string;
  readonly sections: readonly Section[];
}

const money = (minor: number): Cell => ({ minor });

function clock(at: string): string {
  const date = new Date(at.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "22 Oct 2026", or "19 Oct – 22 Oct 2026" for a range. */
export function periodText(summary: Pick<TakingsSummary, 'fromDate' | 'toDate'>): string {
  const day = (iso: string, year: boolean): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
  return summary.fromDate === summary.toDate
    ? day(summary.toDate, true)
    : `${day(summary.fromDate, false)} – ${day(summary.toDate, true)}`;
}

export function takingsReport(summary: TakingsSummary, who: string | null): TakingsReport {
  const ranged = summary.fromDate !== summary.toDate;
  return {
    title: `My takings · ${PERIOD_LABEL[summary.period]}`,
    subtitle: `${periodText(summary)}${who ? ` · ${who}` : ''}`,
    sections: [
      {
        title: 'Sales Summary', head: ['', ''], right: [1], empty: '',
        rows: [
          ['Bills', summary.totals.bills],
          ['Total sales', money(summary.totals.salesMinor)],
          ...((summary.totals.roundOffMinor ?? 0) !== 0
            ? [['Round off', money(summary.totals.roundOffMinor ?? 0)], ['Net payable', money(summary.totals.payableMinor ?? summary.totals.salesMinor)]]
            : []),
          ['Tax', money(summary.totals.taxMinor)],
          ['Transactions', summary.totals.payments],
          ['You collected', money(summary.totals.collectedMinor)],
        ],
      },
      {
        title: 'Bill Amount', right: [3, 4], empty: 'No bills in this period.',
        head: ['Bill', 'Order', ranged ? 'Date' : 'Time', 'Net payable', 'You took'],
        rows: summary.bills.map((b) => [
          `#${b.billNo}`,
          describePlace({ ...b, tables: [] }),
          ranged ? b.businessDate : clock(b.billedAt),
          money(b.payableMinor ?? b.totalMinor),
          money(b.collectedMinor),
        ]),
      },
      {
        title: 'Item Details', head: ['Item', 'Qty', 'Amount'], right: [1, 2], empty: 'No items in this period.',
        rows: summary.items.map((i) => [i.name, i.quantity, money(i.amountMinor)]),
      },
      {
        title: 'Transactions', head: ['Method', 'Count', 'Amount'], right: [1, 2], empty: 'No payments in this period.',
        rows: [
          ...summary.methods.map((m) => [METHOD_LABEL[m.method] ?? m.method, m.payments, money(m.amountMinor)]),
          ...(summary.methods.length > 0 ? [['Total', summary.totals.payments, money(summary.totals.collectedMinor)]] : []),
        ],
      },
    ],
  };
}

/** A cell as text: money with the currency sign, counts as digits. */
export function cellText(cell: Cell): string {
  return typeof cell === 'object' ? formatMinor(minorFrom(cell.minor)) : String(cell);
}

/** A cell for a spreadsheet: money as a NUMBER of rupees, so the column can be summed. */
export function cellValue(cell: Cell): string | number {
  return typeof cell === 'object' ? unitsFromMinor(minorFrom(cell.minor)) : cell;
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The receipt-printer copy: one column of compact text, sized for a 2- or
 * 3-inch roll, every section with its own rule. Printed through the same
 * `printHtml` the bills use.
 */
export function renderTakingsHtml(report: TakingsReport, restaurant: string, rollMm: 58 | 80 = 80): string {
  const body = report.sections.map((s) => {
    const head = s.head.some((h) => h !== '')
      ? `<tr>${s.head.map((h, i) => `<th class="${s.right.includes(i) ? 'n' : ''}">${escape(h)}</th>`).join('')}</tr>` : '';
    const rows = s.rows.length === 0
      ? `<tr><td colspan="${s.head.length}">${escape(s.empty)}</td></tr>`
      : s.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${s.right.includes(i) ? 'n' : ''}">${escape(cellText(c))}</td>`).join('')}</tr>`).join('');
    return `<div class="h">${escape(s.title)}</div><table>${head}${rows}</table>`;
  }).join('<div class="rule"></div>');
  const across = rollContent(rollMm === 58 ? 'thermal_58' : 'thermal_80', 2);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(report.title)}</title><style>
@page { size: ${rollMm}mm auto; margin: 2mm ${across.sideMarginMm}mm; }
body { margin: 0; width: ${across.contentMm}mm; overflow-wrap: anywhere; font: 11px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #000; }
.c { text-align: center; } .name { font-size: 13px; font-weight: 700; } .h { font-weight: 700; margin: 4px 0 2px; text-transform: uppercase; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 1px 0; text-align: left; vertical-align: top; } th { font-weight: 700; }
.n { text-align: right; white-space: nowrap; padding-left: 4px; } .rule { border-top: 1px dashed #000; margin: 4px 0; }
</style></head><body>
<div class="c name">${escape(restaurant)}</div>
<div class="c">${escape(report.title)}</div>
<div class="c">${escape(report.subtitle)}</div>
<div class="rule"></div>
${body}
<div class="rule"></div>
<div class="c">Printed ${escape(new Date().toLocaleString())}</div>
</body></html>`;
}

/** "my-takings-weekly-2026-10-19-to-2026-10-22". */
export function fileStem(summary: TakingsSummary): string {
  const range = summary.fromDate === summary.toDate ? summary.toDate : `${summary.fromDate}-to-${summary.toDate}`;
  return `my-takings-${PERIOD_LABEL[summary.period].toLowerCase()}-${range}`;
}

/** The Excel workbook: one sheet per section, money as summable numbers. Loaded only when asked for. */
export async function downloadTakingsExcel(report: TakingsReport, summary: TakingsSummary): Promise<void> {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  for (const s of report.sections) {
    const head = s.head.some((h) => h !== '') ? [s.head as string[]] : [];
    const rows = s.rows.map((r) => r.map(cellValue));
    const sheet = XLSX.utils.aoa_to_sheet([[report.title], [report.subtitle], [], ...head, ...rows]);
    XLSX.utils.book_append_sheet(book, sheet, s.title.slice(0, 31));
  }
  XLSX.writeFile(book, `${fileStem(summary)}.xlsx`);
}

/** The PDF: an A4 page of the same sections, as text. Loaded only when asked for. */
export async function downloadTakingsPdf(report: TakingsReport, summary: TakingsSummary, restaurant: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const left = 14;
  const right = 196;
  let y = 16;
  const line = (gap: number): void => {
    y += gap;
    if (y > 280) { doc.addPage(); y = 16; }
  };
  doc.setFont('helvetica', 'bold').setFontSize(14).text(restaurant, left, y);
  line(7);
  doc.setFontSize(11).text(report.title, left, y);
  line(5);
  doc.setFont('helvetica', 'normal').setFontSize(9).text(report.subtitle, left, y);
  line(8);
  for (const s of report.sections) {
    doc.setFont('helvetica', 'bold').setFontSize(10).text(s.title, left, y);
    line(5);
    // The first column is wide (names); the rest share the remaining width,
    // each ending at an evenly spaced right edge.
    const first = 64;
    const step = s.head.length > 1 ? (right - left - first) / (s.head.length - 1) : 0;
    const edge = (i: number): number => left + first + step * i;
    const draw = (cells: readonly string[], bold: boolean): void => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(9);
      cells.forEach((text, i) => {
        // jsPDF's standard fonts have no rupee sign: "Rs" in the PDF only.
        const shown = text.replace(/₹/g, 'Rs ');
        if (i === 0) doc.text(doc.splitTextToSize(shown, first - 2)[0] as string, left, y);
        else if (s.right.includes(i)) doc.text(shown, edge(i), y, { align: 'right' });
        else doc.text(doc.splitTextToSize(shown, step - 2)[0] as string, edge(i - 1) + 2, y);
      });
      line(5);
    };
    if (s.head.some((h) => h !== '')) draw(s.head, true);
    if (s.rows.length === 0) draw([s.empty], false);
    for (const r of s.rows) draw(r.map(cellText), false);
    line(3);
  }
  doc.save(`${fileStem(summary)}.pdf`);
}
