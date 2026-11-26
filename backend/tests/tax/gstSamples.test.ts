import { describe, expect, it } from 'vitest';
import {
  TaxProfileInvalidError, componentsForLine, determinePlaceOfSupply, roundOffMinor,
  type SupplierRegistration, type TenantTaxProfile,
} from '../../src/modules/billing/placeOfSupply.js';
import { resolveIndianSupply } from '../../src/modules/tax/in.js';
import { headsForLine, lineTax } from '../../src/modules/tax/taxHeads.js';
import { nearestRupeeRoundOff } from '../../src/modules/payments/billing.js';

/**
 * The sample invoices in docs/backend/gst-review.md, asserted figure for figure, so the
 * document a GST reviewer reads cannot drift from what the code does. These pin
 * CURRENT behaviour; they do not claim it is correct in law. Every figure the
 * review may overturn is named in that document's open questions, and a reviewer's
 * decision changes the code and these expectations together.
 */

const US: SupplierRegistration = {
  gstin: '29AAACK1234A1Z5', stateCode: '29', legalName: 'Platform (sample)', address: 'Bengaluru',
};
const BASE = { legalName: 'Restaurant (sample)', billingAddress: '-', isSez: false, lutNumber: null, financialYearStartsMonth: 4 };
const LUT = 'AD290000000001';
const PLAN = 99900; // a ₹999.00 subscription line
const RATE = 1800;  // invoice.gst_rate_bps in the samples; the live value is a platform setting

function invoice(profile: TenantTaxProfile) {
  const pos = determinePlaceOfSupply(profile, US);
  const components = componentsForLine(pos.treatment, PLAN, RATE);
  const tax = components.reduce((sum, c) => sum + c.amountMinor, 0);
  return { pos, components, tax, roundOff: roundOffMinor(PLAN + tax), total: PLAN + tax + roundOffMinor(PLAN + tax) };
}

describe('P. our invoice to a restaurant (control plane)', () => {
  it('P1 registered, same state as us: CGST 9% + SGST 9%', () => {
    const r = invoice({ ...BASE, gstin: '29AABCR1234B1Z3', stateCode: '29', countryCode: 'IN' });
    expect(r.pos).toEqual({ stateCode: '29', treatment: 'intra_state', isRegisteredRecipient: true, lutNumber: null });
    expect(r.components).toEqual([
      { name: 'CGST', rateBps: 900, amountMinor: 8991 },
      { name: 'SGST', rateBps: 900, amountMinor: 8991 },
    ]);
    expect([r.roundOff, r.total]).toEqual([18, 117900]);
  });

  it('P2 registered, another state: IGST 18%, state from the GSTIN', () => {
    const r = invoice({ ...BASE, gstin: '32AABCR1234B1Z3', stateCode: '32', countryCode: 'IN' });
    expect(r.pos.treatment).toBe('inter_state');
    expect(r.pos.stateCode).toBe('32');
    expect(r.components).toEqual([{ name: 'IGST', rateBps: 1800, amountMinor: 17982 }]);
    expect(r.total).toBe(117900);
  });

  it('P3 unregistered (B2C), another state: IGST, from the stated state', () => {
    const r = invoice({ ...BASE, gstin: null, stateCode: '32', countryCode: 'IN' });
    expect(r.pos).toEqual({ stateCode: '32', treatment: 'inter_state', isRegisteredRecipient: false, lutNumber: null });
  });

  it('P4 an SEZ unit in OUR state is inter-state and zero-rated under LUT', () => {
    const r = invoice({ ...BASE, gstin: '29AABCR1234B1Z3', stateCode: '29', countryCode: 'IN', isSez: true, lutNumber: LUT });
    expect(r.pos.treatment).toBe('sez');
    expect(r.components).toEqual([]);
    expect([r.tax, r.roundOff, r.total]).toEqual([0, 0, 99900]);
  });

  it('P5 outside India: export, place of supply 96, no tax', () => {
    const r = invoice({ ...BASE, gstin: null, stateCode: 'XX', countryCode: 'AE', lutNumber: LUT });
    expect(r.pos).toEqual({ stateCode: '96', treatment: 'export', isRegisteredRecipient: false, lutNumber: LUT });
    expect(r.components).toEqual([]);
  });

  it('P6 refuses a GSTIN whose state contradicts the stated state', () => {
    expect(() => invoice({ ...BASE, gstin: '32AABCR1234B1Z3', stateCode: '29', countryCode: 'IN' }))
      .toThrow(TaxProfileInvalidError);
  });

  it('P7 refuses an SEZ or export claim without an LUT', () => {
    expect(() => invoice({ ...BASE, gstin: '29AABCR1234B1Z3', stateCode: '29', countryCode: 'IN', isSez: true }))
      .toThrow(/LUT/);
    expect(() => invoice({ ...BASE, gstin: null, stateCode: 'XX', countryCode: 'AE' })).toThrow(/LUT/);
  });

  it('P8 an invoice ending in exactly 50 paise rounds DOWN (open question 1)', () => {
    expect(roundOffMinor(10050)).toBe(-50);
    expect(roundOffMinor(10051)).toBe(49);
  });
});

