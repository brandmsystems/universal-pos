import { useState } from 'react';
import type { ReactElement } from 'react';
import { RESERVED_SLUGS, SLUG_PATTERN } from '@universalpos/shared';
import {
  RestaurantLoading, RestaurantNotFound, RestaurantUnavailable, RestaurantUnreachable,
  useRestaurantBySlug, type PublicRestaurant,
} from '../admin/RestaurantPage.js';
import { tabletSlugFromPath, type TabletApp } from '../../../lib/restaurantPath.js';
import { useThemeColor, type Surface } from '../../../lib/theme.js';

/**
 * The POS starts here. The restaurant comes from the address -- `/{slug}/pos`
 * (older `/kot` and `/billing` links too) -- and is looked up before anything else renders:
 * an unknown restaurant is refused by name, a switched-off one says so, and only
 * a found one gets its colour applied and its app mounted.
 */
export function RestaurantGate(props: {
  app: TabletApp;
  surface: Surface;
  children: (restaurant: PublicRestaurant) => ReactElement;
}): ReactElement {
  const slug = tabletSlugFromPath(props.app);
  const lookup = useRestaurantBySlug(slug);
  const restaurant = lookup?.state === 'found' ? lookup.restaurant : null;
  useThemeColor(restaurant?.themeColor ?? null, props.surface, restaurant?.themeColorSecondary ?? null);

  if (slug === null) return <ChooseRestaurant />;
  if (lookup === null || lookup.state === 'loading') return <RestaurantLoading />;
  if (lookup.state === 'not-found') return <RestaurantNotFound slug={slug} />;
  if (lookup.state === 'unreachable') return <RestaurantUnreachable />;
  if (!lookup.restaurant.signInAvailable) return <RestaurantUnavailable name={lookup.restaurant.name} />;
  return props.children(lookup.restaurant);
}

/** The restaurant's logo and name, or the UniversalPOS mark when it has no logo. */
export function RestaurantMark(props: { restaurant: PublicRestaurant; size?: 'md' | 'lg' }): ReactElement {
  const box = props.size === 'lg' ? 'size-16' : 'size-10';
  return props.restaurant.logoUrl !== null
    ? <img src={props.restaurant.logoUrl} alt="" className={`${box} shrink-0 rounded-lg object-contain`} />
    : <img src="/brand/katkitchen-mark.jpg" alt="" className={`${box} shrink-0 object-contain`} />;
}

/**
 * Open restaurant goes to the restaurant's own page, `/{slug}`: the Restaurant
 * Manager's login, with a Staff button there for the POS.
 */
export function chooseRestaurantAddress(slug: string): string {
  return `/${slug}`;
}

function ChooseRestaurant(): ReactElement {
  const [slug, setSlug] = useState('');
  const clean = slug.trim().toLowerCase();
  const valid = SLUG_PATTERN.test(clean) && !RESERVED_SLUGS.has(clean);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 font-sans text-foreground">
      <form className="flex w-full max-w-[440px] flex-col gap-4 rounded-[10px] border border-border bg-card p-8"
        onSubmit={(event) => { event.preventDefault(); if (valid) window.location.assign(chooseRestaurantAddress(clean)); }}>
        <img src="/brand/katkitchen-mark.jpg" alt="" className="w-10" />
        <span className="text-2xl font-bold tracking-tight">Which restaurant?</span>
        <span className="text-sm leading-relaxed text-muted-foreground">
          Type the restaurant name to open its sign-in page.
        </span>
        <input value={slug} autoFocus onChange={(e) => setSlug(e.target.value)} placeholder="spicegarden"
          autoCapitalize="none" spellCheck={false}
          className="h-14 rounded-[10px] border border-input bg-card px-4 font-mono text-xl text-foreground" />
        <button type="submit" disabled={!valid}
          className="h-14 rounded-[10px] bg-primary text-lg font-bold text-primary-foreground disabled:opacity-40">
          Open restaurant
        </button>
      </form>
    </div>
  );
}
