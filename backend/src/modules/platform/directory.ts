import type pg from 'pg';
import { localeForCurrency } from '@universalpos/shared';
import { logoUrl } from './branding.js';
import type { BillRounding } from '../tax/jurisdictions.js';
import { jurisdiction } from '../tax/registry.js';

/**
 * The control-plane READ MODEL: the two lists the console opens on, plus the one
 * slug resolution the control plane needs.
 *
 * ###########################################################################
 * IT READS `platform` AND NOTHING ELSE, AND THAT IS A BOUNDARY NOT A HABIT.
 *
 * `platformPermissions.ts` says it plainly: "there is no key here that reads
 * tenant operational data. The control plane never queries orders." So a tenant
 * row here carries its lifecycle, its plan and its delinquency clock -- the facts
 * the control plane is responsible FOR -- and no branch count, no order volume
 * and no user list. Those arrive as aggregates through `platform.usage_counter`
 * or they do not arrive at all.
 *
 * Every query runs with NO tenant GUC, because `registerPlatformRoute` opens its
 * transaction without one. That is only safe because nothing here touches schema
 * `app`: a join to `app.branch` would either raise 28000 or, run as the owner,
 * return every tenant's rows at once.
 * ###########################################################################
 */

/** A page size the console cannot talk us out of. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Bounded here rather than at the route layer. A cap a handler applies is a cap
 * the next caller of this function does not get, and `?limit=100000` against a
 * table with every tenant on the platform in it is the one read that can take
 * the control plane down.
 */
export function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

export interface TenantSummary {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly address: string | null;
  /** `#rrggbb`, or null for the product's own colours. */
  readonly themeColor: string | null;
  /** The second brand colour, `#rrggbb`, or null. */
  readonly themeColorSecondary: string | null;
  /** Public, versioned by content; null when the restaurant has no logo. */
  readonly logoUrl: string | null;
  readonly status: string;
  readonly statusChangedAt: string;
  /** Day 0 of the ladder. Null exactly when status is 'active' or 'deactivated'. */
  readonly delinquentSince: string | null;
  readonly deactivatedAt: string | null;
  readonly deactivationReason: string | null;
  /** ISO 3166-1 alpha-2: the tax jurisdiction, and so the law every bill is struck under. */
  readonly country: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly createdAt: string;
  /** Null for a tenant with no live subscription -- cancelled, expired or purged. */
  readonly subscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly planVersionId: string | null;
  readonly planKey: string | null;
  readonly planName: string | null;
  readonly planVersion: number | null;
  /** The price of the version this subscription was SOLD on, not the plan's latest. */
  readonly priceMinor: number | null;
  readonly priceCurrency: string | null;
  readonly billingPeriod: string | null;
  /**
   * The owner as the control plane knows them: the address the invite went to,
   * and whether it was taken up. Never a name read from `app.app_user` -- the
   * control plane does not query tenant data.
   */
  readonly ownerEmail: string | null;
  readonly ownerInviteStatus: string | null;
  /** As the salesperson was given them at the sale; see migration 0057. */
  readonly ownerName: string | null;
  readonly ownerPhone: string | null;
  /**
   * The newest invoice's standing: `none` before the first invoice, `paid`,
   * `due` (issued, not yet due) or `overdue`. Read from the invoice, never
   * guessed from the subscription status.
   */
  readonly billingStatus: 'none' | 'paid' | 'due' | 'overdue' | 'void';
  /** Who provisioned it. Null for a tenant created outside the console (a seed). */
  readonly salesPersonId: string | null;
  readonly salesPersonName: string | null;
  readonly salesPersonEmail: string | null;
  readonly salesPersonPhone: string | null;
  /** Sum of PAID invoices, in minor units of the tenant's currency. */
  readonly revenueMinor: number;
  /** Whether a support session could be opened right now. See impersonationPosture. */
  readonly impersonable: boolean;
}

