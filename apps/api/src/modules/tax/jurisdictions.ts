import { countryOf, type CountryDefinition } from '@universalpos/shared';

/**
 * The tax regimes this product knows about, as DATA.
 *
 * ###########################################################################
 * THE CODE AUTHORS IT, THE DATABASE GUARDS IT, A GATE ASSERTS THEY AGREE.
 *
 * `platform.tax_jurisdiction`, `platform.tax_treatment` and
 * `platform.tax_head` hold the same rows. The database copy is what
 * `app.assert_bill_line_heads_match_treatment` reads, so a bill whose heads
 * contradict the vocabulary is refused at COMMIT rather than by a code path
 * somebody might not have taken.
 *
 * This file is the AUTHOR. The tables are read-only to `katkitchen_app` and
 * written only by the owner-role seed, and `tests/tax/jurisdiction.test.ts`
 * asserts the two agree in BOTH directions -- so a hand-edited row fails a test
 * instead of filing a wrong return, and a value added here without a migration
 * fails too.
 *
 * Same posture as `FIELD_CHOICES` in the web tokens against
 * `branch_gst_registration_known`: the client holds a copy of a schema
 * vocabulary and the copy is gated. It is not the schema being duplicated for
 * convenience; it is a guard with two witnesses.
 * ###########################################################################
 *
 * ###########################################################################
 * A HEAD IS A SHARE OF THE HEADLINE RATE, NOT A RATE.
 *
 * India's intra-state supply is CGST and SGST at half each; inter-state is IGST
 * at the whole. A United States combined rate splits into state, county and
 * city at UNEVEN shares. Both are the same shape once a head is a share, and
 * neither needs the rate to be even -- which is what let migration 0052 delete
 * `tax_class_rate_halves`, the CHECK that refused California's 7.25%.
 *
 * Shares must sum to 10000 for any treatment that collects tax.
 * `platform.assert_tax_shares_whole` refuses otherwise at COMMIT, in both
 * directions of the write: a taxable treatment with no head at all is as wrong
 * as one whose shares sum to 9500, and only one of those two writes touches the
 * head table.
 * ###########################################################################
 */

/**
 * What a document's heads must look like under a treatment.
 *
 * ###########################################################################
 * THREE POSITIONS, AND THE THIRD IS WHY THIS IS NOT A BOOLEAN.
 *
 * The first draft of this file had `carriesTax: boolean` and mapped India's
 * `unstated` to false. That is not what `unstated` means. It does not mean "no
 * tax was collected"; it means "tax WAS collected and nobody recorded which
 * head it belongs to" -- migration 0050 wrote it onto bills raised at a branch
 * with no state code. Calling it non-taxable made the database trigger require
 * those lines to carry no tax, and refused documents that already exist. The
 * whole fixture suite said so, which is the only reason it was caught before
 * the install.
 * ###########################################################################
 *
 * `required`   collects tax and reports it under this treatment's heads; the
 *              shares must sum to 10000 and a line's head set must match.
 * `none`       collects no tax -- an unregistered branch, a composition dealer,
 *              an all-exempt bill. A line carries no tax and no head.
 * `unrecorded` tax may have been collected and the head is not
 *              reconstructable. NOTHING is asserted about the line; the
 *              outward-supply return refuses the period instead, which is the
 *              only honest answer -- the amount is right, the head is unknown,
 *              and inventing one is the failure 0037 sets out in capitals.
 */
export type TaxHeadRule = 'required' | 'none' | 'unrecorded';

export interface TaxTreatmentDefinition {
  readonly key: string;
  readonly name: string;
  readonly headRule: TaxHeadRule;
  /** The account a bill under this treatment was charged under (0083); absent for none / unrecorded. */
  readonly account?: TaxAccount;
}

export interface TaxHeadDefinition {
  readonly treatment: string;
  /** The statutory abbreviation, as printed on the document. */
  readonly name: string;
  /** Basis points OF THE HEADLINE RATE. 5000 is half; 10000 is the whole. */
  readonly shareBps: number;
  /**
   * Print order, and the order the remainder is distributed in -- so an odd
   * paisa lands on the same head every time rather than wherever a sort put it.
   */
  readonly ordinal: number;
}

/**
 * Which tax a branch charges (`app.branch.tax_account_type`, 0083). The RATE is
 * always the dish's tax class; the account decides the heads it is reported
 * under. GST is a jurisdiction's own rules (a resolver); VAT and OTHERS are one
 * head at the class rate, the same everywhere they are offered.
 */
export type TaxAccount = 'none' | 'gst' | 'vat' | 'others';

export const TAX_ACCOUNTS: readonly TaxAccount[] = ['none', 'gst', 'vat', 'others'];

/**
 * How a bill is settled, the value `app.bill.rounding_rule` stamps (0082).
 * `nearest_rupee` pays a bill to the nearest whole unit with a Round off line;
 * `none` collects the total to the minor unit -- a UAE bill is paid to the fils.
 */
export type BillRounding = 'nearest_rupee' | 'none';

