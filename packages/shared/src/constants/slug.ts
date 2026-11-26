/**
 * A restaurant's slug: its address (`/abc-restaurant`) and its sign-in path.
 * ONE definition for the API (which enforces it) and the console (which gives
 * live feedback), so the form can never accept what the server refuses.
 * The database CHECK `tenant_slug_format` is the final authority on format.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * What a NEW slug must also be: hyphens only between letters or digits -- no
 * `abc--cafe`, no `abc-`. Kept apart from SLUG_PATTERN on purpose: that one
 * is also the ROUTING rule (vite, restaurantPath, the tablet gate), and it must
 * keep accepting every slug a restaurant already has, or tightening it would
 * make an existing restaurant unreachable at its own address. Migration 0072
 * holds the database to this rule for new and changed rows only (NOT VALID).
 */
const CLEAN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The Super Admin console's address: `/superadmin` and `/superadmin/{section}`.
 * The same platform.html document every control-plane role signs in to; the
 * name is reserved below so no restaurant can shadow it.
 */
export const SUPERADMIN_SEGMENT = 'superadmin';

/**
 * Top-level paths the site already owns. `/{slug}` shares that address space,
 * so a restaurant named "api" or "admin" would shadow what it is named after.
 * Grows only when the site gains a new top-level path (deploy/web.nginx.conf).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api', 'assets', 'brand', 'admin', 'platform', 'kds', 'pos', 'index',
  'healthz', 'login', 'logout', 'signin', 'signup', 'static', 'public',
  'www', 'app', 'apps', 'help', 'support', 'status', 'favicon', 'robots',
  SUPERADMIN_SEGMENT,
]);

/**
 * A name to a URL-friendly slug: lowercase, punctuation dropped, spaces and
 * runs of separators to one hyphen, accents folded. `Fresh & Tasty` ->
 * `fresh-tasty`, `Café Délice` -> `cafe-delice`.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** Null when acceptable; otherwise the sentence to show. Uniqueness is the server's to check. */
export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string' || slug === '') return 'A restaurant slug is required.';
  if (!SLUG_PATTERN.test(slug) || !CLEAN_SLUG.test(slug)) {
    return 'A slug uses lowercase letters and digits, 2–63 characters, with single hyphens only between them.';
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved by the site. Please choose another slug.`;
  return null;
}

export const SLUG_TAKEN_MESSAGE = 'This restaurant slug is already in use. Please choose another slug.';
