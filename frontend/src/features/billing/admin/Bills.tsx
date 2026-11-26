import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../services/api.js';
import { BillHistory, type HistoryAccess, type Write } from '../history/BillHistory.js';

/**
 * The manager's bill history: every day's bills, editing any day (a submitted
 * one only after reopening it, with a reason), reopening and submitting days.
 * The buttons follow the manager's own keys on /me; the server decides again.
 */
export function Bills(props: { api: Api; logoUrl?: string | null }): ReactElement {
  const [access, setAccess] = useState<HistoryAccess | null>(null);
  useEffect(() => {
    let live = true;
    props.api.get<{ screens?: Record<string, boolean | undefined> }>('/me')
      .then((read) => {
        if (!live) return;
        const s = read.screens ?? {};
        setAccess({
          base: '/admin', capacity: 'manager', canEdit: s['billEditAny'] === true,
          canSubmit: s['dayEnd'] === true, canReopen: s['dayReopen'] === true, canPrint: true,
        });
      })
      .catch(() => { if (live) setAccess({ base: '/admin', capacity: 'manager', canEdit: false, canSubmit: false, canReopen: false, canPrint: true }); });
    return () => { live = false; };
  }, [props.api]);
  const write: Write = <T,>(path: string, body: unknown): Promise<T> => props.api.postDetailed<T>(path, body);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <h1 className="m-0 text-2xl font-bold tracking-[-0.4px]">Bills</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Every bill by business day, with the day’s totals. The till edits only today’s bills until Submit Day Bills;
          after that, reopen the day here to edit, and every edit is recorded as a manager edit with its reason.
        </p>
      </div>
      {access !== null && <BillHistory api={props.api} access={access} write={write} logoUrl={props.logoUrl ?? null} />}
    </div>
  );
}
