import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { assertListable, assertStationArchivable } from '../menu/routing.js';

/**
 * The manager's setup flow: kitchens, add-ons, food items, and how far along
 * the restaurant is. Floors, floor types, tables, printers and categories are
 * single-table writes served by the declared admin CRUD; what is here writes
 * several rows that must agree, so each is one function in one transaction.
 *
 * Keys are derived from names here, never typed: a manager types "Butter
 * Naan", not `butter_naan`, and a key the schema refuses should not be a thing
 * a person can get wrong.
 */

export class SetupInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'setup_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'SetupInvalidError';
  }
}

export class SetupConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'setup_conflict';
  constructor(detail: string) {
    super(detail);
    this.name = 'SetupConflictError';
  }
}

export class SetupRowNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'setup_row_not_found';
  constructor(what: string) {
    super(`no ${what} with that id in this restaurant`);
    this.name = 'SetupRowNotFoundError';
  }
}

export class SetupBranchRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'setup_branch_required';
  constructor() {
    super('this belongs to a branch: sign in at the branch, or name it with ?branchId=');
    this.name = 'SetupBranchRequiredError';
  }
}

/* --------------------------------------------------------------- helpers --- */

function text(value: unknown, what: string, options: { required: boolean; max: number }): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (options.required) throw new SetupInvalidError(`${what} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new SetupInvalidError(`${what} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > options.max) throw new SetupInvalidError(`${what} must be at most ${options.max} characters.`);
  return trimmed;
}

function wholeNumber(value: unknown, what: string, options: { min: number; max: number; required: boolean }): number | null {
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new SetupInvalidError(`${what} is required.`);
    return null;
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < options.min || n > options.max) {
    throw new SetupInvalidError(`${what} must be a whole number from ${options.min} to ${options.max}.`);
  }
  return n;
}

function uuid(value: unknown, what: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new SetupInvalidError(`${what} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new SetupInvalidError(`${what} is not a valid id.`);
  return value;
}

/** "Butter Naan (Large)" -> "butter_naan_large"; a leading digit gets a letter. */
export function keyFrom(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  if (base === '') return 'item';
  return /^[a-z]/.test(base) ? base : `x_${base}`;
}

/** A key unique among the table's rows in this tenant (and scope), suffixed _2, _3... when taken. */
async function freeKey(
  context: TenantContext, table: string, column: string, name: string,
  scope: { column: string; value: string } | null = null,
): Promise<string> {
  const base = keyFrom(name);
  const taken = await context.client.query<{ k: string }>(
    `SELECT ${column} AS k FROM ${table}
      WHERE tenant_id = $1 AND (${column} = $2 OR ${column} LIKE $2 || '\\_%')
        ${scope ? `AND ${scope.column} = $3` : ''}`,
    scope ? [context.tenantId, base, scope.value] : [context.tenantId, base]);
  const used = new Set(taken.rows.map((row) => row.k));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

export async function activeBranch(context: TenantContext, branchId: string | null): Promise<string> {
  if (branchId === null) throw new SetupBranchRequiredError();
  const found = await context.client.query(
    `SELECT 1 FROM app.branch WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [context.tenantId, branchId]);
  if ((found.rowCount ?? 0) === 0) throw new SetupRowNotFoundError('active branch');
  return branchId;
}

/* -------------------------------------------------------------- progress --- */

export interface SetupProgress {
  readonly floorTypes: number;
  readonly floors: number;
  readonly tables: number;
  readonly kitchens: number;
  readonly printers: number;
  readonly categories: number;
  readonly items: number;
  readonly addOns: number;
}

export async function setupProgress(context: TenantContext, branchId: string | null): Promise<SetupProgress> {
  const result = await context.client.query<Record<keyof SetupProgress, string>>(
    `SELECT
       (SELECT count(*) FROM app.floor_type WHERE tenant_id = $1 AND status = 'active')::text AS "floorTypes",
       (SELECT count(*) FROM app.floor WHERE tenant_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR branch_id = $2))::text AS floors,
       (SELECT count(*) FROM app.dining_table WHERE tenant_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR branch_id = $2))::text AS tables,
       (SELECT count(*) FROM app.kitchen_station WHERE tenant_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR branch_id = $2))::text AS kitchens,
       (SELECT count(*) FROM app.printer WHERE tenant_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR branch_id = $2))::text AS printers,
       (SELECT count(*) FROM app.menu_category WHERE tenant_id = $1 AND status = 'active')::text AS categories,
       (SELECT count(*) FROM app.menu_item WHERE tenant_id = $1 AND status = 'active')::text AS items,
       (SELECT count(*) FROM app.modifier_group WHERE tenant_id = $1 AND status = 'active')::text AS "addOns"`,
    [context.tenantId, branchId]);
  const row = result.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as unknown as SetupProgress;
}

