import type { ReactElement } from 'react';

/**
 * Hatched, captioned, and never a zero.
 *
 * Consolidated out of five screens that carried a byte-identical copy each
 * (Dashboard, Customers, Inventory, GstRegistration, TaxRates) -- a genuine
 * duplicate, not five deliberately-separate decisions, so collapsing it here
 * is simplification rather than a new abstraction imposed on them.
 *
 * The `unknown` state of the known/stale/unknown model renders through this,
 * never as an empty table or a zero: absence and "could not be read" are
 * different facts, and this is the one shape that says which.
 */
export function Missing(props: { reason: string; children?: string }): ReactElement {
  return (
    <div
      className="rounded-[4px] border border-dashed border-border p-4 text-sm leading-relaxed text-foreground/80"
      style={{
        background: 'repeating-linear-gradient(135deg, #FAFAFA 0 6px, #FFFFFF 6px 12px)',
      }}
    >
      {props.children ?? 'This could not be read just now.'}
      <div className="mt-1.5 font-mono text-xs text-muted-foreground">
        {props.reason}
      </div>
    </div>
  );
}
