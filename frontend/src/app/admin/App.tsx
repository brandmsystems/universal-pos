import { useEffect, useMemo, useState } from 'react';
import {
  ChefHat, ClipboardList, FileText, KeyRound, LayoutDashboard, LogOut, Menu, Percent, Printer, ReceiptText,
  Settings2, ShieldCheck, Store, TabletSmartphone, UtensilsCrossed, X, type LucideIcon,
} from 'lucide-react';
import {
  PLAN_NAMES, lowestPlanIncluding, type AdminMenu, type AdminMenuKey, type PlanEntitlements,
  type PlanKey,
} from '@universalpos/shared';
import type { ReactElement } from 'react';
import { createStore } from '../../services/storage.js';
import { createApi } from '../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { Table } from '../../features/settings/admin/Table.js';
import { Dashboard } from '../../features/dashboard/admin/Dashboard.js';
import { InstallPosApp } from '../../features/dashboard/admin/InstallPosApp.js';
import { TaxRates } from '../../features/settings/admin/TaxRates.js';
import { SignIn } from '../../features/auth/admin/SignIn.js';
import { AcceptInvite, readInviteToken } from '../../features/auth/admin/AcceptInvite.js';
import { PosKdsAccessPage } from '../../features/access/admin/pos-kds-access/PosKdsAccessPage.js';
import { Setup, StepScreen } from '../../features/settings/admin/setup/Setup.js';
import { OpenOrders } from '../../features/orders/admin/OpenOrders.js';
import { PrintedBill } from '../../features/billing/admin/PrintedBill.js';
import { Bills } from '../../features/billing/admin/Bills.js';
import { useThemeColor } from '../../lib/theme.js';
import { accentFor, titleFor, useBusinessType, visibleSections } from '../../lib/business.js';
import { BusinessProvider } from '../../lib/businessContext.js';
import {
  AdminRestaurantLoading, RestaurantNotFound, RestaurantUnavailable, RestaurantUnreachable,
  slugFromPath, useRestaurantBySlug,
} from '../../features/restaurants/admin/RestaurantPage.js';
import { adminLocationFromPath, adminPath } from '../../lib/restaurantPath.js';
import '../../styles/admin.css';
import { UserBadge } from '../../components/UserBadge.js';
import { PageSkeleton } from '../../components/admin/skeletons.js';

/**
 * Branch admin.
 *
 * ###########################################################################
 * PASSWORD, NOT PIN, AND THAT IS THE WHOLE AUTHENTICATION DECISION.
 *
 * A PIN is four digits typed in front of a room. It is the right credential for
 * "this waiter opened table 6" and the wrong one for "this person changed the
 * price of every item on the menu". So admin signs in with an email and a
 * password, over `POST /api/auth/:slug/login`, and no enrolment is involved: a
 * manager works from a laptop that is not a registered terminal.
 *
 * The consequence, which is visible throughout: a password session carries NO
 * branch_id. Every branch-scoped list therefore returns every branch, which is
 * correct for someone signed in at the tenant level -- and it is why the admin
 * list handlers apply the branch scope from the token rather than assuming one is
 * present.
 * ###########################################################################
 *
 * ###########################################################################
 * NO SIDEBAR FOR THINGS THAT DO NOT EXIST.
 *
 * Only what has a served route appears. A menu listing "Purchase orders" that
 * leads to an empty screen is worse than one that does not mention them: it
 * tells a manager the feature is there and broken rather than not built.
 *
 * The note at the foot of this nav used to say stock, purchasing and reports
 * "have working routes but no screens yet". That was half true and the wrong
 * half mattered: the WRITE routes existed and there was no GET for any of them,
 * so a screen was not missing -- it was impossible. The reads exist now, which
 * is what let the dashboard become the landing screen.
 * ###########################################################################
 *
 * ###########################################################################
 * TAILWIND + SHADCN, PHASE 19. THE LOOK IS UNCHANGED; THE MECHANISM IS NOT.
 *
 * Every colour and radius below is transcribed from tokens.ts's `a` object
 * into frontend/src/styles/admin.css -- see the comment there. This file, and
 * every admin screen under features/<feature>/admin, now composes shadcn primitives (Button,
 * Card, Table, Badge, Alert, AlertDialog, Select, Tabs, ToggleGroup) instead
 * of hand-rolled inline `style={{...}}` objects. Nothing about WHAT a screen
 * reads, writes or refuses changed -- every API call, every state machine,
 * every business rule (FIELD_CHOICES, CHOICE_HIDES, the complete-phone-only
 * customer lookup, the PII reveal audit log, the branch-scoped stock question)
 * is carried over exactly. Only how a row gets pixels is different.
 * ###########################################################################
 */