/** The four floor types every restaurant starts with. Idempotent. */
export async function seedFloorTypes(client: pg.ClientBase, tenantId: string): Promise<void> {
  await client.query(
    `INSERT INTO app.floor_type (id, tenant_id, key, name)
     SELECT gen_random_uuid(), $1, v.key, v.name
       FROM (VALUES ('ac', 'AC'), ('non_ac', 'Non AC'), ('vip', 'VIP'), ('rooftop', 'Rooftop')) AS v (key, name)
      WHERE NOT EXISTS (SELECT 1 FROM app.floor_type f WHERE f.tenant_id = $1 AND f.key = v.key AND f.status = 'active')`,
    [tenantId]);
}

/* -------------------------------------------------------------- kitchens --- */

export interface Kitchen {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'food' | 'beverage';
  readonly displayOrder: number;
  readonly printerId: string | null;
  readonly printerName: string | null;
}

function kindOf(value: unknown): 'food' | 'beverage' {
  if (value !== 'food' && value !== 'beverage') throw new SetupInvalidError('type must be "food" or "beverage".');
  return value;
}

export async function listKitchens(context: TenantContext, branchId: string | null): Promise<readonly Kitchen[]> {
  const result = await context.client.query<{
    id: string; branch_id: string; code: string; name: string; kind: 'food' | 'beverage';
    display_order: number; printer_id: string | null; printer_name: string | null;
  }>(
    `SELECT ks.id, ks.branch_id, ks.code, ks.name, sc.kind, ks.display_order,
            p.id AS printer_id, p.name AS printer_name
       FROM app.kitchen_station ks
       JOIN app.station_code sc ON sc.tenant_id = ks.tenant_id AND sc.code = ks.code
       LEFT JOIN app.station_printer sp
              ON sp.tenant_id = ks.tenant_id AND sp.station_id = ks.id AND sp.is_primary
       LEFT JOIN app.printer p ON p.tenant_id = sp.tenant_id AND p.id = sp.printer_id
      WHERE ks.tenant_id = $1 AND ks.status = 'active' AND ($2::uuid IS NULL OR ks.branch_id = $2)
      ORDER BY ks.display_order, ks.name`,
    [context.tenantId, branchId]);
  return result.rows.map((row) => ({
    id: row.id, branchId: row.branch_id, code: row.code, name: row.name, kind: row.kind,
    displayOrder: row.display_order, printerId: row.printer_id, printerName: row.printer_name,
  }));
}

async function assertPrinterAtBranch(context: TenantContext, printerId: string, branchId: string): Promise<void> {
  const found = await context.client.query(
    `SELECT 1 FROM app.printer WHERE tenant_id = $1 AND id = $2 AND branch_id = $3 AND status = 'active'`,
    [context.tenantId, printerId, branchId]);
  if ((found.rowCount ?? 0) === 0) {
    throw new SetupInvalidError('the printer must be an active printer at the same branch as the kitchen.');
  }
}

/**
 * A kitchen is three rows: the restaurant-wide code items route by, the
 * branch's station for that code, and the station's primary printer. A
 * kitchen with no printer cannot print a single ticket, so the printer is
 * required here rather than discovered at the first fire.
 */
