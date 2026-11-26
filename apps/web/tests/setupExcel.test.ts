import { describe, expect, it } from 'vitest';
import * as X from 'xlsx';
import { SETUP_SHEETS } from '@katkitchen/shared';
import { buildTemplate, readWorkbook } from '../src/features/settings/admin/setup/excel.js';

/** The template and the reader agree because both come from SETUP_SHEETS; this proves it on a real file. */

const toBytes = (book: X.WorkBook): ArrayBuffer => X.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

describe('the setup Excel file', () => {
  it('reads its own blank template back with no problems and no rows', () => {
    const book = buildTemplate(X);
    expect(book.SheetNames).toEqual(['How to fill', ...SETUP_SHEETS.map((s) => s.title)]);
    for (const sheet of SETUP_SHEETS) {
      const headers = X.utils.sheet_to_json<string[]>(book.Sheets[sheet.title]!, { header: 1 })[0];
      expect(headers, sheet.title).toEqual(sheet.columns.map((c) => c.header));
    }
    expect(readWorkbook(X, toBytes(book))).toEqual({ sheets: {}, problems: [] });
  });

  it('turns a filled template into rows keyed by field, with Excel row numbers, skipping blank rows', () => {
    const book = buildTemplate(X);
    X.utils.sheet_add_aoa(book.Sheets['Tables']!, [['T1', 'Ground', 4], [], ['T2', 'Ground', '2']], { origin: 'A2' });
    X.utils.sheet_add_aoa(book.Sheets['Menu Items']!, [['Naan', 'Breads', '99.50', 'GST 5%']], { origin: 'A2' });
    const { sheets, problems } = readWorkbook(X, toBytes(book));
    expect(problems).toEqual([]);
    expect(sheets.tables).toEqual([
      { row: 2, name: 'T1', floor: 'Ground', seats: '4' },
      { row: 4, name: 'T2', floor: 'Ground', seats: '2' },
    ]);
    expect(sheets.items?.[0]).toMatchObject({ row: 2, name: 'Naan', category: 'Breads', price: '99.50', tax: 'GST 5%' });
  });

  it('names a missing required column and a column that is not in the template', () => {
    const book = X.utils.book_new();
    X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['Table', 'Seats', 'Colour'], ['T1', 4, 'red']]), 'Tables');
    const { problems } = readWorkbook(X, toBytes(book));
    expect(problems).toEqual([
      { sheet: 'Tables', row: 1, message: 'Column "Floor" is missing.' },
      { sheet: 'Tables', row: 1, message: 'Column "Colour" is not in the template.' },
    ]);
  });

  it('refuses a workbook with none of the setup sheets, and does not read a non-Excel file as data', () => {
    const other = X.utils.book_new();
    X.utils.book_append_sheet(other, X.utils.aoa_to_sheet([['x']]), 'Sheet1');
    expect(readWorkbook(X, toBytes(other)).problems[0]!.message).toMatch(/None of the setup sheets/);
    const junk = new TextEncoder().encode('\u0000\u0001not a spreadsheet\u0002').buffer;
    let read: ReturnType<typeof readWorkbook> | null = null;
    try { read = readWorkbook(X, junk); } catch { read = null; }
    expect(read === null || Object.keys(read.sheets).length === 0).toBe(true);
  });
});
