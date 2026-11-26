/**
 * The per-line tax arithmetic, and what a refund reverses.
 *
 * ###########################################################################
 * WHAT USED TO BE HERE, AND WHERE IT WENT.
 *
 * This module used to hold India's rules: a `TaxTreatment` union naming
 * intra_state / inter_state / none / unstated, a `resolveSupplyPosition` that
 * compared two Indian state codes, a `StoredTaxHead` whose `name` was the
 * literal union 'CGST' | 'SGST' | 'IGST', and a splitter that HALVED the rate
 * and threw when it would not halve.
 *
 * Every one of those is India-shaped, and the owner has settled that this is
 * one product for the whole world with India launched first. So the vocabulary
 * moved to `src/modules/tax/jurisdictions.ts` as DATA, the derivation to
 * `src/modules/tax/in.ts` as one jurisdiction's rule, and the dispatch and the head
 * split to `src/modules/tax/registry.ts`. The halving became the largest-remainder
 * allocator over `share_bps`, which is what let migration 0052 delete
 * `tax_class_rate_halves` -- the CHECK that refused a 7.25% combined rate
 * outright because it is odd in basis points.
 *
 * WHAT REMAINS HERE IS WHAT IS NOT JURISDICTIONAL: the tax on one line is
 * amount x rate, rounded once, everywhere; and a refund handed back in cash is
 * tax-INCLUSIVE everywhere, so the tax inside it divides back out the same way
 * under any regime. Those two facts are the ops layer's, and they are the two
 * places a paisa goes missing.
 * ###########################################################################
 *
 * ###########################################################################
 * THIS SHARES NO CODE WITH src/modules/billing/placeOfSupply.ts. DELIBERATELY, AND THE
 * DUPLICATION IS ASSERTED RATHER THAN TRUSTED.
 *
 * That module decides OUR place of supply when WE invoice a tenant, on the
 * control plane, against `platform.invoice` and `platform.tenant_tax_profile`.
 * The tenant plane decides THEIRS when they bill a diner, against `app.bill`
 * and `app.branch`. Different supplier registrations, different recipients,
 * different tables, and different consequences for being wrong --
 * `src/modules/reporting/gstReturn.ts` already states the argument for keeping them
 * apart: a change made for one would silently alter the other's filed returns.
 *
 * The arithmetic of splitting a rate is nonetheless the same arithmetic, and
 * two copies of it are two things that can drift. `tests/ops/taxHeads.test.ts`
 * asserts the two produce IDENTICAL splits for identical inputs, across every
 * rate either can carry. Drift then fails a test instead of appearing in one
 * plane's returns and not the other's.
 * ###########################################################################
 */

import { splitHeads, type StoredTaxHead } from './registry.js';

/**
 * Re-exported rather than re-declared. Callers in `src/modules/` (orders, payments) reach the head
 * shape and the splitter through this module because that is where they always
 * reached them; the definitions live in `src/modules/tax/` because that is where a
 * second jurisdiction will need them. One definition, two doorways.
 */
export { splitHeads, type StoredTaxHead };

/**
 * The tax on one line. The statutory figure is struck HERE, per line, and never
 * as a percentage of a rounded subtotal.
 *
 * Exported because `generateBill` and the head split must agree to the paisa or
 * the deferred trigger refuses the bill -- and two copies of a rounding rule is
 * how they would come to disagree.
 *
 * NOT jurisdictional. Every regime this product will meet charges a rate on a
 * taxable value; what differs is which heads the result is reported under, and
 * that is `splitHeads`' problem.
 */
export function taxOnLine(amountMinor: number, rateBps: number | null): number {
  if (!rateBps) return 0;
  return Math.round((amountMinor * rateBps) / 10000);
}

/**
 * One line's taxable value and tax, forward or reverse (0083). The ONE copy of
 * the rule: the bill, the order screen's estimate and the printed paper all
 * come through here.
 *
 * Forward: the amount is the taxable value and tax is added to it (100 at 5% is
 * 100 + 5). Reverse: the amount already holds the tax, which is found inside it
 * and the rest is the taxable value (100 at 5% is 95.24 + 4.76) -- so the two
 * always sum back to the amount the diner was shown, to the paisa.
 */
export function lineTax(
  amountMinor: number,
  rateBps: number | null,
  pricesIncludeTax: boolean,
): { readonly taxableMinor: number; readonly taxMinor: number } {
  if (!pricesIncludeTax) return { taxableMinor: amountMinor, taxMinor: taxOnLine(amountMinor, rateBps) };
  if (!rateBps) return { taxableMinor: amountMinor, taxMinor: 0 };
  const taxMinor = Math.round((amountMinor * rateBps) / (10000 + rateBps));
  return { taxableMinor: amountMinor - taxMinor, taxMinor };
}