export async function createKitchen(
  context: TenantContext,
  input: { name?: unknown; kind?: unknown; printerId?: unknown; displayOrder?: unknown; branchId: string | null },
): Promise<Kitchen> {
  const name = text(input.name, 'name', { required: true, max: 60 })!;
  const kind = kindOf(input.kind);
  const printerId = uuid(input.printerId, 'printer', true)!;
  const displayOrder = wholeNumber(input.displayOrder, 'display order', { min: 0, max: 999, required: false }) ?? 0;
  const branchId = await activeBranch(context, input.branchId);
  await assertPrinterAtBranch(context, printerId, branchId);

  const code = keyFrom(name);
  const existing = await context.client.query<{ kind: string }>(
    `SELECT kind FROM app.station_code WHERE tenant_id = $1 AND code = $2`, [context.tenantId, code]);
  if (existing.rows[0] && existing.rows[0].kind !== kind) {
    throw new SetupConflictError(
      `a kitchen called "${name}" already exists at another branch as ${existing.rows[0].kind}; the same kitchen has one type everywhere.`);
  }
  await context.client.query(
    `INSERT INTO app.station_code (tenant_id, code, name, kind) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, code) DO UPDATE SET status = 'active'`,
    [context.tenantId, code, name, kind]);
  const clash = await context.client.query(
    `SELECT 1 FROM app.kitchen_station WHERE tenant_id = $1 AND branch_id = $2 AND code = $3`,
    [context.tenantId, branchId, code]);
  if ((clash.rowCount ?? 0) > 0) throw new SetupConflictError(`this branch already has a kitchen called "${name}".`);

  const id = randomUUID();
  await context.client.query(
    `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name, display_order)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, context.tenantId, branchId, code, name, displayOrder]);
  await context.client.query(
    `INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary) VALUES ($1, $2, $3, true)`,
    [context.tenantId, id, printerId]);
  return (await listKitchens(context, branchId)).find((k) => k.id === id)!;
}

export async function editKitchen(
  context: TenantContext,
  input: { id: string; name?: unknown; kind?: unknown; printerId?: unknown; displayOrder?: unknown },
): Promise<Kitchen> {
  const found = await context.client.query<{ branch_id: string; code: string }>(
    `SELECT branch_id, code FROM app.kitchen_station WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [context.tenantId, input.id]);
  const station = found.rows[0];
  if (!station) throw new SetupRowNotFoundError('kitchen');

  if (input.name !== undefined) {
    const name = text(input.name, 'name', { required: true, max: 60 })!;
    await context.client.query(
      `UPDATE app.kitchen_station SET name = $3 WHERE tenant_id = $1 AND id = $2`, [context.tenantId, input.id, name]);
  }
  if (input.displayOrder !== undefined) {
    const order = wholeNumber(input.displayOrder, 'display order', { min: 0, max: 999, required: true });
    await context.client.query(
      `UPDATE app.kitchen_station SET display_order = $3 WHERE tenant_id = $1 AND id = $2`, [context.tenantId, input.id, order]);
  }
  if (input.kind !== undefined) {
    await context.client.query(
      `UPDATE app.station_code SET kind = $3 WHERE tenant_id = $1 AND code = $2`,
      [context.tenantId, station.code, kindOf(input.kind)]);
  }
  if (input.printerId !== undefined) {
    const printerId = uuid(input.printerId, 'printer', true)!;
    await assertPrinterAtBranch(context, printerId, station.branch_id);
    await context.client.query(
      `DELETE FROM app.station_printer WHERE tenant_id = $1 AND station_id = $2 AND is_primary`,
      [context.tenantId, input.id]);
    await context.client.query(
      `INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary) VALUES ($1, $2, $3, true)
       ON CONFLICT DO NOTHING`,
      [context.tenantId, input.id, printerId]);
  }
  return (await listKitchens(context, station.branch_id)).find((k) => k.id === input.id)!;
}

