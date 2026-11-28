import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { allocateComboPrice } from '../products/comboAllocation.js';

/**
 * Subscription segments.
 *
 * ###########################################################################
 * THERE IS NO "PRORATION" CONCEPT HERE, DELIBERATELY.
 *
 * A segment is a contiguous span during which the plan and quantity were
 * constant. An invoice bills a set of segments, so a mid-period change does not
 * create an adjustment -- it creates a second segment.
 *
 * The alternative, credit-and-rebill, was rejected on a statutory ground rather
 * than a stylistic one: a credit note under Section 34 records a REDUCTION IN THE
 * TAXABLE VALUE OF A SUPPLY ALREADY MADE. Routine proration is not that. The
 * earlier invoice was correct for the facts at the time, so a credit note against
 * it asserts an error that did not occur -- and burns a number in a statutory
 * gapless series to do it. At seat-change frequency that fills the credit-note
 * series with hundreds of documents that are not credits.
 * ###########################################################################
 */

export interface Segment {
  readonly id: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly quantity: number;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

export type ChangeDirection = 'expand' | 'contract';

/**
 * ###########################################################################
 * THE ASYMMETRY, AND WHY IT IS DELIBERATE.
 *
 * Upgrades and seat increases take effect IMMEDIATELY. Downgrades and seat
 * decreases take effect AT THE PERIOD BOUNDARY.
 *
 * The direction that expands what the customer has is immediate; the direction
 * that contracts it waits. This is the same shape as the discount cap asymmetry,
 * and it dissolves the refund-or-credit-or-lapse question rather than answering
 * it: if the contraction happens at the boundary, no unused value ever exists, so
 * there is nothing to refund, credit or forfeit. The tenant simply keeps what
 * they paid for until the period ends.
 *
 * It also matters operationally. An immediate downgrade can put a tenant OVER the
 * new plan's limits -- eight branches on a five-branch plan -- in the middle of
 * service. Deferring moves that collision to the billing moment, where there is a
 * conversation to be had rather than a surprise.
 * ###########################################################################
 */
export function directionOfChange(
  current: { planPriceMinor: number; quantity: number },
  target: { planPriceMinor: number; quantity: number },
): ChangeDirection {
  const currentValue = current.planPriceMinor * current.quantity;
  const targetValue = target.planPriceMinor * target.quantity;
  return targetValue >= currentValue ? 'expand' : 'contract';
}

export interface SegmentCharge {
  readonly segmentId: string;
  readonly amountMinor: number;
  readonly days: number;
}

/**
 * Allocates the period price across segments by days, using LARGEST-REMAINDER --
 * the same allocator that serves combo components and percentage bill splits.
 *
 * Guarantee: the charges sum EXACTLY to the period price. Naive per-segment
 * rounding leaves a residue, and a residue on a tax document is a figure nobody
 * can explain.
 *
 * Note this allocates a single plan's period price across its own segments. Where
 * segments carry DIFFERENT plans, each plan's segments are allocated within that
 * plan's own price -- a segment on plan A cannot borrow rounding from plan B.
 */
export function allocateSegmentCharges(
  periodPriceMinor: number,
  segments: readonly { id: string; days: number; quantity: number }[],
): readonly SegmentCharge[] {
  if (segments.length === 0) return [];

  const allocated = allocateComboPrice(
    periodPriceMinor,
    segments.map((s) => ({
      componentId: s.id,
      listPriceMinor: s.days,
      quantity: s.quantity,
    })),
  );

  return allocated.map((a) => {
    const source = segments.find((s) => s.id === a.componentId)!;
    return { segmentId: a.componentId, amountMinor: a.allocatedMinor, days: source.days };
  });
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Closes the open segment and opens a new one. One transaction: an overlap or a
 * gap between them is a double charge or a free ride, and the exclusion
 * constraint on the table refuses the overlap outright.
 */
export async function openSegment(
  client: pg.ClientBase,
  params: {
    tenantId: string;
    subscriptionId: string;
    planId: string;
    planVersionId: string;
    quantity: number;
    at: Date;
  },
): Promise<{
  segmentId: string;
  closedSegmentId: string | null;
  /** Set when the open segment had not started yet and was replaced outright. */
  supersededSegmentId: string | null;
}> {
  // Locked, because two changes landing at once must not both read the same open
  // segment and both close it -- the exclusion constraint would catch the
  // overlap, but as a constraint name rather than as a wait.
  const open = await client.query<{
    id: string; starts_at: string; invoiced_on_invoice_id: string | null;
  }>(
    `SELECT id, starts_at::text, invoiced_on_invoice_id
       FROM platform.subscription_segment
      WHERE tenant_id = $1 AND subscription_id = $2 AND ends_at IS NULL
      FOR UPDATE`,
    [params.tenantId, params.subscriptionId],
  );
  const current = open.rows[0];

  // #########################################################################
  // A SEGMENT THAT HAS NOT STARTED IS SUPERSEDED, NOT CLOSED.
  //
  // Closing sets `ends_at = at`. When the open segment starts in the FUTURE --
  // which is the normal state of a tenant inside its trial, since provisioning
  // opens the first segment at the trial's end -- that makes `ends_at` earlier
  // than `starts_at`, and `subscription_segment_ordered` refuses it outright.
  //
  // That refusal was the schema catching a real case rather than a typo: a
  // tenant upgrading on day three of a fourteen-day trial. The segment being
  // replaced has accrued nothing and can never be invoiced, so a zero-length or
  // negative-length interval is not a thing to record. It is deleted.
  //
  // AND THE NEW SEGMENT INHERITS ITS START, which is the half that matters:
  // starting the upgraded segment at `at` would begin billing on day three and
  // end the free trial early -- silently, and in the tenant's disfavour. A plan
  // change during a trial changes WHAT will be billed from the trial's end, not
  // WHEN billing starts.
  //
  // Guarded on `invoiced_on_invoice_id IS NULL`: a segment already on an invoice
  // is never deleted, whatever its dates. If one were somehow both invoiced and
  // future-dated, this falls through to the close and the constraint refuses --
  // which is the right outcome for a state that should not exist.
  // #########################################################################
  const startsInFuture = current !== undefined
    && new Date(current.starts_at).getTime() >= params.at.getTime()
    && current.invoiced_on_invoice_id === null;

  let startsAt = params.at;
  let closedSegmentId: string | null = null;
  let supersededSegmentId: string | null = null;

  if (current !== undefined && startsInFuture) {
    startsAt = new Date(current.starts_at);
    await client.query(
      `DELETE FROM platform.subscription_segment WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, current.id],
    );
    supersededSegmentId = current.id;
  } else if (current !== undefined) {
    await client.query(
      `UPDATE platform.subscription_segment
          SET ends_at = $3
        WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, current.id, params.at],
    );
    closedSegmentId = current.id;
  }

  const segmentId = randomUUID();
  await client.query(
    `INSERT INTO platform.subscription_segment
       (id, tenant_id, subscription_id, plan_id, plan_version_id, quantity, starts_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [segmentId, params.tenantId, params.subscriptionId, params.planId,
     params.planVersionId, params.quantity, startsAt],
  );

  return { segmentId, closedSegmentId, supersededSegmentId };
}

export interface UninvoicedSegment {
  readonly id: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly planKey: string;
  readonly planName: string;
  readonly priceMinor: number;
  /** From `plan_version`. An invoice may not mix currencies; see generateInvoice. */
  readonly currency: string;
  readonly quantity: number;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/**
 * Segments not yet on any invoice, bounded to the period.
 *
 * `invoiced_on_invoice_id IS NULL` is what makes generation idempotent per
 * period: a retried job finds nothing left to bill. That matters more here than
 * anywhere else in the product, because the gapless series makes a duplicate
 * invoice a permanent, visible defect rather than a row to delete.
 */
export async function uninvoicedSegments(
  client: pg.ClientBase,
  params: { tenantId: string; subscriptionId: string; upTo: Date },
): Promise<readonly UninvoicedSegment[]> {
  const result = await client.query<{
    id: string; plan_id: string; plan_version_id: string; plan_key: string;
    plan_name: string; price_minor: string; currency: string; quantity: number;
    starts_at: string; ends_at: string | null;
  }>(
    `SELECT s.id, s.plan_id, s.plan_version_id, p.key AS plan_key, p.name AS plan_name,
            pv.price_minor::text, pv.currency, s.quantity, s.starts_at::text, s.ends_at::text
       FROM platform.subscription_segment s
       JOIN platform.plan p ON p.id = s.plan_id
       JOIN platform.plan_version pv ON pv.id = s.plan_version_id
      WHERE s.tenant_id = $1 AND s.subscription_id = $2
        AND s.invoiced_on_invoice_id IS NULL
        AND s.starts_at < $3
      ORDER BY s.starts_at`,
    [params.tenantId, params.subscriptionId, params.upTo],
  );

  return result.rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    planVersionId: r.plan_version_id,
    planKey: r.plan_key,
    planName: r.plan_name,
    priceMinor: Number(r.price_minor),
    currency: r.currency,
    quantity: r.quantity,
    startsAt: new Date(r.starts_at),
    endsAt: r.ends_at ? new Date(r.ends_at) : null,
  }));
}
