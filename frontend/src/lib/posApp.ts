import { posPath } from './restaurantPath.js';

/**
 * The installable POS app: pure helpers shared by the manager's Install card
 * and the POS document. Side effects (the manifest link, the service worker,
 * the browser's install prompt) live in `services/posApp.ts`.
 *
 * An installed app's home-screen icon opens the manifest's `start_url`, which is
 * the restaurant's own `/{slug}/pos` (the API's `posApp.ts`); the till's identity
 * and session are stored under that slug, so an icon can only ever open its own
 * restaurant's POS.
 */

/** The query a link adds to open the POS with its install help showing. Never part of `start_url`. */
export const INSTALL_PARAM = 'install';

/** The address the Install card's QR code and button open: the POS, with its install help. */
export function posInstallUrl(origin: string, slug: string): string {
  return `${origin}${posPath(slug)}?${INSTALL_PARAM}=1`;
}

export function posManifestPath(slug: string): string {
  return `/api/public/restaurants/${slug}/manifest`;
}

/** Whether this page was opened from an install link (and not from the installed app's icon). */
export function wantsInstallHelp(search: string): boolean {
  return new URLSearchParams(search).get(INSTALL_PARAM) === '1';
}

/** The same address without the install query, so a refresh or a bookmark opens the plain POS. */
export function withoutInstallParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(INSTALL_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type PhoneKind = 'android' | 'iphone' | 'other';

/**
 * Which install steps to put first. iPadOS reports itself as a Mac, so a Mac
 * with a touch screen is counted with the iPhone: both add to the Home Screen
 * from Share. Only the order of the help depends on this, never what is allowed.
 */
export function phoneKind(userAgent: string, maxTouchPoints: number): PhoneKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iphone';
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'iphone';
  return 'other';
}

/** Running as the installed app (Android, desktop Chrome) or from an iPhone Home Screen icon. */
export function isInstalledApp(win: Pick<Window, 'matchMedia' | 'navigator'>): boolean {
  if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) return true;
  return (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * The install steps, one wording for the manager's card and the POS's own
 * install help. The app is named as the manifest names it ("{restaurant} POS").
 */
export function androidSteps(appName: string): readonly string[] {
  return [
    'Open the link or scan the QR code in Chrome.',
    'Tap Install app when Chrome offers it, or the ⋮ menu → Install app (or Add to Home screen).',
    `Tap Install. ${appName} appears on the Home screen.`,
    `Open ${appName} from the Home screen.`,
  ];
}

export function iphoneSteps(appName: string): readonly string[] {
  return [
    'Open the link or scan the QR code in Safari.',
    'Tap Share (the square with an arrow) at the bottom of the screen.',
    'Scroll down and tap Add to Home Screen, then Add.',
    `Open ${appName} from the Home Screen, and set up the till there: the Home Screen app keeps its own sign-in, apart from Safari.`,
  ];
}

/** An icon size iOS and Android launchers can use: square and at least this many pixels. */
export const APP_ICON_MIN_PX = 180;

/** Whether an image's natural size can be the app's icon (the same rule as the API's manifest, a little smaller for iOS). */
export function usableAsAppIcon(width: number, height: number): boolean {
  return width === height && width >= APP_ICON_MIN_PX;
}
