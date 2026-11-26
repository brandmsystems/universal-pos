import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { adminLocationFromPath } from '../../../lib/restaurantPath.js';
import { PageSkeleton } from '../../../components/admin/skeletons.js';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { moveRestaurantStorage } from '../../../services/storage.js';
import { setRestaurantMoney } from '../../../lib/money.js';

/**
 * A restaurant's own address, `/{slug}`.
 *
 * The slug in the address only chooses WHICH restaurant's sign-in page to
 * show. It grants nothing: a session belongs to the restaurant whose login
 * issued it, every restaurant API reads the tenant from that verified token,
 * and the database refuses another restaurant's rows. So this page can be
 * opened by anyone -- all it discloses is the restaurant's name, which its
 * address already implies.
 */

export interface PublicRestaurant {
  readonly slug: string;
  readonly name: string;
  readonly signInAvailable: boolean;
  readonly themeColor: string | null;
  /** The second brand colour; absent from an older API. */
  readonly themeColorSecondary?: string | null;
  readonly logoUrl: string | null;
  /** Addresses it had before a rename (absent from an older server). */
  readonly formerSlugs?: readonly string[];
  /** How its money is shown (0084): absent from an older server, which billed in INR. */
  readonly currency?: string;
  readonly billRounding?: 'nearest_rupee' | 'none';
}

/** The slug in the address bar, or null when this is not a `/{slug}` or `/{slug}/{section}` URL. */
export function slugFromPath(pathname: string = window.location.pathname): string | null {
  return adminLocationFromPath(pathname)?.slug ?? null;
}

export type RestaurantLookup =
  | { readonly state: 'loading' }
  | { readonly state: 'found'; readonly restaurant: PublicRestaurant }
  | { readonly state: 'not-found' }
  | { readonly state: 'unreachable' };

/**
 * How long a 5xx or a network failure is waited out before the page says the
 * server is unreachable. A sleeping API (Render free tier) answers 502 at once
 * and takes up to a minute to wake, and this lookup is the first request a
 * visitor makes -- failing on it showed "Can't reach the server" on every
 * first visit after a quiet spell. A 4xx is an answer and is never retried.
 */
const WAKE_WAIT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 10_000] as const;

/** The same address with its first path segment -- the slug -- replaced; path rest, query and hash kept. */
export function addressMovedTo(
  at: Pick<Location, 'pathname' | 'search' | 'hash'>, oldSlug: string, newSlug: string,
): string {
  const path = at.pathname.replace(new RegExp(`^/${oldSlug}(?=/|$)`), `/${newSlug}`);
  return `${path}${at.search}${at.hash}`;
}

/** Reads `GET /api/public/restaurants/:slug` -- no session needed or sent. */
export function useRestaurantBySlug(slug: string | null): RestaurantLookup | null {
  const [lookup, setLookup] = useState<RestaurantLookup | null>(slug === null ? null : { state: 'loading' });
  useEffect(() => {
    if (slug === null) { setLookup(null); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLookup({ state: 'loading' });
    const startedAt = Date.now();
    const attempt = async (n: number): Promise<void> => {
      try {
        const response = await fetch(`/api/public/restaurants/${encodeURIComponent(slug)}`);
        if (!live) return;
        if (response.status === 404) { setLookup({ state: 'not-found' }); return; }
        if (response.ok) {
          const restaurant = await response.json() as PublicRestaurant;
          if (!live) return;
          // Asked by a former address: the restaurant was renamed. Move what this
          // browser keeps to the new slug and open the same screen there, so a
          // tablet stays set up and a bookmark keeps working.
          if (restaurant.slug !== slug) {
            moveRestaurantStorage(slug, restaurant.slug);
            window.location.replace(addressMovedTo(window.location, slug, restaurant.slug));
            return;
          }
          // Opened at the NEW address with things still stored under an old one
          // (a tablet nobody has opened since the rename): move them first, so
          // the app below reads a tablet that is still set up.
          for (const former of restaurant.formerSlugs ?? []) moveRestaurantStorage(former, restaurant.slug);
          // Before any screen renders: every amount on the admin and the till
          // is formatted in the currency this restaurant bills in.
          setRestaurantMoney({ currency: restaurant.currency ?? 'INR', wholeUnitHeadlines: restaurant.billRounding !== 'none' });
          setLookup({ state: 'found', restaurant });
          return;
        }
        if (response.status < 500) { setLookup({ state: 'unreachable' }); return; }
      } catch {
        if (!live) return;
      }
      if (Date.now() - startedAt >= WAKE_WAIT_MS) { setLookup({ state: 'unreachable' }); return; }
      const delay = RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)] ?? 10_000;
      timer = setTimeout(() => { void attempt(n + 1); }, delay);
    };
    void attempt(0);
    return () => { live = false; if (timer !== undefined) clearTimeout(timer); };
  }, [slug]);
  return lookup;
}

function Frame(props: { title: string | ReactElement; children: ReactElement | ReactElement[] | string }): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 font-sans text-foreground">
      <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-[4px] border border-border bg-card p-7">
        <span className="text-2xl font-bold tracking-tight">{props.title}</span>
        {props.children}
      </div>
    </div>
  );
}

/** The sign-in card, while the slug lookup is out. Each app's own theme colours it. */
export function RestaurantLoading(): ReactElement {
  return (
    <Frame title={<Skeleton className="h-8 w-48" />}>
      <Loading label="restaurant" className="flex flex-col gap-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="mt-2 h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mt-1 h-[50px] w-full" />
      </Loading>
    </Frame>
  );
}

/**
 * The admin's own wait for the lookup. Signed in to this restaurant, it is the
 * admin shell still filling in; otherwise it is the sign-in card. Only the
 * shape is a guess: not found, switched off and unreachable each still get
 * their page.
 */
export function AdminRestaurantLoading(props: { signedIn: boolean }): ReactElement {
  if (!props.signedIn) return <RestaurantLoading />;
  return (
    <div className="flex min-h-screen bg-background font-sans text-foreground">
      <nav className="flex w-58 shrink-0 flex-col gap-0.5 border-r border-border bg-card py-5">
        <Loading label="restaurant" className="flex flex-col gap-4 px-5">
          <div className="flex items-center gap-2.5 pb-2">
            <Skeleton className="size-9 shrink-0" />
            <div className="flex flex-col gap-1.5"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-20" /></div>
          </div>
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-4 w-32" />)}
        </Loading>
      </nav>
      <main className="min-w-0 grow p-7"><PageSkeleton label="page" /></main>
    </div>
  );
}

/** An unknown slug is a page that says so -- never an empty dashboard or a generic sign-in. */
export function RestaurantNotFound(props: { slug: string }): ReactElement {
  return (
    <Frame title="Restaurant not found">
      <span className="text-sm leading-relaxed text-muted-foreground">
        There is no restaurant at <span className="font-mono text-foreground">/{props.slug}</span>.
        Check the address you were given, or ask whoever set up your restaurant for the right link.
      </span>
    </Frame>
  );
}

export function RestaurantUnavailable(props: { name: string }): ReactElement {
  return (
    <Frame title={props.name}>
      <span className="text-sm leading-relaxed text-muted-foreground">
        This restaurant cannot be signed in to right now. Please contact your account manager.
      </span>
    </Frame>
  );
}

export function RestaurantUnreachable(): ReactElement {
  return (
    <Frame title="Can’t reach the server">
      <span className="text-sm text-muted-foreground">Check the connection and reload this page.</span>
    </Frame>
  );
}
