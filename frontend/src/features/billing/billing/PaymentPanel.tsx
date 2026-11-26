import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  formatMinor, formatMinorRounded, minorFrom, minorFromTyped, previewPayment, typedFromMinor, type Minor, type PaymentPreview,
} from '../../../lib/money.js';
import type { BillRow } from '../../orders/pos/board.js';
import { cn } from 'cn';
import { LoaderCircle, Wallet } from 'lucide-react';

/**
 * Taking money against one bill: any mix of card, UPI, other and a cash note,
 * in one write. The panel adds nothing up -- it sends what the cashier typed
 * and shows what the server says happened: what each method paid, what the
 * cash note paid, the change to hand back, and what is still due. Before the
 * write it shows only the server's own balance.
 */

export interface PaymentPart {
  readonly method: 'cash' | 'card' | 'upi' | 'other';
  readonly amountMinor?: number;
  readonly cashReceivedMinor?: number;
  readonly reference?: string;
}

export interface PaymentResult {
  readonly tenders: readonly {
    readonly tenderId: string;
    readonly method: string;
    readonly amountMinor: number;
    readonly cashReceivedMinor: number | null;
    readonly changeMinor: number;
  }[];
  readonly totalMinor: number;
  readonly appliedMinor: number;
  readonly paidMinor: number;
  readonly outstandingMinor: number;
  readonly changeMinor: number;
  readonly settled: boolean;
}

const NON_CASH = [
  { method: 'card', label: 'Card' },
  { method: 'upi', label: 'UPI' },
  { method: 'other', label: 'Other' },
] as const;

export const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', other: 'Other' };

type Typed = Record<'cash' | 'card' | 'upi' | 'other', string>;
const EMPTY: Typed = { cash: '', card: '', upi: '', other: '' };

export function paymentParts(typed: Typed, references: Partial<Record<string, string>>): PaymentPart[] | null {
  const parts: PaymentPart[] = [];
  for (const { method } of NON_CASH) {
    if (typed[method].trim() === '') continue;
    const amount = minorFromTyped(typed[method]);
    if (amount === null || amount <= 0) return null;
    const reference = references[method]?.trim();
    parts.push({ method, amountMinor: amount, ...(reference ? { reference } : {}) });
  }
  if (typed.cash.trim() !== '') {
    const received = minorFromTyped(typed.cash);
    if (received === null || received <= 0) return null;
    parts.push({ method: 'cash', cashReceivedMinor: received });
  }
  return parts.length === 0 ? null : parts;
}

