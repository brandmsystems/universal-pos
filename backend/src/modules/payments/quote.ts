import type { TenantContext } from '../../core/database/tenantContext.js';
import {
  ParcelChargeNotParcelError, priceParcelCharge, priceRequestedLine, type PriceLineRequest, type PricedAmount,
} from '../orders/orderEntry.js';
import { lineTax, splitHeads } from '../tax/taxHeads.js';
import type { TaxAccount } from '../tax/jurisdictions.js';
import { branchTaxTerms, roundOffFor, restaurantSupply } from './billing.js';

/**
 * What an order being composed would come to, before it exists.
 *
 * ###########################################################################
 * AN ESTIMATE, AND THE SERVER'S -- NEVER THE TILL'S.
 *
 * The order screen used to show no total at all ("the total, with tax, is
 * worked out on the bill"), because a sum on the client is a second opinion
 * about money. A parcel charge typed at the till made a figure before Confirm
 * worth having, so the figure is computed HERE, from the same pieces the bill
 * will be made of: each dish through `priceRequestedLine` (the resolution
 * `addLine` writes with), the charge through `priceParcelCharge` (the cap and
 * rate `setParcelCharge` writes with), tax per piece with `lineTax` under the
 * branch's own mode and account, and the heads with `splitHeads` -- the bill's
 * own functions. Nothing is written and no number is taken.
 *
 * It can still differ from the bill, and is labelled an estimate for that:
 * a dish that sells out, a price edited, between the estimate and Confirm.
 * The bill is the record.
 * ###########################################################################
 */

export interface QuoteRequest {
  readonly branchId: string;
  readonly parcel: boolean;
  readonly lines: readonly PriceLineRequest[];
  /** A parcel's charge; absent means the branch's default. */
  readonly parcelChargeMinor?: number | null;
}

export interface QuoteTax {
  readonly name: string;
  readonly rateBps: number;
  readonly amountMinor: number;
}

export interface Quote {
  /** The dishes at their prices -- which include tax when `pricesIncludeTax`. */
  readonly itemsMinor: number;
  readonly parcelChargeMinor: number;
  /** The taxable value: items plus the charge, less any tax already inside them. */
  readonly subtotalMinor: number;
  readonly taxes: readonly QuoteTax[];
  readonly taxMinor: number;
  /** Subtotal + tax. */
  readonly totalMinor: number;
  /** To the nearest rupee, as the bill will be (0082). */
  readonly roundOffMinor: number;
  /** What the customer will pay: total + round off. */
  readonly payableMinor: number;
  /** The branch's terms, so the till can fill in the default and say the cap. Null on dine-in. */
  readonly parcelCharge: { readonly defaultMinor: number; readonly maxMinor: number } | null;
  /** Reverse mode (0083): the prices already include the tax shown. */
  readonly pricesIncludeTax: boolean;
  /** Which tax the branch charges; 'none' when tax is off. */
  readonly taxAccount: TaxAccount;
}

export async function quoteOrder(context: TenantContext, request: QuoteRequest): Promise<Quote> {
  const items: PricedAmount[] = [];
  for (const line of request.lines) items.push(...await priceRequestedLine(context, request.branchId, line));

  let charge: PricedAmount | null = null;
  let chargeTerms: Quote['parcelCharge'] = null;
  if (request.parcel) {
    const priced = await priceParcelCharge(context, request.branchId, request.parcelChargeMinor ?? null);
    charge = priced.charge;
    chargeTerms = { defaultMinor: priced.defaultMinor, maxMinor: priced.maxMinor };
  } else if ((request.parcelChargeMinor ?? 0) !== 0) {
    throw new ParcelChargeNotParcelError('');
  }

  const pieces = charge === null ? items : [...items, charge];
  const terms = await branchTaxTerms(context, request.branchId);
  const split = pieces.map((p) => lineTax(p.amountMinor, p.taxRateBps, terms.pricesIncludeTax));
  const itemsMinor = items.reduce((sum, p) => sum + p.amountMinor, 0);
  const subtotalMinor = split.reduce((sum, p) => sum + p.taxableMinor, 0);
  const taxMinor = split.reduce((sum, p) => sum + p.taxMinor, 0);

  const { regime, position } = await restaurantSupply(context, terms.stateCode, taxMinor, terms.taxAccount);

  const taxes = new Map<string, { name: string; rateBps: number; amountMinor: number }>();
  const add = (name: string, rateBps: number, amountMinor: number): void => {
    const key = `${name}:${rateBps}`;
    const at = taxes.get(key) ?? { name, rateBps, amountMinor: 0 };
    taxes.set(key, { ...at, amountMinor: at.amountMinor + amountMinor });
  };
  pieces.forEach((piece, i) => {
    const tax = split[i]!.taxMinor;
    const heads = splitHeads(regime.code, position.treatment, tax, piece.taxRateBps);
    for (const head of heads) add(head.name, head.rate_bps, head.amount_minor);
    // As the printed bill does: tax with no knowable head still shows, unnamed.
    if (heads.length === 0 && tax !== 0) add('Tax', piece.taxRateBps ?? 0, tax);
  });

  return {
    itemsMinor,
    parcelChargeMinor: charge?.amountMinor ?? 0,
    subtotalMinor,
    taxes: [...taxes.values()],
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    roundOffMinor: roundOffFor(regime.billRounding, subtotalMinor + taxMinor),
    payableMinor: subtotalMinor + taxMinor + roundOffFor(regime.billRounding, subtotalMinor + taxMinor),
    parcelCharge: chargeTerms,
    pricesIncludeTax: terms.pricesIncludeTax,
    taxAccount: terms.taxAccount,
  };
}
