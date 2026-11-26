import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Monitor, ShieldCheck, Users } from 'lucide-react';
import { createStore, scopedStore } from '../../services/storage.js';
import { createApi } from '../../services/api.js';
import { createQueue } from '../../services/queue.js';
import { createLeases } from '../../services/lease.js';
import { createPump } from '../../services/pump.js';
import { createConsensusKeys } from '../../lib/consensus.js';
import { businessTypeOf } from '@universalpos/shared';
import { BusinessProvider } from '../../lib/businessContext.js';
import '../../styles/pos.css';
import { SignIn } from '../../features/auth/admin/SignIn.js';
import { PinLogin } from '../../features/auth/pos/PinLogin.js';
import { Shift } from '../../features/orders/pos/Shift.js';
import { RestaurantGate } from '../../features/restaurants/pos/RestaurantGate.js';
import type { PublicRestaurant } from '../../features/restaurants/admin/RestaurantPage.js';
import { RestaurantMark } from '../../features/restaurants/pos/RestaurantGate.js';
import { InstallHelp } from '../../features/restaurants/pos/InstallHelp.js';
import { isInstalledApp, wantsInstallHelp, withoutInstallParam } from '../../lib/posApp.js';
import { setPosAppIdentity } from '../../services/posApp.js';

/**
 * Three states: not a till yet, a till with nobody signed in, and working.
 *
 * At `/{slug}/pos` -- the restaurant's POS, the only POS address, which the
 * login page's Staff Login opens. On a till, staff tap their name and type their
 * 4-digit PIN (`PinLogin`). Managers do not sign in here: their way in is the
 * Manager Login page, and the server refuses them a PIN or till session. A
 * browser that is not a till yet says so; the manager's credentials there only
 * set the till up.
 * No query-string redirect. The device identity and the session are
 * read synchronously out of storage, because a POS that flashes a spinner on
 * every boot reads as broken.
 */

export function App(): ReactElement {
  return (
    <RestaurantGate app="pos" surface="light">
      {(restaurant) => <PosApp key={restaurant.slug} restaurant={restaurant} />}
    </RestaurantGate>
  );
}

/**
 * Everything the tablet keeps -- its identity, the session, the queue -- is
 * stored under `pos:{slug}`, so this page can only ever act as a tablet of the
 * restaurant in its address.
 */
