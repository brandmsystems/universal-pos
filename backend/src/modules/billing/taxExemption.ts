import type pg from 'pg';
import { NoTaxProfileError } from './invoicing.js';

/**
 * Stating a tenant's zero-rating position, attributed to a platform user who saw
 * the evidence.
 *
 * ###########################################################################
 * THE ATTRIBUTION IS THE MECHANISM, AND IT WAS UNREACHABLE.
 *
 * `tenant_tax_profile` has carried `exemption_granted_by_platform_user_id`,
 * `exemption_granted_at` and `exemption_evidence` since 0037, with a CHECK that
 * makes a zero-rating claim impossible without all three, and a trigger that
 * forces the grant to be RE-STATED whenever `is_sez` or `country_code` moves.
 * The comment on the table says why: "if the claim is wrong WE carry the
 * liability", and "the tenant plane holds no platform user id and cannot forge
 * one past the FK, so the write is structurally unavailable to it".
 *
 * Nothing could perform the write either. There was no code path anywhere that
 * set those three columns, so the only way a tenant could become zero-rated was
 * a hand-written UPDATE -- which is the state the constraint was designed to
 * make impossible to reach BY MISTAKE, not the state it was designed to make
 * reachable only by hand.
 *
 * This is the write. It does not validate the zero-rating rules itself: the
 * CHECKs are the authority (`tenant_exemption_attributed` demands the evidence
 * and the LUT, and the SEZ LOA on top for an SEZ claim), and a second copy of
 * those rules here would be a copy that drifts. A request missing the LUT is
 * refused by name -- `tenant_zero_rated_requires_lut` -- which is more useful
 * than a message this module could invent.
 * ###########################################################################
 */

export interface TaxPositionClaim {
  readonly tenantId: string;
  /** SEZ supply. Requires an LOA number as well as the LUT. */
  readonly isSez: boolean;
  /** 'IN' plus is_sez=false is the taxable position; anything else is zero-rated. */
  readonly countryCode: string;
  /** Letter of Undertaking. The only lawful zero-rating form here, by decision. */
  readonly lutNumber: string | null;
  readonly sezLoaNumber: string | null;
  /** What was seen. Free text on purpose: it is a pointer to a document. */
  readonly evidence: string;
  /** The platform user who saw it. Never from the request body. */
  readonly grantedByPlatformUserId: string;
}

export interface TaxPositionResult {
  readonly tenantId: string;
  readonly isSez: boolean;
  readonly countryCode: string;
  readonly zeroRated: boolean;
  readonly lutNumber: string | null;
  readonly sezLoaNumber: string | null;
  readonly grantedAt: string;
  readonly grantedByPlatformUserId: string;
  /** What the profile said before. The audit log's before-image for this write. */
  readonly previous: {
    readonly isSez: boolean;
    readonly countryCode: string;
    readonly zeroRated: boolean;
    readonly grantedAt: string | null;
  };
}

/**
 * Both directions, deliberately.
 *
 * Withdrawing a claim -- back to `IN` and not SEZ -- is as consequential as
 * making one and the trigger treats it identically: it changes `country_code` or
 * `is_sez`, so it must re-state the granting platform user. A separate "revoke"
 * path would be a second write against the same guarded columns, and the one
 * thing worse than an unreachable mechanism is two of them.
 */
export async function stateTaxPosition(
  client: pg.ClientBase,
  claim: TaxPositionClaim,
): Promise<TaxPositionResult> {
  const before = await client.query<{
    is_sez: boolean; country_code: string; exemption_granted_at: string | null;
  }>(
    `SELECT is_sez, country_code, exemption_granted_at::text
       FROM platform.tenant_tax_profile
      WHERE tenant_id = $1
        FOR UPDATE`,
    [claim.tenantId],
  );
  const previous = before.rows[0];
  // A tenant with no profile has no tax identity to exempt. Reusing the
  // invoicing refusal rather than inventing a second one: it is the same
  // missing row, and `generateInvoice` already answers 422 for it.
  if (!previous) throw new NoTaxProfileError(claim.tenantId);

  const updated = await client.query<{
    is_sez: boolean; country_code: string; lut_number: string | null;
    sez_loa_number: string | null; exemption_granted_at: string;
    exemption_granted_by_platform_user_id: string;
  }>(
    `UPDATE platform.tenant_tax_profile
        SET is_sez = $2,
            country_code = $3,
            lut_number = $4,
            sez_loa_number = $5,
            exemption_evidence = $6,
            exemption_granted_by_platform_user_id = $7,
            -- Re-stated on every call, which is what
            -- tenant_tax_profile_exemption_guard requires: "a stale grant from
            -- six months ago cannot carry a new claim".
            exemption_granted_at = now()
      WHERE tenant_id = $1
      RETURNING is_sez, country_code, lut_number, sez_loa_number,
                exemption_granted_at::text, exemption_granted_by_platform_user_id`,
    [
      claim.tenantId,
      claim.isSez,
      claim.countryCode,
      claim.lutNumber,
      claim.sezLoaNumber,
      claim.evidence,
      claim.grantedByPlatformUserId,
    ],
  );
  const row = updated.rows[0]!;

  return {
    tenantId: claim.tenantId,
    isSez: row.is_sez,
    countryCode: row.country_code,
    zeroRated: row.is_sez || row.country_code !== 'IN',
    lutNumber: row.lut_number,
    sezLoaNumber: row.sez_loa_number,
    grantedAt: row.exemption_granted_at,
    grantedByPlatformUserId: row.exemption_granted_by_platform_user_id,
    previous: {
      isSez: previous.is_sez,
      countryCode: previous.country_code,
      zeroRated: previous.is_sez || previous.country_code !== 'IN',
      grantedAt: previous.exemption_granted_at,
    },
  };
}