export interface ListTenantsParams {
  readonly status?: string | undefined;
  /** Matches slug or name, case-insensitively. Never an id: see below. */
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
  readonly planKey?: string | undefined;
  /** A filter the Super Admin chooses. Distinct from the scoping below. */
  readonly salesPersonId?: string | undefined;
  readonly expiry?: ExpiryFilter | undefined;
  /**
   * A Salesperson's own book, not the whole estate.
   *
   * `sales` holds the same `platform.tenant.view` key as every other
   * platform role, which is unscoped by design for Support and Billing --
   * both need to find any restaurant on the platform to do their job. A
   * salesperson does not, and a sales rep who can browse every other rep's
   * accounts is not a permission this product should hand out by default.
   * So the scoping happens here, in the read model, keyed to who actually
   * provisioned the tenant -- not as a narrower permission key, because
   * there is exactly one role this applies to today and a key that exists
   * to be checked by one caller is a key that has not earned its place in
   * the catalogue yet.
   */
  readonly provisionedByPlatformUserId?: string | undefined;
}

export type ExpiryFilter = 'expired' | 'within_7_days' | 'within_30_days';

const EXPIRY_FILTERS: readonly ExpiryFilter[] = ['expired', 'within_7_days', 'within_30_days'];

/** An unrecognised value is no filter at all, never a filter on nothing. */
export function parseExpiryFilter(value: string | undefined): ExpiryFilter | undefined {
  return EXPIRY_FILTERS.find((f) => f === value);
}

/**
 * The tenant list.
 *
 * The subscription join is LEFT and filtered to the three live states, which is
 * exactly the predicate behind `subscription_one_live_per_tenant`. Relying on
 * that partial unique index rather than a DISTINCT ON is deliberate: if the index
 * were ever dropped this list would start duplicating rows, which is a visible
 * failure. A DISTINCT ON would silently pick one and hide it.
 *
 * The owner invite and the revenue are LATERAL subqueries rather than joins for
 * the opposite reason: a tenant legitimately has several invites (re-sent,
 * expired, revoked) and many invoices, and each folds to one value here -- the
 * newest invite, the paid total -- rather than multiplying the row.
 */
