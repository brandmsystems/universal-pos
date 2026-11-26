import type { TenantContext } from '../../core/database/tenantContext.js';
import { UnknownBillingBranchError } from '../payments/billing.js';
import { TAX_ACCOUNTS, type TaxAccount } from './jurisdictions.js';
import { TaxAccountNotOfferedError } from './registry.js';
import { tenantRegime } from './tenantRegime.js';

/**
 * How a branch charges tax (0083): on or off, under which account, forward or
 * reverse, and the VAT / other-tax registration number its bills print.
 *
 * ###########################################################################
 * ITS OWN ROUTE, NOT THE GENERIC BRANCH EDIT -- FOR THE GST POSITION'S REASON.
 *
 * These decide what a diner is charged, so they sit behind `tax.setting.edit`
 * (financial, configuration) and are REFUSED WHILE THE BRANCH HAS AN OPEN
 * ORDER. An order snapshots the mode when it opens and its lines snapshot their
 * rates when added; a change mid-order would leave lines priced under one
 * account billed under another. Refusing it is what makes every order priced
 * under one setting from first line to bill. `openSession` reads the mode under
 * a FOR SHARE on the branch row, so a change racing an opening order waits for
 * it or is seen by it, never half of each.
 *
 * The GST number keeps its own column and its own rules (`branch.gstin`); this
 * number is the VAT or other-tax one, refused on a GST or NONE account rather
 * than stored where nothing would print it.
 * ###########################################################################
 */

export type TaxCalculationMode = 'forward' | 'reverse';

export interface BranchTaxSettings {
  readonly branchId: string;
  readonly taxEnabled: boolean;
  readonly taxAccountType: TaxAccount;
  readonly taxCalculationMode: TaxCalculationMode;
  readonly taxRegistrationNo: string | null;
}

const FIELDS = ['taxEnabled', 'taxAccountType', 'taxCalculationMode', 'taxRegistrationNo'] as const;
const MODES: readonly TaxCalculationMode[] = ['forward', 'reverse'];
/** As `branch_tax_registration_no_format`; asked here so the answer is a sentence. */
const REGISTRATION_NO = /^[A-Z0-9][A-Z0-9 /-]{2,28}[A-Z0-9]$/;

export class TaxSettingsInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'tax_settings_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'TaxSettingsInvalidError';
  }
}

export class TaxSettingsWhileOrdersOpenError extends Error {
  readonly statusCode = 409;
  readonly code = 'tax_settings_while_orders_open';
  constructor(readonly openOrders: number) {
    super(`${openOrders} order(s) are open at this branch. Finish or cancel them, then change how tax is charged.`);
    this.name = 'TaxSettingsWhileOrdersOpenError';
  }
}

/** The four settings from a request body, every one required: a half-stated tax setting is refused, not merged. */
export function parseTaxSettings(input: unknown): Omit<BranchTaxSettings, 'branchId'> {
  const raw = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new TaxSettingsInvalidError(`not a tax setting: ${unknown.join(', ')}`);
  if (typeof raw['taxEnabled'] !== 'boolean') throw new TaxSettingsInvalidError('say whether tax is on: taxEnabled true or false');
  if (!TAX_ACCOUNTS.includes(raw['taxAccountType'] as TaxAccount)) {
    throw new TaxSettingsInvalidError(`choose a tax account: ${TAX_ACCOUNTS.join(', ')}`);
  }
  if (!MODES.includes(raw['taxCalculationMode'] as TaxCalculationMode)) {
    throw new TaxSettingsInvalidError('choose a calculation mode: forward or reverse');
  }
  const account = raw['taxAccountType'] as TaxAccount;
  const typed = raw['taxRegistrationNo'];
  if (typed !== undefined && typed !== null && typeof typed !== 'string') {
    throw new TaxSettingsInvalidError('send the registration number as text, or null');
  }
  const number = typeof typed === 'string' && typed.trim() !== '' ? typed.trim().toUpperCase() : null;
  if (number !== null && account !== 'vat' && account !== 'others') {
    throw new TaxSettingsInvalidError('a VAT or tax registration number goes with the VAT or OTHERS account; a GSTIN is set with the GST position');
  }
  if (number !== null && !REGISTRATION_NO.test(number)) {
    throw new TaxSettingsInvalidError('a registration number is 4 to 30 letters, digits, spaces, slashes or hyphens');
  }
  return {
    taxEnabled: raw['taxEnabled'],
    taxAccountType: account,
    taxCalculationMode: raw['taxCalculationMode'] as TaxCalculationMode,
    taxRegistrationNo: number,
  };
}

export async function setBranchTaxSettings(
  context: TenantContext,
  branchId: string,
  input: unknown,
): Promise<BranchTaxSettings> {
  const settings = parseTaxSettings(input);
  const regime = await tenantRegime(context.client, context.tenantId);
  if (!regime.accounts.includes(settings.taxAccountType)) {
    throw new TaxAccountNotOfferedError(settings.taxAccountType, regime);
  }

  const branch = await context.client.query(
    `SELECT id FROM app.branch WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [context.tenantId, branchId],
  );
  if (branch.rowCount !== 1) throw new UnknownBillingBranchError(branchId);

  const open = await context.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.table_session
      WHERE tenant_id = $1 AND branch_id = $2 AND status = 'open'`,
    [context.tenantId, branchId],
  );
  const openOrders = Number(open.rows[0]!.n);
  if (openOrders > 0) throw new TaxSettingsWhileOrdersOpenError(openOrders);

  await context.client.query(
    `UPDATE app.branch
        SET tax_enabled = $3, tax_account_type = $4, tax_calculation_mode = $5, tax_registration_no = $6
      WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, branchId, settings.taxEnabled, settings.taxAccountType,
      settings.taxCalculationMode, settings.taxRegistrationNo],
  );
  return { branchId, ...settings };
}
