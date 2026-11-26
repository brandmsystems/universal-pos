import { useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { createPlatformApi, type PlatformApi, type PlatformSession } from '../../services/platformApi.js';
import '../../styles/platform.css';
import { cn } from 'cn';
import {
  BadgeIndianRupee, Globe, LayoutDashboard, Store, Layers, Receipt, Users, LogOut, Menu, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { SignIn } from '../../features/auth/platform/SignIn.js';
import { Dashboard } from '../../features/dashboard/platform/Dashboard.js';
import { Restaurants } from '../../features/restaurants/platform/Restaurants.js';
import { Plans } from '../../features/billing/platform/Plans.js';
import { Billing } from '../../features/billing/platform/Billing.js';
import { Staff } from '../../features/users/platform/Staff.js';
import { SalesPersons } from '../../features/users/platform/SalesPersons.js';
import { SalesDashboard } from '../../features/dashboard/platform/SalesDashboard.js';
import { Countries } from '../../features/settings/platform/Countries.js';
import type { RestaurantPermissions } from '../../features/restaurants/platform/RestaurantManager.js';
import { ProfileCard, ProfileModal } from '../../features/auth/platform/Profile.js';
import { useProfile } from '../../hooks/useProfile.js';
import type { Profile } from '../../types/profile.js';
import { PLATFORM_ENTRY, superadminPath, superadminSectionFromPath } from '../../lib/platformPath.js';

/**
 * The control-plane console.
 *
 * ###########################################################################
 * A FOURTH DOCUMENT, NOT A ROUTE TREE INSIDE ADMIN.
 *
 * FRONTEND.md section 12 records the decision as "branch admin and superadmin
 * share one shell, two route trees", with a gate on the import graph to stop a
 * superadmin screen importing a tenant-scoped component. This ships the same
 * intent one step further: a separate Vite entry, so the separation is enforced
 * at the BUNDLE rather than by a lint over imports.
 *
 * The argument for the change is the one bundleSeparation.test.ts already makes
 * about the kitchen and the till. A branch admin is a restaurant's employee.
 * Shipping them the code that lists every tenant, changes plans and starts
 * impersonation sessions puts the control plane's surface area in a document
 * handed to every customer -- and a dynamic import or a hoisted shared chunk
 * would defeat an import-graph rule while shipping it anyway. What IS shared is
 * what FRONTEND.md actually cares about: one design system, one truth model
 * (`lib/remote.ts`), one storage adapter.
 *
 * The redesign (see globals.css) goes further on the visual side than the
 * boundary strictly requires: not just a different accent inside the same
 * light chrome, but a fully dark theme against admin's light one, end to end.
 * A glance at either window now answers "which one is this" before a word
 * is read, and that IS the boundary -- a stronger visual cue, not decoration
 * layered on top of one.
 * ###########################################################################
 */

/**
 * ###########################################################################
 * WHAT EACH ROLE IS SHOWN. A CLIENT COPY OF `src/modules/authz/platformRoles.ts`, AND
 * IT DECIDES DRAWING ONLY.
 *
 * The client cannot import `src/` (the bundle gate), so the few keys that decide
 * which screens and buttons exist are restated here. Every one of them is
 * enforced again at the server against the token's role, so a drift here draws
 * a button that answers "your role is not allowed" -- it never writes. An
 * unknown role gets the most restricted shape, not the most generous.
 * ###########################################################################
 */
interface RoleShape {
  readonly home: 'estate' | 'sales';
  readonly staff: boolean;
  readonly billing: boolean;
  readonly publishPlans: boolean;
  readonly restaurants: RestaurantPermissions;
}

const NOTHING: RestaurantPermissions = {
  create: false, edit: false, toggleStatus: false, changeSubscription: false, rename: false, manageStaff: false,
  changeCountry: false,
};

const ROLE_SHAPES: Readonly<Record<string, RoleShape>> = {
  super_admin: {
    home: 'estate', staff: true, billing: true, publishPlans: true,
    restaurants: { create: true, edit: true, toggleStatus: true, changeSubscription: true, rename: true, manageStaff: true, changeCountry: true },
  },
  sales: {
    home: 'sales', staff: false, billing: false, publishPlans: false,
    restaurants: { create: true, edit: true, toggleStatus: false, changeSubscription: true, rename: false, manageStaff: true, changeCountry: true },
  },
  support: {
    home: 'estate', staff: false, billing: true, publishPlans: false,
    restaurants: { ...NOTHING, edit: true },
  },
  billing: {
    home: 'estate', staff: false, billing: true, publishPlans: true,
    restaurants: { ...NOTHING, toggleStatus: true, changeSubscription: true },
  },
  read_only: {
    home: 'estate', staff: false, billing: true, publishPlans: false, restaurants: NOTHING,
  },
};

const RESTRICTED: RoleShape = {
  home: 'estate', staff: false, billing: false, publishPlans: false, restaurants: NOTHING,
};

interface Section {
  /** The URL slug, `/superadmin/{path}` -- separate from the title it is shown under. */
  readonly path: string;
  readonly title: string;
  readonly hint: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly render: (
    api: PlatformApi, session: PlatformSession, shape: RoleShape, profile: Profile | null,
  ) => ReactElement;
}

/**
 * Only what has a served route AND a screen, and only what this role can use.
 * A nav entry that could only ever answer "not allowed" is the client-side
 * twin of a route with no handler.
 */
function sectionsFor(shape: RoleShape): readonly Section[] {
  if (shape.home === 'sales') {
    return [
      { path: 'dashboard', title: 'My dashboard', hint: 'my restaurants', icon: LayoutDashboard,
        render: (api, _s, sh, profile) => (
          <SalesDashboard api={api} can={sh.restaurants} name={profile?.fullName ?? null} />
        ) },
      { path: 'plans', title: 'Plans', hint: 'what I sell', icon: Layers,
        render: (api, _s, sh) => <Plans api={api} canPublish={sh.publishPlans} /> },
    ];
  }
  const sections: Section[] = [
    { path: 'dashboard', title: 'Dashboard', hint: 'the whole estate', icon: LayoutDashboard,
      render: (api) => <Dashboard api={api} /> },
    { path: 'restaurants', title: 'Restaurants', hint: 'every restaurant', icon: Store,
      render: (api, _s, sh) => <Restaurants api={api} can={sh.restaurants} /> },
  ];
  if (shape.staff) {
    sections.push({ path: 'sales-persons', title: 'Sales persons', hint: 'who sells', icon: BadgeIndianRupee,
      render: (api, session) => <SalesPersons api={api} selfId={session.platformUserId} /> });
  }
  sections.push({ path: 'plans', title: 'Plans', hint: 'Basic · Pro', icon: Layers,
    render: (api, _s, sh) => <Plans api={api} canPublish={sh.publishPlans} /> });
  if (shape.billing) {
    sections.push({ path: 'billing', title: 'Billing', hint: 'invoices & dunning', icon: Receipt,
      render: (api) => <Billing api={api} /> });
  }
  if (shape.staff) {
    sections.push({ path: 'staff', title: 'Platform staff', hint: 'who works here', icon: Users,
      render: (api) => <Staff api={api} /> });
    // `platform.settings.edit`: Super Admin only, the role that holds `staff` here.
    sections.push({ path: 'countries', title: 'Countries', hint: 'currency & tax regions', icon: Globe,
      render: (api) => <Countries api={api} /> });
  }
  return sections;
}

function shownSection(sections: readonly Section[], active: string | null): Section {
  return sections.find((s) => s.path === active) ?? sections[0]!;
}

/**
 * Where this role's console lives. Super Admin has its own address, one per
 * section; every other role keeps the shared entry, whose address never
 * changes. Drawing only -- the server authorises every read against the token.
 */
function addressFor(role: string, active: string | null): string {
  if (role !== 'super_admin') return PLATFORM_ENTRY;
  return superadminPath(shownSection(sectionsFor(ROLE_SHAPES[role] ?? RESTRICTED), active).path);
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  super_admin: 'Super Admin', sales: 'Sales Person', support: 'Support',
  billing: 'Billing', read_only: 'Read only',
};

export function App(): ReactElement {
  const api = useMemo(() => createPlatformApi(), []);
  const [session, setSession] = useState<PlatformSession | null>(() => api.session());
  const [active, setActive] = useState<string | null>(() => superadminSectionFromPath());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profile = useProfile(api, session?.platformUserId ?? null);

  useEffect(() => {
    const onPop = (): void => setActive(superadminSectionFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The address follows the signed-in role: `/platform.html`, `/superadmin` or
  // an unknown section becomes the Super Admin section actually shown, and a
  // `/superadmin` address signed in to by any other role becomes the shared
  // entry. Replaced, not pushed, so Back never lands on a redirect.
  useEffect(() => {
    if (session === null) return;
    const to = addressFor(session.role, active);
    const { pathname, search, hash } = window.location;
    const wrong = to === PLATFORM_ENTRY ? superadminSectionFromPath(pathname) !== null : pathname !== to;
    if (wrong) window.history.replaceState(null, '', to + search + hash);
  }, [session, active]);

  if (session === null) {
    return <SignIn api={api} onSignedIn={(next) => { setActive(superadminSectionFromPath()); setSession(next); }} />;
  }

  const shape = ROLE_SHAPES[session.role] ?? RESTRICTED;
  const sections = sectionsFor(shape);
  const activeSection = shownSection(sections, active);
  const open = (section: Section): void => {
    setActive(section.path);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0 });
    const to = addressFor(session.role, section.path);
    if (to !== PLATFORM_ENTRY && window.location.pathname !== to) window.history.pushState(null, '', to);
  };
  const signOut = (): void => {
    api.signOut(); setSession(null); setMobileNavOpen(false); setProfileOpen(false);
  };

  const NavLinks = (): ReactElement => (
    <>
      {sections.map((section) => {
        const isActive = activeSection.path === section.path;
        const Icon = section.icon;
        return (
          <button
            key={section.path}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => open(section)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4.5 shrink-0', isActive ? 'text-primary' : '')} />
            <div className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-semibold">{section.title}</span>
              <span className="text-[11px] text-subtle-foreground">{section.hint}</span>
            </div>
          </button>
        );
      })}
    </>
  );

  const roleWord = ROLE_WORDS[session.role] ?? session.role.replace(/_/g, ' ');

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground md:flex-row">
      {/* Desktop sidebar. Hidden below md, replaced by the top bar + sheet.
          Sticky at full viewport height, so the page scrolls and the sidebar --
          and Sign out at its foot -- never scrolls away with a long screen. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-card p-4 md:flex">
        <div className="flex items-center gap-2.5 px-1 pb-6">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LayoutDashboard className="size-4.5" />
          </span>
          <span className="text-[15px] font-bold tracking-tight text-foreground">
            UniversalPOS<br />
            <span className="font-normal text-muted-foreground">
              {shape.home === 'sales' ? 'sales console' : 'control plane'}
            </span>
          </span>
        </div>
        <nav className="flex flex-col gap-1">{NavLinks()}</nav>
        <div className="grow" />
        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3">
          <ProfileCard profile={profile} roleWord={roleWord} onOpen={() => setProfileOpen(true)} />
          <SignOutButton onClick={signOut} />
        </div>
      </aside>

      {/* Mobile top bar. */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
        <span className="text-sm font-bold tracking-tight">{activeSection.title}</span>
        <Button variant="outline" size="sm" onClick={() => setMobileNavOpen((v) => !v)}
          aria-expanded={mobileNavOpen} aria-label="Toggle navigation">
          {mobileNavOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          {mobileNavOpen ? 'Close' : 'Menu'}
        </Button>
      </header>
      {mobileNavOpen && (
        <div className="flex flex-col gap-1 border-b border-border bg-card p-3 md:hidden">
          {NavLinks()}
          <div className="mt-2 flex flex-col gap-1 border-t border-border pt-3">
            <ProfileCard profile={profile} roleWord={roleWord}
              onOpen={() => { setMobileNavOpen(false); setProfileOpen(true); }} />
            <SignOutButton onClick={signOut} />
          </div>
        </div>
      )}

      <main className="min-w-0 grow p-4 sm:p-6 lg:p-8">
        <div className="mx-auto w-full max-w-7xl">
          {activeSection.render(api, session, shape, profile)}
        </div>
      </main>
      <ProfileModal api={api} open={profileOpen} profile={profile} roleWord={roleWord}
        onClose={() => setProfileOpen(false)} onSignOut={signOut} />
    </div>
  );
}

function SignOutButton(props: { onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium',
        'text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/40',
      )}
    >
      <LogOut className="size-4.5 shrink-0" />
      Sign out
    </button>
  );
}