/** Code, name, currency, locale and timezone come from the shared country entry: one copy. */
export interface JurisdictionDefinition extends CountryDefinition {
  /**
   * `implemented` means `src/modules/tax/registry.ts` has a resolver for it and a bill
   * can be raised. `declared` means a tenant may be provisioned against it and
   * every bill is refused BY NAME until somebody writes the rules -- which is
   * better than turning the customer away at the door and much better than
   * quietly giving them India's.
   */
  readonly status: 'implemented' | 'declared';
  /** Country calling code, without a plus. */
  readonly dialCode: string;
  readonly treatments: readonly TaxTreatmentDefinition[];
  readonly heads: readonly TaxHeadDefinition[];
  /** The tax accounts a branch here may charge under. A UAE branch has no GST to charge. */
  readonly accounts: readonly TaxAccount[];
  /** What a new restaurant's first branch charges under until its owner says otherwise. */
  readonly defaultAccount: TaxAccount;
  readonly billRounding: BillRounding;
}

/**
 * India.
 *
 * `unstated` is listed rather than omitted so the database trigger recognises
 * it as a DEFINED treatment: an undefined one is refused, and a legacy value
 * that reads as undefined would make every pre-0050 bill unamendable.
 */
const INDIA: JurisdictionDefinition = {
  ...countryOf('IN'),
  status: 'implemented',
  dialCode: '91',
  treatments: [
    { key: 'intra_state', name: 'Intra-state supply', headRule: 'required', account: 'gst' },
    { key: 'inter_state', name: 'Inter-state supply', headRule: 'required', account: 'gst' },
    { key: 'none', name: 'No tax collected', headRule: 'none' },
    // NOT 'none'. These bills charged tax; the head is what is missing.
    { key: 'unstated', name: 'Head not recorded', headRule: 'unrecorded' },
    // A branch charging under the VAT or OTHERS account (0083): one head at the
    // class rate. Never in the GST return, which reads GST-account bills only.
    { key: 'vat', name: 'VAT', headRule: 'required', account: 'vat' },
    { key: 'other', name: 'Other tax', headRule: 'required', account: 'others' },
  ],
  heads: [
    { treatment: 'intra_state', name: 'CGST', shareBps: 5000, ordinal: 1 },
    { treatment: 'intra_state', name: 'SGST', shareBps: 5000, ordinal: 2 },
    { treatment: 'inter_state', name: 'IGST', shareBps: 10000, ordinal: 1 },
    { treatment: 'vat', name: 'VAT', shareBps: 10000, ordinal: 1 },
    { treatment: 'other', name: 'TAX', shareBps: 10000, ordinal: 1 },
  ],
  accounts: ['none', 'gst', 'vat', 'others'],
  defaultAccount: 'gst',
  billRounding: 'nearest_rupee',
};

/**
 * The United Arab Emirates (0083). VAT is one head at the dish's rate -- the
 * standard rate is a tax class the owner can edit, never a constant here. There
 * is no GST to charge, so the GST account is not offered and a bill under it is
 * refused by name.
 */
const UAE: JurisdictionDefinition = {
  ...countryOf('AE'),
  status: 'implemented',
  dialCode: '971',
  treatments: [
    { key: 'vat', name: 'VAT', headRule: 'required', account: 'vat' },
    { key: 'other', name: 'Other tax', headRule: 'required', account: 'others' },
    { key: 'none', name: 'No tax collected', headRule: 'none' },
  ],
  heads: [
    { treatment: 'vat', name: 'VAT', shareBps: 10000, ordinal: 1 },
    { treatment: 'other', name: 'TAX', shareBps: 10000, ordinal: 1 },
  ],
  accounts: ['none', 'vat', 'others'],
  defaultAccount: 'vat',
  // Paid to the fils: whole-dirham rounding is a cash convention, not the law.
  billRounding: 'none',
};

export const JURISDICTIONS: readonly JurisdictionDefinition[] = [INDIA, UAE];

/**
 * What a jurisdiction's resolver is handed, and what it decides.
 *
 * Declared here rather than in `registry.ts` because the per-jurisdiction
 * implementations import it and the registry imports THEM -- putting it beside
 * the resolvers would be a cycle. This module is the leaf of `src/modules/tax/`.
 */
export interface SupplyInput {
  /** The state, province or subdivision the supplier trades in. */
  readonly supplierStateCode: string | null;
  /**
   * Where the supply was made. For restaurant service on the premises this IS
   * the supplier's, and it is a PARAMETER rather than a lookup because it is
   * the fact a practitioner may settle differently -- delivery to another
   * subdivision, catering at a customer's site, a kitchen producing in one
   * place for a branch registered in another.
   */
  readonly placeOfSupplyStateCode: string | null;
  /** What the LINES came to. The treatment describes the document. */
  readonly taxChargedMinor: number;
  /**
   * Which tax the branch charges (0083). Absent is GST, which is what every
   * caller meant before the account existed.
   */
  readonly taxAccount?: TaxAccount;
}

export interface SupplyPosition {
  readonly treatment: string;
  readonly supplierStateCode: string | null;
  readonly placeOfSupplyStateCode: string | null;
}

export type SupplyResolver = (input: SupplyInput) => SupplyPosition;

/**
 * The position under an account that is NOT a jurisdiction's own regime: VAT or
 * OTHERS, one head at the class rate, no place of supply -- or no tax at all.
 * Shared by every resolver that offers them, so the two cannot drift.
 */
export function singleHeadSupply(input: SupplyInput): SupplyPosition {
  const treatment = input.taxChargedMinor === 0 || input.taxAccount === 'none' ? 'none'
    : input.taxAccount === 'vat' ? 'vat' : 'other';
  return { treatment, supplierStateCode: null, placeOfSupplyStateCode: null };
}
