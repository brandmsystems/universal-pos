import { SETUP_SHEETS, type SetupRow, type SetupSheets } from '@katkitchen/shared';

/**
 * The setup workbook, both ways, from the ONE sheet definition the server also
 * imports with: the template's headers are the reader's headers are the
 * importer's fields. SheetJS is passed in so it loads only when the admin
 * actually opens the upload -- it never reaches a tablet bundle.
 */

type XLSX = typeof import('xlsx');

export interface FileProblem { readonly sheet: string; readonly row: number | null; readonly message: string }

export const TEMPLATE_FILE = 'restaurant-setup-template.xlsx';

export function buildTemplate(X: XLSX): import('xlsx').WorkBook {
  const book = X.utils.book_new();
  const help: string[][] = [
    ['How to fill this file'],
    ['Fill the sheets you need; leave the others empty. Row 1 of each sheet is the header -- do not change it.'],
    ['Names link the sheets: a table names its floor, a kitchen names its printer, an item names its category and kitchen.'],
    ['Uploading again is safe: rows are matched by name and updated, and nothing missing from the file is removed.'],
    [],
    ['Sheet', 'Column', 'Required', 'What to enter'],
    ...SETUP_SHEETS.flatMap((s) => s.columns.map((c) => [s.title, c.header, c.required ? 'Yes' : '', c.help])),
  ];
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(help), 'How to fill');
  for (const sheet of SETUP_SHEETS) {
    const ws = X.utils.aoa_to_sheet([sheet.columns.map((c) => c.header)]);
    ws['!cols'] = sheet.columns.map((c) => ({ wch: Math.max(14, c.header.length + 4) }));
    X.utils.book_append_sheet(book, ws, sheet.title);
  }
  return book;
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Reads every known sheet into rows keyed by field; problems are the ones found before the server looks. */
export function readWorkbook(X: XLSX, data: ArrayBuffer): { sheets: SetupSheets; problems: FileProblem[] } {
  const book = X.read(data, { type: 'array' });
  const sheets: Record<string, SetupRow[]> = {};
  const problems: FileProblem[] = [];
  let found = 0;

  for (const sheet of SETUP_SHEETS) {
    const name = book.SheetNames.find((n) => norm(n) === norm(sheet.title));
    if (!name) continue;
    found += 1;
    // raw: false -- the text Excel shows, so "99.50" stays 99.50 and a code
    // like 0012 keeps its zeros.
    const grid = X.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, raw: false, defval: '' });
    const headers = (grid[0] ?? []).map(norm);
    const at = new Map<string, number>();
    for (const column of sheet.columns) {
      const index = headers.indexOf(norm(column.header));
      if (index >= 0) at.set(column.field, index);
      else if (column.required) problems.push({ sheet: sheet.title, row: 1, message: `Column "${column.header}" is missing.` });
    }
    headers.forEach((h, i) => {
      if (h !== '' && !sheet.columns.some((c) => norm(c.header) === h)) {
        problems.push({ sheet: sheet.title, row: 1, message: `Column "${String(grid[0]![i])}" is not in the template.` });
      }
    });
    const rows: SetupRow[] = [];
    grid.slice(1).forEach((cells, i) => {
      if (cells.every((c) => String(c ?? '').trim() === '')) return;
      const row: Record<string, string | number> = { row: i + 2 };
      for (const [field, index] of at) row[field] = String(cells[index] ?? '').trim();
      rows.push(row as SetupRow);
    });
    if (rows.length > 0) sheets[sheet.key] = rows;
  }
  if (found === 0) {
    problems.push({ sheet: 'File', row: null, message: 'None of the setup sheets were found. Start from the downloaded template.' });
  }
  return { sheets: sheets as SetupSheets, problems };
}
