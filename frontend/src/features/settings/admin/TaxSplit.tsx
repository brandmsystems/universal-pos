import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../services/api.js';

/**
 * What a tax rate prints as on a bill -- "CGST 2.5% + SGST 2.5%" within the
 * state, "IGST 5%" across -- READ from `GET /admin/tax-splits`, which derives
 * it with the same function the bill uses. The screen states nothing and
 * computes nothing: a class carries one rate, and there is no CGST or SGST
 * field to type (migration 0050; see TaxRates).
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

/** `null` until read; `'failed'` when the read did not answer -- never an empty map. */
export function useTaxSplits(api: Api): {
  readonly splits: ReadonlyMap<string, TaxClassSplit> | null | 'failed';
  readonly reread: () => Promise<void>;
} {
  const [splits, setSplits] = useState<ReadonlyMap<string, TaxClassSplit> | null | 'failed'>(null);
  const reread = useCallback(async (): Promise<void> => {
    try {
      const body = await api.get<{ rows: readonly TaxClassSplit[] }>('/admin/tax-splits');
      setSplits(new Map(body.rows.map((r) => [r.taxClassId, r])));
    } catch {
      setSplits('failed');
    }
  }, [api]);
  useEffect(() => { void reread(); }, [reread]);
  return { splits, reread };
}

/** 250 -> "2.5%", 500 -> "5%", 5000 -> "50%", 225 -> "2.25%". A rate, not money. */
const pctOfBps = (rateBps: number): string => `${String(Number((rateBps / 100).toFixed(2)))}%`;

const PLACE: Readonly<Record<string, string>> = { intra_state: 'within the state', inter_state: 'across states' };

export function TaxSplitText(props: {
  splits: ReadonlyMap<string, TaxClassSplit> | null | 'failed';
  taxClassId: string;
  className?: string;
}): ReactElement | null {
  if (props.splits === null) return null;
  if (props.splits === 'failed') {
    return <span className={props.className}>The split could not be read just now.</span>;
  }
  const split = props.splits.get(props.taxClassId);
  if (split === undefined) return null;
  if (split.treatments.length === 0) return <span className={props.className}>No tax on the bill.</span>;
  return (
    <span className={props.className}>
      {split.treatments.map((t) => (
        <span key={t.key} className="block">
          {t.heads.map((h) => `${h.name} ${pctOfBps(h.rateBps)}`).join(' + ')}
          <span className="text-muted-foreground"> — {PLACE[t.key] ?? t.name.toLowerCase()}</span>
        </span>
      ))}
    </span>
  );
}
