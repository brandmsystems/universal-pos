import { randomUUID } from 'node:crypto';
import {
  SETUP_MAX_ROWS_PER_SHEET, SETUP_SHEETS,
  type SetupRow, type SetupSheetKey, type SetupSheets,
} from '@katkitchen/shared';
import type { TenantContext } from '../../core/database/tenantContext.js';
import type { Value } from '../../core/database/baseRepository.js';
import type { PermissionKey } from '../authz/permissions.js';
import { resolveActor } from '../authz/authorityStore.js';
import { ADMIN_RESOURCES, writableOnly } from './adminResources.js';
import {
  SetupInvalidError, activeBranch, createKitchen, createMenuItem, editKitchen, editMenuItem, keyFrom, listAtBranch,
} from './setup.js';

/**
 * The restaurant-setup Excel import.
 *
 * Every row goes through the SAME write the setup screens use -- the setup
 * functions for kitchens and dishes, the admin resources' own repository and
 * field allowlist for floors, tables, printers, categories and the branch -- so
 * an import can do nothing a manager could not do by hand, and is checked by
 * the same rules.
 *
 * All or nothing. Each row runs under its own savepoint so one bad row reports
 * its error without hiding the others, and the whole import runs under one
 * outer savepoint that is rolled back unless every row succeeded AND the caller
 * asked to apply. The preview is that same run, always rolled back -- so what
 * the preview says is exactly what the import will do.
 *
 * Rows are matched to what already exists by NAME and updated; nothing that is
 * missing from the file is removed, so uploading a corrected file again is safe.
 */

export interface ImportProblem { readonly sheet: string; readonly row: number | null; readonly message: string }
export interface ImportResult {
  readonly applied: boolean;
  readonly counts: Readonly<Record<SetupSheetKey, { created: number; updated: number }>>;
  readonly errors: readonly ImportProblem[];
}

/** What each sheet writes, so an import never reaches past the caller's own keys. */
const SHEET_KEYS: Readonly<Record<SetupSheetKey, readonly PermissionKey[]>> = {
  restaurant: ['branch.edit'],
  floors: ['table.edit'],
  tables: ['table.edit'],
  printers: ['printer.edit'],
  kitchens: ['kitchen.station.edit'],
  categories: ['menu.category.edit'],
  items: ['menu.item.create', 'menu.item.edit', 'menu.price.edit'],
};

/** The sheets a plan without `tables` cannot carry: the same gate the floor-plan routes declare. */
const FLOOR_PLAN_SHEETS: ReadonlySet<SetupSheetKey> = new Set(['floors', 'tables']);

const TITLE = Object.fromEntries(SETUP_SHEETS.map((s) => [s.key, s.title])) as Record<SetupSheetKey, string>;

