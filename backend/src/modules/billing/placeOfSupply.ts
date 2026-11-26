/**
 * GST place of supply.
 *
 * ###########################################################################
 * WHY THIS IS THE MOST CONSEQUENTIAL FUNCTION IN THE PROJECT
 *
 * Charging CGST+SGST where IGST was due does not misstate a total -- 18% is 18%
 * either way. It breaks the RECIPIENT'S INPUT TAX CREDIT: credit claimed under
 * the wrong head is disallowed, and their only remedy is for us to credit-note
 * and reissue every invoice we ever sent them. The amount is right and the
 * document is worthless.
 *
 * Everything this returns is SNAPSHOTTED onto the invoice. A tenant relocating
 * from Karnataka to Maharashtra must not retroactively convert two years of
 * documents from CGST+SGST to IGST.
 * ###########################################################################
 */

export type TaxTreatment = 'intra_state' | 'inter_state' | 'export' | 'sez';

export interface SupplierRegistration {
  readonly gstin: string;
  readonly stateCode: string;
  readonly legalName: string;
  readonly address: string;
}

export interface TenantTaxProfile {
  readonly legalName: string;
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly countryCode: string;
  readonly billingAddress: string;
  readonly isSez: boolean;
  readonly lutNumber: string | null;
  readonly financialYearStartsMonth: number;
}

export interface PlaceOfSupply {
  readonly stateCode: string;
  readonly treatment: TaxTreatment;
  /** B2B where a GSTIN is on record; B2C otherwise. Drives invoice presentation. */
  readonly isRegisteredRecipient: boolean;
  readonly lutNumber: string | null;
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class TaxProfileInvalidError extends Error {
  readonly statusCode = 422;
  readonly code = 'tax_profile_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'TaxProfileInvalidError';
  }
}

/** Characters 1-2 of a GSTIN are the state code. This is the statutory identity. */
export function stateCodeOfGstin(gstin: string): string {
  if (!GSTIN_PATTERN.test(gstin)) {
    throw new TaxProfileInvalidError(`'${gstin}' is not a well-formed GSTIN`);
  }
  return gstin.slice(0, 2);
}

/**
 * Refused at entry, never reconciled.
 *
 * A tenant whose GSTIN state contradicts their stated state has one of the two
 * wrong, and we cannot know which. Picking one silently would produce invoices
 * that are confidently addressed to the wrong jurisdiction.
 */
export function assertProfileCoherent(profile: TenantTaxProfile): void {
  if (profile.gstin) {
    const embedded = stateCodeOfGstin(profile.gstin);
    if (embedded !== profile.stateCode) {
      throw new TaxProfileInvalidError(
        `GSTIN ${profile.gstin} is registered in state ${embedded} but the profile says ` +
          `${profile.stateCode}. One of them is wrong and this cannot be guessed.`,
      );
    }
    if (profile.countryCode !== 'IN') {
      throw new TaxProfileInvalidError(
        'a GSTIN implies an Indian registration; it cannot accompany a non-IN country',
      );
    }
  }
  if ((profile.isSez || profile.countryCode !== 'IN') && !profile.lutNumber) {
    throw new TaxProfileInvalidError(
      'zero-rated supply is supported under Letter of Undertaking only, so an LUT number ' +
        'is required. The pay-IGST-and-claim-refund route is a deliberate exclusion: it ' +
        'means funding the tax and chasing a refund, which is a treasury decision.',
    );
  }
}

/**
 * The determination.
 *
 * Order matters, and it is the statutory order: leaving India decides before SEZ
 * status, and both decide before comparing states -- an SEZ unit in our own state
 * is still an inter-state supply, which is the case a naive state comparison gets
 * wrong.
 */
export function determinePlaceOfSupply(
  profile: TenantTaxProfile,
  supplier: SupplierRegistration,
): PlaceOfSupply {
  assertProfileCoherent(profile);

  // The GSTIN is the authority; the free-text address never overrides it.
  const recipientState = profile.gstin ? stateCodeOfGstin(profile.gstin) : profile.stateCode;

  if (profile.countryCode !== 'IN') {
    return {
      stateCode: '96', // 'Other country', the code used for a place of supply outside India.
      treatment: 'export',
      isRegisteredRecipient: false,
      lutNumber: profile.lutNumber,
    };
  }

  if (profile.isSez) {
    // Treated as inter-state regardless of geography.
    return {
      stateCode: recipientState,
      treatment: 'sez',
      isRegisteredRecipient: profile.gstin !== null,
      lutNumber: profile.lutNumber,
    };
  }

  return {
    stateCode: recipientState,
    treatment: recipientState === supplier.stateCode ? 'intra_state' : 'inter_state',
    isRegisteredRecipient: profile.gstin !== null,
    lutNumber: null,
  };
}

export interface TaxComponent {
  readonly name: 'CGST' | 'SGST' | 'IGST';
  readonly rateBps: number;
  readonly amountMinor: number;
}

/**
 * Tax is computed PER LINE and summed, never as a percentage of a rounded
 * subtotal. That is standard practice and it removes the discrepancy at source
 * rather than reconciling it afterwards.
 *
 * The intra-state split halves the headline rate. An odd headline rate in basis
 * points would not halve exactly, so the remainder goes to CGST by convention and
 * the two are asserted to sum to the headline -- rather than being allowed to
 * drift apart silently.
 */
export function componentsForLine(
  treatment: TaxTreatment,
  taxableMinor: number,
  headlineRateBps: number,
): readonly TaxComponent[] {
  if (treatment === 'export' || treatment === 'sez') return [];

  const total = Math.round((taxableMinor * headlineRateBps) / 10000);

  if (treatment === 'inter_state') {
    return [{ name: 'IGST', rateBps: headlineRateBps, amountMinor: total }];
  }

  const halfRate = headlineRateBps / 2;
  if (!Number.isInteger(halfRate)) {
    throw new Error(
      `headline rate ${headlineRateBps}bps does not split evenly into CGST and SGST; ` +
        'the intra-state split must be two equal halves',
    );
  }
  const sgst = Math.floor(total / 2);
  return [
    { name: 'CGST', rateBps: halfRate, amountMinor: total - sgst },
    { name: 'SGST', rateBps: halfRate, amountMinor: sgst },
  ];
}

/**
 * The Round Off line every Indian invoice carries. The grand total is presented
 * in whole rupees, and the remainder is a recorded figure rather than silent
 * imprecision -- the same reasoning as cash rounding on a bill.
 */
export function roundOffMinor(subtotalPlusTaxMinor: number): number {
  const remainder = subtotalPlusTaxMinor % 100;
  if (remainder === 0) return 0;
  return remainder <= 50 ? -remainder : 100 - remainder;
}
