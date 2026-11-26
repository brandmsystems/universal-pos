import { allocateComboPrice } from '../menu/comboAllocation.js';
import {
  JURISDICTIONS, type JurisdictionDefinition, type SupplyInput,
  type SupplyPosition, type SupplyResolver, type TaxHeadDefinition,
  type TaxHeadRule,
} from './jurisdictions.js';
import { resolveIndianSupply } from './in.js';
import { resolveUaeSupply } from './ae.js';

/**
 * Which jurisdiction's rules apply, and the refusal when none are written.
 *
 * ###########################################################################
 * DECIDED, by the owner: one product for the whole world, India launched first.
 *
 * That makes the interesting case not India but the OTHER one -- and the only
 * unacceptable answer for a restaurant in a country nobody has written rules
 * for is to give it India's. It would work. Every bill would add up, the till
 * would balance, and the error would be a monthly return filed under a regime
 * the shop is not in.
 *
 * So a jurisdiction is either `implemented` -- there is a resolver below -- or
 * `declared`, and a bill in a declared jurisdiction is REFUSED by name. Being
 * refused at the till on day one is a bad afternoon. Being quietly taxed under
 * the wrong regime is a bad year.
 * ###########################################################################
 */

export class TaxJurisdictionUnknownError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_jurisdiction_unknown';
  constructor(readonly given: string) {
    super(
      `"${given}" is not a tax jurisdiction this product knows about. `
      + `The catalogue holds ${JURISDICTIONS.map((j) => j.code).join(', ')}.`,
    );
    this.name = 'TaxJurisdictionUnknownError';
  }
}

/**
 * The jurisdiction exists and nobody has written its rules.
 *
 * Deliberately NOT the same error as an unknown code. "We have not built
 * Malaysia yet" and "MY is not a country code we recognise" send whoever reads
 * it to two different places, and the first one is a roadmap question rather
 * than a typo.
 */
export class TaxJurisdictionNotImplementedError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_jurisdiction_not_implemented';
  constructor(readonly jurisdiction: JurisdictionDefinition) {
    super(
      `${jurisdiction.name} (${jurisdiction.code}) is a known jurisdiction and its `
      + 'tax rules are not built, so no bill can be raised under it. Implemented '
      + `today: ${implementedCodes().join(', ')}. This is refused rather than `
      + "falling back on another country's rules, because a bill taxed under the "
      + 'wrong regime adds up correctly and is discovered by an assessment.',
    );
    this.name = 'TaxJurisdictionNotImplementedError';
  }
}

/**
 * The implementations. One entry per `implemented` jurisdiction, and
 * `tests/tax/jurisdiction.test.ts` asserts that correspondence in BOTH
 * directions -- so marking a jurisdiction implemented without writing its
 * resolver fails a test, and writing a resolver without listing it does too.
 *
 * That gate is the ratchet that makes the seam real rather than notional: the
 * day a second country is added, the author is forced to confront that
 * `resolveIndianSupply` is India's rule and not a general one.
 */
const RESOLVERS: Readonly<Record<string, SupplyResolver>> = {
  IN: resolveIndianSupply,
  AE: resolveUaeSupply,
};

/**
 * A branch set to charge a tax its jurisdiction has no such thing as -- GST in
 * the UAE. Refused by name rather than resolved: the alternative is a bill with
 * CGST and SGST on it in Dubai, which adds up and is wrong.
 */
export class TaxAccountNotOfferedError extends Error {
  readonly statusCode = 409;
  readonly code = 'tax_account_not_offered';
  constructor(readonly account: string, readonly jurisdiction: JurisdictionDefinition) {
    super(
      `${jurisdiction.name} has no ${account.toUpperCase()} to charge. Choose one of: `
      + `${jurisdiction.accounts.map((a) => a.toUpperCase()).join(', ')}.`,
    );
    this.name = 'TaxAccountNotOfferedError';
  }
}

/**
 * Decide the treatment for a supply, in the jurisdiction's own terms.
 *
 * Every money path goes through this rather than calling a resolver directly,
 * so a declared-but-unbuilt jurisdiction is refused by name in ONE place.
 */
export function resolveSupply(code: string, input: SupplyInput): SupplyPosition {
  const found = implementedJurisdiction(code);
  const account = input.taxAccount ?? 'gst';
  if (!found.accounts.includes(account)) throw new TaxAccountNotOfferedError(account, found);
  const resolver = RESOLVERS[found.code];
  // Unreachable while the gate holds. Raised rather than asserted non-null
  // because the alternative to a refusal here is a bill with no treatment.
  if (!resolver) throw new TaxJurisdictionNotImplementedError(found);
  return resolver(input);
}

export function resolverCodes(): readonly string[] {
  return Object.keys(RESOLVERS);
}

export function implementedCodes(): readonly string[] {
  return JURISDICTIONS.filter((j) => j.status === 'implemented').map((j) => j.code);
}

/** The definition, whatever its status. For catalogue reads and refusals. */
export function jurisdiction(code: string): JurisdictionDefinition {
  const found = JURISDICTIONS.find((j) => j.code === code);
  if (!found) throw new TaxJurisdictionUnknownError(code);
  return found;
}

/**
 * The definition, and only if its rules exist. Every money path goes through
 * this one rather than through `jurisdiction` above.
 */
