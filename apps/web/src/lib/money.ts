/**
 * ###########################################################################
 * MINOR UNITS IN, A FORMATTED STRING OUT, AND NO ARITHMETIC ANYWHERE ELSE.
 *
 * The client never sums lines to display a bill total. The deferred balance
 * trigger is the authority, combo components are priced by largest-remainder
 * allocation, and a client-side sum disagrees by a rupee on exactly the orders
 * that contain a combo and a discount -- in front of the customer, with the
 * printed bill in their hand.
 *
 * So `Minor` is a branded integer with no operators exposed. There is no `add`,
 * no `sum`, no `times`. If a total is needed, the server computed it. The one
 * calculation here is `previewPayment`, a labelled preview of the server's own
 * payment rule that the server's answer replaces.
 * ###########################################################################
 */

import { localeForCurrency, minorExponent } from '@katkitchen/shared';

declare const brand: unique symbol;

export type Minor = number & { readonly [brand]: 'minor' };

export class NotMinorUnitsError extends Error {
  constructor(value: unknown) {
    super(
      `expected an integer number of minor units, got ${JSON.stringify(value)}. ` +
        'A fractional amount means someone has already done arithmetic on it.',
    );
    this.name = 'NotMinorUnitsError';
  }
}

/**
 * The only way to obtain a `Minor`, and it accepts what the API actually sends:
 * money crosses the wire as a STRING, because a paise-precision total in a JSON
 * number is one `Number.MAX_SAFE_INTEGER` conversation away from a rounding bug.
 */
export function minorFrom(value: string | number): Minor {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(parsed)) throw new NotMinorUnitsError(value);
  return parsed as Minor;
}

/**
 * ###########################################################################
 * THE RESTAURANT'S CURRENCY IS SET ONCE, FROM THE LOOKUP EVERY SCREEN WAITS ON.
 *
 * The admin and the till render nothing until `GET /api/public/restaurants/:slug`
 * has answered, and that answer names the currency the restaurant bills in
 * (0084). `setRestaurantMoney` is called there, before any amount is drawn, so
 * the sixty-odd call sites that format a restaurant's money need not each carry
 * it -- and a screen cannot quietly keep its own copy that disagrees. A screen
 * showing ANOTHER currency (a plan's price on the console) passes it explicitly.
 *
 * INR until set: the platform's default country, and what every restaurant
 * billed in before a currency could be chosen.
 * ###########################################################################
 */
let restaurantCurrency = 'INR';
let wholeUnitHeadlines = true;

export function setRestaurantMoney(money: { currency: string; wholeUnitHeadlines: boolean }): void {
  restaurantCurrency = money.currency;
  wholeUnitHeadlines = money.wholeUnitHeadlines;
}

export function currentCurrency(): string {
  return restaurantCurrency;
}

/** The sign for a field label: "₹", "AED". */
export function currencySymbol(currency: string = restaurantCurrency): string {
  return new Intl.NumberFormat(localeForCurrency(currency), { style: 'currency', currency })
    .formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
}

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let found = FORMATTERS.get(currency);
  if (!found) {
    found = new Intl.NumberFormat(localeForCurrency(currency), {
      style: 'currency',
      currency,
      minimumFractionDigits: minorExponent(currency),
    });
    FORMATTERS.set(currency, found);
  }
  return found;
}

/**
 * The single consumer of a `Minor`. Two decimal places is not universal, so the
 * exponent comes from the currency rather than from a hardcoded 100.
 */
export function formatMinor(amount: Minor, currency: string = restaurantCurrency): string {
  return formatter(currency).format(amount / 10 ** minorExponent(currency));
}

/**
 * Minor units as a plain number of whole units (12345 -> 123.45), for a
 * spreadsheet cell that must stay a number a manager can sum. EXPORT ONLY: the
 * screen formats with `formatMinor`, and nothing computes on the result.
 */
export function unitsFromMinor(amount: Minor, currency: string = restaurantCurrency): number {
  return amount / 10 ** minorExponent(currency);
}