export async function listTenants(
  client: pg.ClientBase,
  params: ListTenantsParams = {},
): Promise<readonly TenantSummary[]> {
  const result = await client.query<{
    id: string; slug: string; name: string; legal_name: string | null; status: string;
    address: string | null; theme_color: string | null; theme_color_secondary: string | null; logo_sha256: Buffer | null;
    status_changed_at: string; delinquent_since: string | null;
    deactivated_at: string | null; deactivation_reason: string | null;
    tax_jurisdiction: string; default_currency: string; default_timezone: string; created_at: string;
    subscription_id: string | null; subscription_status: string | null;
    current_period_start: string | null; current_period_end: string | null;
    plan_version_id: string | null;
    plan_key: string | null; plan_name: string | null; plan_version: number | null;
    price_minor: string | null; price_currency: string | null; billing_period: string | null;
    owner_email: string | null; owner_invite_status: string | null;
    owner_name: string | null; owner_phone: string | null; billing_status: string;
    sales_person_id: string | null; sales_person_name: string | null;
    sales_person_email: string | null; sales_person_phone: string | null;
    revenue_minor: string;
  }>(
    `SELECT t.id, t.slug::text AS slug, t.name, t.legal_name, t.status,
            t.address, t.theme_color, t.theme_color_secondary, logo.sha256 AS logo_sha256,
            t.status_changed_at::text, t.delinquent_since::text,
            t.deactivated_at::text, t.deactivation_reason,
            t.tax_jurisdiction, t.default_currency, t.default_timezone, t.created_at::text,
            s.id AS subscription_id, s.status AS subscription_status,
            s.current_period_start::text, s.current_period_end::text,
            pv.id AS plan_version_id,
            p.key AS plan_key, p.name AS plan_name, pv.version AS plan_version,
            pv.price_minor::text, pv.currency AS price_currency, pv.billing_period,
            inv.email::text AS owner_email, inv.status AS owner_invite_status,
            inv.invitee_name AS owner_name, inv.invitee_phone AS owner_phone,
            COALESCE(bill.state, 'none') AS billing_status,
            sp.id AS sales_person_id, sp.full_name AS sales_person_name,
            sp.email::text AS sales_person_email, sp.phone AS sales_person_phone,
            paid.revenue_minor::text
       FROM platform.tenant t
       LEFT JOIN platform.tenant_logo logo ON logo.tenant_id = t.id
       LEFT JOIN platform.subscription s
              ON s.tenant_id = t.id
             AND s.status IN ('trialing', 'active', 'past_due')
       LEFT JOIN platform.plan_version pv ON pv.id = s.plan_version_id
       LEFT JOIN platform.plan p ON p.id = pv.plan_id
       LEFT JOIN platform.provisioning_request pr ON pr.tenant_id = t.id
       LEFT JOIN platform.platform_user sp ON sp.id = pr.requested_by_platform_user_id
       LEFT JOIN LATERAL (
              -- A pending invite past its expiry is reported as expired: the
              -- row is only relabelled when someone acts on it, and a list
              -- saying "invite sent" about a dead link sends nobody to fix it.
              SELECT i.email, i.invitee_name, i.invitee_phone,
                     CASE WHEN i.status = 'pending' AND i.expires_at < now() THEN 'expired'
                          ELSE i.status END AS status
                FROM platform.tenant_owner_invite i
               WHERE i.tenant_id = t.id
               ORDER BY i.created_at DESC LIMIT 1) inv ON true
       LEFT JOIN LATERAL (
              SELECT CASE WHEN v.status = 'paid' THEN 'paid'
                          WHEN v.status = 'void' THEN 'void'
                          WHEN v.due_date < CURRENT_DATE THEN 'overdue'
                          ELSE 'due' END AS state
                FROM platform.invoice v
               WHERE v.tenant_id = t.id
               ORDER BY v.issue_date DESC, v.number DESC LIMIT 1) bill ON true
       CROSS JOIN LATERAL (
              SELECT COALESCE(sum(v.total_minor), 0) AS revenue_minor
                FROM platform.invoice v
               WHERE v.tenant_id = t.id AND v.status = 'paid') paid
      WHERE ($1::text IS NULL OR t.status = $1::text)
        AND ($2::text IS NULL
             OR t.slug::text LIKE '%' || lower($2::text) || '%'
             OR t.name ILIKE '%' || $2::text || '%'
             OR inv.email::text ILIKE '%' || $2::text || '%')
        AND ($4::uuid IS NULL OR pr.requested_by_platform_user_id = $4::uuid)
        AND ($5::text IS NULL OR p.key = $5::text)
        AND ($6::uuid IS NULL OR pr.requested_by_platform_user_id = $6::uuid)
        AND ($7::text IS NULL
             OR ($7::text = 'expired' AND s.current_period_end < now())
             OR ($7::text = 'within_7_days' AND s.current_period_end >= now()
                 AND s.current_period_end < now() + interval '7 days')
             OR ($7::text = 'within_30_days' AND s.current_period_end >= now()
                 AND s.current_period_end < now() + interval '30 days'))
      ORDER BY t.created_at DESC, t.id
      LIMIT $3::int`,
    [
      params.status ?? null, params.search ?? null, boundedLimit(params.limit),
      params.provisionedByPlatformUserId ?? null,
      params.planKey ?? null, params.salesPersonId ?? null, params.expiry ?? null,
    ],
  );

  return result.rows.map((row) => ({
    tenantId: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name,
    address: row.address,
    themeColor: row.theme_color,
    themeColorSecondary: row.theme_color_secondary,
    logoUrl: logoUrl(row.slug, row.logo_sha256),
    status: row.status,
    statusChangedAt: row.status_changed_at,
    delinquentSince: row.delinquent_since,
    deactivatedAt: row.deactivated_at,
    deactivationReason: row.deactivation_reason,
    country: row.tax_jurisdiction,
    defaultCurrency: row.default_currency,
    defaultTimezone: row.default_timezone,
    createdAt: row.created_at,
    subscriptionId: row.subscription_id,
    subscriptionStatus: row.subscription_status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    planVersionId: row.plan_version_id,
    planKey: row.plan_key,
    planName: row.plan_name,
    planVersion: row.plan_version,
    priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    priceCurrency: row.price_currency,
    billingPeriod: row.billing_period,
    ownerEmail: row.owner_email,
    ownerInviteStatus: row.owner_invite_status,
    ownerName: row.owner_name,
    ownerPhone: row.owner_phone,
    billingStatus: row.billing_status as TenantSummary['billingStatus'],
    salesPersonId: row.sales_person_id,
    salesPersonName: row.sales_person_name,
    salesPersonEmail: row.sales_person_email,
    salesPersonPhone: row.sales_person_phone,
    revenueMinor: Number(row.revenue_minor),
    // Not recomputed here: `impersonationPosture` is the one ruling on which
    // rungs admit a support session, and a second copy of that list on the
    // console's list screen would drift from the one the guard enforces.
    impersonable: row.status !== 'purged',
  }));
}

