import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api, type DeviceIdentity } from '../../../services/api.js';
import type { Leases } from '../../../services/lease.js';
import { currencySymbol, formatMinor, minorFrom, minorFromTyped, typedFromMinor } from '../../../lib/money.js';
import type { BoardMenuItem } from '../../orders/pos/board.js';
import { describeRefusal } from '../../orders/pos/refusals.js';
import { cn } from 'cn';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { Switch } from '@/components/ui/switch.js';
import { Check, LoaderCircle, NotebookPen, Plus, ShoppingBag, ShoppingCart, UtensilsCrossed } from 'lucide-react';

/**
 * Basic: the person at the counter takes the order, and Confirm does the rest
 * on the SAME session, order and lines the backend always writes -- open the
 * order (numbered at the counter: D-n, or P-n for a parcel), add the lines,
 * send them to the kitchen (the printed kitchen ticket), and hand the order to
 * billing. The price shown is the menu's, for choosing; the figure charged is
 * the server's, on the bill.
 *
 * One Confirm is one order. Every step carries an idempotency key fixed for
 * the attempt, so a double tap or a retry after a dropped connection replays
 * the step instead of repeating it: never a second order, never a second
 * kitchen ticket. Once anything has been written the cart is locked; a retry
 * resumes the same order.
 *
 * A parcel takes a charge for packing, typed here and capped by the branch
 * (0081). The totals beside the cart are the server's ESTIMATE
 * (`POST /pos/quote`, the bill's own pricing and tax functions), re-asked as
 * the cart or the charge changes; the screen adds nothing up. The bill is the
 * record.
 */

/** The order screen's estimate: `quoteOrder` in modules/payments/quote.ts. */
interface Quote {
  readonly itemsMinor: number;
  readonly parcelChargeMinor: number;
  readonly subtotalMinor: number;
  readonly taxes: readonly { readonly name: string; readonly rateBps: number; readonly amountMinor: number }[];
  readonly taxMinor: number;
  readonly totalMinor: number;
  /** To the nearest rupee, as the bill will be (0082). Absent from an older API. */
  readonly roundOffMinor?: number;
  readonly payableMinor?: number;
  readonly parcelCharge: { readonly defaultMinor: number; readonly maxMinor: number } | null;
  /** Reverse mode (0083): the prices already include the tax shown. Absent from an older API. */
  readonly pricesIncludeTax?: boolean;
}

/** 250 -> "2.5%": a rate in basis points, for the label beside a tax head. */
const pctOfBps = (rateBps: number): string => `${String(Number((rateBps / 100).toFixed(2)))}%`;

interface Category { readonly id: string; readonly name: string; readonly display_order: number | null }
interface CartLine { readonly item: BoardMenuItem; quantity: number; note: string }

interface Attempt {
  readonly open: string;
  readonly lines: readonly string[];
  readonly charge: string;
  readonly fire: string;
  readonly handover: string;
  /** Set once the order exists: from then on the cart is this order's, and locked. */
  opened: { sessionId: string; orderId: string } | null;
}

function newAttempt(lineCount: number): Attempt {
  return {
    open: crypto.randomUUID(),
    lines: Array.from({ length: lineCount }, () => crypto.randomUUID()),
    charge: crypto.randomUUID(),
    fire: crypto.randomUUID(),
    handover: crypto.randomUUID(),
    opened: null,
  };
}

