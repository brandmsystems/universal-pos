/**
 * What each plan includes, and what the admin menu shows for it.
 *
 * ###########################################################################
 * ONE DEFINITION, READ BY BOTH SIDES.
 *
 * The API refuses a request the plan does not include (402 upgrade_required);
 * the admin menu hides what the plan does not include. If each side kept its
 * own copy, the day they disagreed a manager would see a menu entry that
 * always refuses, or never see one they paid for.
 *
 * `ENTITLEMENTS` seeds the three standard plans. After that the published
 * plan version is the truth -- a Super Admin can publish Pro v2 with other
 * numbers -- so every consumer reads a version through `entitlementsFromTerms`,
 * never this constant, except to seed and to name "the plan that has it".
 * ###########################################################################
 */

/**
 * Every plan runs one outlet with KOT, printed kitchen tickets and Billing.
 * Pro adds the kitchen screen and further branches. Max was retired in 0064.
 * In price order: `lowestPlanIncluding` reads the first that has a feature.
 */
export const PLAN_KEYS = ['basic', 'standard', 'pro'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * `kot`: the separate order-taking flow -- KOT staff, kitchen tickets, the
 * billing hand-over. `kds`: the kitchen screen, which only means anything on top
 * of `kot`. Both are plan terms (0067): the plan decides, never a per-restaurant
 * switch that could disagree with what was sold.
 *
 * `staff_tablets`: separate staff tablets, set up with a one-time code and
 * signed in with a staff PIN. Basic is one person at one till -- the owner's
 * own computer, signed in with their email and password (0074) -- so it has
 * no setup codes at all; Standard and Pro hand tablets to staff.
 *
 * `tables`: floors, floor types and dining tables (0075). Basic has none: a
 * dine-in order there is numbered at the counter, like a parcel.
 */
export const PLAN_FEATURES = ['kot', 'kds', 'staff_tablets', 'tables'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_LIMITS = ['branches', 'devices', 'users'] as const;
export type PlanLimit = (typeof PLAN_LIMITS)[number];

export const REPORT_TIERS = ['basic', 'advanced'] as const;
export type ReportTier = (typeof REPORT_TIERS)[number];

export interface PlanEntitlements {
  readonly branches: number;
  /** KOT, kitchen and billing tablets that may be enrolled at once. */
  readonly devices: number;
  /**
   * Restaurant sign-ins: active accounts plus invites not yet accepted,
   * the owner included. Platform staff are never counted -- they are not
   * restaurant users. Only ADDING someone is refused at the limit.
   */
  readonly users: number;
  readonly kot: boolean;
  /** The kitchen screen. Without it KOT staff mark food ready themselves. */
  readonly kds: boolean;
  /** Staff tablets set up with a one-time code. Basic has none: one person, one till. */
  readonly staff_tablets: boolean;
  /** Floors, floor types and tables. Basic has none: dine-in is numbered at the counter. */
  readonly tables: boolean;
  readonly reports: ReportTier;
}

export const ENTITLEMENTS: Readonly<Record<PlanKey, PlanEntitlements>> = {
  basic: { branches: 1, devices: 2, users: 4, kot: true, kds: false, staff_tablets: false, tables: false, reports: 'basic' },
  standard: { branches: 1, devices: 4, users: 8, kot: true, kds: false, staff_tablets: true, tables: true, reports: 'advanced' },
  pro: { branches: 3, devices: 6, users: 25, kot: true, kds: true, staff_tablets: true, tables: true, reports: 'advanced' },
};

/**
 * A plan version stores `features` as booleans only, so the report tier is a
 * flag. Absent means false, which means `basic` -- the same direction as every
 * other absence in the entitlement document: it denies.
 */
export const REPORT_TIER_FLAGS = { advanced: 'reports_advanced' } as const;

/** Every feature key a plan version must state explicitly. */
export const PLAN_FEATURE_KEYS: readonly string[] = [
  ...PLAN_FEATURES, REPORT_TIER_FLAGS.advanced,
];

export interface PlanTermsShape {
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
}

export function planTermsFor(entitlements: PlanEntitlements): {
  limits: Record<PlanLimit, number>;
  features: Record<string, boolean>;
} {
  return {
    limits: { branches: entitlements.branches, devices: entitlements.devices, users: entitlements.users },
    features: {
      kot: entitlements.kot,
      kds: entitlements.kds,
      staff_tablets: entitlements.staff_tablets,
      tables: entitlements.tables,
      [REPORT_TIER_FLAGS.advanced]: entitlements.reports !== 'basic',
    },
  };
}

export function entitlementsFromTerms(terms: PlanTermsShape): PlanEntitlements {
  const on = (key: string): boolean => terms.features[key] === true;
  return {
    branches: terms.limits['branches'] ?? 0,
    devices: terms.limits['devices'] ?? 0,
    users: terms.limits['users'] ?? 0,
    kot: on('kot'),
    // A kitchen screen with no kitchen tickets to show is nothing.
    kds: on('kot') && on('kds'),
    staff_tablets: on('staff_tablets'),
    tables: on('tables'),
    reports: on(REPORT_TIER_FLAGS.advanced) ? 'advanced' : 'basic',
  };
}

export function reportTierAllows(held: ReportTier, needed: ReportTier): boolean {
  return REPORT_TIERS.indexOf(held) >= REPORT_TIERS.indexOf(needed);
}

/** What a route needs from the plan. Declared on the route, checked before its handler. */
export type PlanGate =
  | { readonly feature: PlanFeature }
  | { readonly reports: ReportTier }
  | { readonly limit: PlanLimit };

/** True when the plan includes the feature or tier. A limit is a count, checked where it is counted. */
export function planIncludes(entitlements: PlanEntitlements, gate: PlanGate): boolean {
  if ('feature' in gate) return entitlements[gate.feature];
  if ('reports' in gate) return reportTierAllows(entitlements.reports, gate.reports);
  return entitlements[gate.limit] > 0;
}

/** The cheapest standard plan that includes it -- for "Available on Pro". */
export function lowestPlanIncluding(gate: PlanGate): PlanKey | null {
  return PLAN_KEYS.find((key) => planIncludes(ENTITLEMENTS[key], gate)) ?? null;
}

export const PLAN_NAMES: Readonly<Record<PlanKey, string>> = { basic: 'Basic', standard: 'Standard', pro: 'Pro' };

export type AdminMenuKey = 'branches' | 'kot' | 'kds' | 'devices' | 'reports' | 'tables';

export type AdminMenu = Readonly<Record<AdminMenuKey, boolean>>;

export function getAdminMenu(entitlements: PlanEntitlements): AdminMenu {
  return {
    branches: entitlements.branches > 1,
    kot: entitlements.kot,
    kds: entitlements.kds,
    devices: entitlements.devices > 0,
    reports: entitlements.reports !== 'basic',
    tables: entitlements.tables,
  };
}
