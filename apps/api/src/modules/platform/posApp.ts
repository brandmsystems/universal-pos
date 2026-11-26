import type pg from 'pg';
import { imageSize } from './branding.js';
import { LogoNotFoundError, publicRestaurantBySlug, publicRestaurantLogo, type PublicRestaurant } from './directory.js';

/**
 * The installable POS app's manifest, one per restaurant.
 *
 * Its `start_url`, `scope` and `id` are that restaurant's POS, `/{slug}/pos`, so
 * the home-screen icon opens that restaurant's till and nothing else: the POS
 * keeps the till's identity and session under the slug in its address, and
 * the server never takes a tenant from anything but a verified token. Two
 * restaurants installed on one phone are two apps (different `id`s).
 *
 * Public by design, like the lookup it reads: the restaurant's name, colour and
 * logo, which its own sign-in page already shows. Asked by a former slug, it
 * answers for the CURRENT one, as the lookup does.
 */

export interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: 'any' | 'maskable';
}

export interface PosAppManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly lang: 'en';
  readonly start_url: string;
  readonly scope: string;
  readonly display: 'standalone';
  readonly orientation: 'any';
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly ManifestIcon[];
  readonly prefer_related_applications: false;
}

/** KatKitchen's own icons, in apps/web/public/app-icons (shipped in the web image; public/brand is not): the app icon when the restaurant has no usable logo. */
export const KATKITCHEN_APP_ICONS: readonly ManifestIcon[] = [
  { src: '/app-icons/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/pos-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** The POS's own colours (apps/web/src/styles/pos.css), so the splash screen matches the first screen. */
const POS_PRIMARY = '#FA5C00';
const POS_BACKGROUND = '#F7F7F7';

/** A launcher icon must be square and at least this big, or Android falls back to a letter. */
const LOGO_MIN_PX = 192;

/**
 * The image types Chrome installs an app with. A JPEG logo is refused
 * (`manifest-missing-suitable-icon`, seen in Chrome against a square 1254 px
 * JPEG), so a JPEG keeps the KatKitchen icon; the iPhone, which takes a JPEG,
 * still shows it (services/posApp.ts).
 */
const ICON_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/webp']);

export interface StoredLogo {
  readonly url: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

/** Pure: the manifest for a restaurant and its logo, if any. */
export function buildPosAppManifest(
  restaurant: Pick<PublicRestaurant, 'slug' | 'name' | 'themeColor'>, logo: StoredLogo | null,
): PosAppManifest {
  const pos = `/${restaurant.slug}/pos`;
  // The restaurant's logo is the icon only where a launcher can use it as one;
  // alone, because Android prefers a maskable icon and would pick ours over it.
  const usable = logo !== null && ICON_TYPES.has(logo.contentType)
    && logo.width === logo.height && logo.width >= LOGO_MIN_PX;
  return {
    id: pos,
    name: `${restaurant.name} POS`,
    short_name: restaurant.name,
    description: `${restaurant.name}'s till on KatKitchen: orders, bills and payments.`,
    lang: 'en',
    start_url: pos,
    scope: pos,
    display: 'standalone',
    orientation: 'any',
    theme_color: restaurant.themeColor ?? POS_PRIMARY,
    background_color: POS_BACKGROUND,
    icons: usable
      ? [{ src: logo.url, sizes: `${logo.width}x${logo.height}`, type: logo.contentType, purpose: 'any' }]
      : KATKITCHEN_APP_ICONS,
    prefer_related_applications: false,
  };
}

export async function posAppManifest(
  client: pg.ClientBase, slug: string, authenticable: readonly string[],
): Promise<PosAppManifest> {
  const restaurant = await publicRestaurantBySlug(client, slug, authenticable);
  let logo: StoredLogo | null = null;
  if (restaurant.logoUrl !== null) {
    try {
      const stored = await publicRestaurantLogo(client, restaurant.slug);
      const size = imageSize(stored.contentType, stored.bytes);
      if (size !== null) logo = { url: restaurant.logoUrl, contentType: stored.contentType, ...size };
    } catch (error) {
      // Removed between the two reads: the KatKitchen icon, not a failed manifest.
      if (!(error instanceof LogoNotFoundError)) throw error;
    }
  }
  return buildPosAppManifest(restaurant, logo);
}
