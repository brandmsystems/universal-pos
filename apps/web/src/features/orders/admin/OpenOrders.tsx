import { describePlace } from '@universalpos/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api } from '../../../services/api.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { formatMinor, minorFrom } from '../../../lib/money.js';
import { TableSkeleton } from '../../../components/admin/skeletons.js';
import { Missing } from '../../../components/admin/missing.js';
import { DoneBanner, RefusalBanner } from '../../../components/admin/banner.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Card } from '@/components/ui/card.js';

/**
 * Every order still open, from any day -- the manager's view of what is
 * holding a table or still owed, and the two decisions only a manager makes
 * about one: send it back to KOT, or cancel it.
 *
 * Both are the server's decisions to refuse: back to KOT once a bill exists,
 * cancel once any money is in. This screen asks for the reason and shows the
 * server's sentence when it says no; it never decides an order is cancellable.
 */

interface OpenOrder {
  readonly sessionId: string;
  readonly branchName: string;
  readonly businessDate: string;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly tables: readonly string[];
  readonly stage: 'ordering' | 'billing';
  readonly itemCount: number;
  readonly amountMinor: string;
  readonly billedMinor: string | null;
  readonly paidMinor: string;
  readonly openedAt: string;
}

type Action = 'reopen' | 'cancel';

const WHAT: Record<Action, { button: string; ask: string; path: string; done: string }> = {
  reopen: {
    button: 'Send back to KOT',
    ask: 'Why is it going back to KOT?',
    path: 'reopen',
    done: 'is back with KOT and can be changed there.',
  },
  cancel: {
    button: 'Cancel order',
    ask: 'Why is this order being cancelled?',
    path: 'cancel',
    done: 'is cancelled and its tables are free.',
  },
};

function describe(order: OpenOrder): string {
  return describePlace(order);
}

function day(businessDate: string): string {
  return new Date(`${businessDate}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function OpenOrders(props: { api: Api }): ReactElement {
  const [orders, setOrders] = useState<Remote<readonly OpenOrder[]>>(unknown<readonly OpenOrder[]>());
  const [acting, setActing] = useState<{ sessionId: string; action: Action } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    try {
      const body = await props.api.get<{ rows: readonly OpenOrder[] }>('/admin/sessions/open');
      setOrders(known(body.rows));
    } catch (error) {
      setOrders((current) =>
        error instanceof ApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<readonly OpenOrder[]>(
            error instanceof ApiError && error.failure.kind === 'refused'
              && error.failure.status === 403 ? 'not-permitted' : 'read-failed'));
    }
  }, [props.api]);

  useEffect(() => { void read(); }, [read]);

  const start = (sessionId: string, action: Action): void => {
    setActing({ sessionId, action });
    setReason('');
    setRefusal(null);
    setDone(null);
  };

  const confirm = async (order: OpenOrder, action: Action): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      await props.api.postDetailed(`/admin/sessions/${order.sessionId}/${WHAT[action].path}`,
        { reason: reason.trim() });
      setDone(`${describe(order)} ${WHAT[action].done}`);
      setActing(null);
      await read();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const rows = orders.state === 'unknown' ? [] : orders.value;

  return (
    <div className="max-w-[960px]">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Open orders</h1>
      <p className="mb-5 text-[13px] leading-relaxed text-foreground/70 text-pretty">
        Every order not yet paid and closed, from any day, oldest first. An order
        left open holds its tables. Send it back to KOT if items still need
        changing (only before a bill is made), or cancel it if nobody will pay —
        cancelling is refused once any money has been taken.
      </p>

      {refusal !== null && <div className="mb-4"><RefusalBanner>{refusal}</RefusalBanner></div>}
      {done !== null && <div className="mb-4"><DoneBanner>{done}</DoneBanner></div>}

      <Card className="gap-0 rounded-[4px] border-border p-0">
        {orders.state === 'unknown' && orders.reason === 'never-read' ? (
          <TableSkeleton label="open orders" columns={5} rows={4} className="border-0" />
        ) : orders.state === 'unknown' ? (
          <div className="p-5">
            <Missing reason={orders.reason}>
              {orders.reason === 'not-permitted'
                ? 'You do not have permission to see orders.'
                : 'The open orders could not be read just now.'}
            </Missing>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No open orders. Every table is free.</p>
        ) : rows.map((order) => {
          const billed = order.billedMinor !== null;
          const paid = minorFrom(order.paidMinor) !== 0;
          const here = acting?.sessionId === order.sessionId ? acting.action : null;
          return (
            <div key={order.sessionId} className="flex flex-col gap-3 border-b border-border p-4 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-base font-bold">{describe(order)}</span>
                <span className="text-xs text-muted-foreground">{order.branchName}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {day(order.businessDate)} ·{' '}
                  {new Date(order.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="rounded border border-border px-1.5 text-xs font-semibold">
                  {order.stage === 'billing' ? 'With billing' : 'With KOT'}
                </span>
                <div className="grow" />
                <span className="font-mono text-sm tabular-nums">
                  {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} ·{' '}
                  {formatMinor(minorFrom(order.billedMinor ?? order.amountMinor))}
                  {billed ? (paid ? ` · ${formatMinor(minorFrom(order.paidMinor))} paid` : ' · billed, unpaid') : ' · before tax'}
                </span>
              </div>

              {here === null ? (
                <div className="flex flex-wrap gap-2">
                  {order.stage === 'billing' && !billed && (
                    <Button type="button" variant="outline" size="sm" disabled={busy}
                      onClick={() => start(order.sessionId, 'reopen')}>
                      {WHAT.reopen.button}
                    </Button>
                  )}
                  {!paid && (
                    <Button type="button" variant="outline" size="sm" disabled={busy}
                      className="border-destructive text-destructive"
                      onClick={() => start(order.sessionId, 'cancel')}>
                      {WHAT.cancel.button}
                    </Button>
                  )}
                </div>
              ) : (
                <form className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => { e.preventDefault(); void confirm(order, here); }}>
                  <label className="flex min-w-[260px] grow flex-col gap-1">
                    <span className="text-xs font-semibold">{WHAT[here].ask}</span>
                    <Input autoFocus value={reason} maxLength={200}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={here === 'cancel' ? 'Test order / customer left before food' : 'Customer added dessert'} />
                  </label>
                  <Button type="submit" size="sm" disabled={busy || reason.trim().length < 5}
                    variant={here === 'cancel' ? 'destructive' : 'default'}>
                    {busy ? 'Working…' : here === 'cancel'
                      ? (billed ? 'Void the bill and cancel' : 'Cancel the order')
                      : 'Send back'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy}
                    onClick={() => setActing(null)}>
                    Keep it
                  </Button>
                </form>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