/**
 * The heads for one line, as stored: the rate applied, then split.
 *
 * A zero-tax line on a taxable bill carries NO head rather than several
 * zero-valued ones: an exempt dish beside a taxable one is a real thing, and a
 * head of zero would print a line of tax on a bill that has none.
 */
export function headsForLine(
  jurisdictionCode: string,
  treatment: string,
  taxableMinor: number,
  rateBps: number | null,
): readonly StoredTaxHead[] {
  return splitHeads(
    jurisdictionCode, treatment, taxOnLine(taxableMinor, rateBps), rateBps,
  );
}

/**
 * A partial refund against a bill carrying more than one rate.
 *
 * The refund records an AMOUNT, not which lines were returned, so the tax it
 * reverses is genuinely unknown: apportioning it pro-rata across the bill's
 * rates is a CONVENTION, and one that decides how much output tax the
 * restaurant reclaims. Same posture and same argument as
 * `MixedCurrencyPeriodError` in invoicing and
 * `GstPeriodSpansRegistrationChangeError` in the return: the split is a
 * decision about the filing, not one a write path may make silently.
 *
 * Refunding the WHOLE bill is unambiguous and is not refused -- it reverses the
 * document's own heads.
 */
export class RefundSpansTaxRatesError extends Error {
  readonly statusCode = 409;
  readonly code = 'refund_spans_tax_rates';
  constructor(readonly rateBps: readonly number[]) {
    super(
      `this bill carries ${rateBps.length} different tax rates (`
      + `${[...rateBps].sort((a, b) => a - b).map((r) => `${r / 100}%`).join(', ')}`
      + '), and a part-refund does not say which of them was returned. Refund the '
      + 'whole bill, or raise one refund per rate.',
    );
    this.name = 'RefundSpansTaxRatesError';
  }
}

export interface RefundTaxSnapshot {
  readonly taxableMinor: number;
  readonly taxMinor: number;
  readonly rateBps: number | null;
  /**
   * True when the caller must read the BILL's own heads rather than split a
   * computed figure -- a full refund of a mixed-rate bill has no single rate to
   * split from, and the figures to reverse are the ones on the paper.
   */
  readonly reverseBillHeads: boolean;
}

/**
 * What a refund reverses. Pure, because it is the arithmetic a credit note is
 * judged on and it must be assertable without a database.
 *
 * The refund amount is TAX-INCLUSIVE, so a partial refund divides BACK out of
 * it -- amount x 10000 / (10000 + rate) -- rather than adding tax on top.
 * Deriving the tax as `amount x rate / 10000` would over-reverse by the tax on
 * the tax, which on a 5% bill is a quarter of a percent of every refund and
 * looks exactly like rounding.
 *
 * THE TREATMENT IS NOT AN INPUT, and used to be one. It was carried in and
 * never read, which is worse than absent: a reader had to check the body to
 * find out whether the reversal depended on the head, and a future edit would
 * have been entitled to assume it did. How much tax is inside a tax-inclusive
 * amount does not depend on which heads it is reported under. WHICH heads is
 * the caller's next step, and the caller has the bill's stamped jurisdiction
 * and treatment for exactly that.
 */
export function refundTaxSnapshot(input: {
  readonly billSubtotalMinor: number;
  readonly billTaxMinor: number;
  readonly billTotalMinor: number;
  readonly rates: readonly number[];
  readonly amountMinor: number;
}): RefundTaxSnapshot {
  // The bill charged no tax, so the refund reverses none. An explicit 0 rate
  // and not null: null would read as "nobody worked this out".
  if (input.billTaxMinor === 0) {
    return {
      taxableMinor: input.amountMinor, taxMinor: 0, rateBps: 0, reverseBillHeads: false,
    };
  }

  if (input.amountMinor === input.billTotalMinor) {
    return {
      taxableMinor: input.billSubtotalMinor,
      taxMinor: input.billTaxMinor,
      rateBps: input.rates.length === 1 ? input.rates[0]! : null,
      reverseBillHeads: true,
    };
  }

  if (input.rates.length !== 1) throw new RefundSpansTaxRatesError(input.rates);
  const rate = input.rates[0]!;
  const taxable = Math.round((input.amountMinor * 10000) / (10000 + rate));
  return {
    taxableMinor: taxable,
    taxMinor: input.amountMinor - taxable,
    rateBps: rate,
    reverseBillHeads: false,
  };
}
