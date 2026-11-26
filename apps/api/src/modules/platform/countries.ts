import type pg from 'pg';
import { adoptTenantContext } from '../../core/database/unitOfWork.js';
import type { TenantContext } from '../../core/database/tenantContext.js';
import { JURISDICTIONS, type JurisdictionDefinition } from '../tax/jurisdictions.js';
import { jurisdiction } from '../tax/registry.js';
import { defaultTaxClassesFor } from '../tax/taxClasses.js';
import { seedTaxClasses } from '../tax/taxClassSeed.js';
import { TenantUnknownError } from './tenantAdmin.js';

/**
 * Which countries a restaurant may be in, and moving one between them.
 *
 * ###########################################################################
 * THE COUNTRY DECIDES THE LAW; THE SETTINGS DECIDE WHAT IS OFFERED.
 *
 * What a country MEANS -- its currency, its tax accounts, its heads, how its
 * bills round, its starting tax rates -- is code (modules/tax/jurisdictions.ts
 * and the shared country entry), because a Super Admin typing a rule is a bill
 * taxed under a law nobody wrote. What the platform OFFERS -- which of those
 * countries a new restaurant may pick, which one the form starts on, whether a
 * Sales person may move a restaurant -- is `platform.platform_setting`, changed
 * by `platform.settings.edit` and recorded in the platform audit log.
 * ###########################################################################
 *
 * ###########################################################################
 * A COUNTRY CHANGES ONLY UNTIL THE FIRST BILL, AND NEVER BY ITSELF.
 *
 * After a bill exists the restaurant's history is in one currency under one
 * law, and a move would put a second beside it in every report. So a move is a
 * set-up correction (`country_locked_after_billing` after that), it is refused
 * while any order is open, and it is two steps: a preview that changes nothing
 * and a confirmed request that must say `confirm: true`.
 *
 * Prices are NEVER converted unless the request names a rate. Without one,
 * 250.00 stays 250.00 in the new currency and the preview says so; with one,
 * every catalogue price, add-on delta, branch price, parcel charge and custom-role discount
 * cap is multiplied by it in the same transaction. Order lines, bills, tenders
 * and the stock ledger are records and are never touched.
 * ###########################################################################
 */

const SETTING_DEFAULT = 'country.default';
const SETTING_OFFERED = 'country.offered';
const SETTING_SALES = 'country.sales_may_change';

export class CountrySettingsInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'country_settings_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'CountrySettingsInvalidError';
  }
}

export class CountryNotOfferedError extends Error {
  readonly statusCode = 422;
  readonly code = 'country_not_offered';
  constructor(country: string, offered: readonly string[]) {
    super(`${country} is not offered. The platform offers ${offered.join(', ')}; a Super Admin changes that in platform settings.`);
    this.name = 'CountryNotOfferedError';
  }
}

export class CurrencyNotOfferedError extends Error {
  readonly statusCode = 422;
  readonly code = 'currency_not_offered';
  constructor(currency: string, offered: readonly string[]) {
    super(`${currency} is not a currency of an offered country. Choose one of ${offered.join(', ')}.`);
    this.name = 'CurrencyNotOfferedError';
  }
}

export class CountryChangeInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'country_change_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'CountryChangeInvalidError';
  }
}

export class CountryChangeNotPermittedError extends Error {
  readonly statusCode = 403;
  readonly code = 'country_change_not_permitted';
  constructor() {
    super('a Super Admin has not allowed Sales to change a restaurant\'s country. Ask a Super Admin to make the change, or to allow it in platform settings.');
    this.name = 'CountryChangeNotPermittedError';
  }
}

export class CountryLockedAfterBillingError extends Error {
  readonly statusCode = 409;
  readonly code = 'country_locked_after_billing';
  constructor(readonly bills: number) {
    super(`this restaurant has issued ${bills} bill(s), so its country and currency are fixed: its records must stay in one currency under one tax law. A restaurant moving country is set up as a new restaurant.`);
    this.name = 'CountryLockedAfterBillingError';
  }
}

export class CountryChangeWhileOrdersOpenError extends Error {
  readonly statusCode = 409;
  readonly code = 'country_change_while_orders_open';
  constructor(readonly openOrders: number) {
    super(`${openOrders} order(s) are open at this restaurant. Finish or cancel them, then change its country.`);
    this.name = 'CountryChangeWhileOrdersOpenError';
  }
}

