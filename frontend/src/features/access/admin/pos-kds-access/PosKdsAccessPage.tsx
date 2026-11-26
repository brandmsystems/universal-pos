import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import { TableBones } from '../../../../components/admin/skeletons.js';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { restaurantLinks } from '../../../../lib/restaurantPath.js';
import { AccessList } from './AccessList.js';
import { listAccess, type AccessAccount } from './api.js';

/**
 * POS access: the restaurant's POS link, and who can sign in and how -- read
 * only. Everyone signs in with the username and password the Sales person
 * sets; there are no setup codes and no reset links here.
 */
export function PosKdsAccessPage(props: { api: Api; tenantSlug: string; kot: boolean }): ReactElement {
  const [accounts, setAccounts] = useState<readonly AccessAccount[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  /** Which accounts are shown, by what they work -- from the server's per-screen flags. */
  const [only, setOnly] = useState<'all' | 'kot' | 'billing'>('all');

  const read = useCallback(async (): Promise<void> => {
    try {
      setAccounts(await listAccess(props.api));
      setReadFailed(false);
    } catch {
      setReadFailed(true);
    }
  }, [props.api]);
  useEffect(() => { void read(); }, [read]);

  const origin = window.location.origin;

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-[22px] font-bold tracking-tight">Sale</h1>
        <span className="text-[13px] text-muted-foreground">
          One POS for orders and billing. Staff and managers sign in on it with the username and password your
          Sales person set; the Sales person adds staff and changes their passwords.
        </span>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {restaurantLinks(props.tenantSlug, { kot: props.kot }).map((link) => (
          <a key={link.key} href={link.path} target="_blank" rel="noreferrer"
            className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-4 py-3 hover:bg-accent">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{link.label}</span>
            <span className="font-mono text-sm">{origin}{link.path}</span>
          </a>
        ))}
      </div>

      {readFailed ? (
        <RefusalBanner>The access list did not load. Nothing is shown rather than an empty list.</RefusalBanner>
      ) : accounts === null ? (
        <Loading label="access list" className="flex flex-col gap-[18px]">
          <div className="flex flex-wrap gap-2">
            {[16, 16, 20].map((w, i) => <Skeleton key={i} className="h-10" style={{ width: `${w * 0.25}rem` }} />)}
          </div>
          <div className="overflow-x-auto rounded-[4px] border border-border bg-card">
            <TableBones rows={5} columns={6} />
          </div>
        </Loading>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Show accounts">
            {([['all', 'All', accounts.length],
              ['kot', 'KOT', accounts.filter((a) => a.kotAccess).length],
              ['billing', 'Billing', accounts.filter((a) => a.billingAccess).length]] as const).map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={only === key} onClick={() => setOnly(key)}
                className={`h-10 rounded-md border px-4 text-sm font-semibold ${only === key
                  ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'}`}>
                {label} <span className="font-mono">({count})</span>
              </button>
            ))}
          </div>
          <AccessList accounts={accounts.filter((a) =>
            only === 'all' || (only === 'kot' && a.kotAccess) || (only === 'billing' && a.billingAccess))} />
        </>
      )}
    </div>
  );
}