export interface PlanVersionSummary {
  readonly planVersionId: string;
  readonly version: number;
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingPeriod: string;
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
  /** Null for a draft version. An unpublished version may not be sold. */
  readonly publishedAt: string | null;
  readonly liveSubscriptions: number;
  /** The same live subscriptions, split by where they are in the billing cycle. */
  readonly subscriptionsByStatus: { readonly trialing: number; readonly active: number; readonly past_due: number };
}

export interface PlanSummary {
  readonly planId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly versions: readonly PlanVersionSummary[];
}

/**
 * Plans, with every version and how many live subscriptions sit on each.
 *
 * The subscription count is the part that makes this screen usable rather than
 * decorative: "editing a plan creates a version; live subscriptions stay on the
 * version they were sold" means a retired version with tenants on it is a normal
 * state, and nobody can plan a migration without knowing how many.
 */
export async function listPlans(client: pg.ClientBase): Promise<readonly PlanSummary[]> {
  const result = await client.query<{
    plan_id: string; key: string; name: string; description: string | null;
    status: string;
    version_id: string | null; version: number | null; price_minor: string | null;
    currency: string | null; billing_period: string | null;
    limits: Record<string, number> | null; features: Record<string, boolean> | null;
    published_at: string | null; live_subscriptions: string | null;
    trialing: string | null; active: string | null; past_due: string | null;
  }>(
    `SELECT p.id AS plan_id, p.key, p.name, p.description, p.status,
            pv.id AS version_id, pv.version, pv.price_minor::text,
            pv.currency, pv.billing_period, pv.limits, pv.features,
            pv.published_at::text,
            (SELECT count(*) FROM platform.subscription s
              WHERE s.plan_version_id = pv.id
                AND s.status IN ('trialing', 'active', 'past_due'))::text
              AS live_subscriptions,
            (SELECT count(*) FROM platform.subscription s
              WHERE s.plan_version_id = pv.id AND s.status = 'trialing')::text AS trialing,
            (SELECT count(*) FROM platform.subscription s
              WHERE s.plan_version_id = pv.id AND s.status = 'active')::text AS active,
            (SELECT count(*) FROM platform.subscription s
              WHERE s.plan_version_id = pv.id AND s.status = 'past_due')::text AS past_due
       FROM platform.plan p
       LEFT JOIN platform.plan_version pv ON pv.plan_id = p.id
      ORDER BY p.key, pv.version`,
  );

  const byPlan = new Map<string, PlanSummary & { versions: PlanVersionSummary[] }>();
  for (const row of result.rows) {
    let plan = byPlan.get(row.plan_id);
    if (!plan) {
      plan = {
        planId: row.plan_id,
        key: row.key,
        name: row.name,
        description: row.description,
        status: row.status,
        versions: [],
      };
      byPlan.set(row.plan_id, plan);
    }
    // A plan with no versions is a real state -- created and not yet priced --
    // so the LEFT JOIN's null row becomes an empty version list, not a phantom.
    if (row.version_id === null || row.version === null) continue;
    plan.versions.push({
      planVersionId: row.version_id,
      version: row.version,
      priceMinor: Number(row.price_minor),
      currency: row.currency!,
      billingPeriod: row.billing_period!,
      limits: row.limits ?? {},
      features: row.features ?? {},
      publishedAt: row.published_at,
      liveSubscriptions: Number(row.live_subscriptions ?? '0'),
      subscriptionsByStatus: {
        trialing: Number(row.trialing ?? '0'),
        active: Number(row.active ?? '0'),
        past_due: Number(row.past_due ?? '0'),
      },
    });
  }
  return [...byPlan.values()];
}