/**
 * Only what has a served route. Ordered by how often a manager needs it.
 *
 * `requires` names the plan feature a section needs, from the same menu map
 * the API's plan gates are declared against (shared constants/plans).
 * A section the plan leaves out is not offered at all: offering it only to
 * answer 402 is a menu that lies about what the restaurant has.
 */
const SECTIONS: readonly { resource: string; path: string; title: string; requires?: AdminMenuKey }[] = [
  { resource: '', path: '', title: 'Dashboard' },
  // Read only. Staff are added, given a PIN and switched off by the Sales person.
  { resource: 'access', path: 'access', title: 'Sale' },
  // An order left open holds its tables, and this is the only place a manager
  // can send one back to KOT or cancel it.
  { resource: 'orders', path: 'orders', title: 'Open orders' },
  // Every bill by day: edit any day's (a submitted day once reopened), reopen and submit days.
  { resource: 'bills', path: 'bills', title: 'Bills' },
  { resource: 'setup', path: 'setup', title: 'Setup' },
  { resource: 'menu/items', path: 'menu', title: 'Menu items' },
  // Above Branches because a dish cannot be priced without one, and until
  // migration 0050 a provisioned tenant had none at all -- so this is the first
  // screen a new restaurant needs and the one whose absence blocked the menu.
  { resource: 'tax', path: 'tax', title: 'Tax rates' },
  { resource: 'printed-bill', path: 'printed-bill', title: 'Printed bill' },
  { resource: 'branches', path: 'branches', title: 'Branches', requires: 'branches' },
  { resource: 'roles', path: 'roles', title: 'Roles' },
  { resource: 'stations', path: 'kitchens', title: 'Kitchens' },
  { resource: 'printers', path: 'printers', title: 'Printers' },
  { resource: 'devices', path: 'tablets', title: 'Tablets', requires: 'devices' },
];

/** The sidebar's icon for each section, by path. Presentation only: SECTIONS stays the list. */
const SECTION_ICON: Readonly<Record<string, LucideIcon>> = {
  '': LayoutDashboard, orders: ClipboardList, bills: FileText, setup: Settings2, menu: UtensilsCrossed, tax: Percent,
  'printed-bill': ReceiptText, branches: Store, access: KeyRound, roles: ShieldCheck, kitchens: ChefHat,
  printers: Printer, tablets: TabletSmartphone,
};

/**
 * `/{slug}/{path}` names a section. The address follows the sidebar and the
 * sidebar follows the address (a deep link, a refresh, back and forward); an
 * unknown path is the dashboard. It selects a screen and grants nothing -- the
 * plan and the server still decide what the screen may show.
 */
function sectionForPath(path: string | undefined): (typeof SECTIONS)[number] {
  return SECTIONS.find((section) => section.path === path) ?? SECTIONS[0]!;
}

type PlanRead =
  | { readonly state: 'loading' }
  | { readonly state: 'known'; readonly planKey: string; readonly entitlements: PlanEntitlements; readonly menu: AdminMenu }
  | { readonly state: 'unknown' };

