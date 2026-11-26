import type { TenantContext } from '../../core/database/tenantContext.js';
import {
  AdjustmentReasonKindRepository,
  AdjustmentReasonRepository,
} from '../../core/database/repositories.js';

/**
 * The adjustment vocabulary, as a client may read it.
 *
 * ###########################################################################
 * THE KINDS ARE THE POINT, NOT DECORATION.
 *
 * `app.adjustment_reason_kind` is what stops "customer walked out" being
 * selectable for a discount, and the foreign keys enforce it at the point of
 * use: `order_line_reason_fk`, `kot_recall_reason_fk` and `refund_reason_fk`
 * all reference `(tenant_id, reason_id, kind)`, not the reason alone. A client
 * that offered every reason for every adjustment would therefore produce a 409
 * naming a constraint, in front of a customer, after the tap.
 *
 * So the read returns each reason WITH its kinds and the client filters. It does
 * not filter per surface here: the same list serves the POS sheet and the KDS
 * recall sheet, and a surface that quietly received a pre-filtered list would
 * have no way to tell "no reasons for this kind" from "reasons withheld".
 * ###########################################################################
 */
export interface AdjustmentReasonRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kinds: readonly string[];
}

/**
 * Active reasons only. An archived reason must stay readable through the rows
 * that already reference it -- which is why `adjustment_reason_status_known`
 * has 'archived' rather than the row being deleted -- but offering it for a new
 * adjustment would be offering a vocabulary its owner has retired.
 */
export async function listAdjustmentReasons(
  _context: TenantContext,
): Promise<readonly AdjustmentReasonRow[]> {
  // Two repository reads and a join in memory, rather than one hand-written
  // GROUP BY. The catalogue is a handful of rows per tenant, so the round trip
  // is not the cost that matters -- and the raw-SQL gate's rule is the one worth
  // keeping: the tenant predicate comes from `BaseRepository`, which is the
  // single place it is built correctly, instead of being retyped here where a
  // future edit could drop it and still return plausible-looking rows.
  const reasons = await new AdjustmentReasonRepository().findMany(
    { status: 'active' }, { orderBy: 'name' });
  const kinds = await new AdjustmentReasonKindRepository().findMany();

  const byReason = new Map<string, string[]>();
  for (const row of kinds) {
    const reasonId = String(row['reason_id']);
    const list = byReason.get(reasonId) ?? [];
    list.push(String(row['kind']));
    byReason.set(reasonId, list);
  }

  // A reason scoped to NO kind is unusable by construction -- every point of use
  // references the kind table -- so it is withheld rather than shown as an
  // option that will be refused.
  return reasons
    .map((row) => ({
      id: String(row['id']),
      key: String(row['key']),
      name: String(row['name']),
      kinds: (byReason.get(String(row['id'])) ?? []).slice().sort(),
    }))
    .filter((reason) => reason.kinds.length > 0);
}

export const DEFAULT_ADJUSTMENT_REASONS: readonly {
  readonly key: string;
  readonly name: string;
  readonly kinds: readonly string[];
}[] = [
  { key: 'wrong_item_keyed', name: 'Wrong item keyed', kinds: ['void'] },
  { key: 'guest_changed_mind', name: 'Guest changed their mind', kinds: ['void'] },
  { key: 'quality_issue', name: 'Quality issue', kinds: ['void', 'comp'] },
  { key: 'long_wait', name: 'Long wait', kinds: ['comp', 'discount'] },
  { key: 'service_recovery', name: 'Service recovery', kinds: ['comp', 'discount'] },
  { key: 'staff_meal', name: 'Staff meal', kinds: ['comp'] },
  { key: 'owner_hospitality', name: 'Owner hospitality', kinds: ['comp'] },
  { key: 'manager_discretion', name: 'Manager discretion', kinds: ['discount'] },
  { key: 'promotion', name: 'Promotion', kinds: ['discount'] },
  { key: 'bumped_too_early', name: 'Bumped too early', kinds: ['recall'] },
  { key: 'remake_required', name: 'Remake required', kinds: ['recall', 'void'] },
  { key: 'duplicate_payment', name: 'Duplicate payment', kinds: ['refund'] },
  { key: 'order_cancelled', name: 'Order cancelled', kinds: ['refund', 'void'] },
  // The code a bill edit's voids and refunds carry (0086); the edit's own words are the reason.
  { key: 'bill_corrected', name: 'Bill corrected', kinds: ['void', 'refund'] },
];