function cell(row: SetupRow, field: string): string {
  const value = row[field];
  return typeof value === 'string' ? value.trim() : '';
}
function required(row: SetupRow, field: string, header: string): string {
  const value = cell(row, field);
  if (value === '') throw new SetupInvalidError(`${header} is required.`);
  return value;
}
function whole(value: string, header: string, min: number, max: number): number | undefined {
  if (value === '') return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new SetupInvalidError(`${header} must be a whole number from ${min} to ${max}.`);
  }
  return Number(value);
}
/** Whole units of the restaurant's currency (INR, AED: two decimals), to minor units. Never a float. */
function paise(value: string): number {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.replace(/,/g, ''));
  if (!match) throw new SetupInvalidError(`Price "${value}" is not a price; use a number like 180 or 99.50.`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export async function importSetup(
  context: TenantContext,
  input: {
    branchId: string | null; userId: string; sheets: SetupSheets; apply: boolean;
    /** The plan has floors and tables (`tables`). Basic does not, so a file carrying them is refused, not half-applied. */
    tables?: boolean;
  },
): Promise<ImportResult> {
  const branchId = await activeBranch(context, input.branchId);
  const counts = Object.fromEntries(SETUP_SHEETS.map((s) => [s.key, { created: 0, updated: 0 }])) as
    Record<SetupSheetKey, { created: number; updated: number }>;
  const errors: ImportProblem[] = [];

  // Refused as a whole before anything runs: what the caller may not do by hand.
  const actor = await resolveActor(context, input.userId, branchId);
  const held = actor?.authority?.permissions ?? new Set<string>();
  for (const sheet of SETUP_SHEETS) {
    const rows = input.sheets[sheet.key] ?? [];
    if (rows.length > SETUP_MAX_ROWS_PER_SHEET) {
      errors.push({ sheet: sheet.title, row: null, message: `More than ${SETUP_MAX_ROWS_PER_SHEET} rows; split the file.` });
    }
    if (input.tables === false && FLOOR_PLAN_SHEETS.has(sheet.key) && rows.length > 0) {
      errors.push({ sheet: sheet.title, row: null, message: 'This plan has no floors or tables (dine-in is numbered at the counter); remove this sheet.' });
    }
    const missing = SHEET_KEYS[sheet.key].filter((k) => !held.has(k));
    if (rows.length > 0 && missing.length > 0) {
      errors.push({ sheet: sheet.title, row: null, message: `Your role cannot change this (needs ${missing.join(', ')}).` });
    }
  }
  if (errors.length > 0) return { applied: false, counts, errors };

  // Duplicates inside the file: the same table twice is a mistake, not an update.
  for (const sheet of SETUP_SHEETS) {
    const seen = new Map<string, number>();
    for (const row of input.sheets[sheet.key] ?? []) {
      const name = cell(row, sheet.key === 'restaurant' ? 'branchName' : 'name').toLowerCase();
      if (name === '' || sheet.key === 'restaurant') continue;
      const first = seen.get(name);
      if (first !== undefined) {
        errors.push({ sheet: sheet.title, row: row.row, message: `"${cell(row, 'name')}" is also on row ${first}; each name once.` });
      } else seen.set(name, row.row);
    }
  }

  const db = context.client;
  const t = context.tenantId;
  const one = async <R>(sql: string, params: unknown[]): Promise<R | undefined> =>
    (await db.query(sql, params)).rows[0] as R | undefined;
  const count = (sheet: SetupSheetKey, created: boolean): void => {
    counts[sheet][created ? 'created' : 'updated'] += 1;
  };
  const categoryKitchen = new Map<string, string>();

  const writers: Record<SetupSheetKey, (row: SetupRow) => Promise<void>> = {
    restaurant: async (row) => {
      const values: Record<string, unknown> = {};
      if (cell(row, 'branchName')) values['name'] = cell(row, 'branchName');
      if (cell(row, 'timezone')) values['timezone'] = cell(row, 'timezone');
      if (cell(row, 'dayStartsAt')) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cell(row, 'dayStartsAt'))) {
          throw new SetupInvalidError('Business day starts must be HH:MM, for example 03:00.');
        }
        values['business_day_starts_at'] = cell(row, 'dayStartsAt');
      }
      if (Object.keys(values).length === 0) return;
      const resource = ADMIN_RESOURCES['branches']!;
      await resource.repository().update({ id: branchId }, writableOnly('branches', values, resource.editable));
      count('restaurant', false);
    },

    floors: async (row) => {
      const name = required(row, 'name', 'Floor');
      const typeName = cell(row, 'type');
      const type = typeName === '' ? undefined : await one<{ id: string }>(
        `SELECT id FROM app.floor_type WHERE tenant_id = $1 AND status = 'active' AND (lower(name) = lower($2) OR key = $3)`,
        [t, typeName, keyFrom(typeName)]);
      if (typeName !== '' && !type) throw new SetupInvalidError(`Floor type "${typeName}" not found (AC, Non AC, VIP, Rooftop).`);
      const values: Record<string, unknown> = { name };
      if (type) values['floor_type_id'] = type.id;
      const order = whole(cell(row, 'order'), 'Display order', 0, 999);
      if (order !== undefined) values['display_order'] = String(order);
      await upsert('floors', { name, lookup: `SELECT id FROM app.floor WHERE tenant_id = $1 AND branch_id = $2 AND lower(name) = lower($3) AND status = 'active'` }, values);
    },

    printers: async (row) => {
      const name = required(row, 'name', 'Printer');
      const connection = required(row, 'connection', 'Connection').toLowerCase();
      if (!['network', 'usb', 'bluetooth', 'cloud'].includes(connection)) {
        throw new SetupInvalidError('Connection must be network, usb, bluetooth or cloud.');
      }
      const existing = await one<{ id: string; connection_kind: string }>(
        `SELECT id, connection_kind FROM app.printer WHERE tenant_id = $1 AND branch_id = $2 AND lower(name) = lower($3) AND status = 'active'`,
        [t, branchId, name]);
      if (existing && existing.connection_kind !== connection) {
        throw new SetupInvalidError(`"${name}" is already a ${existing.connection_kind} printer; a connection cannot change, add a new printer instead.`);
      }
      const values: Record<string, unknown> = { name, address: cell(row, 'address') || null };
      if (!existing) values['connection_kind'] = connection;
      await upsert('printers', { name, lookup: `SELECT id FROM app.printer WHERE tenant_id = $1 AND branch_id = $2 AND lower(name) = lower($3) AND status = 'active'` }, values);
    },

    kitchens: async (row) => {
      const name = required(row, 'name', 'Kitchen');
      const kind = required(row, 'type', 'Type').toLowerCase();
      const printerName = required(row, 'printer', 'Printer');
      const printer = await one<{ id: string }>(
        `SELECT id FROM app.printer WHERE tenant_id = $1 AND branch_id = $2 AND lower(name) = lower($3) AND status = 'active'`,
        [t, branchId, printerName]);
      if (!printer) throw new SetupInvalidError(`Printer "${printerName}" not found on the Printers sheet or at this branch.`);
      const existing = await one<{ id: string }>(
        `SELECT id FROM app.kitchen_station WHERE tenant_id = $1 AND branch_id = $2 AND code = $3 AND status = 'active'`,
        [t, branchId, keyFrom(name)]);
      if (existing) await editKitchen(context, { id: existing.id, kind, printerId: printer.id });
      else await createKitchen(context, { name, kind, printerId: printer.id, branchId });
      count('kitchens', !existing);
    },

    categories: async (row) => {
      const name = required(row, 'name', 'Category');
      const kitchen = cell(row, 'kitchen');
      if (kitchen !== '') {
        const found = await one(`SELECT 1 FROM app.station_code WHERE tenant_id = $1 AND code = $2 AND status = 'active'`, [t, keyFrom(kitchen)]);
        if (!found) throw new SetupInvalidError(`Default kitchen "${kitchen}" not found on the Printer Mapping sheet.`);
        categoryKitchen.set(name.toLowerCase(), keyFrom(kitchen));
      }
      const values: Record<string, unknown> = { name };
      const order = whole(cell(row, 'order'), 'Display order', 0, 999);
      if (order !== undefined) values['display_order'] = String(order);
      const existing = await one<{ id: string }>(
        `SELECT id FROM app.menu_category WHERE tenant_id = $1 AND key = $2`, [t, keyFrom(name)]);
      const resource = ADMIN_RESOURCES['menu/categories']!;
      if (existing) {
        await resource.repository().update({ id: existing.id }, writableOnly('menu/categories', values, resource.editable));
      } else {
        await resource.repository().insert({ ...writableOnly('menu/categories', { ...values, key: keyFrom(name) }, resource.creatable), id: randomUUID() });
      }
      count('categories', !existing);
    },

    tables: async (row) => {
      const name = required(row, 'name', 'Table');
      const floorName = required(row, 'floor', 'Floor');
      const seats = whole(required(row, 'seats', 'Seats'), 'Seats', 1, 100)!;
      const floor = await one<{ id: string }>(
        `SELECT id FROM app.floor WHERE tenant_id = $1 AND branch_id = $2 AND lower(name) = lower($3) AND status = 'active'`, [t, branchId, floorName]);
      if (!floor) throw new SetupInvalidError(`Floor "${floorName}" not found on the Floors sheet or at this branch.`);
      const matches = await db.query<{ id: string }>(
        `SELECT id FROM app.dining_table WHERE tenant_id = $1 AND branch_id = $2 AND lower(identifier) = lower($3) AND status = 'active'`,
        [t, branchId, name]);
      if (matches.rows.length > 1) throw new SetupInvalidError(`"${name}" already exists on more than one floor; rename one first.`);
      await upsertById('tables', matches.rows[0]?.id, { identifier: name, floor_id: floor.id, seats: String(seats) });
    },

    items: async (row) => {
      const name = required(row, 'name', 'Item');
      const priceMinor = paise(required(row, 'price', 'Price'));
      const taxName = required(row, 'tax', 'Tax');
      const tax = await one<{ id: string }>(
        `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND status = 'active'
            AND (lower(name) = lower($2) OR key = $3 OR lower(split_part(name, ' (', 1)) = lower($2)
                 OR (rate_bps::text || '%') = $4 OR ((rate_bps / 100)::text || '%') = $4)`,
        [t, taxName, keyFrom(taxName), taxName.replace(/^gst\s*/i, '').replace(/\s/g, '')]);
      if (!tax) throw new SetupInvalidError(`Tax "${taxName}" not found; use GST 5%, GST 18% or Exempt (0%).`);
      const categoryName = cell(row, 'category');
      const category = categoryName === '' ? undefined : await one<{ id: string }>(
        `SELECT id FROM app.menu_category WHERE tenant_id = $1 AND key = $2`, [t, keyFrom(categoryName)]);
      if (categoryName !== '' && !category) throw new SetupInvalidError(`Category "${categoryName}" not found on the Menu Categories sheet.`);
      const kitchenName = cell(row, 'kitchen');
      const kitchenCode = kitchenName !== '' ? keyFrom(kitchenName) : categoryKitchen.get(categoryName.toLowerCase());
      if (!kitchenCode) throw new SetupInvalidError('Kitchen is required (or give the category a Default kitchen).');
      const found = await one(`SELECT 1 FROM app.station_code WHERE tenant_id = $1 AND code = $2 AND status = 'active'`, [t, kitchenCode]);
      if (!found) throw new SetupInvalidError(`Kitchen "${kitchenName || kitchenCode}" not found on the Printer Mapping sheet.`);
      const available = cell(row, 'available').toLowerCase();
      if (!['', 'yes', 'no', 'y', 'n'].includes(available)) throw new SetupInvalidError('Available must be Yes or No.');
      const fields = {
        name, priceMinor, taxClassId: tax.id, kitchenCode, categoryId: category?.id ?? null,
        description: cell(row, 'description') || null,
        prepMinutes: whole(cell(row, 'prepMinutes'), 'Prep minutes', 1, 240) ?? null,
        barcode: cell(row, 'barcode') || null,
      };
      const matches = await db.query<{ id: string }>(
        `SELECT id FROM app.menu_item WHERE tenant_id = $1 AND lower(name) = lower($2) AND status = 'active'`, [t, name]);
      if (matches.rows.length > 1) throw new SetupInvalidError(`More than one item is called "${name}"; rename one first.`);
      const existing = matches.rows[0];
      const id = existing
        ? (await editMenuItem(context, { ...fields, id: existing.id })).id
        : (await createMenuItem(context, { ...fields, kind: 'single', branchId })).id;
      await listAtBranch(context, { itemId: id, branchId, listed: !available.startsWith('n') });
      count('items', !existing);
    },
  };

  /** Finds by name at this branch, then updates or inserts through the resource's own allowlist. */
  async function upsert(resourceName: 'floors' | 'printers', find: { name: string; lookup: string }, values: Record<string, unknown>): Promise<void> {
    const existing = await one<{ id: string }>(find.lookup, [t, branchId, find.name]);
    await upsertById(resourceName, existing?.id, values);
  }
  async function upsertById(resourceName: 'floors' | 'printers' | 'tables', id: string | undefined, values: Record<string, unknown>): Promise<void> {
    const resource = ADMIN_RESOURCES[resourceName]!;
    const sheet: SetupSheetKey = resourceName;
    if (id) {
      const editable = Object.fromEntries(Object.entries(values).filter(([k]) => resource.editable.includes(k)));
      await resource.repository().update({ id, [resource.branchColumn!]: branchId }, writableOnly(resourceName, editable, resource.editable));
    } else {
      const row: Record<string, Value> = { ...writableOnly(resourceName, values, resource.creatable), id: randomUUID() };
      row[resource.branchColumn!] = branchId;
      await resource.repository().insert(row);
    }
    count(sheet, !id);
  }

  await db.query('SAVEPOINT setup_import');
  for (const sheet of SETUP_SHEETS) {
    for (const row of input.sheets[sheet.key] ?? []) {
      await db.query('SAVEPOINT setup_row');
      try {
        await writers[sheet.key](row);
        await db.query('RELEASE SAVEPOINT setup_row');
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT setup_row');
        errors.push({ sheet: TITLE[sheet.key], row: row.row, message: describe(error) });
      }
    }
  }
  const applied = input.apply && errors.length === 0;
  await db.query(applied ? 'RELEASE SAVEPOINT setup_import' : 'ROLLBACK TO SAVEPOINT setup_import');
  return { applied, counts, errors };
}

/** Our own refusals say what to fix; a database refusal names only its constraint. */
function describe(error: unknown): string {
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    return e.code === '23505'
      ? `This duplicates something that already exists (${String(e.constraint ?? 'unique')}).`
      : `Refused by the database (${String(e.constraint ?? e.code)}).`;
  }
  return typeof e.message === 'string' ? e.message : 'This row could not be imported.';
}