export function NewOrder(props: {
  api: Api;
  device: DeviceIdentity;
  leases: Leases;
  /** The plan sends orders to the kitchen (`kot`). The server's answer, from the billing queue. */
  kot: boolean;
  onCancel: () => void;
  onHandedOver: (sessionId: string) => void;
}): ReactElement {
  const [menu, setMenu] = useState<readonly BoardMenuItem[] | null>(null);
  const [menuFailed, setMenuFailed] = useState(false);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [parcel, setParcel] = useState(false);
  const [name, setName] = useState('');
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  /** The parcel charge as typed; '' until the branch's default arrives with the first estimate. */
  const [charge, setCharge] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteRefusal, setQuoteRefusal] = useState<string | null>(null);
  const quoteSeq = useRef(0);
  // Lines whose note box was opened with +; a line with a note keeps its box.
  const [noting, setNoting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  // `busy` is state, so two taps in one instant both read it false; this is read synchronously.
  const inFlight = useRef(false);
  const locked = attempt.current?.opened != null;

  useEffect(() => {
    void props.api.get<{ menu: BoardMenuItem[] }>('/pos/menu').then((r) => setMenu(r.menu))
      .catch((error: unknown) => { setMenuFailed(true); setRefusal(describeRefusal(error, 'now')); });
    void props.api.get<{ rows: Category[] }>('/admin/menu/categories').then((r) => setCategories(r.rows)).catch(() => setCategories([]));
  }, [props.api]);

  const chargeMinor = charge.trim() === '' ? null : minorFromTyped(charge);
  const chargeInvalid = parcel && charge.trim() !== '' && chargeMinor === null;

  // The estimate, re-asked a moment after the cart or the charge stops changing.
  // Only the newest answer is shown: an older one arriving late would put a
  // total on screen for a cart that no longer exists.
  useEffect(() => {
    if (chargeInvalid || (cart.length === 0 && !parcel)) {
      quoteSeq.current += 1;
      setQuote(null);
      setQuoteRefusal(null);
      return;
    }
    const seq = ++quoteSeq.current;
    const timer = setTimeout(() => {
      void props.api.postDetailed<Quote>('/pos/quote', {
        parcel,
        lines: cart.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity })),
        ...(parcel ? { parcelChargeMinor: chargeMinor } : {}),
      }).then((answer) => {
        if (seq !== quoteSeq.current) return;
        setQuote(answer);
        setQuoteRefusal(null);
        // The branch's default fills the box the first time a parcel is priced.
        const usual = answer.parcelCharge?.defaultMinor ?? 0;
        if (parcel && chargeMinor === null && usual > 0) setCharge(typedFromMinor(minorFrom(usual)));
      }).catch((error: unknown) => {
        if (seq !== quoteSeq.current) return;
        setQuote(null);
        setQuoteRefusal(describeRefusal(error, 'now'));
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [props.api, cart, parcel, chargeMinor, chargeInvalid]);

  const items = useMemo(() => (menu ?? []).filter((item) => item.orderable && (category === null || item.category_id === category)),
    [menu, category]);

  /** Any change to what is being ordered starts a new attempt -- allowed only before anything was written. */
  function edit(next: (current: readonly CartLine[]) => readonly CartLine[]): void {
    if (locked) return;
    attempt.current = null;
    setCart(next);
  }
  function add(item: BoardMenuItem): void {
    edit((current) => current.some((l) => l.item.id === item.id)
      ? current.map((l) => (l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l))
      : [...current, { item, quantity: 1, note: '' }]);
  }
  function change(id: string, by: number): void {
    edit((current) => current
      .map((l) => (l.item.id === id ? { ...l, quantity: l.quantity + by } : l))
      .filter((l) => l.quantity > 0));
  }
  function note(id: string, text: string): void {
    edit((current) => current.map((l) => (l.item.id === id ? { ...l, note: text } : l)));
  }
  function typeCharge(text: string): void {
    if (locked) return;
    attempt.current = null;
    setCharge(text);
  }

  /** Open, fill, send to the kitchen and hand over. Online, one step at a time: each one is the server's to refuse. */
  async function confirm(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    const run = attempt.current ?? newAttempt(cart.length);
    attempt.current = run;
    setBusy(true);
    setRefusal(null);
    try {
      if (run.opened === null) {
        const pickupName = name.trim() === '' ? null : name.trim();
        run.opened = await props.api.mutate<{ sessionId: string; orderId: string }>(
          parcel ? '/pos/parcel' : '/pos/dine-in', { pickupName },
          { idempotencyKey: run.open, leaseToken: null });
      }
      const { sessionId, orderId } = run.opened;
      const lease = await props.leases.claim(sessionId, props.device.branchId, props.device.deviceId);
      for (const [i, line] of cart.entries()) {
        const text = line.note.trim();
        await props.api.send('POST', `/pos/order/${orderId}/line`,
          { menuItemId: line.item.id, quantity: line.quantity, ...(text === '' ? {} : { note: text }) },
          { idempotencyKey: run.lines[i]!, leaseToken: lease.token });
      }
      if (parcel && chargeMinor !== null && chargeMinor > 0) {
        await props.api.send('POST', `/pos/order/${orderId}/parcel-charge`, { amountMinor: chargeMinor },
          { idempotencyKey: run.charge, leaseToken: lease.token });
      }
      if (props.kot) {
        const board = await props.api.get<{ session: { version: number | string } }>(`/pos/session/${sessionId}/board`);
        await props.api.send('POST', `/pos/order/${orderId}/fire`, { sessionVersion: Number(board.session.version) },
          { idempotencyKey: run.fire, leaseToken: lease.token });
      }
      await props.api.send('POST', `/pos/session/${sessionId}/ready-for-billing`, {},
        { idempotencyKey: run.handover, leaseToken: lease.token });
      props.leases.forget(sessionId);
      attempt.current = null;
      props.onHandedOver(sessionId);
    } catch (error) {
      // A retry after the hand-over landed but its answer was lost: the order is
      // already billing's, which is exactly where this attempt was taking it.
      if (run.opened !== null && error instanceof ApiError && error.failure.kind === 'refused'
        && error.failure.code === 'order_in_billing') {
        const { sessionId } = run.opened;
        props.leases.forget(sessionId);
        attempt.current = null;
        props.onHandedOver(sessionId);
        return;
      }
      setRefusal(error instanceof ApiError && error.failure.kind === 'refused' && error.failure.status === 403
        ? 'This account cannot take orders. Ask your Sales person to give it POS access, or sign in with an account that can.'
        : error instanceof ApiError && error.failure.kind === 'offline'
          ? 'No connection. Nothing more was sent; tap Confirm order again to finish this same order.'
          : describeRefusal(error, 'now'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const count = cart.reduce((n, l) => n + l.quantity, 0);
  const chip = (active: boolean): string => cn(
    'shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-150',
    active ? 'bg-primary text-white shadow-sm' : 'border border-border bg-card text-foreground hover:bg-accent',
  );

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* The menu: every category as a tab along the top, the items straight below, using the whole width. */}
      <section className="flex min-w-0 flex-col">
        <nav aria-label="Menu categories"
          className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-4">
          <button type="button" onClick={() => setCategory(null)} aria-pressed={category === null} className={chip(category === null)}>
            All items
          </button>
          {[...categories].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)).map((c) => (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)} aria-pressed={category === c.id} className={chip(category === c.id)}>
              {c.name}
            </button>
          ))}
        </nav>

        <div className="p-3 sm:p-4">
          {menu === null ? (
            // A failed read is said in the banner; nothing here claims it is coming.
            menuFailed ? null : (
              <Loading label="menu" className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-[84px]" />)}
              </Loading>
            )
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-8 text-center">
              <UtensilsCrossed aria-hidden className="size-8 text-muted-foreground/70" />
              <p className="m-0 text-muted-foreground">Nothing on sale here.</p>
            </div>
          ) : (
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(150px, 100%), 1fr))' }}>
              {items.map((item) => {
                const inCart = cart.find((l) => l.item.id === item.id)?.quantity ?? 0;
                return (
                  <button key={item.id} type="button" disabled={locked} onClick={() => add(item)}
                    className={cn(
                      'group relative flex min-h-[84px] flex-col justify-between gap-1 rounded-xl border bg-card p-3 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-150',
                      'hover:border-primary hover:shadow-md active:scale-[0.97] disabled:opacity-50',
                      inCart > 0 ? 'border-primary ring-1 ring-primary/30' : 'border-border',
                    )}>
                    <span className="line-clamp-2 pr-7 text-[15px] font-semibold leading-snug">{item.name}</span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground/80 tabular-nums">{formatMinor(minorFrom(item.price_minor))}</span>
                      {/* The add affordance sits in the corner; the whole tile adds. */}
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-ink-orange transition-colors group-hover:bg-primary group-hover:text-white">
                        <Plus className="size-4" />
                      </span>
                    </span>
                    {inCart > 0 && (
                      <span aria-hidden
                        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-white animate-in zoom-in-50 duration-150">
                        {inCart}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* The order: its header and Confirm stay put; only the lines scroll. */}
      <aside id="new-order-cart"
        className="flex scroll-mt-20 flex-col border-t border-border bg-card md:sticky md:top-[72px] md:h-[calc(100dvh-72px)] md:border-t-0 md:border-l">
        <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            <ShoppingCart aria-hidden className="size-5 text-muted-foreground" />
            New order
            {cart.length > 0 && (
              <span className="ml-auto rounded-full bg-background px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                {count} items
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <label title="Parcel (take away)" className={cn('flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-2 px-2 text-sm font-semibold transition-colors duration-150',
              parcel ? 'border-primary bg-primary/5' : 'border-border')}>
              <Switch checked={parcel} disabled={locked} onCheckedChange={setParcel} aria-label="Parcel (take away)" />
              <ShoppingBag aria-hidden className={cn('size-4', parcel ? 'text-ink-orange' : 'text-muted-foreground')} />
            </label>
            {parcel && (
              <input aria-label="Parcel charge" title="Parcel charge" value={charge} inputMode="decimal" placeholder={`${currencySymbol()} 0.00`}
                disabled={locked || quote?.parcelCharge?.maxMinor === 0}
                onChange={(e) => typeCharge(e.target.value)}
                className={cn('h-10 w-[84px] shrink-0 rounded-lg border bg-card px-2 font-mono text-sm tabular-nums transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60',
                  chargeInvalid ? 'border-destructive' : 'border-input')} />
            )}
            <input aria-label="Customer name (optional)" value={name} disabled={locked} maxLength={40} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rahul" className="h-10 min-w-0 grow rounded-lg border border-input bg-card px-2.5 text-sm transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none" />
          </div>
          {parcel && (chargeInvalid || quote?.parcelCharge) && (
            <p className={cn('m-0 text-[11px] leading-tight', chargeInvalid ? 'text-destructive' : 'text-muted-foreground')}>
              {chargeInvalid ? 'Enter an amount like 20 or 20.50.'
                : quote?.parcelCharge?.maxMinor === 0 ? 'This branch takes no parcel charge. A manager sets one under Printed bill.'
                  : quote?.parcelCharge ? `Parcel charge, up to ${formatMinor(minorFrom(quote.parcelCharge.maxMinor))}.` : ''}
            </p>
          )}
        </div>

        <div className="max-h-[50vh] min-h-0 grow overflow-y-auto md:max-h-none" aria-label="Order lines">
          {cart.length === 0 ? (
            <p className="m-3 rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">Tap items to add them.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {cart.map((line) => (
                <li key={line.item.id} className="flex flex-col gap-1 px-3 py-1.5 text-sm animate-in fade-in duration-150">
                  <div className="flex items-center gap-2">
                    <span className="flex min-w-0 grow flex-col">
                      <span className="truncate font-medium">{line.item.name}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {formatMinor(minorFrom(line.item.price_minor))} each
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {line.note === '' && !noting.has(line.item.id) && (
                        <button type="button" disabled={locked} aria-label={`Add a note for ${line.item.name}`} title="Note for the kitchen"
                          onClick={() => setNoting((open) => new Set(open).add(line.item.id))}
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50">
                          <NotebookPen aria-hidden className="size-4" />
                        </button>
                      )}
                      <button type="button" aria-label={`One less ${line.item.name}`} disabled={locked}
                        onClick={() => change(line.item.id, -1)} className="size-8 rounded-md border border-input text-base transition-colors hover:bg-background active:scale-95 disabled:opacity-50">−</button>
                      <span className="w-7 text-center font-mono font-semibold tabular-nums">{line.quantity}</span>
                      <button type="button" aria-label={`One more ${line.item.name}`} disabled={locked}
                        onClick={() => change(line.item.id, 1)} className="size-8 rounded-md border border-input text-base transition-colors hover:bg-background active:scale-95 disabled:opacity-50">+</button>
                    </div>
                  </div>
                  {(line.note !== '' || noting.has(line.item.id)) && (
                    <input aria-label={`Note for ${line.item.name}`} value={line.note} disabled={locked} maxLength={140}
                      autoFocus={line.note === ''}
                      onChange={(e) => note(line.item.id, e.target.value)} placeholder="Note for the kitchen"
                      className="h-8 rounded-md border border-input bg-card px-2.5 text-xs" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card p-2.5">
          {quote !== null && (
            <div aria-label="Estimate" className="flex flex-col gap-0.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-xs">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Estimate <span className="font-normal normal-case tracking-normal">· the bill, made on Confirm, is the record</span>
              </span>
              <Row label="Items" minor={quote.itemsMinor} />
              {parcel && <Row label="Parcel charge" minor={quote.parcelChargeMinor} />}
              <Row label={quote.pricesIncludeTax === true && quote.taxMinor > 0 ? 'Taxable value' : 'Subtotal'} minor={quote.subtotalMinor} />
              {quote.taxes.map((t) => (
                <Row key={`${t.name}:${t.rateBps}`} minor={t.amountMinor}
                  label={`${t.name} ${pctOfBps(t.rateBps)}${quote.pricesIncludeTax === true ? ' (included)' : ''}`} />
              ))}
              {(quote.roundOffMinor ?? 0) !== 0 && <Row label="Round off" minor={quote.roundOffMinor ?? 0} />}
              <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold">
                <span>Payable</span><span className="font-mono tabular-nums">{formatMinor(minorFrom(quote.payableMinor ?? quote.totalMinor))}</span>
              </div>
            </div>
          )}
          {quoteRefusal !== null && <p role="status" className="m-0 text-xs text-destructive">{quoteRefusal}</p>}
          {props.kot && <p className="m-0 text-xs text-muted-foreground">Confirm sends the order to the kitchen.</p>}
          {refusal !== null && (
            <p role="alert" className="m-0 rounded-md border border-destructive bg-destructive/10 p-2.5 text-sm">{refusal}</p>
          )}
          <div className="flex gap-2">
            {!locked && (
              <button type="button" disabled={busy} onClick={props.onCancel}
                className="h-11 shrink-0 rounded-xl border border-input px-3 text-sm transition-colors hover:bg-background disabled:opacity-50">Cancel</button>
            )}
            <button type="button" disabled={busy || cart.length === 0 || chargeInvalid} onClick={() => void confirm()}
              className="flex h-11 grow items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100">
              {busy ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : <Check aria-hidden className="size-5" />}
              {busy ? 'Sending…' : locked ? 'Try again' : 'Confirm order'}
            </button>
          </div>
        </div>
      </aside>

      {/* Phones: the order sits below the menu, so its count and a way to it stay in reach. */}
      {cart.length > 0 && (
        <a href="#new-order-cart"
          className="sticky bottom-3 z-10 mx-3 mb-3 flex h-14 items-center justify-between rounded-xl bg-foreground px-5 font-semibold text-background shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 md:hidden">
          <span className="flex items-center gap-2"><ShoppingCart aria-hidden className="size-5" /> {count} in order</span>
          <span>Review &amp; confirm</span>
        </a>
      )}
    </div>
  );
}

function Row(props: { label: string; minor: number }): ReactElement {
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>{props.label}</span><span className="font-mono tabular-nums">{formatMinor(minorFrom(props.minor))}</span>
    </div>
  );
}
