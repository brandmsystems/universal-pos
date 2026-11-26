import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ArrowLeft, CalendarRange, LoaderCircle, LockKeyhole, LockKeyholeOpen, Minus, PencilLine, Plus, Printer, RefreshCw,
  Search, SendHorizontal,
} from 'lucide-react';
import { cn } from 'cn';
import type { Api } from '../../../services/api.js';
import { describeRefusal } from '../../orders/pos/refusals.js';
import { formatMinor, minorFrom } from '../../../lib/money.js';
import { DEFAULT_LAYOUT, PAPER, type PrintedBill } from '../print/receipt.js';
import { isHandheld, printsDirect, receiptPrinter, sendCopies, type ReceiptPrinter } from '../print/serialPrinter.js';

/**
 * Bill history, bill edits and day end, for the till (`/pos`) and the manager
 * screens (`/admin`) alike. Every figure, every total after an edit and every
 * yes or no is the server's: this screen lists what it is told, previews an
 * edit by asking the server to run it and roll it back, and shows the server's
 * sentence when it refuses. The buttons follow the person's keys and the
 * bill's state, and the server decides again on every write.
 */

export type Capacity = 'pos' | 'manager';
export type EditState = 'editable' | 'locked' | 'submitted' | 'reopened' | 'granted';
type Period = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export interface HistoryAccess {
  readonly base: '/pos' | '/admin';
  readonly capacity: Capacity;
  /** bill.edit on the till, bill.edit.any on the manager screens. */
  readonly canEdit: boolean;
  /** payment.settlement.close. */
  readonly canSubmit: boolean;
  /** payment.settlement.reopen (manager screens only): reopening, and Allow POS Bill Editing. */
  readonly canReopen: boolean;
  /** bill.reprint. */
  readonly canPrint: boolean;
}

/** A write: idempotent on the till (one key per intent), plain on the manager screens. */
export type Write = <T>(path: string, body: unknown, signature: string) => Promise<T>;

interface DayMethod { readonly method: string; readonly payments: number; readonly amountMinor: number }
interface DayFigures {
  readonly billCount: number; readonly voidBillCount: number; readonly salesMinor: number; readonly taxMinor: number;
  readonly payableMinor: number; readonly collectedMinor: number; readonly refundedMinor: number;
  readonly outstandingMinor: number; readonly methods: readonly DayMethod[];
}
interface Submission {
  readonly status: 'submitted' | 'reopened'; readonly submittedAt: string; readonly submittedBy: string | null;
  readonly reopenedAt: string | null; readonly reopenedBy: string | null; readonly reopenReason: string | null;
}
interface HistoryBill {
  readonly billId: string; readonly billNo: number; readonly businessDate: string; readonly generatedAt: string;
  readonly generatedBy: string | null; readonly status: 'open' | 'settled' | 'void'; readonly version: number;
  readonly serviceType: 'dine_in' | 'parcel'; readonly orderNo: number | null; readonly pickupName: string | null;
  readonly subtotalMinor: number; readonly taxMinor: number; readonly totalMinor: number; readonly roundOffMinor: number;
  readonly payableMinor: number; readonly paidMinor: number; readonly refundedMinor: number; readonly outstandingMinor: number;
  readonly methods: readonly string[]; readonly editState: EditState; readonly canEdit: boolean;
  readonly lastEdit: { readonly by: string | null; readonly at: string; readonly authority: Capacity } | null;
  readonly replacedByBillNo: number | null; readonly revisesBillNo: number | null; readonly supplementary: boolean;
}
/** A manager's Allow POS Bill Editing on the day's current submission. */
interface PosEditing {
  readonly on: boolean; readonly enabledBy: string | null; readonly enabledAt: string; readonly reason: string;
  readonly disabledBy: string | null; readonly disabledAt: string | null;
}
interface HistoryDay {
  readonly businessDate: string; readonly state: 'open' | 'submitted' | 'reopened';
  readonly submission: Submission | null; readonly billsSinceSubmission: number;
  readonly posEditing?: PosEditing | null;
  readonly figures: DayFigures; readonly bills: readonly HistoryBill[];
}
interface History {
  readonly period: Period; readonly fromDate: string; readonly toDate: string; readonly today: string;
  readonly days: readonly HistoryDay[];
}
interface DetailLine {
  readonly lineId: string; readonly kind: 'item' | 'combo' | 'charge'; readonly name: string; readonly addOns: readonly string[];
  readonly menuItemId: string | null; readonly modifierOptionIds: readonly string[];
  readonly quantity: number; readonly remainingQuantity: number; readonly amountMinor: number; readonly taxMinor: number;
}
interface Detail {
  readonly bill: HistoryBill;
  readonly lines: readonly DetailLine[];
  readonly tenders: readonly { method: string; kind: string; amountMinor: number; at: string; by: string | null }[];
  readonly refunds: readonly { amountMinor: number; method: string; at: string; by: string | null; note: string | null }[];
  readonly revisions: readonly {
    id: string; authority: Capacity; reason: string; by: string | null; at: string;
    beforePayableMinor: number; afterPayableMinor: number; editedBillNo: number;
    replacementBillNo: number | null; supplementaryBillNo: number | null; refundMinor: number | null;
    reopened: { by: string | null; at: string; reason: string } | null;
    allowedBy?: { by: string | null; at: string; reason: string } | null;
  }[];
}