describe('R. a restaurant bill to a diner (tenant plane)', () => {
  const KERALA = '32';

  it('R1 the place of supply is the branch: a GST bill is intra-state', () => {
    // restaurantSupply passes the branch state as BOTH sides; a guest's state is not an input.
    const pos = resolveIndianSupply({ supplierStateCode: KERALA, placeOfSupplyStateCode: KERALA, taxChargedMinor: 1, taxAccount: 'gst' });
    expect(pos.treatment).toBe('intra_state');
  });

  it('R2 six dishes at 5%, tax per line: ₹282.00 + ₹14.10 = ₹296.10, payable ₹296.00', () => {
    const dishes = [1500, 2900, 9200, 4600, 5200, 4800];
    let tax = 0; let cgst = 0; let sgst = 0;
    for (const amount of dishes) {
      const line = lineTax(amount, 500, false);
      const [c, s] = headsForLine('IN', 'intra_state', line.taxableMinor, 500);
      expect([c!.name, c!.rate_bps, s!.name, s!.rate_bps]).toEqual(['CGST', 250, 'SGST', 250]);
      tax += line.taxMinor; cgst += c!.amount_minor; sgst += s!.amount_minor;
    }
    expect(tax).toBe(1410);
    // The odd paisa of each line goes to CGST, so the bill's halves differ (open question 2).
    expect([cgst, sgst]).toEqual([706, 704]);
    expect(nearestRupeeRoundOff(28200 + tax)).toBe(-10);
  });

  it('R3 prices include tax (reverse): ₹105.00 at 5% is ₹100.00 + ₹5.00', () => {
    expect(lineTax(10500, 500, true)).toEqual({ taxableMinor: 10000, taxMinor: 500 });
  });

  it('R4 tax charged at a branch with no state code is `unstated`, never guessed', () => {
    expect(resolveIndianSupply({ supplierStateCode: null, placeOfSupplyStateCode: null, taxChargedMinor: 500, taxAccount: 'gst' }).treatment)
      .toBe('unstated');
  });

  it('R5 no tax charged is `none`, and keeps the branch state', () => {
    expect(resolveIndianSupply({ supplierStateCode: KERALA, placeOfSupplyStateCode: KERALA, taxChargedMinor: 0, taxAccount: 'gst' }))
      .toEqual({ treatment: 'none', supplierStateCode: KERALA, placeOfSupplyStateCode: KERALA });
  });

  it('R6 a branch on the VAT account is not a GST supply at all', () => {
    expect(resolveIndianSupply({ supplierStateCode: KERALA, placeOfSupplyStateCode: KERALA, taxChargedMinor: 500, taxAccount: 'vat' }).treatment)
      .toBe('vat');
  });

  it('R7 a bill rounds to the nearest rupee and exactly 50 paise rounds UP (open question 1)', () => {
    expect(nearestRupeeRoundOff(26449)).toBe(-49);
    expect(nearestRupeeRoundOff(26450)).toBe(50);
    expect(nearestRupeeRoundOff(19005)).toBe(-5);
  });
});