/** Refused, naming the dishes, while listed items at this branch still route here. */
export async function archiveKitchen(context: TenantContext, id: string): Promise<{ id: string; archived: true }> {
  const found = await context.client.query(
    `SELECT 1 FROM app.kitchen_station WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [context.tenantId, id]);
  if ((found.rowCount ?? 0) === 0) throw new SetupRowNotFoundError('kitchen');
  await assertStationArchivable(context, id);
  await context.client.query(
    `UPDATE app.kitchen_station SET status = 'archived' WHERE tenant_id = $1 AND id = $2`, [context.tenantId, id]);
  return { id, archived: true };
}

/* --------------------------------------------------------------- add-ons --- */

export interface AddOnGroup {
  readonly id: string;
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number | null;
  readonly options: readonly { id: string; name: string; priceDeltaMinor: number; kitchenCode: string | null }[];
}

export async function listAddOns(context: TenantContext): Promise<readonly AddOnGroup[]> {
  const result = await context.client.query<{
    id: string; name: string; min_select: number; max_select: number | null;
    options: AddOnGroup['options'] | null;
  }>(
    `SELECT g.id, g.name, g.min_select, g.max_select,
            (SELECT json_agg(json_build_object('id', o.id, 'name', o.name,
                    'priceDeltaMinor', o.price_delta_minor, 'kitchenCode', o.station_code)
                    ORDER BY o.display_order, o.name)
               FROM app.modifier_option o
              WHERE o.tenant_id = g.tenant_id AND o.modifier_group_id = g.id AND o.status = 'active') AS options
       FROM app.modifier_group g
      WHERE g.tenant_id = $1 AND g.status = 'active'
      ORDER BY g.name`,
    [context.tenantId]);
  return result.rows.map((row) => ({
    id: row.id, name: row.name, minSelect: row.min_select, maxSelect: row.max_select,
    options: (row.options ?? []).map((o) => ({ ...o, priceDeltaMinor: Number(o.priceDeltaMinor) })),
  }));
}

interface OptionInput { id?: unknown; name?: unknown; priceDeltaMinor?: unknown; kitchenCode?: unknown }

function optionsOf(value: unknown): OptionInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new SetupInvalidError('an add-on group needs at least one option.');
  if (value.length > 50) throw new SetupInvalidError('an add-on group may have at most 50 options.');
  return value as OptionInput[];
}

function boundsOf(minValue: unknown, maxValue: unknown): { min: number; max: number | null } {
  const min = wholeNumber(minValue, 'minimum choices', { min: 0, max: 50, required: false }) ?? 0;
  const max = wholeNumber(maxValue, 'maximum choices', { min: 1, max: 50, required: false });
  if (max !== null && max < min) throw new SetupInvalidError('maximum choices cannot be below the minimum.');
  return { min, max };
}

async function kitchenCodeOf(context: TenantContext, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  const found = await context.client.query(
    `SELECT 1 FROM app.station_code WHERE tenant_id = $1 AND code = $2 AND status = 'active'`, [context.tenantId, value]);
  if ((found.rowCount ?? 0) === 0) throw new SetupInvalidError('that kitchen does not exist.');
  return value as string;
}

async function writeOption(context: TenantContext, groupId: string, option: OptionInput, order: number): Promise<string> {
  const name = text(option.name, 'option name', { required: true, max: 60 })!;
  const delta = wholeNumber(option.priceDeltaMinor ?? 0, 'option price', { min: -10_000_000, max: 10_000_000, required: true })!;
  const kitchenCode = await kitchenCodeOf(context, option.kitchenCode);
  const id = uuid(option.id, 'option', false);
  if (id !== null) {
    const updated = await context.client.query(
      `UPDATE app.modifier_option SET name = $4, price_delta_minor = $5, station_code = $6, display_order = $7
        WHERE tenant_id = $1 AND modifier_group_id = $2 AND id = $3 AND status = 'active'`,
      [context.tenantId, groupId, id, name, delta, kitchenCode, order]);
    if ((updated.rowCount ?? 0) === 0) throw new SetupRowNotFoundError('add-on option');
    return id;
  }
  const newId = randomUUID();
  const key = await freeKey(context, 'app.modifier_option', 'key', name, { column: 'modifier_group_id', value: groupId });
  await context.client.query(
    `INSERT INTO app.modifier_option (id, tenant_id, modifier_group_id, key, name, price_delta_minor, station_code, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId, context.tenantId, groupId, key, name, delta, kitchenCode, order]);
  return newId;
}

export async function createAddOn(
  context: TenantContext,
  input: { name?: unknown; minSelect?: unknown; maxSelect?: unknown; options?: unknown },
): Promise<AddOnGroup> {
  const name = text(input.name, 'name', { required: true, max: 60 })!;
  const { min, max } = boundsOf(input.minSelect, input.maxSelect);
  const options = optionsOf(input.options);
  const id = randomUUID();
  await context.client.query(
    `INSERT INTO app.modifier_group (id, tenant_id, key, name, min_select, max_select) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, context.tenantId, await freeKey(context, 'app.modifier_group', 'key', name), name, min, max]);
  for (const [i, option] of options.entries()) await writeOption(context, id, { ...option, id: undefined }, i);
  return (await listAddOns(context)).find((g) => g.id === id)!;
}

/**
 * Options sent with an id are updated, without one are added, and active
 * options not sent are archived -- never deleted, because kitchen tickets
 * already printed name them.
 */
export async function editAddOn(
  context: TenantContext,
  input: { id: string; name?: unknown; minSelect?: unknown; maxSelect?: unknown; options?: unknown },
): Promise<AddOnGroup> {
  const found = await context.client.query<{ min_select: number; max_select: number | null }>(
    `SELECT min_select, max_select FROM app.modifier_group WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [context.tenantId, input.id]);
  const group = found.rows[0];
  if (!group) throw new SetupRowNotFoundError('add-on group');
  if (input.name !== undefined) {
    await context.client.query(`UPDATE app.modifier_group SET name = $3 WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, input.id, text(input.name, 'name', { required: true, max: 60 })]);
  }
  if (input.minSelect !== undefined || input.maxSelect !== undefined) {
    const { min, max } = boundsOf(input.minSelect ?? group.min_select, input.maxSelect === undefined ? group.max_select : input.maxSelect);
    await context.client.query(`UPDATE app.modifier_group SET min_select = $3, max_select = $4 WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, input.id, min, max]);
  }
  if (input.options !== undefined) {
    const kept: string[] = [];
    for (const [i, option] of optionsOf(input.options).entries()) kept.push(await writeOption(context, input.id, option, i));
    await context.client.query(
      `UPDATE app.modifier_option SET status = 'archived'
        WHERE tenant_id = $1 AND modifier_group_id = $2 AND status = 'active' AND NOT (id = ANY($3::uuid[]))`,
      [context.tenantId, input.id, kept]);
  }
  return (await listAddOns(context)).find((g) => g.id === input.id)!;
}