export class TenantSlugUnknownError extends Error {
  readonly code = 'tenant_slug_unknown';
  constructor(readonly slug: string) {
    super(`no tenant has the slug ${JSON.stringify(slug)}`);
    this.name = 'TenantSlugUnknownError';
  }
}

export interface ResolvedTenantRef {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}

/**
 * A slug to a tenant id, for the control plane.
 *
 * ###########################################################################
 * DELIBERATELY NOT `resolveTenantForAuth`.
 *
 * That function shares this query and must not be reused here, because it
 * applies `AUTHENTICABLE_TENANT_STATUSES` -- an allowlist about LOGGING IN. It
 * refuses `hard_lock`, and `impersonationPosture` says the opposite in as many
 * words: hard_lock is "permitted. That is precisely when support is needed."
 * Borrowing the login allowlist would make support unavailable at the one rung
 * where the tenant is definitely on the phone.
 *
 * So this resolves and returns the status; the CALLER rules on it, and for
 * impersonation the caller's ruling is `impersonationPosture`, which is the one
 * place that list lives.
 * ###########################################################################
 */
export async function resolveTenantBySlug(
  client: pg.ClientBase,
  slug: unknown,
): Promise<ResolvedTenantRef> {
  // 63 is the bound `tenant_slug_format` imposes. Not re-validated against the
  // regex here: a second copy of it is a second thing to keep in step, and a
  // slug the CHECK would have refused simply does not resolve.
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 63) {
    throw new TenantSlugUnknownError(String(slug));
  }
  const found = await client.query<{ id: string; slug: string; name: string; status: string }>(
    `SELECT id, slug::text AS slug, name, status FROM platform.tenant WHERE slug = $1`,
    [slug],
  );
  const row = found.rows[0];
  if (!row) throw new TenantSlugUnknownError(slug);
  return { tenantId: row.id, slug: row.slug, name: row.name, status: row.status };
}

/* ------------------------------------------------ the public restaurant page --- */

export class RestaurantNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'restaurant_not_found';
  constructor(readonly slug: string) {
    super('No restaurant has this address.');
    this.name = 'RestaurantNotFoundError';
  }
}

export interface PublicRestaurant {
  readonly slug: string;
  readonly name: string;
  /** False when the restaurant exists but cannot be signed in to right now. */
  readonly signInAvailable: boolean;
  /** Its look, for its own sign-in page and admin screens. Both public by design. */
  readonly themeColor: string | null;
  /** The second brand colour, for tinted surfaces; null keeps tints of the primary. */
  readonly themeColorSecondary: string | null;
  readonly logoUrl: string | null;
  /**
   * Addresses this restaurant had before a rename. They were public addresses
   * and still resolve; a page uses them to find what a tablet stored under an
   * old slug, so a tablet opened straight at the NEW address stays set up.
   */
  readonly formerSlugs: readonly string[];
  /**
   * How the restaurant's money is shown: its currency and the locale amounts are
   * grouped in. Public by design -- every menu and bill it prints says as much --
   * and read here so the admin and the till format every amount the one way the
   * restaurant bills, from the same lookup that already brands them.
   */
  readonly currency: string;
  readonly locale: string;
  /** Whether its bills are paid to the nearest whole unit, so the till may show headlines that way. */
  readonly billRounding: BillRounding;
}

