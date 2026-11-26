import { useEffect, useState } from 'react';
import { ChartColumn, CloudCheck, CloudUpload, LogOut, ReceiptText, Store } from 'lucide-react';
import type { ReactElement } from 'react';
import { type Api, type DeviceIdentity, type Session } from '../../../services/api.js';
import type { Queue, QueueSnapshot } from '../../../services/queue.js';
import type { Leases } from '../../../services/lease.js';
import type { Pump } from '../../../services/pump.js';
import type { ConsensusKeys } from '../../../lib/consensus.js';
import type { Durability } from '../../../services/storage.js';
import { BillingWorkspace } from '../../billing/billing/Desk.js';
import { UserBadge } from '../../../components/UserBadge.js';
import { MyTakings } from '../../billing/billing/MyTakings.js';
import { PrinterConnection } from '../../billing/print/PrinterConnection.js';
import { BillHistory, type Write } from '../../billing/history/BillHistory.js';

/**
 * On shift: the shell around the ONE POS screen (Basic). New order takes the
 * order and sends it to the kitchen; the same screen bills it and takes the
 * money. There is no Dine-in floor, no Parcel list and no KOT board: a parcel
 * is a switch on the order, and the kitchen gets its printed copy by hand.
 */
export function Shift(props: {
  api: Api;
  device: DeviceIdentity;
  session: Session;
  leases: Leases;
  queue: Queue;
  queueState: QueueSnapshot;
  pump: Pump;
  keys: ConsensusKeys;
  durability: Durability;
  /** Ask the browser again for persistent storage, from a tap. Resolves to its answer. */
  onRequestPersistence?: () => Promise<Durability>;
  /** Billing's own leases, kept apart from KOT's: one session is leased by each stage in turn. */
  billingLeases: Leases;
  /** The restaurant's logo, for a bill layout that prints it. */
  logoUrl?: string | null;
  onSignOut: () => void;
}): ReactElement {
  useEffect(() => props.billingLeases.startRenewing(props.device.deviceId),
    [props.billingLeases, props.device.deviceId]);

  useEffect(() => props.leases.startRenewing(props.device.deviceId),
    [props.leases, props.device.deviceId]);

  // My takings and Bills are offered from the person's own keys (`screens` on /me), never their role name.
  const [me, setMe] = useState<{
    fullName: string | null; takings: boolean; bills: boolean; billEdit: boolean; dayEnd: boolean;
  } | null>(null);
  const [takingsOpen, setTakingsOpen] = useState(false);
  const [billsOpen, setBillsOpen] = useState(false);
  useEffect(() => {
    let live = true;
    props.api.get<{ fullName?: string | null; screens?: Record<string, boolean | undefined> }>('/me')
      .then((read) => {
        if (!live) return;
        const s = read.screens ?? {};
        setMe({
          fullName: read.fullName ?? null, takings: s['takings'] === true, bills: s['bills'] === true,
          billEdit: s['billEdit'] === true, dayEnd: s['dayEnd'] === true,
        });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [props.api]);
  // Bill edits and day end are consensus writes: one key per intent, retired on success.
  const write: Write = async <T,>(path: string, body: unknown, signature: string): Promise<T> => {
    const result = await props.api.mutate<T>(path, body, { idempotencyKey: props.keys.for(signature), leaseToken: null });
    props.keys.retire(signature);
    return result;
  };

  const rejected = props.queueState.rejected;
  // Whether a tap already asked and the browser still said no: then the banner
  // says what the browser wants instead of offering the same button again.
  const [declined, setDeclined] = useState(false);
  const [asking, setAsking] = useState(false);
  async function askAgain(): Promise<void> {
    if (props.onRequestPersistence === undefined) return;
    setAsking(true);
    const answer = await props.onRequestPersistence();
    setAsking(false);
    setDeclined(answer !== 'persistent');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-20 flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/95 px-3 py-2 backdrop-blur sm:min-h-[72px] sm:gap-4 sm:px-6">
        <span className="flex min-w-0 items-center gap-2.5">
          {/* The restaurant's own logo; the shop icon only when it has none. */}
          {props.logoUrl ? (
            <img src={props.logoUrl} alt="" className="size-9 shrink-0 rounded-xl border border-border bg-white object-contain p-0.5" />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-black">
              <Store aria-hidden className="size-[18px]" />
            </span>
          )}
          <span className="truncate text-xl font-bold tracking-[-0.4px] text-foreground sm:text-2xl">
            {props.device.tenantSlug}
          </span>
        </span>
        <span className="hidden items-center gap-1.5 rounded-full bg-[#E9F7EF] px-2.5 py-1 text-[13px] font-semibold text-[#1E6B3C] sm:flex">
          <span aria-hidden className="size-2 rounded-full bg-[#2E9E5B]" /> on shift
        </span>
        <div className="grow" />

        {/* Connectivity is the queue's depth and the age of its oldest item, never
            navigator.onLine: a captive portal reports online while nothing resolves. */}
        <div className="flex h-10 items-center gap-2 rounded-[10px] bg-[#F2F2F2] px-3 sm:h-11 sm:px-4">
          {props.queueState.depth === 0
            ? <CloudCheck aria-hidden className="size-4 text-[#2E9E5B]" />
            : <CloudUpload aria-hidden className="size-4 text-ink-orange" />}
          <span className="font-mono text-sm text-[#333333] sm:text-[15px]">
            {props.queueState.depth === 0 ? 'All sent' : `${props.queueState.depth} waiting`}
          </span>
          {props.queueState.oldestAgeMs !== null && (
            <span className="text-[13px] text-muted-foreground">
              · oldest {Math.round(props.queueState.oldestAgeMs / 1000)}s
            </span>
          )}
        </div>

        {/* Refused work is never silently dropped, so it is never silently
            hidden either. Red, because this one is a stop. */}
        {rejected > 0 && (
          <div className="flex h-11 items-center gap-2 rounded-[10px] border-2 border-destructive bg-[#FFF5F5] px-4">
            <span className="font-mono text-[15px] font-semibold text-destructive">
              {rejected} refused
            </span>
            <button type="button" onClick={() => props.queue.clearRejected()}
              className="h-[30px] rounded-[10px] border border-destructive bg-card px-2.5 font-sans text-[13px] font-semibold text-destructive">
              Seen
            </button>
          </div>
        )}

        {/* This till's own receipt printer (USB or Bluetooth over a COM port): bills print on it directly. */}
        <PrinterConnection compact />

        {me?.bills && (
          <button type="button" onClick={() => setBillsOpen(true)}
            className="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-card px-3 font-sans text-[15px] font-semibold transition-colors hover:bg-background active:scale-[0.98] sm:h-11 sm:px-4">
            <ReceiptText aria-hidden className="size-4" />
            Bills
          </button>
        )}
        {me?.takings && (
          <button type="button" onClick={() => setTakingsOpen(true)}
            className="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-card px-3 font-sans text-[15px] font-semibold transition-colors hover:bg-background active:scale-[0.98] sm:h-11 sm:px-4">
            <ChartColumn aria-hidden className="size-4" />
            My takings
          </button>
        )}
        <UserBadge api={props.api} className="text-foreground" />
        <button type="button" onClick={props.onSignOut}
          className="flex h-10 items-center gap-2 rounded-[10px] border-[1.5px] border-foreground bg-card px-3 font-sans text-[15px] font-semibold transition-colors hover:bg-foreground hover:text-background active:scale-[0.98] sm:h-11 sm:px-[18px]">
          <LogOut aria-hidden className="size-4" />
          End shift
        </button>
      </div>

      {billsOpen && me !== null && (
        // Today's bills and earlier ones, Edit before day end, and Submit Day Bills.
        <div role="dialog" aria-label="Bills" className="fixed inset-0 z-30 flex flex-col bg-background">
          <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-3 sm:px-6">
            <div className="flex grow flex-col">
              <span className="text-[19px] font-bold tracking-[-0.3px]">Bills</span>
              <span className="text-[13px] text-muted-foreground">Every bill of this branch, by day. Today’s can be edited until the day is submitted.</span>
            </div>
            <button type="button" onClick={() => setBillsOpen(false)}
              className="h-11 shrink-0 rounded-[10px] border-[1.5px] border-foreground bg-card px-4 font-sans text-[15px] font-semibold">
              Close
            </button>
          </div>
          <div className="grow overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
              <BillHistory api={props.api} write={write} logoUrl={props.logoUrl ?? null}
                access={{ base: '/pos', capacity: 'pos', canEdit: me.billEdit, canSubmit: me.dayEnd, canReopen: false, canPrint: true }} />
            </div>
          </div>
        </div>
      )}

      {takingsOpen && (
        <MyTakings api={props.api} restaurant={props.device.tenantSlug} who={me?.fullName ?? null}
          onClose={() => setTakingsOpen(false)} />
      )}

      {/* The PWA's one honest caveat, and only when it applies. */}
      {props.durability !== 'persistent' && (
        <div className="flex shrink-0 items-center gap-2.5 border-b-2 border-foreground bg-card px-6 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="stroke-foreground" strokeWidth={1.75} strokeLinecap="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" />
          </svg>
          <span className="grow text-pretty text-sm text-foreground">
            {props.durability === 'unavailable'
              ? 'This browser is not letting the tablet store anything. Unsent work will be lost if the page closes.'
              : declined
                ? 'The browser did not agree to keep this till’s storage. Unsent work is still kept, but the browser may clear it if it runs short of space. Installing the POS or bookmarking it usually lets the browser agree.'
                : 'This tablet has not been granted persistent storage, so unsent work is at some risk if the browser needs space.'}
          </span>
          {props.durability === 'best-effort' && props.onRequestPersistence !== undefined && (
            <button type="button" disabled={asking} onClick={() => void askAgain()}
              className="h-10 shrink-0 rounded-[10px] border-[1.5px] border-foreground bg-card px-4 font-sans text-sm font-semibold disabled:opacity-50">
              {asking ? 'Asking…' : declined ? 'Ask again' : 'Keep this till’s work safe'}
            </button>
          )}
        </div>
      )}

      <div className="flex grow flex-col">
        <BillingWorkspace api={props.api} device={props.device} billingLeases={props.billingLeases}
          orderLeases={props.leases} keys={props.keys} logoUrl={props.logoUrl ?? null} />
      </div>
    </div>
  );
}
