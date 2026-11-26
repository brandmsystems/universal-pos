import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, CircleCheck, Inbox, LayoutGrid, LoaderCircle, Plus, Printer, ReceiptText, ShoppingBag, UtensilsCrossed,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { ApiError, type Api, type DeviceIdentity } from '../../../services/api.js';
import type { Leases } from '../../../services/lease.js';
import type { ConsensusKeys } from '../../../lib/consensus.js';
import { formatMinor, minorFrom, minorFromTyped, typedFromMinor } from '../../../lib/money.js';
import { lineMoney, orderedLines, adjustmentLines, type Board, type BillRow } from '../../orders/pos/board.js';
import { describeRefusal } from '../../orders/pos/refusals.js';
import { NewOrder } from './NewOrder.js';
import { OrdersBoard } from './OrdersBoard.js';
import {
  DEFAULT_LAYOUT, PAPER, printHtml, renderCopiesHtml, type CopyPage, type CopyPurpose, type KitchenTicketCopy, type PrintLayout,
  type PrintedBill,
} from '../print/receipt.js';
import { PrintPreview } from '../print/PrintPreview.js';
import { isHandheld, printsDirect, receiptPrinter, sendCopies, type CopiesOutcome, type ReceiptPrinter } from '../print/serialPrinter.js';
import { METHOD_LABEL, PaymentPanel, type PaymentPart, type PaymentResult } from './PaymentPanel.js';
import { cn } from 'cn';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { describePlace } from '@universalpos/shared';

/**
 * The POS (Basic): New order, the orders waiting for payment, the order itself,
 * and the bill and payment. Every figure is the server's -- the queue's amount from
 * the order lines, the bill's subtotal, tax and total from the bill it made, and
 * what is paid and outstanding from the tender rows. This screen adds nothing up.
 */

export type QueueStatus = 'ready' | 'in_progress' | 'completed' | 'cancelled';
/** How much of the bill is paid, as the server compared it. */
export type QueuePayment = 'none' | 'part' | 'full';

export interface QueueRow {
  readonly sessionId: string;
  readonly orderId: string | null;
  readonly businessDate: string;
  /** Still open from an earlier business day -- the server says so. */
  readonly leftover: boolean;
  readonly serviceType: 'dine_in' | 'parcel';
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly tables: readonly string[];
  readonly itemCount: number;
  readonly amountMinor: string;
  readonly billedMinor: string | null;
  readonly paidMinor: string;
  readonly payment: QueuePayment;
  readonly readyAt: string;
  readonly readyBy: string | null;
  readonly status: QueueStatus;
}

interface QueueRead { readonly kot: boolean; readonly rows: readonly QueueRow[] }

type Tab = Exclude<QueueStatus, 'cancelled'>;

const TABS: readonly { readonly status: Tab; readonly label: string }[] = [
  { status: 'ready', label: 'To bill' },
  { status: 'in_progress', label: 'Billed' },
  { status: 'completed', label: 'Completed' },
];

/** A cancelled order is finished too; it sits with the completed ones. */
function tabOf(status: QueueStatus): Tab {
  return status === 'cancelled' ? 'completed' : status;
}