/**
 * A figure shown to the nearest whole unit ("₹292.95" -> "₹293"), half up, for
 * a headline the eye reads across a counter. DISPLAY ONLY: what is owed, filled
 * and recorded stays the exact minor units -- this never feeds a payment.
 *
 * Only where bills are paid to the whole unit (India). A UAE bill is paid to the
 * fils, and AED 5.25 headlined as AED 5 would ask the customer for the wrong sum.
 */
export function formatMinorRounded(amount: Minor, currency: string = restaurantCurrency): string {
  if (!wholeUnitHeadlines) return formatMinor(amount, currency);
  const unit = 10 ** minorExponent(currency);
  const whole = Math.sign(amount) * Math.floor((Math.abs(amount) + unit / 2) / unit);
  return new Intl.NumberFormat(localeForCurrency(currency), { style: 'currency', currency, maximumFractionDigits: 0 }).format(whole);
}

export function formatMinorWhole(amount: Minor, currency: string): string {
  try {
    return new Intl.NumberFormat(localeForCurrency(currency), {
      style: 'currency', currency, maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

/**
 * What a cashier typed ("350", "350.5", "350.50"), as minor units -- or null
 * for anything that is not a plain amount with at most two decimals. Parsed
 * as text, never through a float, so "0.29" is 29 and not 28.999.
 */
export function minorFromTyped(text: string): Minor | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  return Number.parseInt(match[1]! + (match[2] ?? '').padEnd(2, '0'), 10) as Minor;
}

/** A server figure put back into an input box ("350.00"), the inverse of `minorFromTyped`. */
export function typedFromMinor(amount: Minor): string {
  return (amount / 100).toFixed(2);
}

export interface PreviewPart {
  readonly method: string;
  /** A non-cash part: what it pays. */
  readonly amountMinor?: Minor;
  /** The cash part: the note handed over. */
  readonly cashReceivedMinor?: Minor;
}

export type PaymentPreview =
  | {
    readonly state: 'applies';
    readonly lines: readonly { readonly method: string; readonly appliedMinor: Minor }[];
    /** What this payment takes off the bill: every part as applied, change excluded. */
    readonly addedMinor: Minor;
    readonly balanceAfterMinor: Minor;
    readonly changeMinor: Minor;
  }
  | {
    readonly state: 'refused';
    readonly method: string;
    /** exceeds_balance: a non-cash part above what is left; already_paid: cash with nothing left to pay. */
    readonly reason: 'exceeds_balance' | 'already_paid';
    readonly leftMinor: Minor;
  };

/**
 * A PREVIEW of one payment against a balance, while the cashier types -- never
 * the record; the server's answer replaces it. It mirrors `takePayment`:
 * non-cash parts first, in the order given, each refused (not capped) above what
 * is left; then the one cash note pays what is left and anything over is change.
 * Integer minor units throughout.
 */
export function previewPayment(balance: Minor, parts: readonly PreviewPart[]): PaymentPreview {
  let left: number = balance;
  let added = 0;
  let change = 0;
  const lines: { method: string; appliedMinor: Minor }[] = [];
  const ordered = [...parts.filter((p) => p.method !== 'cash'), ...parts.filter((p) => p.method === 'cash')];
  for (const part of ordered) {
    let applied: number;
    if (part.method === 'cash' && part.cashReceivedMinor !== undefined) {
      if (left <= 0) return { state: 'refused', method: part.method, reason: 'already_paid', leftMinor: left as Minor };
      applied = Math.min(part.cashReceivedMinor, left);
      change += part.cashReceivedMinor - applied;
    } else {
      applied = part.amountMinor ?? 0;
      if (applied > left) return { state: 'refused', method: part.method, reason: 'exceeds_balance', leftMinor: left as Minor };
    }
    left -= applied;
    added += applied;
    lines.push({ method: part.method, appliedMinor: applied as Minor });
  }
  return { state: 'applies', lines, addedMinor: added as Minor, balanceAfterMinor: left as Minor, changeMinor: change as Minor };
}