function PosApp(props: { restaurant: PublicRestaurant }): ReactElement {
  const store = useMemo(() => scopedStore(createStore(), `pos:${props.restaurant.slug}`), [props.restaurant.slug]);
  const api = useMemo(() => createApi(store), [store]);
  const queue = useMemo(() => createQueue(store), [store]);
  const leases = useMemo(() => createLeases(store, api), [store, api]);
  // Billing's leases in their own storage, as in the Billing app: KOT and Billing
  // lease the same session one after the other and must not overwrite each other.
  const billingLeases = useMemo(() => createLeases(scopedStore(store, 'billing'), api, 'billing'), [store, api]);
  // ONE pump for the process. Two would send the same operation twice under two
  // different keys, which is the exact failure the queue exists to prevent.
  const pump = useMemo(() => createPump({ api, queue, leases }), [api, queue, leases]);
  // Idempotency keys for the seven writes the server forbids offline, which
  // therefore cannot go through the queue and would otherwise mint a key in a
  // tap handler. Process-scoped like the pump, so navigating away from a table
  // and back does not re-key an intent whose response was lost. See
  // shared/consensus.ts.
  const keys = useMemo(() => createConsensusKeys(), []);

  const [device, setDevice] = useState(() => {
    const held = api.device();
    return held !== null && held.tenantSlug === props.restaurant.slug ? held : null;
  });
  useEffect(() => { document.title = `${props.restaurant.name} · KOT`; }, [props.restaurant.name]);
  // What an iPhone names and shows on its Home Screen (it does not read the manifest's).
  useEffect(() => { setPosAppIdentity(props.restaurant); }, [props.restaurant]);
  // Opened from the manager's install link or QR code, and not already the installed app.
  const [installHelp, setInstallHelp] = useState(
    () => wantsInstallHelp(window.location.search) && !isInstalledApp(window));
  const [session, setSession] = useState(() => api.session());
  // A restaurant the staff cards cannot serve without a set-up till (several
  // branches): the explanation, or the manager's form that sets the till up.
  const [needsSetUp, setNeedsSetUp] = useState(false);
  const [managerForm, setManagerForm] = useState(false);
  useEffect(() => api.onSessionEnded(() => setSession(null)), [api]);
  const [depth, setDepth] = useState(() => queue.snapshot());
  // The browser answers the persistence request after the first render; the
  // warning follows the answer instead of the moment the page was drawn.
  const [durability, setDurability] = useState(() => store.durability);
  useEffect(() => {
    setDurability(store.durability);
    return store.onDurabilityChange(setDurability);
  }, [store]);

  useEffect(() => queue.onChange(setDepth), [queue]);
  // A claim, a renew or a forget changes what every leased screen may do, and
  // the holder is not React state -- so it announces, and this is the one place
  // that turns the announcement into a render.
  const [, leaseTick] = useState(0);
  useEffect(() => leases.onChange(() => leaseTick((n) => n + 1)), [leases]);
  // Started only while somebody is on shift: a signed-out tablet has no token to
  // send with, and hammering a 401 would end the session it is trying to use.
  useEffect(() => (session === null ? undefined : pump.start()), [pump, session]);

  return (
    <BusinessProvider type={businessTypeOf(props.restaurant.businessType)}>
    <div className="min-h-screen bg-background font-sans text-foreground antialiased">
      {installHelp && (
        <InstallHelp restaurant={props.restaurant} onClose={() => {
          // A refresh or bookmark after this opens the plain POS.
          window.history.replaceState(window.history.state, '', withoutInstallParam(window.location.href));
          setInstallHelp(false);
        }} />
      )}
      {session === null && needsSetUp && !managerForm ? (
        // Not a till yet: said plainly, before any form. Only the manager makes one.
        <NotATill restaurant={props.restaurant} onSetUp={() => setManagerForm(true)} />
      ) : session === null && needsSetUp ? (
        // The manager setting this computer up as the till. A manager gets no POS
        // session from it (the server's rule): the staff cards follow.
        <SignIn api={api} restaurant={{ slug: props.restaurant.slug, name: props.restaurant.name }}
          pos={{
            onTill: (till, signed) => { setManagerForm(false); setNeedsSetUp(false); setDevice(till); setSession(signed); },
            onStaff: () => setManagerForm(false),
          }} />
      ) : session === null || device === null ? (
        // Staff Login: straight onto the staff cards, then the tapped person's PIN.
        // A correct PIN on a browser that is not a till yet makes it one.
        <PinLogin api={api} device={device} restaurant={props.restaurant}
          onSignedIn={(signed) => { setDevice(api.device()); setSession(signed); }}
          // A till a manager took out of use (Tablets), or a restaurant with several
          // branches: only the manager's set-up opens this computer again. It is not
          // forgotten here, so a staff PIN cannot quietly undo the manager's decision.
          onTabletLost={() => { setSession(null); setNeedsSetUp(true); }} />
      ) : (
        <Shift
          api={api}
          device={device}
          session={session}
          leases={leases}
          billingLeases={billingLeases}
          queue={queue}
          queueState={depth}
          pump={pump}
          keys={keys}
          durability={durability}
          logoUrl={props.restaurant.logoUrl}
          onRequestPersistence={() => store.requestPersistence()}
          onSignOut={() => {
            api.signOut();
            setSession(null);
          }}
        />
      )}
    </div>
    </BusinessProvider>
  );
}

/**
 * This computer is not the restaurant's till. The staff list and PIN sign-in
 * answer only a till -- a PIN accepted from any browser could be guessed by
 * anyone with the link, and the POS takes orders against the till's device -- so
 * this says so and offers the manager's one-time set-up. After it, Staff Login
 * on this computer opens straight onto the staff cards.
 */
function NotATill(props: { restaurant: PublicRestaurant; onSetUp: () => void }): ReactElement {
  return (
    <div className="flex min-h-screen items-start justify-center bg-[radial-gradient(ellipse_at_top,#FFF1E6,transparent_60%)] px-4 py-10 sm:items-center">
      <div className="flex w-full max-w-[520px] flex-col items-center gap-6 rounded-3xl border border-border bg-card p-6 text-center shadow-xl shadow-black/5 animate-in fade-in slide-in-from-bottom-2 duration-300 sm:p-10">
        <RestaurantMark restaurant={props.restaurant} size="lg" />
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-ink-orange">
          <Monitor aria-hidden className="size-7" />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[24px] font-bold text-foreground">This computer is not the till yet</h1>
          <p className="m-0 text-pretty text-[15px] text-muted-foreground">
            Staff sign in on {props.restaurant.name}&apos;s till. The Restaurant Manager sets this computer up once;
            after that, Staff Login here opens straight onto the staff cards.
          </p>
        </div>
        <ol className="m-0 flex w-full flex-col gap-2 p-0 text-left text-sm">
          {[
            [ShieldCheck, 'The manager sets it up once, with their username and password (this does not open the POS for them).'],
            [Users, 'Then every Staff Login on this computer shows the staff to tap.'],
          ].map(([Icon, text], i) => {
            const I = Icon as typeof ShieldCheck;
            return (
              <li key={i} className="flex items-center gap-3 rounded-xl bg-background px-4 py-3">
                <I aria-hidden className="size-5 shrink-0 text-ink-orange" />
                <span>{text as string}</span>
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={props.onSetUp}
          className="h-14 w-full rounded-2xl bg-brand-gradient font-sans text-lg font-bold text-black shadow-sm transition-transform active:scale-[0.98]">
          Set up this computer as the till
        </button>
      </div>
    </div>
  );
}
