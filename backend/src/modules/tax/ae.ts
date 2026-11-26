import { singleHeadSupply, type SupplyInput, type SupplyPosition } from './jurisdictions.js';

/**
 * The United Arab Emirates' rules (0083).
 *
 * VAT is one head at the dish's own rate, charged where the restaurant is, so
 * there is no place-of-supply question for a restaurant sale and no state to
 * record. OTHERS is the same shape under a generic head. The registry has
 * already refused an account the UAE does not offer (GST) before this runs.
 */
export function resolveUaeSupply(input: SupplyInput): SupplyPosition {
  return singleHeadSupply(input);
}