export class CountryChangeUnconfirmedError extends Error {
  readonly statusCode = 409;
  readonly code = 'country_change_unconfirmed';
  constructor() {
    super('changing a restaurant\'s country and currency must be confirmed: read the preview, then send confirm: true.');
    this.name = 'CountryChangeUnconfirmedError';
  }
}

/* -------------------------------------------------------------- settings --- */

export interface CountryOffer {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly locale: string;
  readonly timezone: string;
  /** False for a country whose tax rules are declared but not written: no bill can be raised there. */
  readonly billable: boolean;
  readonly offered: boolean;
}

export interface CountrySettings {
  readonly countries: readonly CountryOffer[];
  readonly defaultCountry: string;
  /** The currencies of the offered countries: what a restaurant may bill in. */
  readonly currencies: readonly string[];
  readonly salesMayChangeCountry: boolean;
}

const CATALOGUE_CODES = JURISDICTIONS.map((j) => j.code);

function currenciesOf(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => jurisdiction(code).currency))];
}

export async function readCountrySettings(client: pg.ClientBase): Promise<CountrySettings> {
  const rows = await client.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM platform.platform_setting WHERE key = ANY($1::text[])`,
    [[SETTING_DEFAULT, SETTING_OFFERED, SETTING_SALES]]);
  const stored = new Map(rows.rows.map((r) => [r.key, r.value]));
  const offeredRaw = stored.get(SETTING_OFFERED);
  const defaultRaw = stored.get(SETTING_DEFAULT);
  // No fallback to India. A missing or corrupt setting is the migration not
  // having run, and answering it would let a form offer what nobody chose.
  if (!Array.isArray(offeredRaw) || typeof defaultRaw !== 'string') {
    throw new Error('platform settings country.offered / country.default are missing or malformed');
  }
  const offered = offeredRaw.filter((c): c is string => typeof c === 'string' && CATALOGUE_CODES.includes(c));
  return {
    countries: JURISDICTIONS.map((j) => ({
      code: j.code, name: j.name, currency: j.currency, locale: j.locale, timezone: j.timezone,
      billable: j.status === 'implemented', offered: offered.includes(j.code),
    })),
    defaultCountry: defaultRaw,
    currencies: currenciesOf(offered),
    salesMayChangeCountry: stored.get(SETTING_SALES) === true,
  };
}

/**
 * The Super Admin's change. Every field optional, but what results must hold
 * together: at least one country offered, the default among them. A country
 * that restaurants are already in may be withdrawn -- that stops NEW
 * restaurants choosing it and moves nobody.
 */
export async function setCountrySettings(
  client: pg.ClientBase,
  input: { offered?: unknown; defaultCountry?: unknown; salesMayChangeCountry?: unknown },
): Promise<CountrySettings> {
  const current = await readCountrySettings(client);
  let offered = current.countries.filter((c) => c.offered).map((c) => c.code);
  if (input.offered !== undefined) {
    if (!Array.isArray(input.offered) || input.offered.some((c) => typeof c !== 'string')) {
      throw new CountrySettingsInvalidError('offered is a list of country codes, e.g. ["IN", "AE"].');
    }
    const unknown = (input.offered as string[]).filter((c) => !CATALOGUE_CODES.includes(c));
    if (unknown.length > 0) {
      throw new CountrySettingsInvalidError(`not a country this product knows: ${unknown.join(', ')}. Known: ${CATALOGUE_CODES.join(', ')}.`);
    }
    offered = [...new Set(input.offered as string[])];
  }
  if (offered.length === 0) throw new CountrySettingsInvalidError('offer at least one country.');
  let defaultCountry = current.defaultCountry;
  if (input.defaultCountry !== undefined) {
    if (typeof input.defaultCountry !== 'string') throw new CountrySettingsInvalidError('defaultCountry is a country code.');
    defaultCountry = input.defaultCountry;
  }
  if (!offered.includes(defaultCountry)) {
    throw new CountrySettingsInvalidError(`the default country (${defaultCountry}) must be one of the offered countries (${offered.join(', ')}).`);
  }
  if (input.salesMayChangeCountry !== undefined && typeof input.salesMayChangeCountry !== 'boolean') {
    throw new CountrySettingsInvalidError('salesMayChangeCountry is true or false.');
  }
  const sales = input.salesMayChangeCountry ?? current.salesMayChangeCountry;

  for (const [key, value] of [
    [SETTING_OFFERED, offered], [SETTING_DEFAULT, defaultCountry], [SETTING_SALES, sales],
  ] as const) {
    await client.query(
      `UPDATE platform.platform_setting SET value = $2::jsonb, updated_at = now() WHERE key = $1`,
      [key, JSON.stringify(value)]);
  }
  return readCountrySettings(client);
}

/**
 * A country and currency a restaurant may be CREATED in or MOVED to: the
 * country offered, the currency one an offered country uses. The currency
 * defaults to the country's own.
 */
export async function offeredCountry(
  client: pg.ClientBase,
  country: unknown,
  currency: unknown,
): Promise<{ regime: JurisdictionDefinition; currency: string }> {
  const settings = await readCountrySettings(client);
  const offered = settings.countries.filter((c) => c.offered).map((c) => c.code);
  if (typeof country !== 'string' || !offered.includes(country)) {
    throw new CountryNotOfferedError(typeof country === 'string' ? country : String(country), offered);
  }
  const regime = jurisdiction(country);
  const chosen = currency === undefined || currency === null || currency === '' ? regime.currency : currency;
  if (typeof chosen !== 'string' || !settings.currencies.includes(chosen)) {
    throw new CurrencyNotOfferedError(String(chosen), settings.currencies);
  }
  return { regime, currency: chosen };
}

/* ------------------------------------------------------- the conversion --- */

/**
 * ###########################################################################
 * EVERY MONEY COLUMN IN SCHEMA app IS IN EXACTLY ONE OF THESE TWO LISTS.
 *
 * `tests/platform/countryChange.test.ts` reads information_schema for every
 * `_minor`, `_micro` and `_cap` column and refuses one in neither list or in
 * both -- so a price column added later cannot be silently left in rupees by a
 * conversion that never heard of it.
 * ###########################################################################
 *
 * CONVERTED is ordered: a branch price may only RAISE the catalogue price it
 * pins by cascading FK, so for a rate of 1 or more the branch price moves up
 * first, and for a rate under 1 the catalogue moves down first -- the list is
 * walked in reverse. Rounding is monotonic, so the may-only-raise CHECK and the
 * parcel default-within-max CHECK hold after every statement.
 */
export const CONVERTED_MONEY_COLUMNS: readonly {
  table: string; columns: readonly string[]; minimumOne?: true;
  /** Rows of the table the conversion may touch, beyond this restaurant's. */
  rows?: string;
}[] = [
  { table: 'branch_menu_price', columns: ['price_minor'] },
  { table: 'menu_item', columns: ['price_minor'] },
  { table: 'modifier_option', columns: ['price_delta_minor'] },
  { table: 'combo_choice_option', columns: ['price_delta_minor'] },
  { table: 'branch', columns: ['parcel_charge_max_minor', 'parcel_charge_default_minor'] },
  // `role_discount_amount_cap_positive`: a cap converted to 0 would read as no
  // ceiling at all, so it rounds to at least one minor unit. Custom roles only:
  // a system role is locked, and its cap is the seed's, reconciled on deploy.
  { table: 'role', columns: ['discount_amount_cap'], minimumOne: true, rows: 'is_system = false' },
  { table: 'supplier_product', columns: ['list_price_minor'] },
];

/** Columns a conversion never touches, each with why. */
export const KEPT_MONEY_COLUMNS: Readonly<Record<string, string>> = {
  'branch_menu_price.catalogue_price_minor': 'follows menu_item.price_minor by its ON UPDATE CASCADE pin',
  'role.discount_percent_cap': 'a percentage, not an amount',
  'branch_premises_class.declared_tariff_minor': 'an Indian GST declaration for a financial year, a statement of fact',
  'bill.subtotal_minor': 'a record', 'bill.tax_minor': 'a record', 'bill.total_minor': 'a record',
  'bill.round_off_minor': 'a record', 'bill.payable_minor': 'a record (generated)',
  'bill_line.amount_minor': 'a record', 'bill_line.tax_minor': 'a record',
  'order_line.unit_price_minor': 'a snapshot', 'order_line.line_total_minor': 'a snapshot',
  'order_line.display_total_minor': 'a snapshot', 'order_line.adjusted_unit_price_minor': 'a snapshot',
  'tender.amount_minor': 'a record', 'tender.cash_received_minor': 'a record', 'tender.rounding_minor': 'a record',
  'refund.amount_minor': 'a record', 'refund.tax_minor': 'a record', 'refund.taxable_minor': 'a record',
  // Day end and bill edits (0086): what was handed over, and the bill before and after an edit.
  'day_submission.sales_minor': 'a record', 'day_submission.tax_minor': 'a record',
  'day_submission.payable_minor': 'a record', 'day_submission.collected_minor': 'a record',
  'day_submission.refunded_minor': 'a record',
  'bill_revision.before_payable_minor': 'a record', 'bill_revision.after_payable_minor': 'a record',
  'goods_receipt_line.unit_price_minor': 'a record', 'goods_receipt_line.line_total_minor': 'a record',
  'purchase_order_line.unit_price_minor': 'a record', 'purchase_order_line.line_total_minor': 'a record',
  'stock_balance.value_micro': 'the fold of the stock ledger', 'stock_balance.last_unit_cost_micro': 'the fold of the stock ledger',
  'stock_balance.unbacked_value_micro': 'the fold of the stock ledger', 'stock_movement.value_micro': 'the stock ledger',
};

/** The rows of an entry a conversion changes: a non-zero amount, in rows it may touch. */
function convertible(entry: (typeof CONVERTED_MONEY_COLUMNS)[number]): string {
  const amounts = `(${entry.columns.map((c) => `${c} <> 0`).join(' OR ')})`;
  return entry.rows === undefined ? amounts : `${amounts} AND ${entry.rows}`;
}

/** A typed rate: a plain decimal above zero, at most six places. Kept as text so it never passes through a float. */
function parseRate(rate: unknown): string | null {
  if (rate === undefined || rate === null || rate === '') return null;
  const text = typeof rate === 'number' ? String(rate) : rate;
  if (typeof text !== 'string' || !/^\d{1,7}(\.\d{1,6})?$/.test(text.trim()) || Number(text) <= 0) {
    throw new CountryChangeInvalidError('rate is how many of the new currency one unit of the old buys, e.g. 0.044 -- a number above zero with at most six decimal places.');
  }
  return text.trim();
}

function parseTimezone(timezone: unknown, fallback: string): string {
  if (timezone === undefined || timezone === null || timezone === '') return fallback;
  if (typeof timezone !== 'string') throw new CountryChangeInvalidError('timezone is an IANA name, e.g. Asia/Dubai.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new CountryChangeInvalidError(`${timezone} is not a timezone. Use an IANA name, e.g. Asia/Dubai.`);
  }
  return timezone;
}

/* ------------------------------------------------------------ the change --- */

export interface CountryChangeActor {
  readonly platformUserId: string;
  /** Holds `platform.tenant.country.any`: every restaurant, whatever the Sales setting says. */
  readonly anyRestaurant: boolean;
}

export interface CountryChangeRequest {
  readonly country?: unknown;
  readonly currency?: unknown;
  readonly timezone?: unknown;
  readonly rate?: unknown;
  readonly confirm?: unknown;
}

interface Resolved {
  readonly context: TenantContext;
  readonly from: { country: string; currency: string; timezone: string };
  readonly to: { country: string; currency: string; timezone: string };
  readonly regime: JurisdictionDefinition;
  readonly rate: string | null;
}

async function resolveChange(
  client: pg.ClientBase,
  actor: CountryChangeActor,
  tenantId: string,
  input: CountryChangeRequest,
  lock: boolean,
): Promise<Resolved> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TenantUnknownError(tenantId);
  if (!actor.anyRestaurant && !(await readCountrySettings(client)).salesMayChangeCountry) {
    throw new CountryChangeNotPermittedError();
  }
  // Outside the actor's book is UNKNOWN, as the edit answers it.
  const found = await client.query<{ tax_jurisdiction: string; default_currency: string; default_timezone: string }>(
    `SELECT t.tax_jurisdiction, t.default_currency, t.default_timezone
       FROM platform.tenant t
      WHERE t.id = $1
        AND ($2::boolean OR EXISTS (SELECT 1 FROM platform.provisioning_request pr
                                     WHERE pr.tenant_id = t.id AND pr.requested_by_platform_user_id = $3))
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [tenantId, actor.anyRestaurant, actor.platformUserId]);
  const row = found.rows[0];
  if (!row) throw new TenantUnknownError(tenantId);

  const { regime, currency } = await offeredCountry(client, input.country, input.currency);
  const timezone = parseTimezone(input.timezone, regime.code === row.tax_jurisdiction ? row.default_timezone : regime.timezone);
  const rate = parseRate(input.rate);
  if (rate !== null && currency === row.default_currency) {
    throw new CountryChangeInvalidError('a rate converts prices into a new currency; the currency is not changing, so send no rate.');
  }
  if (regime.code === row.tax_jurisdiction && currency === row.default_currency && timezone === row.default_timezone) {
    throw new CountryChangeInvalidError('nothing to change: that is already this restaurant\'s country, currency and timezone.');
  }

  const context = await adoptTenantContext(client, tenantId);
  const bills = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.bill WHERE tenant_id = $1`, [tenantId]);
  if (Number(bills.rows[0]!.n) > 0) throw new CountryLockedAfterBillingError(Number(bills.rows[0]!.n));

  // Every branch row locked before the open-order count: `openSession` reads the
  // branch FOR SHARE, so an order opening now waits for this transaction and
  // then prices under the new settings -- and with no open order there is no
  // bill that can be raised under the old ones while this runs.
  if (lock) {
    await client.query(`SELECT id FROM app.branch WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
  }
  const open = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.table_session WHERE tenant_id = $1 AND status = 'open'`, [tenantId]);
  if (Number(open.rows[0]!.n) > 0) throw new CountryChangeWhileOrdersOpenError(Number(open.rows[0]!.n));

  return {
    context,
    from: { country: row.tax_jurisdiction, currency: row.default_currency, timezone: row.default_timezone },
    to: { country: regime.code, currency, timezone },
    regime,
    rate,
  };
}

export interface CountryChangePreview {
  readonly from: { country: string; currency: string; timezone: string };
  readonly to: { country: string; currency: string; timezone: string };
  readonly rate: string | null;
  /** Rows a conversion would change, per table; all zero without a rate. */
  readonly converted: Readonly<Record<string, number>>;
  /** Up to five dishes, before and after, in minor units. */
  readonly samples: readonly { name: string; priceMinor: string; newPriceMinor: string }[];
  /** The new country's starting tax rates; dishes move to the one with the same rate, else the first. */
  readonly taxClasses: readonly { key: string; name: string; rateBps: number }[];
  readonly itemsRetaxed: number;
  readonly taxAccount: string;
}

/** What a change WOULD do. Writes nothing; refused for the same reasons the change is. */
export async function previewCountryChange(
  client: pg.ClientBase,
  actor: CountryChangeActor,
  tenantId: string,
  input: CountryChangeRequest,
): Promise<CountryChangePreview> {
  const resolved = await resolveChange(client, actor, tenantId, input, false);
  const { context, rate } = resolved;
  const converted: Record<string, number> = {};
  for (const entry of CONVERTED_MONEY_COLUMNS) {
    const count = rate === null ? 0 : Number((await context.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.${entry.table}
        WHERE tenant_id = $1 AND ${convertible(entry)}`,
      [tenantId])).rows[0]!.n);
    converted[entry.table] = count;
  }
  const samples = await context.client.query<{ name: string; price_minor: string; new_price_minor: string }>(
    `SELECT name, price_minor::text,
            (CASE WHEN $2::numeric IS NULL THEN price_minor ELSE round(price_minor * $2::numeric) END)::bigint::text AS new_price_minor
       FROM app.menu_item WHERE tenant_id = $1 AND status = 'active'
      ORDER BY name LIMIT 5`,
    [tenantId, rate]);
  const plan = await retaxPlan(context, resolved.from.country, resolved.regime.code);
  return {
    from: resolved.from, to: resolved.to, rate, converted,
    samples: samples.rows.map((r) => ({ name: r.name, priceMinor: r.price_minor, newPriceMinor: r.new_price_minor })),
    taxClasses: defaultTaxClassesFor(resolved.regime.code),
    itemsRetaxed: plan.items,
    taxAccount: resolved.regime.defaultAccount,
  };
}

