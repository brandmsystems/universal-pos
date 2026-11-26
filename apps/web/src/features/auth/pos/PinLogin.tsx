import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ArrowLeft, ChevronRight, CircleCheck, Delete, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, UserRound, Users,
} from 'lucide-react';
import { ApiError, type Api, type DeviceIdentity, type Session } from '../../../services/api.js';
import { cn } from 'cn';
import type { PublicRestaurant } from '../../restaurants/admin/RestaurantPage.js';
import { RestaurantMark } from '../../restaurants/pos/RestaurantGate.js';

/**
 * Staff sign-in on the restaurant's till, two screens:
 *
 *   Screen 2 -- who is signing in: the till's staff as cards, from
 *               `GET /api/public/restaurants/:slug/till/staff` (answered only to
 *               a till, never naming a manager).
 *   Screen 3 -- the tapped person's 4-digit PIN on a keypad; the 4th digit signs
 *               in (`POST /api/auth/:slug/pin`).
 *
 * Identified, never anonymous: the PIN tells one KNOWN person apart and is never
 * a lookup key. Lockout, the till check and what the session may do are the
 * server's; this screen reports them. The PIN is never shown in a message.
 * Screen 1 is the restaurant's login page, whose Staff Login opens this.
 */

const PIN_LENGTH = 4;
/** How long "Signed in" shows before the POS opens. Long enough to read, short enough not to wait on. */
export const SUCCESS_MS = 350;

/** `hasPin` false: listed, but cannot sign in until the Sales person sets a PIN. Absent (an older API): true. */
type Person = { readonly userId: string; readonly fullName: string; readonly hasPin?: boolean };
type Roster =
  | { readonly state: 'loading' }
  | { readonly state: 'known'; readonly staff: readonly Person[] }
  | { readonly state: 'failed'; readonly offline: boolean };

const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || '?';

/**
 * An avatar in the restaurant's own colour (`--color-primary`, set from its
 * theme by RestaurantGate), with the foreground chosen for contrast. Nothing on
 * this screen names a colour of its own: a red brand gets red, a green one green.
 */
function Avatar(props: { person: Person; size: 'md' | 'lg' }): ReactElement {
  return (
    <span className={cn(
      'flex shrink-0 items-center justify-center rounded-full font-bold shadow-sm ring-4',
      props.size === 'lg'
        ? 'size-20 bg-primary text-2xl text-primary-foreground ring-accent'
        : 'size-14 bg-accent text-lg text-ink-orange ring-card',
    )}>
      {initials(props.person.fullName)}
    </span>
  );
}

export function PinLogin(props: {
  api: Api;
  /** Null on a browser that is not a till yet: a correct PIN makes it one. */
  device: DeviceIdentity | null;
  restaurant: PublicRestaurant;
  onSignedIn: (session: Session) => void;
  /** The server has no live till with this browser's identity: set it up again. */
  onTabletLost: () => void;
}): ReactElement {
  const [roster, setRoster] = useState<Roster>({ state: 'loading' });
  const [person, setPerson] = useState<Person | null>(null);

  const read = useCallback(async (): Promise<void> => {
    setRoster({ state: 'loading' });
    try {
      setRoster({ state: 'known', staff: await props.api.tillStaff(props.restaurant.slug) });
    } catch (error) {
      if (error instanceof ApiError && error.failure.kind === 'refused' && error.failure.code === 'tablet_not_set_up') {
        props.onTabletLost();
        return;
      }
      setRoster({ state: 'failed', offline: error instanceof ApiError && error.failure.kind === 'offline' });
    }
  }, [props]);
  useEffect(() => { void read(); }, [read]);

  return (
    <div className="flex min-h-[100dvh] items-start justify-center bg-[radial-gradient(ellipse_at_top,var(--color-accent),transparent_65%)] px-4 py-6 sm:items-center sm:p-8">
      <div className="flex w-full max-w-[720px] flex-col gap-6">
        <header className="flex items-center justify-between gap-3 animate-in fade-in duration-300">
          <div className="flex min-w-0 items-center gap-3">
            <RestaurantMark restaurant={props.restaurant} size="lg" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[22px] font-bold tracking-[-0.3px] text-foreground sm:text-[26px]">{props.restaurant.name}</span>
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-orange">
                <KeyRound aria-hidden className="size-3.5" /> Staff Login
              </span>
            </div>
          </div>
          {/* Managers sign in on their own page, never on the till. */}
          <a href={`/${props.restaurant.slug}`}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-sm transition-colors hover:border-foreground/30 active:scale-[0.98]">
            <ShieldCheck aria-hidden className="size-4" /> Manager Login
          </a>
        </header>

        {person === null
          ? <StaffCards roster={roster} onRetry={() => { void read(); }} onChoose={setPerson} />
          : <PinPad key={person.userId} api={props.api} tenantSlug={props.restaurant.slug} person={person} onBack={() => setPerson(null)}
              onSignedIn={props.onSignedIn} onTabletLost={props.onTabletLost} />}
      </div>
    </div>
  );
}

/* ----------------------------------------------- Screen 2: who are you --- */