/**
 * Loading shows only the ungated sections, so nothing appears and then
 * vanishes. An UNREADABLE plan shows everything, as before plans existed:
 * the sign-in may simply lack `tenant.settings.view`, and the API's 402 is
 * still the authority on every gated route.
 */
function offered(plan: PlanRead, requires: AdminMenuKey | undefined): boolean {
  if (requires === undefined) return true;
  if (plan.state === 'loading') return false;
  return plan.state === 'unknown' || plan.menu[requires];
}

export function App(): ReactElement {
  const store = useMemo(() => createStore(), []);
  const api = useMemo(() => createApi(store), [store]);

  const [session, setSession] = useState(() => api.session());
  useEffect(() => api.onSessionEnded(() => setSession(null)), [api]);
  const [active, setActive] = useState(() => sectionForPath(adminLocationFromPath()?.section));
  const [invite, setInvite] = useState(() => readInviteToken());
  const [prefill, setPrefill] = useState<{ tenantSlug: string; email: string } | null>(null);
  // `/{slug}`: this restaurant's own page. Null on admin.html itself.
  const urlSlug = useMemo(() => slugFromPath(), []);
  // The restaurant this page is for: the address when it names one, else the
  // signed-in restaurant. Its public lookup carries the name, logo and colour.
  const lookup = useRestaurantBySlug(urlSlug ?? session?.tenantSlug ?? null);
  const brand = lookup?.state === 'found' ? lookup.restaurant : null;
  // The kind of business decides the sections, their words and the look; a colour the business chose itself wins.
  const businessType = useBusinessType(brand?.businessType);
  const typeSections = useMemo(() => visibleSections(SECTIONS, businessType), [businessType]);
  useThemeColor(accentFor(brand?.themeColor ?? null, businessType), 'light', brand?.themeColorSecondary ?? null);
  const [plan, setPlan] = useState<PlanRead>({ state: 'loading' });
  // Below lg the sidebar is a drawer; this is only whether it is drawn open.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onPop = (): void => setActive(sectionForPath(adminLocationFromPath()?.section));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // An address naming no section, or one the plan leaves out, is corrected
  // to the dashboard it shows -- once the plan is known, so a deep link to a
  // gated section is not lost while the plan is still loading.
  useEffect(() => {
    const here = adminLocationFromPath();
    if (session === null || plan.state === 'loading' || here?.slug !== session.tenantSlug) return;
    const shown = offered(plan, active.requires) && typeSections.includes(active) ? active : SECTIONS[0]!;
    if (shown !== active) setActive(shown);
    if (here.section !== shown.path) {
      const { search, hash } = window.location;
      window.history.replaceState(null, '', adminPath(here.slug, shown.path) + search + hash);
    }
  }, [session, plan, active, typeSections]);

  useEffect(() => {
    if (session === null) return;
    let live = true;
    setPlan({ state: 'loading' });
    api.get<{ planKey: string; entitlements: PlanEntitlements; menu: AdminMenu }>('/admin/entitlements')
      .then((read) => { if (live) setPlan({ state: 'known', ...read }); })
      .catch(() => { if (live) setPlan({ state: 'unknown' }); });
    return () => { live = false; };
  }, [api, session]);

  // A link pasted into a tab that already has this app open changes only the
  // fragment -- no reload -- so the token has to be picked up as it arrives.
  useEffect(() => {
    const onHash = (): void => {
      const token = readInviteToken();
      if (token !== null) setInvite(token);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (invite !== null) {
    // Keyed by the token: a second link opened in the same tab must start a
    // fresh screen, not show the previous manager's "You're all set".
    return <AcceptInvite key={invite} token={invite}
      signIn={(input) => api.signInWithPassword(input)}
      onDone={(next) => { setPrefill(next); setInvite(null); }} />;
  }
  // ###########################################################################
  // THE ADDRESS CHOOSES THE SIGN-IN PAGE, NEVER THE DATA.
  //
  // A session from ANOTHER restaurant in this browser does not open this
  // restaurant's dashboard: `/fresh-bites` with ABC's session still stored shows
  // Fresh Bites' sign-in. Even if it did not, every API call carries ABC's token
  // and the server would answer with ABC's rows only -- this is presentation,
  // the wall is on the server.
  // ###########################################################################
  if (urlSlug !== null) {
    if (lookup === null || lookup.state === 'loading') {
      // Drawn as whichever screen the lookup will most likely lead to; the gate still decides.
      return <AdminRestaurantLoading signedIn={session?.tenantSlug === urlSlug} />;
    }
    if (lookup.state === 'not-found') return <RestaurantNotFound slug={urlSlug} />;
    if (lookup.state === 'unreachable') return <RestaurantUnreachable />;
    const restaurant = lookup.restaurant;
    // The POS has its own sign-in at `/{slug}/pos` (the same form); this page is
    // the manager screens' only.
    if (session === null || session.tenantSlug !== restaurant.slug) {
      if (!restaurant.signInAvailable) return <RestaurantUnavailable name={restaurant.name} />;
      return <SignIn api={api} onSignedIn={setSession} prefill={prefill}
        restaurant={{ slug: restaurant.slug, name: restaurant.name }} />;
    }
  }
  if (session === null) return <SignIn api={api} onSignedIn={setSession} prefill={prefill} />;

  const sections = typeSections.filter((section) => offered(plan, section.requires));
  // A section the plan no longer offers (a downgrade, or a stale selection)
  // falls back to the dashboard rather than rendering a screen that refuses.
  const current = sections.find((section) => section.resource === active.resource) ?? SECTIONS[0]!;
  // A deep link to a plan-gated section while the plan is still being read:
  // its screen is not decided yet, so neither it nor the dashboard is drawn.
  const pending = plan.state === 'loading' && active.requires !== undefined;
  // Always the signed-in restaurant's: past the gate above, a slug in the
  // address is that same restaurant.
  const slug = session.tenantSlug;
  const open = (section: (typeof SECTIONS)[number]): void => {
    setActive(section);
    setNavOpen(false);
    const to = adminPath(slug, section.path);
    if (window.location.pathname !== to) window.history.pushState(null, '', to);
  };
  const advancedReportsOn = lowestPlanIncluding({ reports: 'advanced' });
  const exceptionReport = plan.state !== 'known' ? undefined
    : plan.entitlements.reports === 'advanced' ? { included: true as const }
    : { included: false as const, availableOn: advancedReportsOn === null ? 'a higher' : PLAN_NAMES[advancedReportsOn] };

  return (
    <BusinessProvider type={businessType}>
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground lg:flex-row">
      {/* Below lg: a top bar, and the sidebar becomes a drawer behind its Menu button. */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
        <button type="button" onClick={() => setNavOpen(true)} aria-label="Open menu" aria-expanded={navOpen}
          className="flex size-10 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent">
          <Menu className="size-5" />
        </button>
        {brand?.logoUrl != null && <img src={brand.logoUrl} alt="" className="size-8 shrink-0 rounded-md object-contain" />}
        <span className="min-w-0 truncate text-base font-bold tracking-tight">{brand?.name ?? session.tenantSlug}</span>
        <span className="ml-auto truncate text-sm font-medium text-muted-foreground">{titleFor(businessType, pending ? active : current)}</span>
      </header>
      {navOpen && (
        <>
          <div aria-hidden onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 animate-in fade-in duration-200 lg:hidden" />
          {/* Outside the nav, so the nav holds only its sections. */}
          <button type="button" onClick={() => setNavOpen(false)} aria-label="Close menu"
            className="fixed top-3 right-3 z-50 flex size-11 items-center justify-center rounded-full bg-card text-foreground shadow-lg transition-colors hover:bg-accent lg:hidden">
            <X className="size-5" />
          </button>
        </>
      )}
      <nav className={cn(
        'fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card py-5 shadow-xl transition-transform duration-200',
        navOpen ? 'translate-x-0' : '-translate-x-full',
        'lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-60 lg:max-w-none lg:translate-x-0 lg:shadow-none',
      )}>
        <span className="flex items-center gap-2.5 px-5 pb-4">
          {brand?.logoUrl != null && (
            <img src={brand.logoUrl} alt="" className="size-9 shrink-0 rounded-md object-contain" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[17px] font-bold leading-tight tracking-tight">
              {brand?.name ?? session.tenantSlug}
            </span>
            {brand !== null && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">/{session.tenantSlug}</span>
            )}
          </span>
        </span>
        {plan.state === 'known' && (
          <span className="-mt-3 px-5 pb-3 text-xs font-medium text-muted-foreground">
            {PLAN_NAMES[plan.planKey as PlanKey] ?? plan.planKey} plan
          </span>
        )}
        {sections.map((section) => {
          const isActive = !pending && current.resource === section.resource;
          const Icon = SECTION_ICON[section.path];
          return (
            <button
              key={section.resource}
              type="button"
              onClick={() => open(section)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'mx-2 flex h-11 items-center gap-3 rounded-lg border-l-[3px] px-3 text-left font-sans text-sm transition-colors duration-150',
                isActive
                  ? 'border-l-ink-orange bg-accent font-bold text-foreground'
                  : 'border-l-transparent font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {Icon !== undefined && <Icon aria-hidden className={cn('size-[18px] shrink-0', isActive && 'text-ink-orange')} />}
              <span className="truncate">{titleFor(businessType, section)}</span>
            </button>
          );
        })}
        <div className="grow" />
        <UserBadge api={api} opens="up" block className="mx-5 mt-4 text-foreground" />
        <Button
          type="button"
          variant="outline"
          onClick={() => { api.signOut(); setSession(null); }}
          className="mx-5 mt-4 h-10 border-[1.5px] border-foreground font-sans text-sm font-semibold"
        >
          <LogOut aria-hidden className="size-4" />
          Sign out
        </Button>
      </nav>

      <main className="min-w-0 grow p-4 animate-in fade-in duration-300 sm:p-6 lg:p-8" key={current.resource}>
        {pending ? (
          <PageSkeleton label={titleFor(businessType, active)} />
        ) : current.resource === '' ? (
          <>
            <InstallPosApp api={api} slug={session.tenantSlug} restaurantName={brand?.name ?? session.tenantSlug}
              logoUrl={brand?.logoUrl ?? null} />
            <Dashboard api={api} {...(exceptionReport ? { exceptionReport } : {})} />
          </>
        ) : current.resource === 'orders' ? (
          <OpenOrders api={api} />
        ) : current.resource === 'bills' ? (
          <Bills api={api} logoUrl={brand?.logoUrl ?? null} />
        ) : current.resource === 'printed-bill' ? (
          <PrintedBill api={api} restaurantName={brand?.name ?? session.tenantSlug} logoUrl={brand?.logoUrl ?? null} />
        ) : current.resource === 'tax' ? (
          <TaxRates api={api} />
        ) : current.resource === 'setup' ? (
          <Setup api={api} tables={plan.state !== 'known' || plan.entitlements.tables} />
        ) : current.resource === 'menu/items' ? (
          <StepScreen key="items" api={api} step="items" />
        ) : current.resource === 'stations' ? (
          <StepScreen key="kitchens" api={api} step="kitchens" />
        ) : current.resource === 'printers' ? (
          <StepScreen key="printers" api={api} step="printers" />
        ) : current.resource === 'access' ? (
          <PosKdsAccessPage api={api} tenantSlug={session.tenantSlug} kot={plan.state !== 'known' || plan.menu.kot} />
        ) : (
          <Table
            key={current.resource}
            api={api}
            resource={current.resource}
            title={titleFor(businessType, current)}
          />
        )}
      </main>
    </div>
    </BusinessProvider>
  );
}