const money = (minor: number): string => formatMinor(minorFrom(minor));
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (iso: string): string => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayTitle = (date: string, today: string): string => {
  const label = new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return date === today ? `Today · ${label}` : label;
};
const orderLabel = (b: Pick<HistoryBill, 'serviceType' | 'orderNo' | 'pickupName'>): string => {
  const no = b.orderNo === null ? '' : `${b.serviceType === 'parcel' ? 'P' : 'D'}-${b.orderNo}`;
  return [no, b.pickupName].filter((s) => s !== null && s !== '').join(' · ') || (b.serviceType === 'parcel' ? 'Parcel' : 'Dine-in');
};
// Its own copy, not PaymentPanel's: that module is the till's, and importing it
// would carry the payment panel into the manager screens' bundle.
const METHOD_NAME: Readonly<Record<string, string>> = {
  cash: 'Cash', card: 'Card', upi: 'UPI', wallet: 'Wallet', voucher: 'Voucher', other: 'Other',
};
const methodName = (m: string): string => METHOD_NAME[m] ?? m;

const STATE_BADGE: Record<EditState, { label: string; className: string }> = {
  editable: { label: 'Editable', className: 'bg-[#E9F7EF] text-[#1E6B3C]' },
  locked: { label: 'Locked', className: 'bg-[#F2F2F2] text-[#555555]' },
  submitted: { label: 'Submitted', className: 'bg-[#EAF1FB] text-[#1D4F91]' },
  reopened: { label: 'Manager reopened', className: 'bg-[#FFF4E5] text-[#8A4B00]' },
  granted: { label: 'Editing enabled by manager', className: 'bg-[#E9F7EF] text-[#1E6B3C]' },
};

function StateBadge(props: { state: EditState; capacity: Capacity }): ReactElement {
  const badge = STATE_BADGE[props.state];
  // On the till a submitted day's bill is simply locked to it.
  const label = props.state === 'submitted' && props.capacity === 'pos' ? 'Bill locked' : badge.label;
  return <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold', badge.className)}>{label}</span>;
}

const LIVE_EVERY_MS = 15_000;

/**
 * Reads again every 15 s while the page is visible, and when it comes back into
 * view: a manager switching Allow POS Bill Editing shows on the till without a
 * new sign-in. The server still decides every save.
 */
function useLive(refresh: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const tick = (): void => { if (document.visibilityState !== 'hidden') refresh(); };
    const timer = window.setInterval(tick, LIVE_EVERY_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, enabled]);
}

function payBadge(b: HistoryBill): { label: string; className: string } {
  if (b.status === 'void') return { label: b.replacedByBillNo === null ? 'Void' : `Replaced by #${b.replacedByBillNo}`, className: 'bg-[#F2F2F2] text-[#555555] line-through decoration-1' };
  if (b.status === 'settled') return { label: b.refundedMinor > 0 ? 'Paid · refunded' : 'Paid', className: 'bg-[#E9F7EF] text-[#1E6B3C]' };
  return b.paidMinor > 0
    ? { label: 'Part paid', className: 'bg-[#FFF4E5] text-[#8A4B00]' }
    : { label: 'Unpaid', className: 'bg-[#FDECEC] text-[#9B1C1C]' };
}

const action = 'flex h-11 items-center justify-center gap-2 rounded-xl border border-input bg-card px-3 text-sm font-semibold transition-colors hover:bg-background active:scale-[0.98] disabled:opacity-50';
const primary = 'flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-white transition-colors hover:opacity-90 active:scale-[0.98] disabled:opacity-50';
const field = 'h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none';
const panel = 'flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm';

function Alert(props: { tone: 'error' | 'done' | 'note'; children: string }): ReactElement {
  return (
    <p role={props.tone === 'error' ? 'alert' : 'status'} className={cn('m-0 rounded-xl border p-3 text-sm',
      props.tone === 'error' && 'border-destructive bg-destructive/10',
      props.tone === 'done' && 'border-[#7FB07F] bg-[#F1F8F1] text-[#1c6b1c]',
      props.tone === 'note' && 'border-border bg-card text-muted-foreground')}>
      {props.children}
    </p>
  );
}