/**
 * The old country's starting classes the new one does not share: dishes on
 * them are re-taxed, and they are archived. One copy for preview and change.
 */
function retiredTaxKeys(from: string, to: string): string[] {
  if (from === to) return [];
  const keep = defaultTaxClassesFor(to).map((c) => c.key);
  return defaultTaxClassesFor(from).map((c) => c.key).filter((k) => !keep.includes(k));
}

async function retaxPlan(context: TenantContext, from: string, to: string): Promise<{ items: number }> {
  const found = await context.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.menu_item mi
       JOIN app.tax_class tc ON tc.tenant_id = mi.tenant_id AND tc.id = mi.tax_class_id
      WHERE mi.tenant_id = $1 AND tc.key = ANY($2::text[])`,
    [context.tenantId, retiredTaxKeys(from, to)]);
  return { items: Number(found.rows[0]!.n) };
}

export interface CountryChangeResult {
  readonly tenantId: string;
  readonly from: { country: string; currency: string; timezone: string };
  readonly to: { country: string; currency: string; timezone: string };
  readonly rate: string | null;
  readonly converted: Readonly<Record<string, number>>;
  readonly taxClassesSeeded: readonly string[];
  readonly itemsRetaxed: number;
  readonly branchesUpdated: number;
}

export async function changeTenantCountry(
  client: pg.ClientBase,
  actor: CountryChangeActor,
  tenantId: string,
  input: CountryChangeRequest,
): Promise<CountryChangeResult> {
  if (input.confirm !== true) throw new CountryChangeUnconfirmedError();
  const resolved = await resolveChange(client, actor, tenantId, input, true);
  const { context, regime, rate, from, to } = resolved;
  const q = context.client;

  // 1. Prices, only when a rate was named. See CONVERTED_MONEY_COLUMNS.
  const converted: Record<string, number> = {};
  if (rate !== null) {
    const ordered = Number(rate) >= 1 ? CONVERTED_MONEY_COLUMNS : [...CONVERTED_MONEY_COLUMNS].reverse();
    for (const entry of ordered) {
      const sets = entry.columns.map((c) => entry.minimumOne
        ? `${c} = CASE WHEN ${c} IS NULL THEN NULL ELSE GREATEST(1, round(${c} * $2::numeric))::bigint END`
        : `${c} = round(${c} * $2::numeric)::bigint`);
      const updated = await q.query(
        `UPDATE app.${entry.table} SET ${sets.join(', ')}
          WHERE tenant_id = $1 AND ${convertible(entry)}`,
        [tenantId, rate]);
      converted[entry.table] = updated.rowCount ?? 0;
    }
  }

  // 2. The new country's starting rates, live again if a past move archived
  // them; dishes and parcel charges on any class the new country does not start
  // with move to its class at the same rate, else its first (standard) one; the
  // old country's starting classes, now unused, are archived. A class the owner
  // made themselves is a rate, valid anywhere, and is left alone.
  const classes = defaultTaxClassesFor(regime.code);
  const keys = classes.map((c) => c.key);
  const seeded = await seedTaxClasses(q, tenantId, regime.code);
  await q.query(
    `UPDATE app.tax_class SET status = 'active' WHERE tenant_id = $1 AND key = ANY($2::text[]) AND status <> 'active'`,
    [tenantId, keys]);
  const oldKeys = retiredTaxKeys(from.country, regime.code);
  const target = `(SELECT n.id FROM app.tax_class n
                    WHERE n.tenant_id = $1 AND n.key = ANY($3::text[])
                    ORDER BY (n.rate_bps = o.rate_bps) DESC, array_position($3::text[], n.key)
                    LIMIT 1)`;
  const retaxed = await q.query(
    `UPDATE app.menu_item mi SET tax_class_id = ${target}
       FROM app.tax_class o
      WHERE mi.tenant_id = $1 AND o.tenant_id = mi.tenant_id AND o.id = mi.tax_class_id
        AND o.key = ANY($2::text[])`,
    [tenantId, oldKeys, keys]);
  await q.query(
    `UPDATE app.branch b SET parcel_charge_tax_class_id = ${target}
       FROM app.tax_class o
      WHERE b.tenant_id = $1 AND o.tenant_id = b.tenant_id AND o.id = b.parcel_charge_tax_class_id
        AND o.key = ANY($2::text[])`,
    [tenantId, oldKeys, keys]);
  await q.query(
    `UPDATE app.tax_class SET status = 'archived' WHERE tenant_id = $1 AND key = ANY($2::text[])`,
    [tenantId, oldKeys]);

  // 3. Every branch charges under the new country's default account, on its
  // clock; a registration number belongs to the old country's authority.
  const branches = from.country === regime.code
    ? await q.query(`UPDATE app.branch SET timezone = $2 WHERE tenant_id = $1`, [tenantId, to.timezone])
    : await q.query(
      `UPDATE app.branch SET tax_account_type = $2, tax_registration_no = NULL, timezone = $3
        WHERE tenant_id = $1`,
      [tenantId, regime.defaultAccount, to.timezone]);

  // 4. The restaurant root, last: what every bill, print and screen reads.
  await client.query(
    `UPDATE platform.tenant SET tax_jurisdiction = $2, default_currency = $3, default_timezone = $4 WHERE id = $1`,
    [tenantId, to.country, to.currency, to.timezone]);

  return {
    tenantId, from, to, rate, converted,
    taxClassesSeeded: seeded, itemsRetaxed: retaxed.rowCount ?? 0, branchesUpdated: branches.rowCount ?? 0,
  };
}