export function PaymentPanel(props: {
  bill: BillRow;
  busy: boolean;
  /** Not writable yet (e.g. the lease is still being taken); unlike busy, nothing is in flight. */
  disabled?: boolean;
  /** Sends the parts; resolves to the server's answer, or null if it was refused. */
  onPay: (parts: readonly PaymentPart[]) => Promise<PaymentResult | null>;
}): ReactElement {
  const outstanding = minorFrom(props.bill.outstanding_minor);
  const [typed, setTyped] = useState<Typed>(EMPTY);
  const [result, setResult] = useState<PaymentResult | null>(null);

  useEffect(() => { setTyped(EMPTY); }, [props.bill.id]);

  const parts = paymentParts(typed, {});
  const invalid = Object.values(typed).some((v) => v.trim() !== '' && minorFromTyped(v) === null);
  const fill = (method: keyof Typed, amount: Minor): void =>
    setTyped({ ...EMPTY, [method]: typedFromMinor(amount) });

  async function pay(): Promise<void> {
    if (parts === null) return;
    const answer = await props.onPay(parts);
    if (answer !== null) {
      setResult(answer);
      setTyped(EMPTY);
    }
  }

  const preview = parts === null || invalid ? null : previewPayment(outstanding, parts.map((p) => ({
    method: p.method,
    ...(p.amountMinor !== undefined ? { amountMinor: minorFrom(p.amountMinor) } : {}),
    ...(p.cashReceivedMinor !== undefined ? { cashReceivedMinor: minorFrom(p.cashReceivedMinor) } : {}),
  })));
  const row = 'grid grid-cols-[44px_7.5rem_auto] items-center gap-1.5';
  const field = 'h-9 w-full min-w-0 rounded-md border border-input px-2.5 font-mono text-sm tabular-nums transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none';
  const quick = 'h-9 rounded-md border border-input px-2.5 text-xs font-semibold transition-colors hover:bg-background active:scale-95';

  return (
    <div className="flex flex-col gap-3">
      {result !== null && <PaymentReceipt result={result} onDismiss={() => setResult(null)} />}

      {!props.bill.settled && (
        <>
          {/* The headline is to the nearest rupee; Full and Exact still fill the exact balance. */}
          <div className="flex items-center justify-between rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3.5 shadow-sm">
            <span className="text-sm font-semibold text-foreground/80">Balance due</span>
            <span aria-label="Balance due" className="font-mono text-[26px] leading-none font-extrabold tracking-tight text-foreground tabular-nums">
              {formatMinorRounded(outstanding)}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            {NON_CASH.map(({ method, label }) => (
              <div key={method} className={row}>
                <span className="text-xs font-semibold">{label}</span>
                <input aria-label={`${label} amount`} value={typed[method]} inputMode="decimal" placeholder="0.00"
                  onChange={(e) => setTyped({ ...typed, [method]: e.target.value })} className={field} />
                <button type="button" onClick={() => fill(method, outstanding)} className={quick}>Full</button>
              </div>
            ))}

            <div className={row}>
              <span className="text-xs font-semibold">Cash</span>
              <input aria-label="Cash received" value={typed.cash} inputMode="decimal" placeholder="Received"
                onChange={(e) => setTyped({ ...typed, cash: e.target.value })} className={field} />
              <button type="button" onClick={() => fill('cash', outstanding)} className={quick}>Exact</button>
            </div>
          </div>
          {invalid && <p className="m-0 text-sm text-destructive">Amounts are numbers like 350 or 350.50.</p>}
          {preview !== null && <PaymentPreviewPanel preview={preview} />}
          <p className="m-0 text-[11px] leading-snug text-muted-foreground">
            Card, UPI and other are taken first; cash pays what is left, and anything over is change — never sales.
          </p>

          <button type="button" disabled={props.busy || props.disabled === true || parts === null || invalid} onClick={() => void pay()}
            className="flex h-14 items-center justify-center gap-2 rounded-xl bg-primary text-lg font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-50">
            {props.busy ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : <Wallet aria-hidden className="size-5" />}
            {props.busy ? 'Recording…' : 'Add payment'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * What this payment WOULD do, as the cashier types: the server's rule
 * (`previewPayment`), labelled a preview. After Add payment the server's own
 * answer is shown instead, and it is the record.
 */
function PaymentPreviewPanel(props: { preview: PaymentPreview }): ReactElement {
  const p = props.preview;
  return (
    <div aria-label="Payment preview" className="flex flex-col gap-2 rounded-2xl border border-border bg-background/60 p-3.5 text-sm shadow-sm">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Preview</span>
      {p.state === 'refused' ? (
        <p role="alert" className="m-0 text-xs font-semibold text-destructive">
          {p.reason === 'exceeds_balance'
            ? `${METHOD_LABEL[p.method] ?? p.method} is more than the ${formatMinor(p.leftMinor)} left to pay — this payment would be refused.`
            : 'Cash is not needed: the other methods already pay the bill — this payment would be refused.'}
        </p>
      ) : (
        <>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {p.lines.map((l) => `${METHOD_LABEL[l.method] ?? l.method} −${formatMinor(l.appliedMinor)}`).join(' · ')}
          </span>
          <div className="flex justify-between text-foreground/80">
            <span>Added</span><span className="font-mono font-semibold tabular-nums">{formatMinor(p.addedMinor)}</span>
          </div>
          {/* To the nearest rupee, like Balance due; Added and change stay exact -- change is cash handed back. */}
          <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
            <span className="font-semibold">Balance after this payment</span>
            <span aria-label="Balance after this payment" className="font-mono text-[22px] leading-none font-extrabold tracking-tight tabular-nums">
              {formatMinorRounded(p.balanceAfterMinor)}
            </span>
          </div>
          {p.changeMinor > 0 && (
            <div className="flex items-center justify-between rounded-xl bg-paid/10 px-3 py-2 font-bold">
              <span>Change to return</span><span className="font-mono text-lg tabular-nums">{formatMinor(p.changeMinor)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What the server recorded, in the order the cashier needs it: the change first. */
function PaymentReceipt(props: { result: PaymentResult; onDismiss: () => void }): ReactElement {
  const r = props.result;
  const money = (n: number): string => formatMinor(minorFrom(n));
  return (
    <div role="status" className={cn('flex flex-col gap-1.5 rounded-xl border-2 p-3 text-sm animate-in fade-in zoom-in-95 duration-200',
      r.settled ? 'border-paid bg-paid/10' : 'border-primary bg-primary/5')}>
      {r.changeMinor > 0 && (
        <div className="flex items-baseline justify-between text-lg font-bold">
          <span>Change to return</span><span className="font-mono tabular-nums">{money(r.changeMinor)}</span>
        </div>
      )}
      {r.tenders.map((t) => (
        <div key={t.tenderId} className="flex flex-col">
          <div className="flex justify-between">
            <span>{METHOD_LABEL[t.method] ?? t.method}{t.cashReceivedMinor !== null ? ' applied' : ''}</span>
            <span className="font-mono tabular-nums">{money(t.amountMinor)}</span>
          </div>
          {t.cashReceivedMinor !== null && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Cash received</span><span className="font-mono tabular-nums">{money(t.cashReceivedMinor)}</span>
            </div>
          )}
        </div>
      ))}
      <div className="my-1 border-t border-border" />
      <div className="flex justify-between"><span>This payment</span><span className="font-mono tabular-nums">{money(r.appliedMinor)}</span></div>
      <div className="flex justify-between"><span>Total settled</span><span className="font-mono tabular-nums">{money(r.paidMinor)}</span></div>
      <div className="flex justify-between font-semibold">
        <span>Balance due</span><span className="font-mono tabular-nums">{money(r.outstandingMinor)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className={cn('font-bold', r.settled ? 'text-paid' : 'text-primary')}>
          {r.settled ? 'Paid' : 'Partially paid'}
        </span>
        <button type="button" onClick={props.onDismiss} className="text-xs underline">Dismiss</button>
      </div>
    </div>
  );
}
