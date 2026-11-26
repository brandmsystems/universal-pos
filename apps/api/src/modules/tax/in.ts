import { singleHeadSupply, type SupplyInput, type SupplyPosition } from './jurisdictions.js';

/**
 * India's rules. The only implemented jurisdiction.
 *
 * ###########################################################################
 * THIS FILE IS WHERE "INDIA-SPECIFIC" IS ALLOWED TO BE TRUE.
 *
 * Everything else under `src/modules/tax/` is jurisdiction-agnostic: the registry
 * dispatches, `splitHeads` allocates across whatever shares a treatment has,
 * and the catalogue is data. The knowledge that a supply is intra-state when
 * the place of supply matches the supplier's state lives HERE, because it is
 * not a general rule -- a United States regime asks origin-versus-destination
 * sourcing and a European one asks domestic / intra-community / reverse
 * charge, and neither is a renaming of this.
 * ###########################################################################
 */

/**
 * The four values `app.bill.tax_treatment` permits for an Indian supply.
 *
 * `unstated` is not reachable from the derivation below for a NEW bill -- it is
 * what migration 0050 wrote onto historical bills that charged tax at a branch
 * with no state code, whose head genuinely cannot be reconstructed. It is part
 * of the vocabulary because the return has to read those rows and refuse them,
 * which it can only do if the type admits they exist.
 */
export type IndianTaxTreatment = 'intra_state' | 'inter_state' | 'none' | 'unstated';

/**
 * The one place an Indian supply's treatment is decided.
 *
 * ###########################################################################
 * PLACE OF SUPPLY IS THE RESTAURANT'S STATE, AND THAT IS SETTLED.
 *
 * Restaurant service is performed where the restaurant is, so a diner from
 * another state is still an intra-state supply and reading it from the GUEST
 * would put IGST on a walk-in. Published rules confirm the format does not
 * alter it either: dine-in, takeaway, home delivery and cloud kitchens are all
 * treated alike, so `inter_state` does not arise for restaurant service and is
 * unreachable in production today. It is built, guarded by the database and
 * asserted by construction, so an out-of-state supply -- catering at a
 * customer's site, say -- heads correctly the day a channel supplies one.
 *
 * THE BRANCH'S GST REGISTRATION IS DELIBERATELY NOT AN INPUT. An unregistered
 * branch and a composition dealer both resolve every line at 0bps upstream, so
 * they arrive with `taxChargedMinor` 0 and land on the `none` arm. If a rate
 * ever SURVIVES that suppression -- a new write path, a bulk insert -- the
 * treatment falls through to the state comparison and the document is refused
 * by `bill_non_collecting_position_carries_no_tax`, which is the constraint
 * written for that case and which closes the laundering route of taking a taxed
 * order and flipping the branch before billing it. Returning `none` here
 * instead would trip `bill_tax_treatment_consistent` and report the wrong
 * broken rule.
 * ###########################################################################
 */
export function resolveIndianSupply(input: SupplyInput): SupplyPosition {
  // A branch charging VAT or another tax, or none (0083): not GST, so none of
  // the rules below -- one head, no place of supply.
  if (input.taxAccount !== undefined && input.taxAccount !== 'gst') return singleHeadSupply(input);
  if (input.taxChargedMinor === 0) {
    return {
      treatment: 'none',
      supplierStateCode: input.supplierStateCode,
      // Kept, not blanked. Where a branch trades is a fact about the place, and
      // the place of supply is that state whether or not tax is charged on it --
      // the same reasoning that keeps the state code on deregistration.
      placeOfSupplyStateCode: input.placeOfSupplyStateCode,
    };
  }

  // Tax was charged and nobody has stated which state this branch trades in.
  // Naming a head here would be inventing the one fact a return turns on, so it
  // is recorded as unknown and the return refuses the period.
  if (input.supplierStateCode === null || input.placeOfSupplyStateCode === null) {
    return {
      treatment: 'unstated',
      supplierStateCode: input.supplierStateCode,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode,
    };
  }

  return {
    treatment: input.placeOfSupplyStateCode === input.supplierStateCode
      ? 'intra_state'
      : 'inter_state',
    supplierStateCode: input.supplierStateCode,
    placeOfSupplyStateCode: input.placeOfSupplyStateCode,
  };
}
