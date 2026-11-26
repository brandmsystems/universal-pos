import { posPath } from '../lib/restaurantPath.js';
import { posManifestPath, usableAsAppIcon } from '../lib/posApp.js';

/**
 * The POS document's installable-app wiring: the restaurant's manifest, the
 * iPhone's Home Screen title and icon, the service worker, and the browser's
 * install prompt. Pure rules are in `lib/posApp.ts`.
 *
 * Nothing here stores or caches restaurant data: the manifest is the API's
 * public answer, and the worker (`public/pos-sw.js`) caches nothing.
 */

/** The link (or meta) element with this selector, made once. */
function headElement<T extends HTMLElement>(doc: Document, tag: 'link' | 'meta', attribute: 'rel' | 'name', value: string): T {
  const found = doc.head.querySelector<T>(`${tag}[${attribute}="${value}"]`);
  if (found !== null) return found;
  const made = doc.createElement(tag) as unknown as T;
  made.setAttribute(attribute, value);
  doc.head.appendChild(made);
  return made;
}

/** Points the page at this restaurant's manifest, so an install opens `/{slug}/pos`. */
export function linkPosManifest(slug: string, doc: Document = document): void {
  headElement<HTMLLinkElement>(doc, 'link', 'rel', 'manifest').href = posManifestPath(slug);
}

/**
 * What an iPhone puts on its Home Screen: it reads these from the page when
 * Add to Home Screen is tapped (Safari does not use the manifest's name or
 * icons). The restaurant's logo is the icon only when it is square and big
 * enough; otherwise the UniversalPOS icon from index.html stays.
 */
export function setPosAppIdentity(
  restaurant: { readonly name: string; readonly logoUrl: string | null }, doc: Document = document,
): void {
  headElement<HTMLMetaElement>(doc, 'meta', 'name', 'apple-mobile-web-app-title').content = `${restaurant.name} POS`;
  const { logoUrl } = restaurant;
  if (logoUrl === null || typeof Image === 'undefined') return;
  const probe = new Image();
  probe.onload = () => {
    if (usableAsAppIcon(probe.naturalWidth, probe.naturalHeight)) {
      headElement<HTMLLinkElement>(doc, 'link', 'rel', 'apple-touch-icon').href = logoUrl;
    }
  };
  probe.src = logoUrl;
}

/**
 * The worker that makes the POS an installable app, scoped to this restaurant's
 * POS. `updateViaCache: 'none'` and nginx's no-cache mean a deploy's worker is
 * picked up on the next launch. Its failure never stops the POS: the page works
 * as a page without it.
 */
export async function registerPosWorker(slug: string, nav: Navigator = navigator): Promise<boolean> {
  if (!('serviceWorker' in nav) || (typeof window !== 'undefined' && !window.isSecureContext)) return false;
  try {
    await nav.serviceWorker.register('/pos-sw.js', { scope: posPath(slug), updateViaCache: 'none' });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- install prompt --- */

/** Chrome's install prompt (not in the DOM's own types). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  /** The browser offered an install that a tap can start (Chrome, Edge, Samsung Internet). */
  readonly canPrompt: boolean;
  /** Installed while this page was open. */
  readonly installed: boolean;
}

let held: InstallPromptEvent | null = null;
let installed = false;
let unwatch: (() => void) | null = null;
const listeners = new Set<(state: InstallState) => void>();
const announce = (): void => { for (const listener of listeners) listener(installState()); };

/**
 * Listens from boot, because the browser may offer the install before React has
 * drawn anything. `hold` keeps Chrome's own mini-bar from showing, for a page
 * that shows its own Install button instead (the POS opened from an install link).
 */
export function watchInstallPrompt(options: { hold: boolean }, win: Window = window): void {
  if (unwatch !== null) return;
  const offered = (event: Event): void => {
    if (options.hold) event.preventDefault();
    held = event as InstallPromptEvent;
    announce();
  };
  const done = (): void => {
    held = null;
    installed = true;
    announce();
  };
  win.addEventListener('beforeinstallprompt', offered);
  win.addEventListener('appinstalled', done);
  unwatch = () => {
    win.removeEventListener('beforeinstallprompt', offered);
    win.removeEventListener('appinstalled', done);
  };
}

export function installState(): InstallState {
  return { canPrompt: held !== null, installed };
}

export function onInstallStateChange(listener: (state: InstallState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Shows the browser's install dialog. A prompt can be shown once, so it is spent either way. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = held;
  if (event === null) return 'unavailable';
  held = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return 'unavailable';
  } finally {
    announce();
  }
}

/** For tests: forget what an earlier test's page was offered. */
export function resetInstallPromptForTests(): void {
  held = null;
  installed = false;
  unwatch?.();
  unwatch = null;
  listeners.clear();
}