/** "1 Oct", for an order left over from an earlier day. */
export function dayLabel(businessDate: string): string {
  return new Date(`${businessDate}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const POLL_MS = 5_000;

export function describeOrder(row: Pick<QueueRow, 'serviceType' | 'parcelNo' | 'pickupName' | 'tables'>): string {
  return describePlace(row);
}

/**
 * The one POS screen: take the order (New order, which sends it to the kitchen),
 * then bill it and take the money. Orders not yet paid stay in the list, so a
 * part payment is finished later from here.
 */
export function BillingWorkspace(props: {
  api: Api;
  device: DeviceIdentity;
  billingLeases: Leases;
  /** The ordering stage's leases, for New order. Renewed by whoever owns them. */
  orderLeases: Leases;
  keys: ConsensusKeys;
  /** The restaurant's logo, for a bill layout that prints it. */
  logoUrl?: string | null;
  /** This till's receipt printer; the page's own when not given. */
  printer?: ReceiptPrinter | undefined;
}): ReactElement {
  const [queue, setQueue] = useState<QueueRead | null>(null);
  const [queueFailed, setQueueFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('ready');
  const [selected, setSelected] = useState<string | null>(null);
  // The till opens on a new order: taking one is what the counter does first.
  const [creating, setCreating] = useState(true);
  /** The order just confirmed: its bill is made as soon as Billing holds it. */
  const [justConfirmed, setJustConfirmed] = useState<string | null>(null);

  useEffect(() => props.billingLeases.startRenewing(props.device.deviceId),
    [props.billingLeases, props.device.deviceId]);

  const read = useCallback(async (): Promise<void> => {
    try {
      setQueue(await props.api.get<QueueRead>('/billing/queue'));
      setQueueFailed(false);
    } catch {
      setQueueFailed(true);
    }
  }, [props.api]);

  // Nobody sees a hidden till's queue, so it is not read until the tab is shown
  // again (and then at once). One read at a time: on a slow answer the next tick
  // would otherwise start a second, and the older answer could land last.
  const reading = useRef(false);
  useEffect(() => {
    const tick = (): void => {
      if (reading.current || document.visibilityState === 'hidden') return;
      reading.current = true;
      void read().finally(() => { reading.current = false; });
    };
    const onVisible = (): void => { if (document.visibilityState === 'visible') tick(); };
    tick();
    const handle = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const rows = queue?.rows ?? [];
  const shown = rows.filter((row) => tabOf(row.status) === tab);
  const current = rows.find((row) => row.sessionId === selected) ?? null;
  // Below lg one pane at a time: the list, or what is being worked on. The same
  // selection state decides both; nothing new is stored.
  // The Orders board fills the work area whenever nothing else does; on a phone
  // it is its own screen, opened from the list.
  const [boardOpen, setBoardOpen] = useState(false);
  const working = creating || current !== null || boardOpen;
  const openOrder = (sessionId: string): void => { setSelected(sessionId); setCreating(false); setBoardOpen(false); };

  return (
    <div className="grid grow grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_360px] 2xl:grid-cols-[300px_minmax(0,1fr)_380px]">
      {/* ---- the queue ------------------------------------------------- */}
      <aside className={cn('flex-col border-r border-border bg-card', working ? 'hidden lg:flex' : 'flex')}>
        <button type="button" onClick={() => { setCreating(true); setSelected(null); setBoardOpen(false); }}
          className="m-3 mb-2 flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-base font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98]">
          <Plus aria-hidden className="size-5" />
          New order
        </button>
        <button type="button" onClick={() => { setCreating(false); setSelected(null); setBoardOpen(true); }}
          aria-pressed={!creating && current === null}
          className={cn('mx-3 mb-3 flex h-11 items-center justify-center gap-2 rounded-md border text-sm font-semibold transition-colors',
            !creating && current === null ? 'border-primary bg-accent text-ink-orange' : 'border-input bg-card hover:bg-background')}>
          <LayoutGrid aria-hidden className="size-4" />
          Orders
        </button>
        <div className="grid grid-cols-3 border-b border-border">
          {TABS.map((t) => {
            const count = rows.filter((row) => tabOf(row.status) === t.status).length;
            return (
              <button key={t.status} type="button" onClick={() => setTab(t.status)} aria-pressed={tab === t.status}
                className={cn('flex flex-col items-center gap-0.5 border-b-2 px-2 py-3 text-xs font-semibold transition-colors duration-150',
                  tab === t.status ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                <span className="font-mono text-lg tabular-nums">{count}</span>
                {t.label}
              </button>
            );
          })}
        </div>
        {queueFailed && (
          <p className="m-3 rounded-md border border-destructive p-3 text-sm text-destructive">
            The queue could not be read. What is shown may be out of date.
          </p>
        )}
        <div className="flex flex-col">
          {queue === null ? (
            // A failed first read is said above; nothing here claims it is coming.
            queueFailed ? null : (
              <Loading label="queue" className="flex flex-col gap-2 p-3">
                {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}
              </Loading>
            )
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Inbox aria-hidden className="size-8 text-muted-foreground/70" />
              <p className="m-0 text-sm text-muted-foreground">
                {tab === 'ready'
                  ? 'Nothing waiting. Start one with New order.'
                  : 'None.'}
              </p>
            </div>
          ) : shown.map((row) => (
            <button key={row.sessionId} type="button" onClick={() => openOrder(row.sessionId)}
              aria-current={selected === row.sessionId ? 'true' : undefined}
              className={cn('flex flex-col gap-1 border-b border-l-[3px] border-b-border px-4 py-3 text-left transition-colors duration-150',
                selected === row.sessionId ? 'border-l-primary bg-primary/5' : 'border-l-transparent hover:bg-background')}>
              <span className="flex items-baseline gap-2">
                {row.serviceType === 'parcel'
                  ? <ShoppingBag aria-hidden className="size-4 shrink-0 self-center text-ink-orange" />
                  : <UtensilsCrossed aria-hidden className="size-4 shrink-0 self-center text-muted-foreground" />}
                <span className="font-semibold">{describeOrder(row)}</span>
                {row.leftover && (
                  <span className="rounded border border-destructive px-1.5 text-xs font-semibold text-destructive">
                    from {dayLabel(row.businessDate)}
                  </span>
                )}
                {row.status === 'cancelled' && (
                  <span className="rounded border border-border px-1.5 text-xs font-semibold text-muted-foreground">
                    Cancelled
                  </span>
                )}
                <span className="ml-auto font-mono text-sm tabular-nums">
                  {formatMinor(minorFrom(row.billedMinor ?? row.amountMinor))}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {row.itemCount} {row.itemCount === 1 ? 'item' : 'items'}
                {' · '}{new Date(row.readyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {row.readyBy ? ` · by ${row.readyBy}` : ''}
                {row.billedMinor === null ? ' · before tax' : ''}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {working && (
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
          <button type="button" onClick={() => { setCreating(false); setSelected(null); setBoardOpen(false); }}
            className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-foreground transition-colors hover:bg-background">
            <ArrowLeft aria-hidden className="size-4" />
            Orders ({rows.filter((row) => tabOf(row.status) !== 'completed').length})
          </button>
        </div>
      )}
      {creating ? (
        <div className="lg:col-span-2">
          <NewOrder api={props.api} device={props.device} leases={props.orderLeases} kot={queue?.kot ?? false}
            onCancel={() => setCreating(false)}
            onHandedOver={(sessionId) => {
              setCreating(false); setTab('ready'); setSelected(sessionId); setJustConfirmed(sessionId); void read();
            }} />
        </div>
      ) : current === null ? (
        <div className={cn('lg:col-span-2', boardOpen ? 'block' : 'hidden lg:block')}>
          <OrdersBoard api={props.api} rows={queue?.rows ?? null} onOpen={openOrder} />
        </div>
      ) : (
        <OrderAndBill key={current.sessionId} api={props.api} device={props.device} row={current}
          leases={props.billingLeases} keys={props.keys} onChanged={() => void read()}
          billNow={justConfirmed === current.sessionId} logoUrl={props.logoUrl ?? null} printer={props.printer} />
      )}
    </div>
  );
}

/* ------------------------------------------------------ order and bill --- */



function OrderAndBill(props: {
  api: Api;
  device: DeviceIdentity;
  row: QueueRow;
  leases: Leases;
  keys: ConsensusKeys;
  onChanged: () => void;
  /** Just confirmed at this counter: make its bill straight away, once. */
  billNow?: boolean;
  /** The restaurant's logo, for a bill layout that prints it. */
  logoUrl?: string | null;
  printer?: ReceiptPrinter | undefined;
}): ReactElement {
  const sessionId = props.row.sessionId;
  const [board, setBoard] = useState<Board | null>(null);
  // Its own flag, not `refusal`: a refused lease claim says nothing about the board.
  const [boardFailed, setBoardFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const completed = props.row.status === 'completed' || props.row.status === 'cancelled';

  const read = useCallback(async (): Promise<void> => {
    try {
      setBoard(await props.api.get<Board>(`/pos/session/${sessionId}/board`));
      setBoardFailed(false);
    } catch (error) {
      setBoardFailed(true);
      setRefusal(describeRefusal(error, 'money'));
    }
  }, [props.api, sessionId]);

  // Billing holds the order while it works on it: the claim is Billing's own
  // route and key, and the server refuses it unless KOT handed the order over.
  // Until the claim answers, nothing here can be written: a tap on Create bill
  // in that instant was refused with "not holding the order", which reads as
  // a fault. The buttons wait instead, and say why.
  const [holding, setHolding] = useState(() => props.leases.tokenFor(sessionId) !== null);
  useEffect(() => {
    void read();
    if (completed) return;
    props.leases.claim(sessionId, props.device.branchId, props.device.deviceId)
      .then(() => setHolding(true))
      .catch((error: unknown) => setRefusal(describeRefusal(error, 'money')));
  }, [read, completed, props.leases, sessionId, props.device.branchId, props.device.deviceId]);

  const bills: readonly BillRow[] = board?.bills ?? [];
  const bill = bills.find((b) => !b.settled) ?? bills[0] ?? null;
  const allSettled = bills.length > 0 && bills.every((b) => b.settled);

  /**
   * The copies of a paid order (Basic): CUSTOMER, KITCHEN and BILLING COUNTER,
   * as the branch's print settings choose. The customer and counter copies are
   * ONE counted print of the bill; the kitchen copy is the kitchen ticket's own
   * text, READ -- never a new print job, never a new ticket, never a new order.
   * A copy that could not be fetched is named, and its Reprint stays.
   */
  const [failedCopies, setFailedCopies] = useState<readonly string[]>([]);
  // Whether this counter has already put out the kitchen copy: the next one says REPRINT.
  const kitchenShown = useRef(false);
  const [preview, setPreview] = useState<{ readonly pages: readonly CopyPage[]; readonly layout: PrintLayout } | null>(null);
  async function fetchCopies(billId: string, which: 'all' | CopyPurpose): Promise<{ pages: CopyPage[]; layout: PrintLayout } | null> {
    setBusy(`print-${which}`);
    setRefusal(null);
    const failed: string[] = [];
    const parcel = props.row.serviceType === 'parcel';
    let bill: PrintedBill | null = null;
    let tickets: readonly KitchenTicketCopy[] = [];
    if (which !== 'kitchen') {
      try {
        bill = await props.api.postDetailed<PrintedBill>(`/pos/bill/${billId}/print`, {});
      } catch {
        failed.push(which === 'all' ? 'customer and counter' : which);
      }
    }
    const layout = bill?.layout ?? DEFAULT_LAYOUT;
    const wanted = (purpose: CopyPurpose): boolean => which === purpose || (which === 'all' && layout.copies[purpose]);
    if (wanted('kitchen')) {
      try {
        tickets = props.row.orderId === null ? []
          : await props.api.get<KitchenTicketCopy[]>(`/pos/order/${props.row.orderId}/tickets`);
      } catch { /* named below */ }
      if (tickets.length === 0) failed.push('kitchen');
    }
    const printed = bill;
    const pages: CopyPage[] = [
      ...(printed !== null && wanted('customer') ? [{ purpose: 'customer' as const, bill: printed }] : []),
      ...tickets.map((ticket) => ({ purpose: 'kitchen' as const, ticket, parcel, reprint: kitchenShown.current })),
      ...(printed !== null && wanted('counter') ? [{ purpose: 'counter' as const, bill: printed }] : []),
    ];
    if (tickets.length > 0) kitchenShown.current = true;
    setFailedCopies(failed);
    setBusy(null);
    return pages.length === 0 ? null : { pages, layout };
  }

  /**
   * A reprint, or the bill alone. Straight to the till's own printer when it
   * prints directly (no preview, no dialog); otherwise into the preview, printed
   * from there. Nothing is ordered or sent again either way.
   */
  async function printCopies(billId: string, which: 'all' | CopyPurpose): Promise<void> {
    const copies = await fetchCopies(billId, which);
    if (copies === null) return;
    if (printsDirect(copies.layout, tillPrinter())) await deliver(copies);
    else if (handheldRoll(copies.layout)) noPrinterHere(copies);
    else setPreview(copies);
  }
  const printPreviewed = (): void => {
    if (preview === null) return;
    const copies = preview;
    void deliver(copies).then((outcome) => { if (outcome?.via === 'printer') setPreview(null); });
  };

  /**
   * A phone or tablet never opens a preview or the print dialog for a receipt
   * roll by itself: the copies go to the printer connected on the device, or the
   * till says why they did not. A sheet (A4, A5) prints as it always has.
   */
  const tillPrinter = (): ReceiptPrinter => props.printer ?? receiptPrinter();
  const handheldRoll = (layout: PrintLayout): boolean => isHandheld() && PAPER[layout.paperSize].roll;
  function noPrinterHere(copies: { readonly pages: readonly CopyPage[]; readonly layout: PrintLayout }): void {
    setPrintDone(null);
    setPrintTrouble({
      ...copies,
      message: tillPrinter().state().kind === 'unsupported'
        ? 'This browser cannot print to a receipt printer directly. Use Chrome or Edge on Android or Windows, or the print dialog below.'
        : 'No receipt printer is connected on this device. Connect it with the Printer button at the top, then Retry.',
    });
  }
  /** Retry: a handheld still without its printer is told again, never sent to the dialog. */
  const retryPrint = (copies: { readonly pages: readonly CopyPage[]; readonly layout: PrintLayout }): void => {
    if (handheldRoll(copies.layout) && !printsDirect(copies.layout, tillPrinter())) noPrinterHere(copies);
    else void deliver(copies);
  };

  /**
   * Copies already fetched go to the printer (sendCopies decides: the till's own
   * USB or Bluetooth printer, or the print dialog). What the printer did not take
   * is kept, and Retry resends exactly those pages -- no bill print, ticket,
   * order or payment is asked for again.
   */
  const [printTrouble, setPrintTrouble] = useState<{ readonly pages: readonly CopyPage[]; readonly layout: PrintLayout; readonly message: string } | null>(null);
  // What a handheld printed, said briefly: it has no dialog to show it happened.
  const [printDone, setPrintDone] = useState<string | null>(null);
  useEffect(() => {
    if (printDone === null) return;
    const handle = setTimeout(() => setPrintDone(null), 4000);
    return () => clearTimeout(handle);
  }, [printDone]);
  // One send at a time: a second tap while copies are going out would print them twice.
  const sending = useRef(false);
  const [printing, setPrinting] = useState(false);
  async function deliver(copies: { readonly pages: readonly CopyPage[]; readonly layout: PrintLayout }): Promise<CopiesOutcome | null> {
    if (sending.current) return null;
    sending.current = true;
    setPrinting(true);
    setPrintTrouble(null);
    setPrintDone(null);
    try {
      const outcome = await sendCopies(copies.pages, copies.layout, { logoUrl: props.logoUrl ?? null }, props.printer);
      if (outcome.via === 'printer' && outcome.failed.length > 0) {
        setPrintTrouble({ pages: outcome.failed, layout: copies.layout, message: outcome.message ?? 'The printer did not take every copy.' });
      } else if (outcome.via === 'printer' && isHandheld()) {
        const names = copies.pages.map((p) => p.purpose).join(', ');
        setPrintDone(`Printed: ${names} ${copies.pages.length > 1 ? 'copies' : 'copy'}.`);
      }
      return outcome;
    } catch (error) {
      setPrintTrouble({ ...copies, message: error instanceof Error && error.message ? error.message : 'The printer did not take the copies.' });
      return null;
    } finally {
      sending.current = false;
      setPrinting(false);
    }
  }

  /**
   * Confirming an order prints nothing: the copies print once the bill is paid
   * in full -- straight to the printer when the branch prints automatically or
   * the till prints directly, otherwise into the preview with a Print button. On
   * a phone or tablet a receipt roll goes to the device's own printer or nowhere,
   * never the preview or the dialog. A part payment prints nothing by itself;
   * Print bill is there for it.
   */
  const printedFor = useRef<string | null>(null);
  async function printWhenPaid(billId: string): Promise<void> {
    const copies = await fetchCopies(billId, 'all');
    if (copies === null) return;
    if (printsDirect(copies.layout, tillPrinter())) await deliver(copies);
    else if (handheldRoll(copies.layout)) noPrinterHere(copies);
    else if (copies.layout.autoPrint) await deliver(copies);
    else setPreview(copies);
  }

  /** All methods in one write; the answer (change, balance, status) is the server's. */
  async function pay(parts: readonly PaymentPart[]): Promise<PaymentResult | null> {
    if (bill === null) return null;
    const leaseToken = props.leases.tokenFor(sessionId);
    if (leaseToken === null) {
      setRefusal('This counter is not holding the order. Choose it again from the queue.');
      return null;
    }
    const signature = `payment:${bill.id}:${bill.paid_minor}:${JSON.stringify(parts)}`;
    setBusy('pay');
    setRefusal(null);
    try {
      const result = await props.api.send<PaymentResult>('POST', `/pos/bill/${bill.id}/payment`, { parts },
        { idempotencyKey: props.keys.for(signature), leaseToken });
      props.keys.retire(signature);
      await read();
      props.onChanged();
      // Paid in full: the copies print now, once. A retried payment replays the
      // same answer and lands here again; the ref keeps it to one print.
      if (result.outstandingMinor <= 0 && printedFor.current !== bill.id) {
        printedFor.current = bill.id;
        const billId = bill.id;
        setTimeout(() => { void printWhenPaid(billId); }, 0);
      }
      // The last bill paid in full completes the order: paying and closing were
      // two taps, and an order paid but never closed stayed on the board as owed.
      // The server still refuses the close while anything is owed.
      if (result.outstandingMinor <= 0 && bills.every((b) => b.id === bill.id || b.settled)) {
        await write('close', 'DELETE', `/pos/session/${sessionId}`, undefined, `close:${sessionId}`);
      }
      return result;
    } catch (error) {
      setRefusal(error instanceof ApiError && error.failure.kind === 'offline'
        ? 'No connection, so nothing was recorded. Payment is never taken offline.'
        : describeRefusal(error, 'money'));
      await read();
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function write(label: string, method_: 'POST' | 'DELETE', path: string, body: unknown, signature: string): Promise<boolean> {
    const leaseToken = props.leases.tokenFor(sessionId);
    if (leaseToken === null) {
      setRefusal('This counter is not holding the order. Choose it again from the queue.');
      return false;
    }
    setBusy(label);
    setRefusal(null);
    try {
      await props.api.send(method_, path, body, { idempotencyKey: props.keys.for(signature), leaseToken });
      props.keys.retire(signature);
      await read();
      props.onChanged();
      return true;
    } catch (error) {
      setRefusal(error instanceof ApiError && error.failure.kind === 'offline'
        ? 'No connection, so nothing was recorded. Payment is never taken offline.'
        : describeRefusal(error, 'money'));
      await read();
      return false;
    } finally {
      setBusy(null);
    }
  }

  // A just-confirmed order goes straight to payment. The same idempotency key as
  // the Create bill button, so the two can never make two bills.
  const autoBilled = useRef(false);
  useEffect(() => {
    if (!props.billNow || autoBilled.current || !holding || board === null || bills.length > 0 || completed) return;
    autoBilled.current = true;
    void write('bill', 'POST', `/pos/session/${sessionId}/bill`, { splitKind: 'whole' }, `bill:${sessionId}`);
  });

  // A parcel charge cleared to 0 stays as a line (a voided bill points at it) and is not shown.
  const shown = (line: { kind: string; line_total_minor: string | null }): boolean =>
    !(line.kind === 'charge' && line.line_total_minor !== null && minorFrom(line.line_total_minor) === 0);
  const lines = board === null ? [] : orderedLines(board.lines).filter(shown);
  const chargeLine = board?.lines.find((l) => l.kind === 'charge') ?? null;
  const moneyIn = bills.some((b) => minorFrom(b.paid_minor) !== 0);
  const editsCharge = props.row.serviceType === 'parcel' && props.row.orderId !== null && board !== null
    && !moneyIn && !completed;

  /**
   * The parcel charge, changed or removed before any money is taken. The server
   * voids the unpaid bill (a snapshot of the old charge), so the bill is made
   * again straight after -- the same route and key as Create bill.
   */
  async function changeCharge(amountMinor: number): Promise<void> {
    const hadBill = bill !== null;
    const changed = await write('charge', 'POST', `/pos/order/${props.row.orderId}/parcel-charge`, { amountMinor },
      `charge:${props.row.orderId}:${amountMinor}`);
    if (changed && hadBill) {
      await write('bill', 'POST', `/pos/session/${sessionId}/bill`, { splitKind: 'whole' }, `bill:${sessionId}`);
    }
  }
  const adjustments = board === null ? [] : adjustmentLines(board.lines);

  return (
    <>
      {/* ---- the order ------------------------------------------------- */}
      <section className="flex min-w-0 flex-col gap-4 p-4 animate-in fade-in duration-200 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="m-0 text-2xl font-semibold">{describeOrder(props.row)}</h1>
          {props.row.serviceType === 'parcel' && (
            <span className="rounded-md bg-primary px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-white">Parcel</span>
          )}
          <span className="text-sm text-muted-foreground">
            {props.row.serviceType === 'parcel' ? 'Take away' : 'Dine-in'}
            {props.row.readyBy ? ` · taken by ${props.row.readyBy}` : ''}
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-background text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">Item</th>
                <th className="px-4 py-2.5 text-right">Qty</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {board === null ? (
                boardFailed ? null : (
                  <tr><td colSpan={3} className="px-4 py-3">
                    <Loading label="bill" className="flex flex-col gap-3">
                      {Array.from({ length: 3 }, (_, i) => (
                        <div key={i} className="flex gap-4"><Skeleton className="h-4 grow" /><Skeleton className="h-4 w-10" /><Skeleton className="h-4 w-20" /></div>
                      ))}
                    </Loading>
                  </td></tr>
                )
              ) : [...lines, ...adjustments].map((line) => {
                const money = lineMoney(line);
                return (
                  <tr key={line.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5">
                      {line.display_name}
                      {line.note && <span className="block text-xs text-muted-foreground">{line.note}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{line.quantity}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {money === null ? '—' : formatMinor(money)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- the bill and payment -------------------------------------- */}
      <aside className="flex flex-col gap-4 border-t border-border bg-card p-4 sm:p-6 lg:border-t-0 lg:border-l">
        <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
          <ReceiptText aria-hidden className="size-5 text-muted-foreground" /> Bill
        </h2>
        {refusal !== null && (
          <p role="alert" className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm">{refusal}</p>
        )}

        {editsCharge && (
          <ParcelChargeEditor key={chargeLine?.line_total_minor ?? '0'} current={chargeLine?.line_total_minor ?? '0'}
            disabled={busy !== null || !holding} onSave={(amount) => void changeCharge(amount)} />
        )}

        {bill === null ? (
          <>
            <Figure label="Order amount (before tax)" value={props.row.amountMinor} />
            <p className="text-sm text-muted-foreground">Tax is worked out when the bill is made.</p>
            {!holding && !completed && refusal === null && (
              <p className="m-0 text-sm text-muted-foreground">Taking the order for billing…</p>
            )}
            <button type="button" disabled={busy !== null || completed || !holding}
              onClick={() => void write('bill', 'POST', `/pos/session/${sessionId}/bill`, { splitKind: 'whole' },
                `bill:${sessionId}`)}
              className="flex h-14 items-center justify-center gap-2 rounded-xl bg-primary text-lg font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-50">
              {busy === 'bill' ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : <ReceiptText aria-hidden className="size-5" />}
              {busy === 'bill' ? 'Making the bill…' : 'Create bill'}
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-background/50 p-4 animate-in fade-in zoom-in-95 duration-200">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Bill #{bill.bill_no}</span>
              {(bill.parcel_charge_minor ?? '0') !== '0' && (
                <>
                  <Figure label="Items" value={bill.items_minor!} />
                  <Figure label="Parcel charge" value={bill.parcel_charge_minor!} />
                </>
              )}
              {/* Reverse mode (0083): the prices above hold the tax, so the subtotal is the taxable value. */}
              <Figure label={bill.prices_include_tax === true && bill.tax_account_type !== 'none' ? 'Taxable value' : 'Subtotal'}
                value={bill.subtotal_minor} />
              {bill.tax_account_type !== 'none' && (
                <Figure value={bill.tax_minor}
                  label={`${bill.tax_account_type === 'vat' ? 'VAT' : bill.tax_account_type === 'gst' ? 'GST' : 'Tax'}${bill.prices_include_tax === true ? ' (included)' : ''}`} />
              )}
              <div className="my-1 border-t border-border" />
              <Figure label="Grand total" value={bill.total_minor} strong={(bill.round_off_minor ?? '0') === '0'} />
              {/* Paid to the nearest rupee (0082): the round-off is its own line, and Net payable is what is collected. */}
              {(bill.round_off_minor ?? '0') !== '0' && (
                <>
                  <Figure label="Round off" value={bill.round_off_minor!} />
                  <Figure label="Net payable" value={bill.payable_minor ?? bill.total_minor} strong />
                </>
              )}
              <Figure label="Paid" value={bill.paid_minor} />
              <Figure label="Outstanding" value={bill.outstanding_minor} strong />
            </div>

            {bill.tenders.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {bill.tenders.map((t) => (
                  <li key={t.id} className="flex flex-col">
                    <span className="flex justify-between">
                      <span>{t.kind === 'void' ? `${METHOD_LABEL[t.method] ?? t.method} void` : METHOD_LABEL[t.method] ?? t.method}{t.reference ? ` · ${t.reference}` : ''}</span>
                      <span className="font-mono tabular-nums">{formatMinor(minorFrom(t.amount_minor))}</span>
                    </span>
                    {t.cash_received_minor !== null && minorFrom(t.change_minor) !== 0 && (
                      <span className="flex justify-between text-xs text-muted-foreground">
                        <span>received {formatMinor(minorFrom(t.cash_received_minor))}</span>
                        <span>change {formatMinor(minorFrom(t.change_minor))}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <button type="button" disabled={busy !== null || printing}
              onClick={() => void printCopies(bill.id, 'customer')}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border-[1.5px] border-foreground bg-card font-semibold transition-colors hover:bg-foreground hover:text-background active:scale-[0.98] disabled:opacity-50">
              <Printer aria-hidden className="size-4" />
              {busy === 'print-customer' ? 'Preparing…' : printing ? 'Printing…' : bill.settled ? 'Print invoice' : 'Print bill'}
            </button>
            {printDone !== null && (
              <p role="status" className="m-0 flex items-center gap-2 rounded-md border border-paid bg-paid/10 p-3 text-sm font-semibold text-paid">
                <CircleCheck aria-hidden className="size-4" /> {printDone}
              </p>
            )}
            {printTrouble !== null && (
              <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                <p className="m-0 font-semibold">{printTrouble.message}</p>
                <p className="m-0">
                  Not printed: {printTrouble.pages.map((p) => p.purpose).join(', ')} copy. Retry sends the same copies again;
                  nothing is ordered, billed or charged again.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={printing} onClick={() => retryPrint(printTrouble)}
                    className="h-10 rounded-[10px] bg-primary px-4 font-semibold text-white disabled:opacity-50">
                    Retry
                  </button>
                  <button type="button"
                    onClick={() => { printHtml(renderCopiesHtml(printTrouble.pages, { layout: printTrouble.layout, logoUrl: props.logoUrl ?? null })); setPrintTrouble(null); }}
                    className="h-10 rounded-[10px] border border-input bg-card px-4 font-semibold">
                    Use the print dialog
                  </button>
                </div>
              </div>
            )}
            {failedCopies.length > 0 && (
              <p role="alert" className="m-0 rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                Did not print: {failedCopies.join(', ')} copy. Print it again below; the order is not sent again.
              </p>
            )}
            <div className="grid grid-cols-3 gap-2">
              {(['customer', 'kitchen', 'counter'] as const).map((copy) => (
                <button key={copy} type="button" disabled={busy !== null || printing} onClick={() => void printCopies(bill.id, copy)}
                  className="h-11 rounded-xl border border-input bg-card px-1 text-xs font-semibold leading-tight transition-colors hover:bg-background active:scale-[0.98] disabled:opacity-50">
                  {busy === `print-${copy}` ? 'Preparing…' : `${bill.settled ? 'Reprint' : 'Print'} ${copy} copy`}
                </button>
              ))}
            </div>

            {/* Stays after the order completes: the change to hand back is on it. */}
            {props.row.status !== 'cancelled' && <PaymentPanel bill={bill} busy={busy !== null} disabled={!holding || completed} onPay={pay} />}

            {allSettled && !completed && (
              <button type="button" disabled={busy !== null}
                onClick={() => void write('close', 'DELETE', `/pos/session/${sessionId}`, undefined, `close:${sessionId}`)}
                className="flex h-14 items-center justify-center gap-2 rounded-xl bg-paid text-lg font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-50">
                <CircleCheck aria-hidden className="size-5" />
                {busy === 'close' ? 'Completing…' : 'Complete payment'}
              </button>
            )}
            {completed && props.row.status === 'cancelled' && (
              <p className="rounded-md border border-border p-3 text-sm font-semibold text-muted-foreground">
                Cancelled by a manager. Nothing is owed.
              </p>
            )}
            {completed && props.row.status !== 'cancelled' && (
              <p className="flex items-center gap-2 rounded-xl border border-paid bg-paid/10 p-3 text-sm font-semibold text-paid animate-in fade-in duration-200">
                <CircleCheck aria-hidden className="size-4" /> Paid and completed.
              </p>
            )}
          </>
        )}
      </aside>

      {preview !== null && (
        <div role="dialog" aria-modal="true" aria-label="Print preview"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 animate-in fade-in duration-150 sm:items-center">
          <div className="flex w-full max-w-[460px] flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xl animate-in zoom-in-95 duration-150">
            <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
              <Printer aria-hidden className="size-5 text-muted-foreground" /> Print preview
            </h2>
            <PrintPreview pages={preview.pages} layout={preview.layout} options={{ logoUrl: props.logoUrl ?? null }} maxWidth={400} />
            <div className="flex gap-2">
              <button type="button" onClick={printPreviewed}
                className="flex h-12 grow items-center justify-center gap-2 rounded-xl bg-primary font-semibold text-white shadow-sm transition-[transform,filter] hover:brightness-105 active:scale-[0.98]">
                <Printer aria-hidden className="size-4" />
                {preview.pages.length > 1 ? `Print ${preview.pages.length} copies` : 'Print'}
              </button>
              <button type="button" onClick={() => setPreview(null)}
                className="h-12 rounded-xl border border-input px-5 font-semibold transition-colors hover:bg-background">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Change or remove a parcel's charge before payment. The cap and the tax are the server's. */
function ParcelChargeEditor(props: { current: string; disabled: boolean; onSave: (amountMinor: number) => void }): ReactElement {
  const current = minorFrom(props.current);
  const [text, setText] = useState(current === 0 ? '' : typedFromMinor(current));
  const typed = text.trim() === '' ? 0 : minorFromTyped(text);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-background/50 p-3">
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Parcel charge
        <input aria-label="Parcel charge" value={text} inputMode="decimal" placeholder="0.00" disabled={props.disabled}
          onChange={(e) => setText(e.target.value)}
          className={cn('h-10 rounded-lg border bg-card px-3 font-mono text-sm tabular-nums',
            typed === null ? 'border-destructive' : 'border-input')} />
      </label>
      {typed === null && <span className="text-xs text-destructive">Enter an amount like 20 or 20.50.</span>}
      <div className="flex gap-2">
        <button type="button" disabled={props.disabled || typed === null || typed === current}
          onClick={() => { if (typed !== null) props.onSave(typed); }}
          className="h-9 grow rounded-lg bg-primary px-3 text-sm font-semibold text-white disabled:opacity-50">
          Update
        </button>
        {current !== 0 && (
          <button type="button" disabled={props.disabled} onClick={() => props.onSave(0)}
            className="h-9 rounded-lg border border-border px-3 text-sm font-semibold disabled:opacity-50">
            Remove
          </button>
        )}
      </div>
      <span className="text-xs text-muted-foreground">Changing it makes the bill again. It cannot change once money is taken.</span>
    </div>
  );
}

function Figure(props: { label: string; value: string; strong?: boolean }): ReactElement {
  return (
    <div className={cn('flex items-baseline justify-between', props.strong && 'text-lg font-semibold')}>
      <span className={props.strong ? '' : 'text-sm text-muted-foreground'}>{props.label}</span>
      <span className="font-mono tabular-nums">{formatMinor(minorFrom(props.value))}</span>
    </div>
  );
}