export async function archiveAddOn(context: TenantContext, id: string): Promise<{ id: string; archived: true }> {
  const updated = await context.client.query(
    `UPDATE app.modifier_group SET status = 'archived' WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [context.tenantId, id]);
  if ((updated.rowCount ?? 0) === 0) throw new SetupRowNotFoundError('add-on group');
  await context.client.query(
    `DELETE FROM app.menu_item_modifier_group WHERE tenant_id = $1 AND modifier_group_id = $2`, [context.tenantId, id]);
  return { id, archived: true };
}

/* ------------------------------------------------------------ food items --- */

export interface MenuItemDetail {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly barcode: string | null;
  readonly categoryId: string | null;
  readonly kind: 'single' | 'combo';
  readonly kitchenCode: string | null;
  readonly kitchenKind: 'food' | 'beverage' | null;
  readonly priceMinor: number;
  readonly prepMinutes: number | null;
  readonly taxClassId: string;
  readonly addOnGroupIds: readonly string[];
  readonly components: readonly { itemId: string; name: string; quantity: number }[];
  readonly listedAt: readonly string[];
}

export async function menuItemDetail(context: TenantContext, id: string): Promise<MenuItemDetail> {
  const result = await context.client.query<{
    id: string; key: string; name: string; description: string | null; barcode: string | null;
    category_id: string | null; kind: 'single' | 'combo'; station_code: string | null;
    kitchen_kind: 'food' | 'beverage' | null; price_minor: string; prep_minutes: number | null;
    tax_class_id: string; add_ons: string[] | null;
    components: { itemId: string; name: string; quantity: number }[] | null; listed_at: string[] | null;
  }>(
    `SELECT mi.id, mi.key, mi.name, mi.description, mi.barcode, mi.category_id, mi.kind, mi.station_code,
            sc.kind AS kitchen_kind, mi.price_minor::text, mi.prep_minutes, mi.tax_class_id,
            (SELECT array_agg(g.modifier_group_id ORDER BY g.display_order)
               FROM app.menu_item_modifier_group g WHERE g.tenant_id = mi.tenant_id AND g.menu_item_id = mi.id) AS add_ons,
            (SELECT json_agg(json_build_object('itemId', c.component_item_id, 'name', ci.name, 'quantity', c.quantity)
                    ORDER BY c.display_order)
               FROM app.combo_component c
               JOIN app.menu_item ci ON ci.tenant_id = c.tenant_id AND ci.id = c.component_item_id
              WHERE c.tenant_id = mi.tenant_id AND c.combo_item_id = mi.id) AS components,
            (SELECT array_agg(l.branch_id) FROM app.branch_menu_listing l
              WHERE l.tenant_id = mi.tenant_id AND l.menu_item_id = mi.id AND l.listed) AS listed_at
       FROM app.menu_item mi
       LEFT JOIN app.station_code sc ON sc.tenant_id = mi.tenant_id AND sc.code = mi.station_code
      WHERE mi.tenant_id = $1 AND mi.id = $2`,
    [context.tenantId, id]);
  const row = result.rows[0];
  if (!row) throw new SetupRowNotFoundError('food item');
  return {
    id: row.id, key: row.key, name: row.name, description: row.description, barcode: row.barcode,
    categoryId: row.category_id, kind: row.kind, kitchenCode: row.station_code, kitchenKind: row.kitchen_kind,
    priceMinor: Number(row.price_minor), prepMinutes: row.prep_minutes, taxClassId: row.tax_class_id,
    addOnGroupIds: row.add_ons ?? [], components: row.components ?? [], listedAt: row.listed_at ?? [],
  };
}

interface ItemInput {
  name?: unknown; description?: unknown; barcode?: unknown; categoryId?: unknown; kind?: unknown;
  kitchenCode?: unknown; priceMinor?: unknown; prepMinutes?: unknown; taxClassId?: unknown;
  addOnGroupIds?: unknown; components?: unknown;
}

async function writeAddOns(context: TenantContext, itemId: string, value: unknown): Promise<void> {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new SetupInvalidError('add-ons must be a list.');
  await context.client.query(
    `DELETE FROM app.menu_item_modifier_group WHERE tenant_id = $1 AND menu_item_id = $2`, [context.tenantId, itemId]);
  for (const [i, groupId] of value.entries()) {
    const id = uuid(groupId, 'add-on group', true)!;
    const active = await context.client.query(
      `SELECT 1 FROM app.modifier_group WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [context.tenantId, id]);
    if ((active.rowCount ?? 0) === 0) throw new SetupInvalidError('an add-on group chosen does not exist.');
    await context.client.query(
      `INSERT INTO app.menu_item_modifier_group (tenant_id, menu_item_id, modifier_group_id, display_order)
       VALUES ($1, $2, $3, $4)`, [context.tenantId, itemId, id, i]);
  }
}