export function implementedJurisdiction(code: string): JurisdictionDefinition {
  const found = jurisdiction(code);
  if (found.status !== 'implemented') throw new TaxJurisdictionNotImplementedError(found);
  return found;
}

export function treatmentsOf(code: string): readonly string[] {
  return jurisdiction(code).treatments.map((t) => t.key);
}

/**
 * What a document's heads must look like under this treatment.
 *
 * Throws on a treatment the jurisdiction does not define, rather than answering
 * `none`. `none` is a LAWFUL position a document can be issued under; an
 * undefined treatment is a bug, and answering it as a lawful position is how a
 * typo becomes a nil return.
 */
export function headRuleOf(code: string, treatment: string): TaxHeadRule {
  const found = jurisdiction(code).treatments.find((t) => t.key === treatment);
  if (!found) {
    throw new TaxTreatmentUnknownError(code, treatment);
  }
  return found.headRule;
}

export class TaxTreatmentUnknownError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_treatment_unknown';
  constructor(readonly jurisdictionCode: string, readonly treatment: string) {
    super(
      `${jurisdictionCode} does not define a supply treatment called `
      + `"${treatment}". It defines ${treatmentsOf(jurisdictionCode).join(', ')}.`,
    );
    this.name = 'TaxTreatmentUnknownError';
  }
}

export function headsOf(code: string, treatment: string): readonly TaxHeadDefinition[] {
  return jurisdiction(code).heads
    .filter((h) => h.treatment === treatment)
    .toSorted((a, b) => a.ordinal - b.ordinal);
}

/**
 * A head as it is STORED, in `bill_line.tax_components`.
 *
 * snake_case deliberately: these are the keys
 * `app.assert_bill_line_heads_match_treatment` reads out of the jsonb. A
 * storage shape, not a domain type -- renaming a field here changes what a
 * CONSTRAINT sees.
 */
export interface StoredTaxHead {
  readonly name: string;
  readonly rate_bps: number;
  readonly amount_minor: number;
}

/**
 * Split a KNOWN tax amount across a treatment's heads.
 *
 * ###########################################################################
 * THE ALLOCATOR, NOT A HALVING.
 *
 * This used to be `floor(tax / 2)` to SGST and the remainder to CGST, which is
 * correct for two equal shares and expressible for nothing else. It is now the
 * SAME largest-remainder allocator combo pricing uses -- pro-rata by share with
 * the remainder distributed by ordinal -- which gives:
 *
 *   an exact sum for ANY number of heads at ANY shares, guaranteed by
 *   `allocateComboPrice`'s own invariant and asserted by the database;
 *
 *   no dependence on the rate being even, which is what removed the CHECK that
 *   refused a US combined rate outright;
 *
 *   the same answer as before for India -- 17 paise splits 9 to CGST, 8 to
 *   SGST -- so no bill moves, which `tests/ops/taxHeads.test.ts` asserts.
 *
 * Reusing that function rather than writing a second largest-remainder is the
 * point: it is already gated, already proven exact across a sweep, and a second
 * copy of a rounding rule is how two copies come to disagree.
 * ###########################################################################
 *
 * `rate_bps` on each head is the share OF THE RATE, for the document to print.
 * It is a display figure: the AMOUNTS are what must sum, and they do.
 */
export function splitHeads(
  jurisdictionCode: string,
  treatment: string,
  taxMinor: number,
  rateBps: number | null,
): readonly StoredTaxHead[] {
  // `none` has no tax to split; `unrecorded` has tax and no knowable head, and
  // naming one here would invent the single fact a return turns on. Both answer
  // with no head -- and `headRuleOf` refuses an UNDEFINED treatment rather than
  // treating it as either.
  if (headRuleOf(jurisdictionCode, treatment) !== 'required') return [];
  if (taxMinor === 0 || rateBps === null || rateBps === 0) return [];

  const heads = headsOf(jurisdictionCode, treatment);
  // A taxable treatment with no head is a catalogue somebody half-filled. The
  // database refuses such a line at COMMIT; refusing here means the message
  // says which treatment rather than naming a constraint.
  if (heads.length === 0) throw new TaxHeadsMissingError(jurisdictionCode, treatment);

  const allocated = allocateComboPrice(
    taxMinor,
    heads.map((h) => ({ componentId: h.name, listPriceMinor: h.shareBps, quantity: 1 })),
  );
  const byName = new Map(allocated.map((a) => [a.componentId, a.allocatedMinor]));

  return heads.map((h) => ({
    name: h.name,
    rate_bps: headRateBps(rateBps, h.shareBps),
    amount_minor: byName.get(h.name)!,
  }));
}

/**
 * A head's printed rate: its share OF the class rate. One copy, used by the
 * bill (`splitHeads`) and by the tax-rate screens (`taxClassSplits`), so the
 * rate a manager is shown is the rate the bill prints.
 */
export function headRateBps(rateBps: number, shareBps: number): number {
  return Math.round((rateBps * shareBps) / 10000);
}

export class TaxHeadsMissingError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_heads_missing';
  constructor(readonly jurisdictionCode: string, readonly treatment: string) {
    super(
      `${jurisdictionCode}'s "${treatment}" collects tax and the catalogue gives it `
      + 'no head to collect it under, so no bill can be raised. This is a setup '
      + 'gap in the jurisdiction catalogue, not something a till can fix.',
    );
    this.name = 'TaxHeadsMissingError';
  }
}
