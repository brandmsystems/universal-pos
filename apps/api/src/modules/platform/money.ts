/**
 * Money is integer minor units, always.
 *
 * The exponent is NOT always 2. A hardcoded /100 is correct for INR and USD,
 * silently wrong for JPY (0 decimals) and KWD (3), and there is no way to notice
 * from the number alone -- a JPY price of 1000 displayed as 10.00 looks perfectly
 * plausible. So the exponent is resolved from the currency, every time.
 */

const EXPONENTS: Readonly<Record<string, number>> = {
  // Zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal
  CLF: 4, UYW: 4,
};

const DEFAULT_EXPONENT = 2;

export class UnknownCurrencyError extends Error {
  constructor(currency: string) {
    super(`currency must be a 3-letter ISO 4217 code, got ${JSON.stringify(currency)}`);
    this.name = 'UnknownCurrencyError';
  }
}

export function minorUnitExponent(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new UnknownCurrencyError(currency);
  return EXPONENTS[currency] ?? DEFAULT_EXPONENT;
}

/** Presentation only. Never round-trip money through this. */
export function formatMinor(amountMinor: bigint | number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const value = typeof amountMinor === 'bigint' ? amountMinor : BigInt(Math.trunc(amountMinor));
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0');

  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction} ${currency}`;
}

/**
 * Parses a decimal string into minor units without ever touching a float.
 * "10.5" in a 2-decimal currency is 1050; in JPY it is an error.
 */
export function parseMinor(input: string, currency: string): bigint {
  const exponent = minorUnitExponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) throw new Error(`not a decimal amount: ${JSON.stringify(input)}`);

  const [, sign, whole, fraction = ''] = match as unknown as [string, string, string, string?];
  if (fraction.length > exponent) {
    throw new Error(
      `${currency} has ${exponent} decimal place(s); ${JSON.stringify(input)} has ${fraction.length}`,
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  return BigInt(`${sign}${whole}${padded}`);
}
