import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { CircleCheck, Clock, Inbox, ReceiptText, Search, ShoppingBag, UtensilsCrossed, Wallet } from 'lucide-react';
import type { Api } from '../../../services/api.js';
import { formatMinor, minorFrom } from '../../../lib/money.js';
import { lineMoney, orderedLines, type Board } from '../../orders/pos/board.js';
import { counterNumber } from '@katkitchen/shared';
import { cn } from 'cn';
import { Skeleton } from '@/components/ui/skeleton.js';
import { describeOrder, type QueueRow } from './Desk.js';

/**
 * The orders at a glance: one card per order, with what was ordered and what it
 * comes to, and the two things the counter does next -- see it, or take the
 * money. Built only from reads the POS already makes: the billing queue for the
 * list, and each order's own board for its lines. Every figure is the server's
 * -- each line's amount, the bill's total (or the order's amount before tax
 * while there is no bill yet). Nothing here adds anything up.
 */

type Filter = 'process' | 'all' | 'completed';

const FILTERS: readonly { readonly key: Filter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'process', label: 'On process' },
  { key: 'completed', label: 'Completed' },
];

const inProcess = (row: QueueRow): boolean => row.status === 'ready' || row.status === 'in_progress';

type Badge = { readonly label: string; readonly note: string; readonly tone: string };

const AMBER = 'border-[#E8B04A]/40 bg-[#FFF6E0] text-[#8A5A00]';
const PAID = 'border-paid/30 bg-paid/10 text-paid';

/**
 * A billed order still open is one of three things, and the server says which:
 * nothing paid yet, part paid, or paid in full and waiting to be completed.
 */
function badgeOf(row: QueueRow): Badge {
  switch (row.status) {
    case 'ready': return { label: 'To bill', note: 'Waiting for payment', tone: 'border-primary/30 bg-accent text-ink-orange' };
    case 'completed': return { label: 'Completed', note: 'Paid', tone: PAID };
    case 'cancelled': return { label: 'Cancelled', note: 'Nothing owed', tone: 'border-border bg-background text-muted-foreground' };
    case 'in_progress':
      return row.payment === 'full' ? { label: 'Paid', note: 'Tap Complete to finish', tone: PAID }
        : row.payment === 'part' ? { label: 'Part paid', note: 'Balance due', tone: AMBER }
          : { label: 'Unpaid', note: 'Bill printed', tone: AMBER };
  }
}

/** Lines shown on a card before "+N more". */

export function OrdersBoard(props: {
  api: Api;
  rows: readonly QueueRow[] | null;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  const [filter, setFilter] = useState<Filter>('process');
  const [search, setSearch] = useState('');
  const rows = useMemo(() => props.rows ?? [], [props.rows]);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((row) => filter === 'all' || (filter === 'process' ? inProcess(row) : !inProcess(row)))
      .filter((row) => term === '' || [describeOrder(row), row.pickupName ?? '', counterNumber(row) ?? '', row.readyBy ?? '']
        .some((text) => text.toLowerCase().includes(term)));
  }, [rows, filter, search]);

  const count = (key: Filter): number =>
    rows.filter((row) => key === 'all' || (key === 'process' ? inProcess(row) : !inProcess(row))).length;

  return (
    <section className="flex min-w-0 flex-col gap-4 p-3 sm:p-5 lg:col-span-2" aria-label="Orders">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 mr-auto text-2xl font-bold tracking-tight">Orders</h1>
        <span className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show orders" className="flex gap-1 rounded-xl bg-card p-1 shadow-sm ring-1 ring-border">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
              className={cn('flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold transition-colors',
                filter === f.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {f.label}
              <span className={cn('rounded-full px-1.5 font-mono text-xs tabular-nums',
                filter === f.key ? 'bg-black/15' : 'bg-background')}>{count(f.key)}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-11 w-full items-center gap-2 rounded-xl border border-input bg-card px-3 shadow-sm focus-within:ring-[3px] focus-within:ring-ring/40 sm:w-72">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a name or order number"
            aria-label="Search orders" className="h-full min-w-0 grow bg-transparent text-sm outline-none" />
        </label>
      </div>

      {props.rows === null ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(290px, 100%), 1fr))' }}>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border p-10 text-center">
          <Inbox aria-hidden className="size-9 text-muted-foreground/70" />
          <p className="m-0 text-muted-foreground">
            {search.trim() !== '' ? 'No order matches that search.' : filter === 'completed' ? 'Nothing completed yet today.' : 'No orders in process.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(290px, 100%), 1fr))' }}>
          {shown.map((row, i) => <OrderCard key={row.sessionId} api={props.api} row={row} index={i} onOpen={props.onOpen} />)}
        </div>
      )}
    </section>
  );
}