async function writeComponents(context: TenantContext, comboId: string, value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.length === 0) throw new SetupInvalidError('a combo needs at least one dish in it.');
  await context.client.query(`DELETE FROM app.combo_component WHERE tenant_id = $1 AND combo_item_id = $2`,
    [context.tenantId, comboId]);
  for (const [i, raw] of (value as { itemId?: unknown; quantity?: unknown }[]).entries()) {
    const itemId = uuid(raw.itemId, 'combo dish', true)!;
    const quantity = wholeNumber(raw.quantity ?? 1, 'quantity', { min: 1, max: 20, required: true })!;
    const single = await context.client.query(
      `SELECT 1 FROM app.menu_item WHERE tenant_id = $1 AND id = $2 AND kind = 'single' AND status = 'active'`,
      [context.tenantId, itemId]);
    if ((single.rowCount ?? 0) === 0) throw new SetupInvalidError('a combo may only contain active single dishes.');
    await context.client.query(
      `INSERT INTO app.combo_component (id, tenant_id, combo_item_id, combo_kind, kind, component_item_id,
         component_kind, quantity, display_order)
       VALUES ($1, $2, $3, 'combo', 'fixed', $4, 'single', $5, $6)`,
      [randomUUID(), context.tenantId, comboId, itemId, quantity, i]);
  }
}

async function barcodeOf(context: TenantContext, value: unknown, exceptId: string | null): Promise<string | null> {
  const barcode = text(value, 'barcode', { required: false, max: 64 });
  if (barcode === null) return null;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(barcode)) throw new SetupInvalidError('barcode must be 4 to 64 letters, digits or dashes.');
  const taken = await context.client.query(
    `SELECT 1 FROM app.menu_item WHERE tenant_id = $1 AND barcode = $2 AND status = 'active' AND ($3::uuid IS NULL OR id <> $3)`,
    [context.tenantId, barcode, exceptId]);
  if ((taken.rowCount ?? 0) > 0) throw new SetupConflictError('another item already has this barcode.');
  return barcode;
}

export interface ListingOutcome {
  readonly listed: boolean;
}

/**
 * Puts an item on sale at a branch, or takes it off. Routing is refused
 * outright -- the kitchen chosen does not exist here, which the manager can fix
 * in the same form.
 */
export async function listAtBranch(
  context: TenantContext,
  input: { itemId: string; branchId: string; listed: boolean },
): Promise<ListingOutcome> {
  if (input.listed) await assertListable(context, input.branchId, input.itemId);
  await context.client.query(
    `INSERT INTO app.branch_menu_listing (tenant_id, branch_id, menu_item_id, listed) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, branch_id, menu_item_id) DO UPDATE SET listed = EXCLUDED.listed`,
    [context.tenantId, input.branchId, input.itemId, input.listed]);
  return { listed: input.listed };
}

