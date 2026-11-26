import { RESERVED_SLUGS, SLUG_PATTERN, type PlanEntitlements } from '@universalpos/shared';

/**
 * The one restaurant app a person opens from an address: the POS (Dine-in,
 * Parcel, KOT and Billing on one sign-in), at `/{slug}/pos`.
 */
export type TabletApp = 'pos';

/**
 * Earlier addresses still served, so a till set up before keeps working:
 * `/{slug}/kot` was the POS's address, and `/{slug}/billing` opens its
 * Billing tab. The kitchen screen (`/kds`) was removed with the Basic-only
 * product and is no longer a POS address.
 */
const ALIASES: Readonly<Record<TabletApp, readonly string[]>> = {
  pos: ['pos', 'kot', 'billing'],
};

/**
 * The restaurant a tablet page is for. Null for any other address, including
 * the old bare `/` and `/kds.html`, which then ask which restaurant rather than
 * guessing one.
 */
export function tabletSlugFromPath(app: TabletApp, pathname: string = window.location.pathname): string | null {
  const match = new RegExp(`^/([^/]+)/(${ALIASES[app].join('|')})/?$`).exec(pathname);
  const slug = match?.[1] ?? null;
  return slug !== null && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug) ? slug : null;
}

/**
 * The restaurant's POS: Dine-in, Parcel, KOT and Billing on one sign-in. The
 * same document as `/{slug}/kot` (served directly, not redirected), so a till
 * opened at either address is the same till.
 */
export function posPath(slug: string): string {
  return `/${slug}/pos`;
}

export interface RestaurantLink { readonly key: 'pos' | TabletApp; readonly label: string; readonly path: string }

/**
 * The links a restaurant's plan opens, derived from its entitlements -- never
 * from a plan NAME. One function for the manager's access page and the control
 * plane's restaurant view, so the two cannot disagree. With the product Basic
 * only there is one: the POS (KOT named where the plan has it).
 */
export function restaurantLinks(
  slug: string, plan: Pick<PlanEntitlements, 'kot'>,
): readonly RestaurantLink[] {
  return [{
    key: 'pos', path: posPath(slug),
    label: plan.kot ? 'POS · Dine-in, Parcel, KOT, Billing' : 'POS · Dine-in, Parcel, Billing',
  }];
}

const TABLET_SEGMENTS: ReadonlySet<string> = new Set(Object.values(ALIASES).flat());
const SECTION_SEGMENT = /^[a-z][a-z-]*$/;

/**
 * The restaurant admin's address: `/{slug}` (the dashboard) or
 * `/{slug}/{section}`. The slug chooses which restaurant's sign-in to show and
 * nothing more -- the tenant is always the verified token's. A tablet app's
 * segment is never an admin section, so `/{slug}/kot` stays the KOT app.
 * `section` is the raw segment; whether it names a section is the shell's call.
 */
export function adminLocationFromPath(
  pathname: string = window.location.pathname,
): { readonly slug: string; readonly section: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length > 2) return null;
  const [slug = '', section = ''] = parts;
  if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug)) return null;
  if (parts.length === 2 && (!SECTION_SEGMENT.test(section) || TABLET_SEGMENTS.has(section))) return null;
  return { slug, section };
}

export function adminPath(slug: string, section: string): string {
  return section === '' ? `/${slug}` : `/${slug}/${section}`;
}