function OrderCard(props: { api: Api; row: QueueRow; index: number; onOpen: (sessionId: string) => void }): ReactElement {
  const row = props.row;
  // The order's own lines, re-read when its money or state moves -- never a copy kept elsewhere.
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    props.api.get<Board>(`/pos/session/${row.sessionId}/board`)
      .then((read) => { if (live) { setBoard(read); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [props.api, row.sessionId, row.paidMinor, row.billedMinor, row.status]);

  // Every item, in a list that scrolls inside the card; a parcel charge cleared to 0 is not an item.
  const lines = board === null ? [] : orderedLines(board.lines)
    .filter((l) => !(l.kind === 'charge' && l.line_total_minor !== null && minorFrom(l.line_total_minor) === 0));
  const status = badgeOf(row);
  const parcel = row.serviceType === 'parcel';
  const number = counterNumber(row) ?? (row.tables.length > 0 ? row.tables.join('+') : '—');
  const open = inProcess(row);
  const total = row.billedMinor ?? row.amountMinor;

  return (
    <article style={{ animationDelay: `${Math.min(props.index, 8) * 30}ms` }}
      className="flex flex-col rounded-2xl border border-border bg-card shadow-sm transition-shadow animate-in fade-in slide-in-from-bottom-1 fill-mode-both hover:shadow-md">
      <header className="flex items-start gap-3 p-4 pb-3">
        <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl font-mono text-sm font-bold',
          parcel ? 'bg-accent text-ink-orange' : 'bg-primary text-primary-foreground')}>
          {number}
        </span>
        <div className="flex min-w-0 grow flex-col">
          <span className="truncate text-base font-bold">{row.pickupName ?? (parcel ? 'Parcel' : 'Dine-in')}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {parcel ? <ShoppingBag aria-hidden className="size-3" /> : <UtensilsCrossed aria-hidden className="size-3" />}
            {describeOrder(row)}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold', status.tone)}>
            {row.status === 'completed' || row.payment === 'full' ? <CircleCheck aria-hidden className="size-3" /> : <Clock aria-hidden className="size-3" />}
            {status.label}
          </span>
          <span className="text-[11px] text-muted-foreground">{status.note}</span>
        </div>
      </header>

      <div className="flex items-center justify-between border-y border-dashed border-border px-4 py-2 text-xs text-muted-foreground">
        <span>{new Date(row.readyAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span className="font-mono tabular-nums">{new Date(row.readyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="flex grow flex-col px-4 py-3 text-sm">
        <div className="mb-1 grid grid-cols-[minmax(0,1fr)_2.5rem_5.5rem] text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Items</span><span className="text-center">Qty</span><span className="text-right">Amount</span>
        </div>
        {board === null ? (
          failed ? <p className="m-0 py-2 text-xs text-destructive">The items could not be read.</p> : (
            <div className="flex flex-col gap-2 py-1">
              {Array.from({ length: Math.min(row.itemCount, 3) || 1 }, (_, i) => <Skeleton key={i} className="h-4" />)}
            </div>
          )
        ) : (
          <ul aria-label="Items" className="m-0 flex max-h-[6.75rem] list-none flex-col gap-1 overflow-y-auto overscroll-contain p-0 pr-1">
            {lines.map((line) => {
              const money = lineMoney(line);
              return (
                <li key={line.id} className="grid grid-cols-[minmax(0,1fr)_2.5rem_5.5rem] items-baseline">
                  <span className="truncate">{line.display_name}</span>
                  <span className="text-center font-mono tabular-nums">{line.quantity}</span>
                  <span className="text-right font-mono tabular-nums">{money === null ? '—' : formatMinor(money)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-baseline justify-between border-t border-border px-4 py-3">
        <span className="text-sm font-semibold">{row.billedMinor === null ? 'Total (before tax)' : 'Total'}</span>
        <span className="font-mono text-lg font-bold tabular-nums">{formatMinor(minorFrom(total))}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 pb-4">
        <button type="button" onClick={() => props.onOpen(row.sessionId)}
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-input bg-card text-sm font-semibold transition-colors hover:bg-background active:scale-[0.98]">
          <ReceiptText aria-hidden className="size-4" /> See details
        </button>
        <button type="button" disabled={!open} onClick={() => props.onOpen(row.sessionId)}
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-[transform,filter] hover:brightness-105 active:scale-[0.98] disabled:opacity-40">
          <Wallet aria-hidden className="size-4" /> {!open ? 'Paid' : row.payment === 'full' ? 'Complete' : 'Pay bill'}
        </button>
      </div>
    </article>
  );
}