export function BillHistory(props: {
  api: Api;
  access: HistoryAccess;
  write: Write;
  /** The till's branch when the manager names one (`?branchId=`); empty on the till. */
  query?: string;
  logoUrl?: string | null;
  printer?: ReceiptPrinter;
}): ReactElement {
  const [period, setPeriod] = useState<Period>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [asked, setAsked] = useState<{ period: Period; from: string; to: string; q: string }>({ period: 'today', from: '', to: '', q: '' });
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [dayDialog, setDayDialog] = useState<{ day: HistoryDay; kind: DayDialogKind } | null>(null);
  const [switching, setSwitching] = useState(false);

  const extra = props.query ?? '';
  const read = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) { setBusy(true); setRefusal(null); }
    const params = new URLSearchParams();
    if (asked.period === 'custom') { params.set('from', asked.from); params.set('to', asked.to); } else params.set('period', asked.period);
    if (asked.q.trim() !== '') params.set('q', asked.q.trim());
    try {
      setHistory(await props.api.get<History>(`${props.access.base}/bills?${params.toString()}${extra}`));
    } catch (error) {
      if (!quiet) setRefusal(describeRefusal(error, 'now'));
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [props.api, props.access.base, asked, extra]);
  useEffect(() => { void read(); }, [read]);
  const quietly = useCallback(() => { void read(true); }, [read]);
  useLive(quietly, opened === null && dayDialog === null);

  /** Allow POS Bill Editing off: it only takes a permission back, so it asks no reason. */
  async function switchOff(day: HistoryDay): Promise<void> {
    setSwitching(true);
    setRefusal(null);
    setDone(null);
    try {
      await props.write(`/admin/days/${day.businessDate}/pos-editing/disable${extra.replace(/^&/, '?')}`, {},
        `pos-editing-off:${day.businessDate}`);
      setDone('POS bill editing is off: the till can no longer edit today’s submitted bills.');
      await read(true);
    } catch (error) {
      setRefusal(describeRefusal(error, 'now'));
    } finally {
      setSwitching(false);
    }
  }

  if (opened !== null) {
    return (
      <BillView api={props.api} access={props.access} write={props.write} billId={opened} query={extra}
        logoUrl={props.logoUrl ?? null} printer={props.printer}
        onOpen={setOpened}
        onBack={(message) => { setOpened(null); setDone(message ?? null); void read(); }} />
    );
  }

  const today = history?.today ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Period" className="grid grid-cols-3 gap-1 rounded-xl bg-card p-1 ring-1 ring-border sm:grid-cols-5">
        {([['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom date']] as const).map(([p, label]) => (
          <button key={p} type="button" role="tab" aria-selected={period === p}
            onClick={() => { setPeriod(p); if (p !== 'custom') setAsked({ period: p, from: '', to: '', q: search }); }}
            className={cn('h-10 rounded-lg text-sm font-semibold transition-colors',
              period === p ? 'bg-primary text-white shadow-sm' : 'text-foreground hover:bg-background')}>
            {label}
          </button>
        ))}
      </div>

      {period === 'custom' && (
        <form aria-label="Date range" className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => { e.preventDefault(); if (from !== '' && to !== '') setAsked({ period: 'custom', from, to, q: search }); }}>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
            From date
            <input type="date" value={from} max={to || today || undefined} className={field} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
            To date
            <input type="date" value={to} min={from || undefined} max={today ?? undefined} className={field} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" disabled={from === '' || to === ''} className={cn(action, 'col-span-2 sm:col-span-1')}>
            <CalendarRange aria-hidden className="size-4" /> Show
          </button>
        </form>
      )}

      <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setAsked((a) => ({ ...a, q: search })); }}>
        <label className="sr-only" htmlFor="bill-search">Search bills</label>
        <input id="bill-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Bill no., D-/P- no. or pickup name" className={field} />
        <button type="submit" className={action} aria-label="Search"><Search aria-hidden className="size-4" /></button>
        <button type="button" onClick={() => void read()} disabled={busy} className={action} aria-label="Refresh">
          {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <RefreshCw aria-hidden className="size-4" />}
        </button>
      </form>

      {refusal !== null && <Alert tone="error">{refusal}</Alert>}
      {done !== null && <Alert tone="done">{done}</Alert>}
      {history !== null && history.days.length === 0 && (
        <Alert tone="note">{asked.q.trim() !== '' ? 'No bill matches that search in these dates.' : 'No bills in these dates.'}</Alert>
      )}

      {history?.days.map((day) => (
        <DaySection key={day.businessDate} day={day} today={history.today} access={props.access}
          onOpen={setOpened}
          onSubmit={() => setDayDialog({ day, kind: 'submit' })}
          onReopen={() => setDayDialog({ day, kind: 'reopen' })}
          switching={switching}
          onPosEditing={(on) => { if (on) setDayDialog({ day, kind: 'grant' }); else void switchOff(day); }} />
      ))}

      {dayDialog !== null && (
        <DayDialog api={props.api} access={props.access} write={props.write} day={dayDialog.day} kind={dayDialog.kind}
          today={today ?? dayDialog.day.businessDate} query={extra}
          onClose={(message) => { setDayDialog(null); if (message) { setDone(message); void read(); } }} />
      )}
    </div>
  );
}