export class LogoNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'logo_not_found';
  constructor() {
    super('This restaurant has no logo.');
    this.name = 'LogoNotFoundError';
  }
}

/** The logo image itself, for `GET /api/public/restaurants/:slug/logo`. */
export async function publicRestaurantLogo(
  client: pg.ClientBase,
  slug: string,
): Promise<{ contentType: string; bytes: Buffer; etag: string }> {
  if (slug.length === 0 || slug.length > 63) throw new RestaurantNotFoundError(slug);
  const found = await client.query<{ content_type: string; bytes: Buffer; sha256: Buffer }>(
    `SELECT l.content_type, l.bytes, l.sha256
       FROM platform.tenant t
       JOIN platform.tenant_logo l ON l.tenant_id = t.id
      WHERE t.id = platform.tenant_id_for_slug($1) AND t.status <> 'purged'`,
    [slug]);
  const row = found.rows[0];
  if (!row) throw new LogoNotFoundError();
  return { contentType: row.content_type, bytes: row.bytes, etag: `"${row.sha256.toString('hex')}"` };
}

/**
 * What `/{slug}` may show BEFORE anyone signs in: the restaurant's name and
 * whether sign-in is open. Nothing else -- no plan, no status word, no owner,
 * no counts. The slug is already public (it is the restaurant's address), so
 * confirming a name for it discloses nothing the address did not.
 *
 * `signInAvailable` applies the SAME allowlist login does
 * (`AUTHENTICABLE_TENANT_STATUSES`), passed in rather than restated here, so
 * the page cannot invite a sign-in the login route would refuse.
 */
export async function publicRestaurantBySlug(
  client: pg.ClientBase,
  slug: string,
  authenticable: readonly string[],
): Promise<PublicRestaurant> {
  if (slug.length === 0 || slug.length > 63) throw new RestaurantNotFoundError(slug);
  const found = await client.query<{
    slug: string; name: string; status: string; theme_color: string | null; theme_color_secondary: string | null;
    logo_sha256: Buffer | null; former_slugs: string[]; default_currency: string; tax_jurisdiction: string;
  }>(
    `SELECT t.slug::text AS slug, t.name, t.status, t.theme_color, t.theme_color_secondary, l.sha256 AS logo_sha256,
            t.default_currency, t.tax_jurisdiction,
            ARRAY(SELECT h.slug::text FROM platform.tenant_slug_history h
                   WHERE h.tenant_id = t.id ORDER BY h.retired_at) AS former_slugs
       FROM platform.tenant t
       LEFT JOIN platform.tenant_logo l ON l.tenant_id = t.id
      WHERE t.id = platform.tenant_id_for_slug($1) AND t.status <> 'purged'`,
    [slug]);
  const row = found.rows[0];
  if (!row) throw new RestaurantNotFoundError(slug);
  // `slug` is the CURRENT address. Asked by a former one, the answer differs
  // from the question, and that difference is how a page knows to redirect.
  return {
    slug: row.slug, name: row.name, signInAvailable: authenticable.includes(row.status),
    themeColor: row.theme_color, themeColorSecondary: row.theme_color_secondary,
    logoUrl: logoUrl(row.slug, row.logo_sha256), formerSlugs: row.former_slugs,
    currency: row.default_currency, locale: localeForCurrency(row.default_currency),
    billRounding: jurisdiction(row.tax_jurisdiction).billRounding,
  };
}