export async function createMenuItem(
  context: TenantContext,
  input: ItemInput & { branchId: string | null },
): Promise<MenuItemDetail & ListingOutcome> {
  const name = text(input.name, 'name', { required: true, max: 120 })!;
  const description = text(input.description, 'description', { required: false, max: 1000 });
  if (input.kind !== 'single' && input.kind !== 'combo') throw new SetupInvalidError('type must be "single" or "combo".');
  const kind = input.kind;
  const kitchenCode = kind === 'single' ? await kitchenCodeOf(context, input.kitchenCode) : null;
  if (kind === 'single' && kitchenCode === null) throw new SetupInvalidError('kitchen is required for a single dish.');
  const priceMinor = wholeNumber(input.priceMinor, 'price', { min: 0, max: 100_000_000, required: true })!;
  const prepMinutes = wholeNumber(input.prepMinutes, 'preparation time', { min: 1, max: 240, required: false });
  const taxClassId = uuid(input.taxClassId, 'tax class', true)!;
  const categoryId = uuid(input.categoryId, 'category', false);
  const branchId = await activeBranch(context, input.branchId);
  const barcode = await barcodeOf(context, input.barcode, null);

  const id = randomUUID();
  await context.client.query(
    `INSERT INTO app.menu_item (id, tenant_id, key, name, description, barcode, kind, category_id, tax_class_id,
       station_code, price_minor, prep_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, context.tenantId, await freeKey(context, 'app.menu_item', 'key', name), name, description, barcode, kind,
     categoryId, taxClassId, kitchenCode, priceMinor, prepMinutes]);
  await writeAddOns(context, id, input.addOnGroupIds ?? []);
  if (kind === 'combo') await writeComponents(context, id, input.components);
  const listing = await listAtBranch(context, { itemId: id, branchId, listed: true });
  return { ...(await menuItemDetail(context, id)), ...listing };
}

export async function editMenuItem(
  context: TenantContext,
  input: ItemInput & { id: string },
): Promise<MenuItemDetail> {
  const found = await context.client.query<{ kind: string }>(
    `SELECT kind FROM app.menu_item WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [context.tenantId, input.id]);
  const item = found.rows[0];
  if (!item) throw new SetupRowNotFoundError('food item');
  if (input.kind !== undefined && input.kind !== item.kind) {
    throw new SetupInvalidError('a dish cannot change between single and combo; archive it and create the other kind.');
  }

  const sets: string[] = [];
  const values: unknown[] = [context.tenantId, input.id];
  const set = (column: string, value: unknown): void => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (input.name !== undefined) set('name', text(input.name, 'name', { required: true, max: 120 }));
  if (input.description !== undefined) set('description', text(input.description, 'description', { required: false, max: 1000 }));
  if (input.barcode !== undefined) set('barcode', await barcodeOf(context, input.barcode, input.id));
  if (input.categoryId !== undefined) set('category_id', uuid(input.categoryId, 'category', false));
  if (input.priceMinor !== undefined) set('price_minor', wholeNumber(input.priceMinor, 'price', { min: 0, max: 100_000_000, required: true }));
  if (input.prepMinutes !== undefined) set('prep_minutes', wholeNumber(input.prepMinutes, 'preparation time', { min: 1, max: 240, required: false }));
  if (input.taxClassId !== undefined) set('tax_class_id', uuid(input.taxClassId, 'tax class', true));
  if (input.kitchenCode !== undefined && item.kind === 'single') {
    const code = await kitchenCodeOf(context, input.kitchenCode);
    if (code === null) throw new SetupInvalidError('kitchen is required for a single dish.');
    set('station_code', code);
  }
  if (sets.length > 0) {
    await context.client.query(`UPDATE app.menu_item SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`, values);
  }
  await writeAddOns(context, input.id, input.addOnGroupIds);
  if (item.kind === 'combo' && input.components !== undefined) await writeComponents(context, input.id, input.components);
  // A new kitchen or new add-ons must still route everywhere the item is on sale.
  const listed = await context.client.query<{ branch_id: string }>(
    `SELECT branch_id FROM app.branch_menu_listing WHERE tenant_id = $1 AND menu_item_id = $2 AND listed`,
    [context.tenantId, input.id]);
  for (const row of listed.rows) await assertListable(context, row.branch_id, input.id);
  return menuItemDetail(context, input.id);
}
