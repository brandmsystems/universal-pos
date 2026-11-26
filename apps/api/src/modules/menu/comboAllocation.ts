/**
 * Combo price allocation.
 *
 * A combo is priced as a unit at a discount to the component sum. If components
 * carry different tax rates -- food 5%, beverage 12%, which is ordinary in most
 * Indian states -- the combo cannot be taxed as an opaque unit. The combo price
 * must be allocated across components, and the allocation must be STORED, because
 * a return that recomputes it later from live catalogue prices would disagree
 * with the bill it came from.
 *
 * Hence: components at allocated prices, under a parent line that carries no
 * money. The bill DISPLAYS one line; the GST return READS the components.
 */

export interface AllocationInput {
  /** Stable ordering, used as the deterministic tie-break. */
  readonly componentId: string;
  /** Catalogue list price at order time, already snapshotted. */
  readonly listPriceMinor: number;
  readonly quantity: number;
}

export interface AllocationLine {
  readonly componentId: string;
  readonly allocatedMinor: number;
}

export class AllocationImpossibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationImpossibleError';
  }
}

/**
 * Pro-rata by extended list price, with LARGEST-REMAINDER rounding.
 *
 * Naive rounding leaves the components summing to 298.99 or 299.01. Over a month
 * that is thousands of one-paise discrepancies in a return that has to balance
 * exactly, so the remainder is distributed rather than dropped.
 *
 * Guarantee: sum(allocated) === comboPriceMinor, exactly, always.
 */
export function allocateComboPrice(
  comboPriceMinor: number,
  components: readonly AllocationInput[],
): readonly AllocationLine[] {
  if (!Number.isInteger(comboPriceMinor) || comboPriceMinor < 0) {
    throw new AllocationImpossibleError('combo price must be a non-negative integer minor amount');
  }
  if (components.length === 0) {
    throw new AllocationImpossibleError('a combo must have at least one component');
  }

  const extended = components.map((c) => c.listPriceMinor * c.quantity);
  const total = extended.reduce((a, b) => a + b, 0);

  if (total <= 0) {
    // Every component is free, so pro-rata has no basis. Spread evenly and give
    // the remainder to the earliest components -- still exact, still deterministic.
    const base = Math.floor(comboPriceMinor / components.length);
    let remainder = comboPriceMinor - base * components.length;
    return components.map((c) => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return { componentId: c.componentId, allocatedMinor: base + extra };
    });
  }

  const raw = extended.map((value) => (comboPriceMinor * value) / total);
  const floored = raw.map(Math.floor);
  let remainder = comboPriceMinor - floored.reduce((a, b) => a + b, 0);

  // Largest fractional part first; ties broken by input order, which the caller
  // fixes as display_order. Two runs over the same input always agree.
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  const allocated = [...floored];
  for (const { index } of order) {
    if (remainder <= 0) break;
    allocated[index] = allocated[index]! + 1;
    remainder -= 1;
  }

  return components.map((c, i) => ({ componentId: c.componentId, allocatedMinor: allocated[i]! }));
}

/**
 * The invariant Phase 3 enforces with a DEFERRED constraint trigger at COMMIT.
 * Exported so the repository can assert it before it ever gets that far.
 */
export function allocationBalances(
  comboPriceMinor: number,
  lines: readonly AllocationLine[],
): boolean {
  return lines.reduce((sum, l) => sum + l.allocatedMinor, 0) === comboPriceMinor;
}

