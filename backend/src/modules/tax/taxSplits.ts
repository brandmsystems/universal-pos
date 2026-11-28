import type { TenantContext } from '../../database/tenantContext.js';
import { BranchRepository, TaxClassRepository } from '../../database/repositories.js';
import { headRateBps, headsOf } from './registry.js';
import { tenantRegime } from './tenantRegime.js';
import type { TaxAccount } from './jurisdictions.js';

/**
 * What each tax rate becomes on a bill, for the screens that set rates.
 *
 * READ ONLY, AND DERIVED -- NEVER STATED. A tax class carries ONE rate; the
 * heads (CGST + SGST within the state, IGST across states, for India) are the
 * jurisdiction's, applied per bill by `splitHeads`. Migration 0050 removed
 * owner-typed heads because a free-text head made returns report zero. So a
 * manager is SHOWN the split here, from the same catalogue and the same
 * `headRateBps` the bill prints, and is given nowhere to type one.
 *
 * Only treatments that collect tax are listed: `none` and `unstated` have no
 * heads to show. And only those of an account some active branch charges
 * under (0083): a GST restaurant is not shown what its rates would print as
 * under VAT.
 */
export interface TaxClassSplit {
  readonly taxClassId: string;
  readonly rateBps: number;
  readonly treatments: readonly {
    readonly key: string;
    readonly name: string;
    readonly heads: readonly { readonly name: string; readonly rateBps: number }[];
  }[];
}

export async function taxClassSplits(context: TenantContext): Promise<{
  readonly jurisdiction: string;
  /** The tax accounts a branch here may charge under (0083), for the tax settings choice. */
  readonly accounts: readonly TaxAccount[];
  readonly rows: readonly TaxClassSplit[];
}> {
  const regime = await tenantRegime(context.client, context.tenantId);
  // Through the repository, which injects the tenant and refuses without one.
  const classes = await new TaxClassRepository().findMany({ status: 'active' }, { orderBy: 'rate_bps' });
  const branches = await new BranchRepository().findMany({ status: 'active' });
  const charged = new Set(branches.map((b) => (b['tax_enabled'] ? b['tax_account_type'] : 'none')));
  const taxing = regime.treatments.filter((t) => t.headRule === 'required' && t.account !== undefined && charged.has(t.account));
  return {
    jurisdiction: regime.code,
    accounts: regime.accounts,
    rows: classes.map((c) => {
      const rateBps = Number(c['rate_bps']);
      return {
        taxClassId: String(c['id']),
        rateBps,
        treatments: rateBps === 0 ? [] : taxing.map((t) => ({
          key: t.key,
          name: t.name,
          heads: headsOf(regime.code, t.key).map((h) => ({ name: h.name, rateBps: headRateBps(rateBps, h.shareBps) })),
        })),
      };
    }),
  };
}
