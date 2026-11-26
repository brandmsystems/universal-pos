/**
 * The countries a restaurant can be in, and what each one means for how money
 * is SHOWN: its currency, the locale amounts are grouped in, and the clock a
 * new restaurant starts on.
 *
 * Tax law is not here. Which heads a bill carries, which accounts a branch may
 * charge under and how a bill rounds are the API's (modules/tax/jurisdictions.ts),
 * which builds each jurisdiction FROM this entry so the code and name have one
 * copy. Which of these the platform currently OFFERS, and which one a new
 * restaurant form starts on, are platform settings the Super Admin changes.
 */
export interface CountryDefinition {
  /** ISO 3166-1 alpha-2, the same code as `platform.tax_jurisdiction`. */
  readonly code: string;
  readonly name: string;
  /** ISO 4217. What a new restaurant here bills in unless told otherwise. */
  readonly currency: string;
  /** BCP 47, for digit grouping: en-IN writes 1,00,000; en-AE writes 100,000. */
  readonly locale: string;
  /** IANA. Where a new restaurant's business day is counted from. */
  readonly timezone: string;
}

export const COUNTRIES: readonly CountryDefinition[] = [
  { code: 'IN', name: 'India', currency: 'INR', locale: 'en-IN', timezone: 'Asia/Kolkata' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', locale: 'en-AE', timezone: 'Asia/Dubai' },
];

export function countryOf(code: string): CountryDefinition {
  const found = COUNTRIES.find((c) => c.code === code);
  if (found === undefined) throw new Error(`no country has the code ${code}`);
  return found;
}

/**
 * The locale a currency is grouped in. A currency no country here uses (a plan
 * priced in USD) is shown in en-US rather than refused: a console row must still
 * render, and grouping is presentation, never arithmetic.
 */
export function localeForCurrency(currency: string): string {
  return COUNTRIES.find((c) => c.currency === currency)?.locale ?? 'en-US';
}

/** Digits after the point. Not always 2: JPY and KRW have none. */
export function minorExponent(currency: string): number {
  return currency === 'JPY' || currency === 'KRW' ? 0 : 2;
}
