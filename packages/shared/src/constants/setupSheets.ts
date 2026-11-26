/**
 * The restaurant-setup Excel file, defined ONCE.
 *
 * The template the admin downloads, the reader that turns an uploaded file into
 * rows, and the server that imports them all read this table -- so a column
 * cannot be in the template and unknown to the importer, or the other way round.
 * Each sheet is an existing setup screen; nothing here is a new concept.
 */

export type SetupSheetKey =
  | 'restaurant' | 'floors' | 'tables' | 'printers' | 'kitchens' | 'categories' | 'items';

export interface SetupColumn {
  /** The field name the rows carry to the server. */
  readonly field: string;
  /** The header as it appears in the Excel file. */
  readonly header: string;
  readonly required: boolean;
  /** One line for the "How to fill" sheet. */
  readonly help: string;
}

export interface SetupSheet {
  readonly key: SetupSheetKey;
  readonly title: string;
  readonly columns: readonly SetupColumn[];
}

const col = (field: string, header: string, required: boolean, help: string): SetupColumn =>
  ({ field, header, required, help });

/** In import order: each sheet may refer to the ones above it. */
export const SETUP_SHEETS: readonly SetupSheet[] = [
  {
    key: 'restaurant', title: 'Restaurant', columns: [
      col('branchName', 'Branch name', false, 'The branch this file sets up. Blank keeps the current name.'),
      col('timezone', 'Time zone', false, 'For example Asia/Kolkata. Blank keeps the current one.'),
      col('dayStartsAt', 'Business day starts', false, 'When a new business day begins, HH:MM, for example 03:00.'),
    ],
  },
  {
    key: 'floors', title: 'Floors', columns: [
      col('name', 'Floor', true, 'A floor or section, for example Ground floor or Terrace.'),
      col('type', 'Floor type', false, 'AC, Non AC, VIP or Rooftop (or another floor type you added).'),
      col('order', 'Display order', false, 'Whole number; smaller shows first.'),
    ],
  },
  {
    key: 'tables', title: 'Tables', columns: [
      col('name', 'Table', true, 'The table number or name staff use, for example T1. Each table once.'),
      col('floor', 'Floor', true, 'A floor from the Floors sheet, or one already set up.'),
      col('seats', 'Seats', true, 'How many people it seats, 1 to 100.'),
    ],
  },
  {
    key: 'printers', title: 'Printers', columns: [
      col('name', 'Printer', true, 'A name staff recognise, for example Kitchen printer.'),
      col('connection', 'Connection', true, 'network, usb, bluetooth or cloud.'),
      col('address', 'Address', false, 'For a network printer, its IP and port, for example 192.168.1.50:9100.'),
    ],
  },
  {
    key: 'kitchens', title: 'Printer Mapping', columns: [
      col('name', 'Kitchen', true, 'A kitchen or counter that prepares food, for example Main Kitchen or Bar.'),
      col('type', 'Type', true, 'food or beverage.'),
      col('printer', 'Printer', true, 'The printer its tickets print on, from the Printers sheet.'),
    ],
  },
  {
    key: 'categories', title: 'Menu Categories', columns: [
      col('name', 'Category', true, 'For example Starters, Main Course, Drinks.'),
      col('kitchen', 'Default kitchen', false, 'Items in this category print here when their own Kitchen is blank.'),
      col('order', 'Display order', false, 'Whole number; smaller shows first.'),
    ],
  },
  {
    key: 'items', title: 'Menu Items', columns: [
      col('name', 'Item', true, 'The dish name as it appears on the bill.'),
      col('category', 'Category', false, 'From the Menu Categories sheet.'),
      col('price', 'Price', true, 'In the restaurant\'s currency, for example 180 or 99.50.'),
      col('tax', 'Tax', true, 'GST 5%, GST 18% or Exempt (0%).'),
      col('kitchen', 'Kitchen', false, 'Where it is prepared and printed; blank uses the category default.'),
      col('description', 'Description', false, 'Optional.'),
      col('prepMinutes', 'Prep minutes', false, 'Optional, 1 to 240.'),
      col('barcode', 'Barcode', false, 'Optional; each barcode once.'),
      col('available', 'Available', false, 'Yes or No. Blank means Yes.'),
    ],
  },
];

/** A row as sent to the server: fields from the columns above, plus its Excel row number. */
export type SetupRow = { readonly row: number } & Readonly<Record<string, string>>;
export type SetupSheets = Partial<Record<SetupSheetKey, readonly SetupRow[]>>;

/** Large enough for any real restaurant, small enough to keep one request sane. */
export const SETUP_MAX_ROWS_PER_SHEET = 2000;