function StaffCards(props: {
  roster: Roster; onRetry: () => void; onChoose: (person: Person) => void;
}): ReactElement {
  return (
    <section aria-label="Choose your name"
      className="flex flex-col gap-5 rounded-3xl border border-border bg-card p-5 shadow-xl shadow-black/5 animate-in fade-in slide-in-from-bottom-2 duration-300 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-ink-orange">
          <Users aria-hidden className="size-5" />
        </span>
        <div className="flex flex-col">
          <h1 className="m-0 text-[22px] font-bold text-foreground">Who&apos;s signing in?</h1>
          <span className="text-sm text-muted-foreground">Tap your name, then enter your 4-digit PIN.</span>
        </div>
      </div>

      {props.roster.state === 'loading' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Loading staff" role="status">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex h-[132px] flex-col items-center justify-center gap-3 rounded-2xl bg-muted/60 animate-pulse">
              <span className="size-14 rounded-full bg-muted" />
              <span className="h-3 w-20 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : props.roster.state === 'failed' ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="m-0 text-sm font-semibold text-destructive">
            {props.roster.offline ? 'No connection. The staff list needs one.' : 'The staff list did not load.'}
          </p>
          <button type="button" onClick={props.onRetry}
            className="flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-5 text-sm font-semibold transition-colors hover:bg-background">
            <RefreshCw aria-hidden className="size-4" /> Try again
          </button>
        </div>
      ) : props.roster.staff.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border p-8 text-center">
          <UserRound aria-hidden className="size-9 text-muted-foreground/70" />
          <p className="m-0 font-semibold text-foreground">No staff have been added yet.</p>
          <p className="m-0 text-sm text-muted-foreground">Your Sales person adds staff and sets their PIN.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {props.roster.staff.map((member, i) => member.hasPin === false ? (
            // Listed so nobody wonders where they went; no PIN pad to open, because no PIN exists to check.
            <div key={member.userId} aria-disabled="true" title="No PIN has been set for this person yet."
              style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}
              className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-muted/30 p-4 text-center animate-in fade-in slide-in-from-bottom-1 fill-mode-both">
              <span className="opacity-60"><Avatar person={member} size="md" /></span>
              <span className="max-w-full truncate text-base font-semibold text-muted-foreground">{member.fullName}</span>
              <span className="flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-ink-orange">
                <KeyRound aria-hidden className="size-3" /> PIN not set — ask your Sales person
              </span>
            </div>
          ) : (
            <button key={member.userId} type="button" onClick={() => props.onChoose(member)}
              style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}
              className="group flex min-h-[132px] flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-background p-4 text-center shadow-sm transition-[transform,box-shadow,border-color] duration-150 animate-in fade-in slide-in-from-bottom-1 fill-mode-both hover:-translate-y-0.5 hover:border-primary hover:shadow-md active:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              <Avatar person={member} size="md" />
              <span className="flex max-w-full items-center gap-1 text-base font-semibold text-foreground">
                <span className="truncate">{member.fullName}</span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------- Screen 3: the PIN --- */

function PinPad(props: {
  api: Api;
  tenantSlug: string;
  person: Person;
  onBack: () => void;
  onSignedIn: (session: Session) => void;
  onTabletLost: () => void;
}): ReactElement {
  const [pin, setPin] = useState('');
  const [shown, setShown] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped on each refused PIN, so the dots shake once per refusal (presentation only).
  const [shake, setShake] = useState(0);
  const [signedIn, setSignedIn] = useState(false);

  const submit = useCallback(async (value: string): Promise<void> => {
    if (!/^\d{4}$/.test(value)) { setRefusal('Your PIN is 4 digits.'); return; }
    setRefusal(null);
    setBusy(true);
    try {
      const session = await props.api.signInWithPin({ tenantSlug: props.tenantSlug, userId: props.person.userId, pin: value });
      // A beat of "Signed in" so the change of screen reads as success, not as a flicker.
      setSignedIn(true);
      setTimeout(() => props.onSignedIn(session), SUCCESS_MS);
    } catch (error) {
      // `till_not_permitted`: the PIN was right, but this browser is not a till and
      // this person may not make it one. Both answers need the manager's set-up --
      // the Manager Login link opens the manager screens, which never set a till up.
      if (error instanceof ApiError && error.failure.kind === 'refused'
        && (error.failure.code === 'tablet_not_set_up' || error.failure.code === 'till_not_permitted')) {
        props.onTabletLost();
        return;
      }
      // Lockout is reported as TIME, never as attempts remaining: a waiter told
      // "3 attempts remaining" during a rush enters a fourth guess.
      const seconds = error instanceof ApiError && error.failure.kind === 'refused'
        ? (error.failure as { retryAfterSeconds?: number }).retryAfterSeconds : undefined;
      setRefusal(
        error instanceof ApiError && error.failure.kind === 'offline'
          ? 'No connection. Signing in needs one.'
          : seconds !== undefined
          ? `Too many wrong PINs. Wait ${seconds} seconds, then try again.`
          : error instanceof ApiError && error.failure.kind === 'refused' && error.failure.code === 'upgrade_required'
          ? 'Every till this plan allows is in use. Ask the manager to take an old one out of use under Tablets.'
          : 'That PIN was not accepted. Try again.',
      );
      setPin('');
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [props]);

  const press = (digit: string): void => {
    if (busy || signedIn || pin.length >= PIN_LENGTH) return;
    setRefusal(null);
    const next = pin + digit;
    setPin(next);
    // Four digits is the whole PIN: sign in without a separate button press.
    if (next.length === PIN_LENGTH) void submit(next);
  };
  const erase = (): void => { if (!busy) setPin((current) => current.slice(0, -1)); };
  const clear = (): void => { if (!busy) { setPin(''); setRefusal(null); } };

  // A physical keyboard works too: digits, Backspace, Escape to go back.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') erase();
      else if (event.key === 'Escape') props.onBack();
      else if (event.key === 'Enter' && pin.length === PIN_LENGTH) void submit(pin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const key = (label: ReactElement | string, onPress: () => void, aria: string, extra?: string): ReactElement => (
    <button key={aria} type="button" onClick={onPress} disabled={busy || signedIn} aria-label={aria}
      className={cn(
        'flex h-14 items-center justify-center rounded-2xl border border-border bg-card font-sans text-[26px] font-semibold text-foreground shadow-sm',
        'transition-[transform,background-color,border-color] duration-100 [@media(min-height:760px)]:h-16 sm:[@media(min-height:860px)]:h-[72px]',
        'hover:border-primary/40 active:scale-95 active:border-primary active:bg-accent',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
        extra,
      )}>
      {label}
    </button>
  );
  const state = signedIn ? 'done' : busy ? 'busy' : refusal !== null ? 'refused' : 'typing';

  return (
    <section aria-label={`PIN for ${props.person.fullName}`}
      className="mx-auto flex w-full max-w-[400px] flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-black/5 animate-in fade-in slide-in-from-right-3 duration-200">
      {/* Who is signing in, on a band of the restaurant's colour. */}
      <div className="relative flex flex-col items-center gap-1.5 bg-accent px-5 pt-4 pb-5 text-center">
        <button type="button" onClick={props.onBack}
          className="absolute top-3 left-3 flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <ArrowLeft aria-hidden className="size-4" /> Back
        </button>
        <span className="mt-8 sm:mt-6"><Avatar person={props.person} size="lg" /></span>
        <span className="text-[22px] font-bold text-foreground">{props.person.fullName}</span>
        <span className="text-sm text-muted-foreground">Enter your 4-digit PIN</span>
      </div>

      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className={cn(
          'flex h-16 items-center gap-2 rounded-2xl border-2 bg-background px-3 transition-colors duration-150',
          state === 'refused' ? 'border-destructive' : state === 'done' ? 'border-paid' : pin.length > 0 ? 'border-primary' : 'border-border',
        )} aria-live="polite">
          <div key={shake} className={cn('flex grow justify-center gap-3.5', shake > 0 && 'animate-pin-shake')}
            role="status" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => (
              <span key={i} className={cn(
                'flex size-10 items-center justify-center rounded-xl font-mono text-xl font-bold transition-[transform,background-color] duration-150',
                i < pin.length
                  ? (shown ? 'scale-105 bg-accent text-foreground' : 'scale-105 bg-primary text-primary-foreground')
                  : 'bg-card text-transparent ring-1 ring-border',
                state === 'busy' && i < pin.length && 'animate-pulse',
              )}>
                {i < pin.length ? (shown ? pin[i] : '•') : '·'}
              </span>
            ))}
          </div>
          <button type="button" onClick={() => setShown((v) => !v)}
            aria-label={shown ? 'Hide PIN' : 'Show PIN'} aria-pressed={shown}
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
            {shown ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
          </button>
        </div>

        <div className="min-h-6 text-center" aria-live="polite">
          {state === 'busy' ? (
            <p className="m-0 flex items-center justify-center gap-2 text-sm font-semibold text-muted-foreground">
              <LoaderCircle aria-hidden className="size-4 animate-spin" /> Signing in…
            </p>
          ) : state === 'done' ? (
            <p className="m-0 flex items-center justify-center gap-2 text-sm font-semibold text-paid animate-in fade-in zoom-in-95 duration-150">
              <CircleCheck aria-hidden className="size-4" /> Signed in
            </p>
          ) : refusal !== null ? (
            <p role="alert" className="m-0 text-sm font-semibold text-destructive animate-in fade-in duration-150">{refusal}</p>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">Signs in on the fourth digit</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => key(digit, () => press(digit), digit))}
          {key('Clear', clear, 'Clear', 'text-sm font-semibold uppercase tracking-wider text-muted-foreground')}
          {key('0', () => press('0'), '0')}
          {key(<Delete aria-hidden className="size-6" />, erase, 'Delete last digit', 'text-muted-foreground')}
        </div>

        <button type="button" disabled={busy || signedIn || pin.length !== PIN_LENGTH} onClick={() => void submit(pin)}
          className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary text-base font-bold text-primary-foreground shadow-sm transition-[transform,opacity,filter] hover:brightness-105 active:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-40">
          {busy ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : <KeyRound aria-hidden className="size-5" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </section>
  );
}