function DaySection(props: {
  day: HistoryDay; today: string; access: HistoryAccess;
  onOpen: (billId: string) => void; onSubmit: () => void; onReopen: () => void;
  switching: boolean; onPosEditing: (on: boolean) => void;
}): ReactElement {
  const { day, access } = props;
  const isToday = day.businessDate === props.today;
  const granted = isToday && day.state !== 'open' && day.posEditing?.on === true;
  const state: EditState = granted ? 'granted' : day.state === 'open' ? (isToday ? 'editable' : 'locked') : day.state;
  // The till submits today; the manager any day. A submitted day with bills made since is submitted again.
  const maySubmit = access.canSubmit && (access.capacity === 'manager' || isToday)
    && (day.state !== 'submitted' || day.billsSinceSubmission > 0);
  const f = day.figures;
  return (
    <section aria-label={dayTitle(day.businessDate, props.today)} className={panel}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 grow text-base font-bold">{dayTitle(day.businessDate, props.today)}</h3>
        <StateBadge state={state} capacity={access.capacity} />
      </div>
      {access.capacity === 'pos' && isToday && day.state !== 'open' && (
        granted ? (
          <p role="status" className="m-0 flex items-start gap-2 rounded-xl border border-[#7FB07F] bg-[#F1F8F1] p-3 text-sm text-[#1c6b1c]">
            <LockKeyholeOpen aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span><strong>Editing Enabled by Manager</strong>
              {` · ${day.posEditing!.enabledBy ?? 'A manager'} allowed edits to today’s submitted bills (${time(day.posEditing!.enabledAt)}).`}</span>
          </p>
        ) : (
          <p role="status" className="m-0 flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-sm">
            <LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span><strong>Bill Locked</strong> · Today’s bills are submitted. A manager can allow POS bill editing.</span>
          </p>
        )
      )}
      {access.capacity === 'manager' && access.canReopen && isToday && (
        <PosEditingSwitch day={day} busy={props.switching} onChange={props.onPosEditing} />
      )}
      {day.submission !== null && (
        <p className="m-0 text-xs text-muted-foreground">
          Submitted {when(day.submission.submittedAt)}{day.submission.submittedBy ? ` by ${day.submission.submittedBy}` : ''}
          {day.submission.reopenedAt !== null
            ? ` · reopened ${when(day.submission.reopenedAt)}${day.submission.reopenedBy ? ` by ${day.submission.reopenedBy}` : ''}: “${day.submission.reopenReason ?? ''}”`
            : ''}
          {day.billsSinceSubmission > 0 ? ` · ${day.billsSinceSubmission} bill(s) since` : ''}
        </p>
      )}
      <dl className="m-0 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Figure label="Bills" value={`${f.billCount}${f.voidBillCount > 0 ? ` (+${f.voidBillCount} void)` : ''}`} />
        <Figure label="Sales" value={money(f.payableMinor)} />
        <Figure label="Collected" value={money(f.collectedMinor)} />
        <Figure label={f.refundedMinor > 0 ? 'Refunded' : 'Outstanding'} value={money(f.refundedMinor > 0 ? f.refundedMinor : f.outstandingMinor)} />
      </dl>
      {f.methods.length > 0 && (
        <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {f.methods.map((m) => <span key={m.method}>{methodName(m.method)} {money(m.amountMinor)} ({m.payments})</span>)}
        </p>
      )}
      {(maySubmit || (access.canReopen && day.state === 'submitted')) && (
        <div className="flex flex-wrap gap-2">
          {maySubmit && (
            <button type="button" className={primary} onClick={props.onSubmit}>
              <SendHorizontal aria-hidden className="size-4" /> {day.state === 'submitted' ? 'Submit day again' : 'Submit Day Bills'}
            </button>
          )}
          {access.canReopen && day.state === 'submitted' && (
            <button type="button" className={action} onClick={props.onReopen}>
              <LockKeyholeOpen aria-hidden className="size-4" /> Reopen day for editing
            </button>
          )}
        </div>
      )}
      {day.bills.length > 0 && (
        <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
          {day.bills.map((b) => {
            const pay = payBadge(b);
            return (
              <li key={b.billId}>
                <button type="button" onClick={() => props.onOpen(b.billId)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left hover:bg-background">
                  <span className="w-14 shrink-0 font-mono text-sm font-bold">#{b.billNo}</span>
                  <span className="min-w-0 grow">
                    <span className="block truncate text-sm font-semibold">{orderLabel(b)}{b.supplementary ? ' · added items' : ''}</span>
                    <span className="block text-xs text-muted-foreground">
                      {time(b.generatedAt)}{b.methods.length > 0 ? ` · ${b.methods.map(methodName).join(', ')}` : ''}
                      {b.lastEdit !== null ? ` · edited by ${b.lastEdit.by ?? 'someone'}${b.lastEdit.authority === 'manager' ? ' (manager)' : ''} ${time(b.lastEdit.at)}` : ''}
                    </span>
                  </span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', pay.className)}>{pay.label}</span>
                  <span className="w-24 shrink-0 text-right font-mono text-sm font-semibold tabular-nums">{money(b.payableMinor)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Figure(props: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-xl bg-background px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{props.label}</dt>
      <dd className="m-0 font-mono text-sm font-bold tabular-nums">{props.value}</dd>
    </div>
  );
}

/**
 * Allow POS Bill Editing, on today's card on the manager screens. Off until a
 * manager turns it on after the day is submitted; each new submission starts
 * it off again. Switching it is the server's decision, shown as it answers.
 */
function PosEditingSwitch(props: { day: HistoryDay; busy: boolean; onChange: (on: boolean) => void }): ReactElement {
  const { day } = props;
  const submitted = day.state !== 'open';
  const on = submitted && day.posEditing?.on === true;
  const last = day.posEditing ?? null;
  const note = !submitted ? 'The POS can edit today’s bills until the day is submitted.'
    : on ? `ON · allowed by ${last!.enabledBy ?? 'a manager'} at ${time(last!.enabledAt)}: “${last!.reason}”`
      : last?.disabledAt ? `OFF · switched off by ${last.disabledBy ?? 'a manager'} at ${time(last.disabledAt)}. Submitted bills are read-only on the POS.`
        : 'OFF · Submitted bills are read-only on the POS.';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-background p-3">
      <div className="min-w-0 grow">
        <p id={`pos-editing-${day.businessDate}`} className="m-0 text-sm font-semibold">Allow POS Bill Editing</p>
        <p className="m-0 text-xs text-muted-foreground">{note}</p>
      </div>
      <span className={cn('text-xs font-bold', on ? 'text-[#1E6B3C]' : 'text-muted-foreground')}>{on ? 'ON' : 'OFF'}</span>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`pos-editing-${day.businessDate}`}
        disabled={!submitted || props.busy} onClick={() => props.onChange(!on)}
        className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50',
          on ? 'bg-[#1E6B3C]' : 'bg-[#C9C9C9]')}>
        <span aria-hidden className={cn('absolute top-0.5 size-6 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

type DayDialogKind = 'submit' | 'reopen' | 'grant';

const DIALOG_TITLE: Record<DayDialogKind, string> = {
  submit: 'Submit Day Bills', reopen: 'Reopen day for editing', grant: 'Allow POS Bill Editing',
};

/**
 * Submit Day Bills (the count and totals as the server has them, confirmed), a
 * manager's reopen, or a manager switching Allow POS Bill Editing on -- the last
 * two with a reason, kept with the record.
 */
function DayDialog(props: {
  api: Api; access: HistoryAccess; write: Write; day: HistoryDay; kind: DayDialogKind; today: string; query: string;
  onClose: (message?: string) => void;
}): ReactElement {
  const [review, setReview] = useState<{ figures: DayFigures; openOrders: number | null } | null>(
    props.access.base === '/pos' ? null : { figures: props.day.figures, openOrders: null });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (props.access.base !== '/pos' || props.kind !== 'submit') return;
    props.api.get<{ figures: DayFigures; openOrders: number }>('/pos/day')
      .then((r) => setReview({ figures: r.figures, openOrders: r.openOrders }))
      .catch((error: unknown) => setRefusal(describeRefusal(error, 'now')));
  }, [props.api, props.access.base, props.kind]);

  async function confirm(): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      if (props.kind === 'submit') {
        const expected = { billCount: review!.figures.billCount, payableMinor: review!.figures.payableMinor };
        const path = props.access.base === '/pos' ? '/pos/day/submit' : `/admin/days/${props.day.businessDate}/submit${props.query.replace(/^&/, '?')}`;
        const answer = await props.write<{ alreadySubmitted: boolean }>(path, { expected },
          `day-submit:${props.day.businessDate}:${expected.billCount}:${expected.payableMinor}`);
        props.onClose(answer.alreadySubmitted
          ? 'This day was already submitted with these figures; nothing changed.'
          : `Submitted: ${expected.billCount} bill(s), ${money(expected.payableMinor)}. The till can no longer change this day's bills.`);
      } else if (props.kind === 'reopen') {
        await props.write(`/admin/days/${props.day.businessDate}/reopen${props.query.replace(/^&/, '?')}`, { reason },
          `day-reopen:${props.day.businessDate}:${reason}`);
        props.onClose('The day is reopened. Its bills can now be edited here, by a manager; the till stays locked out.');
      } else {
        await props.write(`/admin/days/${props.day.businessDate}/pos-editing/enable${props.query.replace(/^&/, '?')}`, { reason },
          `pos-editing-on:${props.day.businessDate}:${reason}`);
        props.onClose('POS bill editing is on: the till can edit today’s bills until you switch it off or the day is submitted again.');
      }
    } catch (error) {
      setRefusal(describeRefusal(error, 'now'));
    } finally {
      setBusy(false);
    }
  }

  const f = review?.figures ?? null;
  const blocked = props.kind === 'submit' && (review?.openOrders ?? 0) > 0;
  return (
    <div role="dialog" aria-modal="true" aria-label={props.kind === 'reopen' ? 'Reopen day' : DIALOG_TITLE[props.kind]}
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-t-3xl bg-background p-5 shadow-xl sm:rounded-3xl">
        <h2 className="m-0 text-lg font-bold">
          {DIALOG_TITLE[props.kind]} · {dayTitle(props.day.businessDate, props.today)}
        </h2>
        {props.kind === 'submit' ? (
          f === null ? <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Reading the day…</p> : (
            <>
              <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
                <Figure label="Bills" value={String(f.billCount)} />
                <Figure label="Voided bills" value={String(f.voidBillCount)} />
                <Figure label="Sales (payable)" value={money(f.payableMinor)} />
                <Figure label="Tax" value={money(f.taxMinor)} />
                <Figure label="Collected" value={money(f.collectedMinor)} />
                <Figure label="Refunded" value={money(f.refundedMinor)} />
              </dl>
              {f.methods.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                  {f.methods.map((m) => (
                    <li key={m.method} className="flex justify-between"><span>{methodName(m.method)} ({m.payments})</span><span className="font-mono">{money(m.amountMinor)}</span></li>
                  ))}
                </ul>
              )}
              {blocked
                ? <Alert tone="error">{`${review!.openOrders} order(s) of today are still open. Take their payment or have a manager cancel them, then submit.`}</Alert>
                : <Alert tone="note">After submitting, these bills are locked: the till cannot edit them. Only a manager can reopen the day.</Alert>}
            </>
          )
        ) : (
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {props.kind === 'reopen' ? 'Why is the day being reopened?' : 'Why may the POS edit today’s submitted bills?'}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500}
              className="rounded-xl border border-input bg-card p-3 text-sm font-normal" />
            <span className="text-xs font-normal text-muted-foreground">
              {props.kind === 'reopen' ? 'Kept with the submission. Edits made now are recorded as manager edits.'
                : 'Kept with the permission. The POS may edit today’s bills only, never a previous day’s; each edit is recorded as a POS edit allowed by you.'}
            </span>
          </label>
        )}
        {refusal !== null && <Alert tone="error">{refusal}</Alert>}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={action} onClick={() => props.onClose()} disabled={busy}>Cancel</button>
          <button type="button" className={primary} onClick={() => void confirm()}
            disabled={busy || (props.kind === 'submit' ? f === null || blocked : reason.trim().length < 5)}>
            {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" />
              : props.kind === 'submit' ? <LockKeyhole aria-hidden className="size-4" /> : <LockKeyholeOpen aria-hidden className="size-4" />}
            {props.kind === 'submit' ? 'Submit and lock' : props.kind === 'reopen' ? 'Reopen' : 'Allow editing'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One copy of the bill to the till's printer, the browser's dialog, or a sentence why not (a phone without its printer). */
async function printOne(api: Api, path: string, logoUrl: string | null, printer: ReceiptPrinter): Promise<string> {
  const bill = await api.postDetailed<PrintedBill>(path, {});
  const layout = bill.layout ?? DEFAULT_LAYOUT;
  if (isHandheld() && PAPER[layout.paperSize].roll && !printsDirect(layout, printer)) {
    return 'No receipt printer is connected on this device. Connect it with the Printer button, then print again.';
  }
  const outcome = await sendCopies([{ purpose: 'customer', bill }], layout, { logoUrl }, printer);
  if (outcome.via === 'printer' && outcome.failed.length > 0) return outcome.message ?? 'The printer did not take the copy.';
  return bill.copyNo > 1 ? 'Reprint sent.' : 'Sent to print.';
}

function BillView(props: {
  api: Api; access: HistoryAccess; write: Write; billId: string; query: string;
  logoUrl: string | null; printer: ReceiptPrinter | undefined;
  onOpen: (billId: string) => void; onBack: (message?: string) => void;
}): ReactElement {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const qs = props.query.replace(/^&/, '?');

  const read = useCallback(async (): Promise<void> => {
    try {
      setDetail(await props.api.get<Detail>(`${props.access.base}/bills/${props.billId}${qs}`));
    } catch (error) {
      setRefusal(describeRefusal(error, 'now'));
    }
  }, [props.api, props.access.base, props.billId, qs]);
  useEffect(() => { setDetail(null); setEditing(false); void read(); }, [read]);
  // Kept current while only looked at; an open edit is decided by the server when saved.
  const quietly = useCallback(() => { props.api.get<Detail>(`${props.access.base}/bills/${props.billId}${qs}`).then(setDetail, () => undefined); },
    [props.api, props.access.base, props.billId, qs]);
  useLive(quietly, !editing);

  async function print(): Promise<void> {
    setPrinting(true);
    setRefusal(null);
    try {
      const path = props.access.base === '/pos' ? `/pos/bill/${props.billId}/print` : `/admin/bills/${props.billId}/print${qs}`;
      setNote(await printOne(props.api, path, props.logoUrl, props.printer ?? receiptPrinter()));
    } catch (error) {
      setRefusal(describeRefusal(error, 'now'));
    } finally {
      setPrinting(false);
    }
  }

  const b = detail?.bill ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={action} onClick={() => props.onBack()}><ArrowLeft aria-hidden className="size-4" /> All bills</button>
        <span className="grow" />
        {b !== null && props.access.canPrint && b.status !== 'void' && (
          <button type="button" className={action} onClick={() => void print()} disabled={printing}>
            {printing ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Printer aria-hidden className="size-4" />} Print / Reprint
          </button>
        )}
        {b !== null && props.access.canEdit && b.canEdit && !editing && (
          <button type="button" className={primary} onClick={() => setEditing(true)}><PencilLine aria-hidden className="size-4" /> Edit bill</button>
        )}
      </div>
      {refusal !== null && <Alert tone="error">{refusal}</Alert>}
      {note !== null && <Alert tone="done">{note}</Alert>}
      {b === null ? (refusal === null && <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Reading the bill…</p>) : (
        <>
          <section aria-label={`Bill ${b.billNo}`} className={panel}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="m-0 grow text-lg font-bold">Bill #{b.billNo} · {orderLabel(b)}</h3>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', payBadge(b).className)}>{payBadge(b).label}</span>
              <StateBadge state={b.editState} capacity={props.access.capacity} />
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              {when(b.generatedAt)}{b.generatedBy ? ` · billed by ${b.generatedBy}` : ''}
              {b.revisesBillNo !== null ? ` · ${b.supplementary ? 'adds to' : 'replaces'} bill #${b.revisesBillNo}` : ''}
            </p>
            {!b.canEdit && b.status !== 'void' && (
              <p className="m-0 text-xs text-muted-foreground">
                {b.editState === 'submitted' ? (props.access.capacity === 'manager' ? 'This day is submitted. Reopen it from the list to edit its bills.' : 'Bill locked: this day is submitted. A manager can allow POS bill editing for today.')
                  : b.editState === 'granted' ? 'The POS may edit this bill: a manager allowed POS bill editing for today. To edit it here, reopen the day.'
                  : b.editState === 'reopened' ? 'A manager reopened this day: only a manager can edit it.'
                    : b.editState === 'locked' ? 'A previous day’s bill: only a manager can edit it.' : ''}
              </p>
            )}
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-1 font-semibold">Item</th><th className="pb-1 text-right font-semibold">Qty</th><th className="pb-1 text-right font-semibold">Amount</th>
              </tr></thead>
              <tbody>
                {detail!.lines.map((l) => (
                  <tr key={l.lineId} className="border-t border-border">
                    <td className="py-1.5">{l.name}{l.addOns.length > 0 && <span className="block text-xs text-muted-foreground">{l.addOns.join(', ')}</span>}
                      {l.remainingQuantity < l.quantity && <span className="block text-xs text-[#9B1C1C]">{l.quantity - l.remainingQuantity} taken off since</span>}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{l.quantity}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{money(l.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="m-0 flex flex-col gap-1 border-t border-border pt-2 text-sm">
              <Row label="Subtotal" value={money(b.subtotalMinor)} />
              <Row label="Tax" value={money(b.taxMinor)} />
              {b.roundOffMinor !== 0 && <Row label="Round off" value={money(b.roundOffMinor)} />}
              <Row label="Total" value={money(b.payableMinor)} strong />
              <Row label="Paid" value={money(b.paidMinor)} />
              {b.refundedMinor > 0 && <Row label="Refunded" value={money(b.refundedMinor)} />}
              {b.outstandingMinor > 0 && <Row label="Still to pay" value={money(b.outstandingMinor)} strong />}
            </dl>
          </section>

          {(detail!.tenders.length > 0 || detail!.refunds.length > 0) && (
            <section aria-label="Payments" className={panel}>
              <h4 className="m-0 text-xs font-bold uppercase tracking-wider text-muted-foreground">Payments</h4>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {detail!.tenders.map((t, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2">
                    <span>{t.kind === 'void' ? 'Voided ' : ''}{methodName(t.method)} · {when(t.at)}{t.by ? ` · ${t.by}` : ''}</span>
                    <span className="font-mono">{money(t.amountMinor)}</span>
                  </li>
                ))}
                {detail!.refunds.map((r, i) => (
                  <li key={`r${i}`} className="flex flex-wrap justify-between gap-2 text-[#9B1C1C]">
                    <span>Refund ({methodName(r.method)}) · {when(r.at)}{r.by ? ` · ${r.by}` : ''}{r.note ? ` · “${r.note}”` : ''}</span>
                    <span className="font-mono">−{money(r.amountMinor)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail!.revisions.length > 0 && (
            <section aria-label="Edit history" className={panel}>
              <h4 className="m-0 text-xs font-bold uppercase tracking-wider text-muted-foreground">Edit history</h4>
              <ol className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
                {detail!.revisions.map((rv) => (
                  <li key={rv.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
                    <span className="font-semibold">
                      {rv.authority === 'manager' ? 'Manager edit' : 'POS edit'} by {rv.by ?? 'someone'} · {when(rv.at)}
                    </span>
                    <span>“{rv.reason}”</span>
                    <span className="text-xs text-muted-foreground">
                      Bill #{rv.editedBillNo}: {money(rv.beforePayableMinor)} → {money(rv.afterPayableMinor)}
                      {rv.replacementBillNo !== null ? ` · reissued as #${rv.replacementBillNo}` : ''}
                      {rv.supplementaryBillNo !== null ? ` · added items on #${rv.supplementaryBillNo}` : ''}
                      {rv.refundMinor !== null ? ` · refunded ${money(rv.refundMinor)}` : ''}
                    </span>
                    {rv.reopened !== null && (
                      <span className="text-xs text-[#8A4B00]">Under the reopening by {rv.reopened.by ?? 'a manager'} ({when(rv.reopened.at)}): “{rv.reopened.reason}”</span>
                    )}
                    {rv.allowedBy != null && (
                      <span className="text-xs text-[#1E6B3C]">After day end, allowed by {rv.allowedBy.by ?? 'a manager'} ({when(rv.allowedBy.at)}): “{rv.allowedBy.reason}”</span>
                    )}
                  </li>
                ))}
              </ol>
              {b.replacedByBillNo !== null && (
                <p className="m-0 text-xs text-muted-foreground">This bill was replaced; the current one is #{b.replacedByBillNo}.</p>
              )}
            </section>
          )}

          {editing && (
            <BillEditor api={props.api} access={props.access} write={props.write} detail={detail!} query={props.query}
              onCancel={() => setEditing(false)}
              onDone={(message, nextBillId) => { setEditing(false); setNote(message); if (nextBillId !== null) props.onOpen(nextBillId); else void read(); }} />
          )}
        </>
      )}
    </div>
  );
}

function Row(props: { label: string; value: string; strong?: boolean }): ReactElement {
  return (
    <div className={cn('flex justify-between gap-2', props.strong && 'font-bold')}>
      <dt>{props.label}</dt><dd className="m-0 font-mono tabular-nums">{props.value}</dd>
    </div>
  );
}

interface MenuChoice { readonly id: string; readonly name: string; readonly priceMinor: number }

interface RevisionResult {
  readonly before: { payableMinor: number; totalMinor: number };
  readonly after: { payableMinor: number; totalMinor: number; subtotalMinor: number; taxMinor: number; roundOffMinor: number };
  readonly replacementBill: { billId: string; billNo: number; payableMinor: number } | null;
  readonly supplementaryBill: { billId: string; billNo: number; payableMinor: number } | null;
  readonly refund: { amountMinor: number; method: string } | null;
  readonly collectMinor: number;
  readonly differenceMinor: number;
}

/**
 * Take items off (by quantity) and add items, with a reason. "Check totals" asks
 * the server to run the edit and roll it back; Save runs it. A paid bill on the
 * till only gains items; on the manager screens items taken off are refunded.
 */
function BillEditor(props: {
  api: Api; access: HistoryAccess; write: Write; detail: Detail; query: string;
  onCancel: () => void; onDone: (message: string, nextBillId: string | null) => void;
}): ReactElement {
  const { bill, lines } = props.detail;
  const paid = bill.status === 'settled' || bill.paidMinor > 0;
  const mayRemove = !paid || (props.access.capacity === 'manager' && bill.status === 'settled');
  const [keep, setKeep] = useState<Record<string, number>>(() => Object.fromEntries(lines.map((l) => [l.lineId, l.remainingQuantity])));
  const [adds, setAdds] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<readonly MenuChoice[] | null>(null);
  const [filter, setFilter] = useState('');
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState(bill.methods[0] ?? 'cash');
  const [preview, setPreview] = useState<RevisionResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const qs = props.query.replace(/^&/, '?');
    const load = props.access.base === '/pos'
      ? props.api.get<{ menu: { id: string; name: string; price_minor: string; orderable: boolean }[] }>('/pos/menu')
        .then((r) => r.menu.filter((m) => m.orderable).map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.price_minor) })))
      : props.api.get<{ rows: { id: string; name: string; price_minor: string | number; status: string; kind: string }[] }>(`/admin/menu/items${qs}${qs ? '&' : '?'}limit=200`)
        .then((r) => r.rows.filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.price_minor) })));
    load.then(setMenu).catch(() => setMenu([]));
  }, [props.api, props.access.base, props.query]);

  const remove = lines.flatMap((l) => {
    const taken = l.remainingQuantity - (keep[l.lineId] ?? l.remainingQuantity);
    return taken > 0 ? [{ lineId: l.lineId, quantity: taken }] : [];
  });
  const add = Object.entries(adds).filter(([, q]) => q > 0).map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
  const changed = remove.length + add.length > 0;
  const body = useMemo(() => ({
    expectedVersion: bill.version, reason: reason.trim(), remove, add,
    ...(paid && remove.length > 0 ? { refundMethod } : {}),
  }), [bill.version, reason, remove, add, paid, refundMethod]);
  const signature = `bill-revise:${bill.billId}:${JSON.stringify(body)}`;
  const qs = props.query.replace(/^&/, '?');
  // Any change to the edit makes the last preview stale.
  useEffect(() => { setPreview(null); }, [signature]);

  async function run(kind: 'preview' | 'save'): Promise<void> {
    setBusy(kind);
    setRefusal(null);
    try {
      const path = `${props.access.base}/bills/${bill.billId}/revise${kind === 'preview' ? '/preview' : ''}${qs}`;
      const result = await props.write<RevisionResult>(path, body, `${kind}:${signature}`);
      if (kind === 'preview') { setPreview(result); return; }
      const parts = [
        result.replacementBill !== null ? `Bill #${bill.billNo} is reissued as #${result.replacementBill.billNo}: ${money(result.replacementBill.payableMinor)} to collect.` : null,
        result.supplementaryBill !== null ? `Added items are on bill #${result.supplementaryBill.billNo}: collect ${money(result.supplementaryBill.payableMinor)} at the till.` : null,
        result.refund !== null ? `Refund ${money(result.refund.amountMinor)} by ${methodName(result.refund.method)}.` : null,
      ].filter((s): s is string => s !== null);
      props.onDone(parts.join(' ') || 'The bill is edited.', result.replacementBill?.billId ?? null);
    } catch (error) {
      setRefusal(describeRefusal(error, 'now'));
    } finally {
      setBusy(null);
    }
  }

  const shown = (menu ?? []).filter((m) => filter.trim() === '' || m.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 40);
  return (
    <section aria-label="Edit bill" className={cn(panel, 'ring-2 ring-primary/30')}>
      <h4 className="m-0 text-base font-bold">Edit bill #{bill.billNo}</h4>
      <p className="m-0 text-xs text-muted-foreground">
        {paid
          ? mayRemove ? 'This bill is paid. Items taken off are refunded; items added go on a new bill to collect.'
            : 'This bill is paid. Items can be added (collected as a new bill); taking items off is a refund a manager makes.'
          : 'This bill is not paid yet. It will be reissued with a new number; the old one is kept as void.'}
      </p>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {lines.map((l) => {
          const now = keep[l.lineId] ?? l.remainingQuantity;
          const editable = mayRemove && l.kind === 'item' && l.remainingQuantity > 0;
          return (
            <li key={l.lineId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 grow truncate">{l.name}{l.kind === 'combo' ? ' (combo)' : ''}</span>
              {editable ? (
                <span className="flex items-center gap-1">
                  <button type="button" aria-label={`One less ${l.name}`} className={cn(action, 'h-9 w-9 px-0')} disabled={now <= 0}
                    onClick={() => setKeep((k) => ({ ...k, [l.lineId]: Math.max(0, now - 1) }))}><Minus className="size-4" /></button>
                  <span className={cn('w-8 text-center font-mono', now < l.remainingQuantity && 'font-bold text-[#9B1C1C]')}>{now}</span>
                  <button type="button" aria-label={`One more ${l.name} back`} className={cn(action, 'h-9 w-9 px-0')} disabled={now >= l.remainingQuantity}
                    onClick={() => setKeep((k) => ({ ...k, [l.lineId]: Math.min(l.remainingQuantity, now + 1) }))}><Plus className="size-4" /></button>
                </span>
              ) : <span className="w-[7.5rem] text-right font-mono text-muted-foreground">{l.remainingQuantity}</span>}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="text-xs font-semibold text-muted-foreground" htmlFor="add-item-filter">Add items</label>
        <input id="add-item-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find an item" className={field} />
        {menu === null ? <p className="m-0 text-xs text-muted-foreground">Reading the menu…</p> : (
          <ul className="m-0 grid max-h-56 list-none grid-cols-1 gap-1 overflow-y-auto p-0 sm:grid-cols-2">
            {shown.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-lg bg-background px-2 py-1 text-sm">
                <span className="min-w-0 grow truncate">{m.name} <span className="text-xs text-muted-foreground">{money(m.priceMinor)}</span></span>
                {(adds[m.id] ?? 0) > 0 && (
                  <>
                    <button type="button" aria-label={`Add one less ${m.name}`} className={cn(action, 'h-8 w-8 px-0')}
                      onClick={() => setAdds((a) => ({ ...a, [m.id]: Math.max(0, (a[m.id] ?? 0) - 1) }))}><Minus className="size-3.5" /></button>
                    <span className="w-6 text-center font-mono font-bold">{adds[m.id]}</span>
                  </>
                )}
                <button type="button" aria-label={`Add ${m.name}`} className={cn(action, 'h-8 w-8 px-0')}
                  onClick={() => setAdds((a) => ({ ...a, [m.id]: (a[m.id] ?? 0) + 1 }))}><Plus className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {paid && remove.length > 0 && (
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Refund by
          <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} className={field}>
            {['cash', 'card', 'upi', 'wallet', 'other'].map((m) => <option key={m} value={m}>{methodName(m)}</option>)}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm font-semibold">
        Reason for the edit
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
          placeholder="e.g. Guest changed one thali to a lassi"
          className="rounded-xl border border-input bg-card p-3 text-sm font-normal" />
      </label>

      {preview !== null && (
        <dl className="m-0 flex flex-col gap-1 rounded-xl bg-background p-3 text-sm">
          <Row label="Bill before" value={money(preview.before.payableMinor)} />
          {preview.replacementBill !== null && <Row label="Reissued bill" value={money(preview.after.payableMinor)} strong />}
          {preview.supplementaryBill !== null && <Row label="Added items to collect" value={money(preview.supplementaryBill.payableMinor)} strong />}
          {preview.refund !== null && <Row label={`Refund (${methodName(preview.refund.method)})`} value={money(preview.refund.amountMinor)} strong />}
          <Row label="Difference" value={money(preview.differenceMinor)} />
        </dl>
      )}
      {refusal !== null && <Alert tone="error">{refusal}</Alert>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button type="button" className={action} onClick={props.onCancel} disabled={busy !== null}>Cancel</button>
        <button type="button" className={action} onClick={() => void run('preview')} disabled={busy !== null || !changed || reason.trim().length < 5}>
          {busy === 'preview' ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null} Check totals
        </button>
        <button type="button" className={primary} onClick={() => void run('save')} disabled={busy !== null || preview === null}>
          {busy === 'save' ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null} Save edit
        </button>
      </div>
      {preview === null && changed && reason.trim().length >= 5 && (
        <p className="m-0 text-xs text-muted-foreground">Check totals first: the server works out the new bill, tax and round off.</p>
      )}
    </section>
  );
}
