# UniversalPOS — Project Documentation

> **Living document.** Updated whenever the project changes. Last updated: **2026-10-20**.
> The engineering rulebook is [CLAUDE.md](CLAUDE.md) (backend) and [docs/frontend/FRONTEND.md](docs/frontend/FRONTEND.md) (clients).
> This file is the *status* view: what exists, how to run it, what's done, and what's next.

---

## 1. What UniversalPOS is

A multi-tenant restaurant SaaS. **Basic is the only plan sold** (2026-10-12, migration 0077): every restaurant has one **POS** (`/{slug}/pos` — Dine-in, Parcel, KOT and Billing tabs) and the **Restaurant Manager** admin (`/{slug}`).

- **Restaurants (tenants)** use it to run service: menu, orders, printed kitchen tickets, bills, payments and reports.
- **The manager** signs in at `/{slug}` with email + password. Sent from the POS (`/{slug}?to=pos`), the same sign-in makes this computer the till (at most 2 tills).
- **Staff** sign in on the till: tap their name, type a **4-digit PIN**. Staff have no password.
- **The Sales person** who sold the restaurant adds staff, sets and resets their PINs, changes what they can use and switches them off — from the console, never for a manager account, within the 4-user limit. The manager manages no staff.
- Removed with 0077: the kitchen screen (KDS), the separate KOT and Billing apps, tablet setup codes, staff invites and the manager's staff screens. Standard and Pro are retired (their rows are kept).
- **The platform team** uses a separate console to run the business: sell restaurants, manage plans and subscriptions, billing, and platform staff.

### Who uses what

| Person | App | Address (local) |
|---|---|---|
| Super Admin | Control-plane console, one address per menu | http://127.0.0.1:9180/superadmin (`/superadmin/dashboard`, `/restaurants`, `/sales-persons`, `/plans`, `/billing`, `/staff`) |
| Support, Billing, Read-only staff | Same console | http://127.0.0.1:9180/platform.html |
| Sales Person | Same console, own "My dashboard" | http://127.0.0.1:9180/platform.html |
| Restaurant Manager / Admin | Restaurant admin | http://127.0.0.1:9180/{slug} |
| Manager at the till | POS — **Dine-in · Parcel · KOT · Billing** on the manager's email + password, once per computer | http://127.0.0.1:9180/{slug}?to=pos |
| Staff | POS — tap your name, 4-digit PIN. Old `/{slug}/kot` and `/{slug}/billing` links open the same POS | http://127.0.0.1:9180/{slug}/pos |

### Role hierarchy

```
Super Admin
 └─ Sales Person            (control plane, sees only restaurants they sold)
     └─ Restaurant Manager  (tenant "owner"; one per restaurant, invited at creation)
         └─ staff (POS by name + PIN; added by the Sales person)
```

---

## 2. Architecture

### 2.1 Two planes (the most important rule)

| | Control plane | Tenant plane |
|---|---|---|
| Who | Platform staff (`platform_user`) | Restaurant staff (`app_user`) |
| Routes | `/api/platform/*` | `/api/t/*`, `/pos/*`, `/admin/*` |
| DB schema | `platform` | `app` (every table has `tenant_id`, RLS on) |
| Token | carries `platform_role`, never `tenant_id` | carries `tenant_id`, never `platform_role` |

- A platform user is **never** a row in `app_user`.
- Only two things cross the boundary: **entitlements flow down** (plan limits/features as a cached document) and **usage flows up** (daily aggregates).
- The only cross-plane exception is a time-boxed, audited **impersonation** token.
- The control plane **never reads schema `app`** (no orders, no staff lists).

### 2.2 Stack

| Layer | Technology |
|---|---|
| Backend | Node 22, Fastify 5, TypeScript (ESM) |
| Database | PostgreSQL 16 (15+ required), `pg` with hand-written SQL (no ORM), hand-written SQL migrations |
| Pooling | PgBouncer in **transaction** mode (the app always goes through it) |
| Cache/queue | Redis |
| Web clients | React 19, Vite, Tailwind v4, shadcn-style components, lucide icons |
| Tests | Vitest (backend + web), Playwright for manual browser verification |
| Package manager | pnpm (via `corepack pnpm`) |

### 2.3 Database roles

| Role | Used for |
|---|---|
| `katkitchen_owner` | Owns objects; runs migrations, seeds, owner-posture jobs |
| `katkitchen_app` | The running app (both planes). Not owner, no RLS bypass, cannot update/delete audit logs |
| `katkitchen_platform_readonly` | Reporting on schema `platform` only |

### 2.4 Tenant isolation

- Base repository injects `tenant_id`; refuses to run without the tenant GUC.
- Row-level security on every `app` table is the backstop (`USING` + `WITH CHECK`).
- `tenant_id` only ever comes from a verified token (or, before login, from the slug typed in the URL).
- Startup probes verify the pooler really is in transaction mode and that the app role cannot bypass RLS.

### 2.5 Audit

- Every route declares an audit posture (`{action, target}`, `'none'`, or a credential `attempt`); missing posture refuses boot.
- Tenant audit rows are written in the same transaction as the change, and record the authorising membership.
- Platform audit rows record actor, action, target, and (opt-in via `afterIsResult`) the result. Routes that return secrets (setup links, passwords) deliberately do **not** record results.
- Login/credential events go to `platform.auth_attempt` (security telemetry, 30-day retention).

### 2.6 Local runtime (Docker Compose)

| Service | Host port | Notes |
|---|---|---|
| `postgres` | 5433 | Data in volume `katkitchen-1_katkitchen_pgdata` |
| `pgbouncer` | 6432 | Transaction mode — the app connects here |
| `pgbouncer-statement` | 6433 | Deliberately misconfigured; used only to prove the startup probe fails |
| `redis` | 6380 | |
| `api` | 8080 | Fastify server |
| `web` | 127.0.0.1:9180 | nginx serving the built web bundle (3 HTML entries) |

Connection strings are in `.env` (`DATABASE_URL_OWNER`, `DATABASE_URL_APP`, …).

---

## 3. Project structure

The repo is a **pnpm workspace** (monorepo): `backend/`, `frontend/`, `shared/` and
`packages/*` are the workspace members. Folder layout since Stage 2 (2026-11-26):

```
UNIVERSALPOS/
├── backend/                 @universalpos/api (was apps/api)
│   ├── src/                 app.ts, server.ts, config/, jobs/, core/ (database errors
│   │                        middleware security), modules/ (auth authz billing inventory
│   │                        kitchen menu metering notifications offline orders payments
│   │                        platform privacy reporting restaurants tax users), routes/
│   ├── tests/               Vitest suites (run from backend, real Postgres)
│   ├── tsconfig.json        Typecheck (src + tests)
│   ├── tsconfig.build.json  Emit to backend/dist
│   └── vitest.config.ts     Loads the repo-root .env
├── frontend/                @universalpos/web (was apps/web): index.html (POS),
│   │                        admin.html, platform.html; public/; tests/ (jsdom)
│   └── src/                 app/ (3 shells) features/<domain>/<app>/ components/ hooks/
│                            services/ lib/ styles/ types/
├── shared/                  @universalpos/shared (was packages/shared), compiled to dist/
├── packages/                tsconfig/ and eslint-config/ (workspace tooling)
├── print-agent/             universalpos-print-agent.mjs (printer bridge) + README
├── database/                bootstrap/, migrations/ (0001 -> 0088), pgbouncer/ (was db/)
├── deploy/                  api/web/scheduler Dockerfiles, nginx config, crontab
├── docs/                    billing-terms, deploy-render, print-agent-design,
│                            scheduler-monitoring, postman/
├── scripts/                 Operator scripts (seeds, recovery, backfills)
├── CLAUDE.md  AGENTS.md  docs/frontend/FRONTEND.md  README.md  docs/development/universalpos.md
├── .env / .env.example      One environment file for the whole repo
├── docker-compose.yml
├── package.json             Workspace root: operator scripts only
└── pnpm-workspace.yaml      backend, frontend, shared, packages/*
```

### 3.1 Where the control-plane console lives (frontend/src)

| Path | Purpose |
|---|---|
| `app/platform/App.tsx` | Shell, role-based navigation, sidebar profile card, sign out |
| `features/auth/platform/` | SignIn, Profile (account menu, change password) |
| `features/dashboard/platform/` | Super Admin Dashboard, Sales Person dashboard |
| `features/restaurants/platform/` | Restaurants page, RestaurantManager (list), RestaurantModals, NewRestaurantModal, `subscription.ts` (plan options, status rule) |
| `features/users/platform/` | Platform staff, Sales persons |
| `features/billing/platform/` | Plans, Billing |
| `components/platform/` | `kit.tsx` (Modal, fields, CopyField, formatting), Pagination |
| `hooks/` · `types/` · `services/platformApi.ts` | `/me` and `/plans` hooks, API shapes, the control-plane client |

---

## 4. Running it locally

### 4.0 From a fresh clone

```bash
git clone https://github.com/brandmsystems/universal-pos.git   # or the infoinfynstudio mirror
cd katkitchen
cp .env.example .env            # local credentials; .env is never committed
corepack enable                 # pnpm 9 via Node 22's corepack
corepack pnpm install           # also compiles shared
docker compose up -d            # Postgres, PgBouncer, Redis, api, web
corepack pnpm db:migrate && corepack pnpm db:seed && corepack pnpm db:partitions && corepack pnpm seed:demo
```

Then open http://127.0.0.1:9180/superadmin. `seed:demo` creates a development Super Admin (`superadmin@universalpos.example`, or `DEV_SUPER_ADMIN_EMAIL`) and prints its generated password once; set `DEV_SUPER_ADMIN_PASSWORD` to choose one instead. Nothing is stored in this repository.

**Git remotes:** `origin` = https://github.com/infoinfynstudio/UniversalPOS.git,
`brandm` = https://github.com/brandmsystems/universal-pos.git (branch `amruthesh` is pushed there as `main`).


```bash
# start / rebuild the stack
docker compose up -d
docker compose build api web && docker compose up -d api web   # after code changes

# database
corepack pnpm db:migrate        # apply migrations
corepack pnpm db:seed           # permission catalogues & roles
corepack pnpm db:partitions     # audit partitions
corepack pnpm seed:demo         # demo restaurant + local super admin + Basic/Pro

# install (also compiles shared)
corepack pnpm install

# tests & typecheck
corepack pnpm db:test:create    # once: the separate test database katkitchen_test
corepack pnpm test              # backend: runs backend's vitest against katkitchen_test (1151 tests)
corepack pnpm test:web          # web (jsdom)
corepack pnpm typecheck         # every package
corepack pnpm lint              # ESLint, every package
# or directly: cd backend && npx vitest run   |   cd frontend && npx vitest run
```

**Full local reset** (wipes all data):

```bash
docker compose stop api pgbouncer pgbouncer-statement postgres
docker compose rm -f postgres
docker volume rm katkitchen-1_katkitchen_pgdata
docker compose up -d postgres pgbouncer pgbouncer-statement
corepack pnpm db:migrate && corepack pnpm db:seed && corepack pnpm db:partitions && corepack pnpm seed:demo
docker compose up -d api web
```

**Small dataset** (Super Admin + 5 sales persons + 10 restaurants, no invoices): the same reset, but
instead of `seed:demo` run (PowerShell)
`$env:PLATFORM_EMAIL='<email>'; $env:PLATFORM_PASSWORD='<a password you choose>'; corepack pnpm seed:platform-user; corepack pnpm seed:dummy`.
The API test suite uses this same database, so `pnpm test` adds test restaurants back.

**Empty start** (the dev database as of 2026-10-01): drop schemas `app`, `platform`, `migration`,
`redis-cli FLUSHALL`, then `db:migrate`, `db:seed` (permissions, roles and the Basic / Standard / Pro
plans) and `seed:platform-user` -- no restaurants, no sales persons, no invoices. Do not run
`seed:dummy` or `seed:demo` (owner's rule: no dummy data).

### 4.0b Postman

`docs/api/postman/UniversalPOS.postman_collection.json` (all API routes) and `docs/api/postman/UniversalPOS-local.postman_environment.json` (base URL `http://127.0.0.1:8080` + local sign-ins). Import both, select **UniversalPOS local**, then run in order:

1. **1. Sign-in & public → POST /api/auth/platform/login** — saves the platform token.
2. **2. Platform → GET /plans** — saves `planVersionId`; then **POST /tenants** (change slug + email first) — saves `tenantId`, `tenantSlug`, `subscriptionId`, `inviteToken`.
3. **POST /api/auth/invite/accept**, then **POST /api/auth/:tenantSlug/login** — saves the restaurant token for everything under **3. Restaurant**.

The collection is generated from the route table: after adding a route run `corepack pnpm postman` and commit the two files.

### 4.1 Local credentials (development only)

| Account | Where | Credentials |
|---|---|---|
| Super Admin | /superadmin | the email and password `seed:demo` printed, or the ones you gave `seed:platform-user` (both refuse production defaults; no password is committed) |
| Sales Person | platform.html | the five dummy sales persons below, or create one from **Sales persons** as Super Admin |
| Demo restaurant manager | `/spicegarden` (or admin.html) | only after `corepack pnpm seed:demo` — `owner@spicegarden.test`, with the password and PIN it prints once (or `DEMO_PASSWORD` / `DEMO_PIN`) |
| The till | `/{slug}?to=pos` | the restaurant manager's own email + password, once per computer; the browser becomes a till (at most 2) |
| Staff | `/{slug}/pos` on a till | tap your name, then the 4-digit PIN the Sales person set (console → Restaurants → the restaurant → Staff) |

> **The local database was reset on 2026-10-01** to clear the test-probe data the API test suite leaves behind (it runs against the same database). It now holds exactly: the Super Admin and plans Basic, Standard and Pro -- **no restaurants, no sales persons, no dummy data**. Running `pnpm test` again will add probe rows back.

> **No dummy data (decided 2026-10-01).** The local database is kept free of dummy restaurants and sales persons: the owner creates their own data when they need it. Do **not** run `seed:dummy` or `seed:demo` as part of a reset or setup. A clean database holds only the Super Admin, the plans (Basic, Standard, Pro) and the base catalogue, plus whatever the owner created by hand (e.g. Sales Person `hashim@universalpos.example`). The API test suite still writes probe restaurants into this same database (gap #2), so after `pnpm test` the database needs a reset.

**Dummy data (optional, not loaded)** — `corepack pnpm seed:dummy` adds 5 sales persons and 10 restaurants through real provisioning, each with a floor, 8 tables, 3 kitchens, a printer and 10 menu items. Pro restaurants get KOT Staff, Billing Staff and kitchen staff; Basic ones get the owner (with a Billing PIN), an admin, a manager and one Billing Staff. Skips any slug that already exists.

| Account | Where | Credentials |
|---|---|---|
| Sales Persons | platform.html | `ravi@` (restaurants 1, 6), `anita@` (2, 7), `vikram@` (3, 8), `deepa@` (4, 9), `farhan@universalpos.example` (5, 10) / generated per run, printed once by `seed:dummy` |
| Restaurants | `/<slug>` | Basic: spice-garden-blr, dosa-corner, chai-and-chaat, green-leaf-cafe · Pro: tandoori-nights, biryani-bay, malabar-kitchen, coastal-curry-house, punjab-grill-house, royal-thali |
| Manager / admin / manager | `/<slug>` | `manager@` · `adm1@` · `mgr1@<slug>.example` / generated per run, printed once by `seed:dummy` |
| Staff PINs (need an enrolled tablet) | KOT / Kitchen / Billing | generated per person; reset one from the console (Restaurants → the restaurant → Staff) |

> Running the backend test suite writes test data into the same local database. Reset it afterwards if you want a clean catalogue.

---

## 5. Implementation status

### 5.1 Build phases (the original build order, now in `docs/architecture/decision-history.md`)

| Phase | Scope | Status |
|---|---|---|
| 0 | Identity, roles, permissions, isolation, audit | ✅ Done |
| 1 | Control plane: provisioning, plans, subscriptions, entitlements, impersonation | ✅ Done |
| 2 | Tenant setup: branches, floors, tables, stations, printers, devices, menu | ✅ Done |
| 3 | Operations: session → order → KOT → kitchen → ready for billing → bill → payment | ✅ Done |
| 4 | Inventory, recipes, stock, suppliers, purchasing | ⛔ Retired from the product in 0064 (tables kept) |
| 5 | Billing automation, dunning, reporting, offline POS | ✅ Done (see pending gaps) |
| 7–9 | API surface, first clients (POS, admin, KDS) | ✅ Done |
| 18–23 | Tailwind redesigns (admin, platform, KDS, POS), platform dashboard | ✅ Done |

### 5.2 Recent work (control plane & sales) — committed on branch `amruthesh`

**Plans page**
- Softer dark palette (fixed near-white borders caused by Tailwind v4 `currentColor`), compact plan cards, pagination, fixed sidebar with Sign out.
- Exactly three plans (0067): **Basic ₹999 / Standard ₹1,799 / Pro ₹2,499** per month. All three have KOT, printed kitchen tickets and Billing; only **Pro** has the kitchen screen (KDS) and more than one branch (branches 1/1/3, tablets 2/4/6, advanced reports on Standard and Pro). Seeded by `ensureStandardPlans` and migration 0067. The plan editor shows KDS as a plan feature. Max was retired in 0064 and its restaurants moved to Pro.
- Publish a new version (price/period/limits) — existing customers keep their version.
- Activate / deactivate a plan — inactive plans can't be sold (enforced in provisioning).

**Restaurants (Super Admin)**
- Full list: Restaurant, Sales Person, Client/Manager, Plan, Subscription, Start, Expiry, Status, Price, Actions; search + filters (plan, sales person, status, expiry); pagination; responsive cards on small screens.
- Create / Edit / View / Activate-Deactivate in modals.
- **Deactivate** is a new tenant status (migration 0055) with required reason, recorded actor; blocks login and token refresh; entitlements republished. Only active restaurants can be deactivated (can't hide debt).
- **Change plan** modal: upgrade applies now, downgrade at period end (existing billing rules); pending change visible and cancellable.
- **Renew**: extends from current expiry by 1/3/6/12 periods; trial becomes active.
- **Subscription status** derived live: Active / Expiring soon (≤7 days) / Expired / Suspended.
- **Billing status** from latest invoice: Not billed yet / Paid / Invoice due / Overdue.

**Sales Persons**
- Super Admin page: create/edit, activate/deactivate, reset password (shown once, masked with eye); columns Name, Email, Phone, Restaurants, Active subs, Expiring soon, Expired, Status.
- Sales Person dashboard: "Welcome, {name}", 6 stat cards, only their own restaurants ("Sold by …" on each row).
- Restaurants created by a Sales Person are linked to them automatically (from the verified token).
- Deactivated accounts are refused on their very next request.

**Accounts & credentials**
- Local default Super Admin (dev seed only).
- Restaurant Manager **setup link** (invite) + set-password page (`admin.html#invite=…`); re-issue link; nobody else ever knows the password (only hashes stored).
- Profile card + account menu for every platform user (name, email, phone, role, status, change password, sign out) via `GET /api/platform/me`.
- Change own password: `POST /api/auth/platform/password` (verifies current password with login lockout).
- Eye (show/hide) toggle on every password field; one-time passwords shown masked.
- Create-restaurant form: manager name/email/phone, plan, "14-day trial" or "Paid from today" with date preview.

**Restaurant URL, unique slug and restaurant login**
- Every restaurant has its own address, **`/{slug}`** (e.g. `/abc-restaurant`). It shows that restaurant's name and sign-in; an unknown slug shows "Restaurant not found". Served by nginx (`deploy/web.nginx.conf`) and the Vite dev middleware, both rewriting slug paths to `admin.html`.
- Every admin screen has its own address under the restaurant's slug: `/{slug}` (Dashboard), `/{slug}/setup`, `/menu`, `/tax`, `/branches`, `/staff`, `/access`, `/roles`, `/kitchens`, `/printers`, `/tablets`. The sidebar updates the address (browser back/forward work), a pasted or refreshed address opens that screen, an unknown section or one the plan leaves out shows the Dashboard. The address chooses the screen only; the data is still the signed-in restaurant's. `/{slug}/kot`, `/kds`, `/billing` stay the tablet apps.
- While a screen's data loads, the sidebar, restaurant name/logo and sign-out stay put and the content area shows a grey skeleton shaped like what is coming (dashboard tiles and cards, list tables with their real column headings, staff, access, setup counts). It appears only if the wait passes 150 ms, so fast reads never flash. It ends the moment the read answers: a failed read shows the existing "did not load" message and an empty list its existing empty text — never a skeleton. The tablet apps use the same rule: KOT's floor, order and menu, the kitchen board and kitchen picker, and Billing's queue, bill and new-order menu show skeletons while loading (Billing's new-order menu used to say "Loading the menu…" for ever after a failed read). A first read that fails offline now counts as failed, not still loading.
- The console (`/platform.html`) follows the same rule. Super Admin's dashboard tiles, invoiced-by-day chart, plan bars and recent invoices, the Restaurants and Sales persons tables (and their phone-width cards), Plans (plan cards), Billing (dunning queue and invoice ledger) and Platform staff all show skeletons under their real headings. A Sales Person's figure tiles and restaurant list do too. Before this, every console screen said "could not be read just now" while its first read was still in flight. Tablets waiting on the slug lookup get the sign-in-card skeleton instead of "Loading…". Tests: `frontend/tests/platformLoading.test.tsx`.
- Three areas, three navigations: **Super Admin** and **Sales Person** share one document (`platform.html`) and get different sidebars from their role (control plane vs sales console); neither uses a restaurant slug. Super Admin's address is `/superadmin/{section}` — one per menu (`dashboard`, `restaurants`, `sales-persons`, `plans`, `billing`, `staff`; the slug is separate from the label), reloadable and Back-able; `/platform.html` and `/superadmin` become `/superadmin/dashboard` once signed in. Every other platform role stays at `/platform.html`, and a `/superadmin` address signed in to by one becomes `/platform.html`. The address decides nothing — the server authorises against the token. `superadmin` is a reserved slug (`SUPERADMIN_SEGMENT`), routed before the restaurant rules in nginx and Vite. Only the **restaurant** (a UniversalPOS customer) is addressed by its slug. There is no sales-person slug.
- Create form: slug is generated from the name (`ABC Restaurant` → `abc-restaurant`) until edited by hand; live availability check (`GET /api/platform/tenants/slug-available`); duplicate → *"This restaurant slug is already in use. Please choose another slug."*; reserved words (`admin`, `api`, `pos`, `kds`, …) refused. Rules live once in `shared/src/constants/slug.ts` and are checked again on the server (pre-check + unique index → 409 `slug_taken`).
- Optional **Restaurant details** (registered/legal name) on create.
- After creation the Sales Person sees Restaurant URL, Login email and the one-time setup link — never a password (the manager sets it).
- After the manager sets their password from the setup link they are **signed in automatically** and **Open my restaurant** takes them to their own `/{slug}` dashboard. This replaces any other restaurant's session left in that browser (previously the old session, e.g. the demo Spice Garden, opened instead).
- Public lookup `GET /api/public/restaurants/:slug` returns only `{slug, name, signInAvailable}`; it grants nothing.
- A session from another restaurant in the same browser does not open this restaurant's dashboard; it shows this restaurant's sign-in instead. The real wall is the server: tenant comes only from the verified token, and RLS.
- **Password reset after sign-up**: Sales Person / Super Admin can issue a new setup link for a manager who already signed up, with a **required reason** (stored on the invite, migration 0058). The old password keeps working until the link is used.
- Admin CRUD: editing/archiving/deleting a row that isn't yours (another branch/restaurant) or doesn't exist now returns **404 `row_not_found`** instead of `200 {updated:false}`.

**Plans and what they include (Basic / Standard / Pro)** *— since 2026-10-12 only Basic is sold; Standard and Pro are retired (rows kept). See 5.2c.*

| | Basic | Standard | Pro |
|---|---|---|---|
| Branches | 1 | 1 | 3 |
| Tablets and tills (KOT, kitchen, billing) | 2 | 4 | 6 |
| Restaurant users (owner included; active + invited + pending invites) | 4 | 8 | 25 |
| KOT, printed kitchen tickets, Billing | ✓ | ✓ | ✓ |
| Kitchen screen (KDS) | – | – | ✓ |
| Reports | Dashboard only | Advanced | Advanced |

- One definition: `ENTITLEMENTS` in `shared/src/constants/plans.ts`, with `getAdminMenu()` (menu rules) and `entitlementsFromTerms()` used by both the API and the admin screens.
- **API:** each route declares `plan` (feature / report tier / limit); the route layer refuses with **402 `upgrade_required`** naming the plan that has it ("…available on Pro"). Branch, tablet and user limits are counted under a lock; unused tablet setup codes and pending staff invites count too. Only ADDING is refused at a limit: a restaurant already over it keeps every tablet and account.
- **Admin sidebar** shows only what the plan includes (Basic: no Branches, no KOT/kitchen links or staff roles); plan name shown under the restaurant slug.
- **Console:** plan versions show what they include; "New version" edits tablets, the KOT feature and the report tier. A version missing any plan key is refused.
- Plan changes reach the restaurant without a restart: every change publishes a new entitlement document and clears the cached one. The cache refills from the database on a miss.
- Fixed along the way: restaurants created from the console never got an entitlement document, and plan upgrades/downgrades never republished one (so an upgrade would not have unlocked anything). Migration 0059 backfilled every plan version and restaurant.

**New flow: Super Admin → Sales Person → Restaurant → Manager → Staff**
- Sales Person creates a restaurant with **address** (required), **logo** (PNG/JPEG/WebP ≤ 256 KB, optional) and **theme colour** (optional), plus the manager's details and trial/paid. Edit restaurant changes name, legal name, address, colour and logo; the manager's details are shown read-only.
- The restaurant's admin screens and its `/{slug}` sign-in use its colour and show its logo and name.
- **Staff screen**: people with their roles, pending invites, **Add staff** popup (name, role, branch, sign-in by staff code + PIN or email + password). It gives a one-time setup link; the staff member sets their own PIN/password. Owner and Restaurant Admin can add staff; the Manager role cannot (by design).
- Roles shown as **KOT Staff** (`waiter`), **KDS Staff** (`kds`) and **Billing Staff** (`cashier`). Chef was retired in 0065 (it duplicated KDS).
- Admin add/edit opens in a **popup**; required fields show a red **\***, derived from the database's NOT NULL columns.

**Manager setup flow (Setup page)**
- 7 steps with ticks and "Next": Floors → Floor types → Tables → Printers → Kitchens → Menu categories → Food items (+ Add-ons). Printers come before Kitchens because a kitchen needs its printer.
- Floor types AC / Non AC / VIP / Rooftop seeded for every restaurant; tables have seats; kitchens are Food or Beverage and print on a chosen printer.
- Food item popup: name*, type (Single/Combo)*, price (₹)*, tax*, kitchen* (single), description, category, preparation time, barcode (unique), add-ons, combo dishes. Key is made from the name automatically.
- The sidebar's Menu items, Kitchens and Printers open the same screens; every add/edit is a popup with red **\*** on required fields.

**Each restaurant has its own KOT, kitchen and Billing pages** *(superseded by 5.2c: one POS; `/kot` and `/billing` open it; the kitchen screen is gone)*
- POS: `/{slug}/pos` and `/{slug}/kot` (the same page, both served; enrolled tablets stay signed in at either) · Kitchen: `/{slug}/kds` · Billing: `/{slug}/billing` (nginx and the Vite dev server both route them). Bare `/` and `/kds.html` ask which restaurant.
- The page looks the restaurant up first (`GET /api/public/restaurants/:slug`): unknown → "Restaurant not found", switched off → its own message. Its logo, name and theme colour are shown on the setup and PIN screens and recolour the app.
- The tablet's identity, sign-in, queue and station are stored under `pos:{slug}` (KOT) / `kds:{slug}` / `billing:{slug}`, so a browser set up for one restaurant can never open as another, and a setup code for another restaurant is refused.
- Tablet setup codes (Standard and Pro) came from **Admin → KOT, KDS & Billing Access → Set up a tablet**, with `corepack pnpm tablet-code <slug>` for local testing. *(Both removed in 0077, with the script.)*

**KOT, KDS & Billing Access (admin sidebar)** *(superseded by 5.2c: now "POS Access", read only)*
- Lists everyone who can sign in: staff code + PIN (tablets), email + password (admin), roles, which screens they can use (KOT / Billing / Kitchen, from their permissions), last sign-in, status, and the restaurant's own tablet links.
- **Set up a tablet** (setup code per branch). The owner no longer needs a PIN of their own: every PIN screen offers "Owner or manager? Sign in with email and password" (the till).
- **Reset PIN / Reset password**: the old one stops working at once and a one-time link (7 days) is shown; the staff member chooses the new one. The manager never sees it.
- **Switch off / on**: a switched-off person cannot sign in anywhere; roles and history stay.
- Refused: acting on yourself, on anyone whose roles you could not grant (a restaurant admin cannot reset the owner), on people outside your branch, and anything in another restaurant.

**KOT and Billing (migration 0064)**
- One order, two owners in turn: KOT takes and sends the order, then **Ready for billing** hands it over; from then on the server refuses every order change (add, edit, send, void, join, move, guests) and Billing bills it. Billing cannot bill an order KOT still owns. A manager can send an unbilled order back (`POST /admin/sessions/:id/reopen`, reason required).
- On Pro the hand-over is refused while any item is unsent. Basic has no KOT: sending to the kitchen and the kitchen screen answer 402; the owner makes a counter or table order in Billing (**New order**) and bills it.
- **Billing app** (`/{slug}/billing`, its own calm teal theme): queue (Ready / In progress / Completed), the order, Create bill, subtotal / tax / total, cash / card / UPI / other (split across methods), Complete payment.
- **KOT app**: floor cards show **With billing**; the order screen has **Ready for billing** instead of Bill/Payment.
- Removed: Stock, purchasing, suppliers, recipes, customers & loyalty, GST registration and premises class, the company-GSTIN option — screens, routes, handlers and unreferenced modules. Their tables and permission keys stay (keys listed as retired in `KEYS_WITHOUT_ROUTES`).

**Staff accounts by type, KDS kitchen picker, KOT printing (migration 0065)** *(staff creation and the KDS picker superseded by 5.2c; KOT printing stands)*
- **Staff → Create staff → pick KOT / KDS / Billing → Create account → Account ready.** Each type is one system role (KOT Staff / KDS Staff / Billing Staff), signs in with staff code + PIN, and the ready screen shows the setup link and the tablet address. KOT and KDS need Pro (shown "Available on Pro" on Basic). "Office account instead…" keeps the other roles (email + password).
- **KOT, KDS & Billing Access** filters accounts by All / KOT / KDS / Billing. Sidebar "Terminals" is now **Tablets**.
- **KDS setup** lists the branch's kitchens as big buttons (KDS Staff now hold `kitchen.station.view`); the choice is verified by reading its board. No more pasting a station id.
- **Chef retired** (0065): refused if anyone holds or is invited to it; custom roles cloned from it now point at KDS.
- **Kitchen printing, reusing the existing print jobs:** the print worker now sends the ticket to **network printers** (raw ESC/POS over TCP to the printer's `address`, default port 9100, 5 s timeout). USB/Bluetooth printers are not reachable from the server, so they fail and the job walks to the fallback printer as before.
- **KOT order screen → Kitchen tickets:** each ticket's kitchen, number, send, lines, printer and status (Printed / Waiting for printer / Did not print), **Print again** (a new reprint job; KOT Staff now hold `kot.reprint`) and **Print on this tablet** (the same ticket text through the tablet's print dialog). New read `GET /pos/order/:id/tickets` (`kot.view`, Pro).

**Security fixes found along the way**
- Sales Person could reprice / read another rep's subscriptions, invoices and dunning — now scoped.
- Token refresh ignored restaurant status (locked restaurants kept working 12h) — fixed.
- Payment webhooks could silently reactivate a deactivated restaurant — fixed.
- Deactivated platform users kept access until token expiry — now refused per request.
- No restaurant created from the console could ever sign in (invite was unredeemable) — fixed.
- Billing segment started microseconds after the displayed period — fixed.

### 5.2b Basic: one sign-in till, payments in parts, users limit, slugs (2026-10-09)

**The owner's till — Dine-in, Parcel and Billing on one sign-in (no setup code, no PIN).**
- `/{slug}/kot` on a fresh browser opens **Sign in to the till**: the owner/manager's email and password (a staff tablet's setup code is one tap away). `POST /admin/till` registers this browser as an ordinary `app.device` (key `device.register`: owner and Restaurant Admin; counted against the plan's tablet limit) and answers with a session for the **same user** at the till's branch. On Basic that session holds owner + the cashier membership provisioning gives the owner, so one person takes the order and the money while the audit log still records which capacity acted (payments: the cashier membership).
- Next sign-in on the same browser: `POST /admin/till/:id/session` signs that till back in (no new device, no limit check). The PIN screen offers "Owner or manager? Sign in with email and password".
- Both till routes refuse an impersonation session, a session already on a tablet, and any `Idempotency-Key` (a stored response would be a stored credential). Revoking the device in **Tablets** ends the till (`till_unknown`).
- The KOT screen shows **Dine-in · Parcel · Billing**. Billing is the Billing app's own workspace (one component, `BillingWorkspace`), shown when `GET /me`'s new `screens.billing` says this sign-in may bill (read from permission keys, never role or plan names) — so Pro's KOT Staff tablets are unchanged. On a till browser `/{slug}/billing` opens `/{slug}/kot#billing`. Billing waits for its lease before **Create bill** / **Add payment** enable.

**Payments in parts, mixed methods, cash change (0070).** `POST /pos/bill/:id/payment` takes any mix of card, UPI, other and one cash note, all or none; the server locks the bill, applies non-cash first (never above the balance), then the cash note up to what is left. The rest is **change**, stored as `cash_received_minor` beside the tender, never as sales. The Billing panel shows the server's answer: change to return, each method, cash received, this payment, total settled, balance due, Paid / Partially paid. Bill printed after a part payment: **PART-PAYMENT RECEIPT** with BALANCE DUE; **RECEIPT** only when fully paid. Sales reports read order lines (once per sale); the payment mix reads applied amounts only.

**Four restaurant users on Basic (0071).** `users` is a plan limit (Basic 4, Standard 8, Pro 25; any other version 25). Counted: active and invited accounts plus pending staff invites, owner included; platform staff never. Checked on staff invite, the generic user create and switching an account back on — never on switching off, never on sign-in.

**Slugs (0072).** New slugs must be clean — single hyphens only between letters or digits (`slugProblem`, shared by form and server; DB constraint `tenant_slug_clean` NOT VALID, so existing slugs are untouched). Routing (`SLUG_PATTERN`) still accepts every existing slug. Concurrent creates of one slug: exactly one wins, the other gets `409 slug_taken` (tested). **Slugs stay permanent after creation** — see gap 23.

**Tests have their own database** (`katkitchen_test`, `corepack pnpm db:test:create` once); the dev database keeps only real data.

**One POS link on Basic (0074).** New plan feature `staff_tablets` (Basic off, Standard/Pro on). `POST /admin/devices` (issue a setup code) is gated on it and on the tablet limit: Basic gets 402 naming Standard. On Basic the access page shows one link, `/{slug}/pos`, and no "Set up a tablet" panel; Staff shows "N of 4 restaurant users" and disables Create staff at the limit (`GET /admin/entitlements` now returns `usage`). The POS has a **KOT** tab: every open order with tickets, with printer status, Print again and Mark ready. `/{slug}/pos` is served, not redirected; `/{slug}/billing` on a till opens `/{slug}/pos#billing`.

**No tables on Basic (0075).** Plan feature `tables` (off on Basic). The Dine-in tab on Basic is a counter list — **New dine-in order**, numbered **D-n** from the same counter as parcels (`POST /pos/dine-in`, `GET /pos/dine-ins`); kitchen tickets, the KDS card, billing, receipts and open orders say "Dine-in D-4". Floors, floor types and tables are gone from Basic's Setup and refused by the API (402 naming Standard), including the Excel import's Floors/Tables sheets.

**One login page; the manager creates staff logins (0076).** *Staff part superseded by 0077 below: staff are PIN-only and the Sales person manages them.*
- `/{slug}` is the one login page for the manager and the staff (username or email, and password). The server answers where each lands: managers (anyone holding `user.view`: owner, Restaurant Admin, Manager) → the manager screens; staff → the POS (`/{slug}/pos`, Dine-in · Parcel · KOT · Billing), signed in on this computer's till with the same credentials (`POST /api/auth/:slug/till`).
- On Basic a staff sign-in on a new computer makes it a till (within the plan's 2 tills; the third is refused with a message). Standard/Pro staff still use tablets with a setup code and PIN.
- **Staff → Create staff** (Basic): name, username, password, and what they can use (POS staff / Orders & KOT / Billing / Manager). `POST /admin/staff/accounts`; the subset rule and the 4-user limit are checked on the server. Standard/Pro keep the invite flow.
- Removed: the POS's own till sign-in screen, `POST /admin/till` and `/admin/till/:id/session` (folded into the one till route), and the Sales person's staff screen and routes (0075's `staff_admin` and `platform.tenant.staff`, dropped by 0076).

### 5.2c Basic only: PIN staff, the Sales person manages them (2026-10-12, 0077)

**What was done to the data first.** A backup of the dev database was taken before any change: `C:\Amruthesh\katkitchen-backups\katkitchen-before-basic-only-2026-10-12.dump` (`pg_dump -Fc`, restore with `pg_restore`). Then `scripts/move-to-basic.mts` (dry-run first) moved every live subscription to Basic through the ordinary plan-change path (`changeSubscription` + `applyDueChanges`, so each move is a segment and a new entitlement document) and retired Standard and Pro (`setPlanStatus`). Nothing was deleted: kfc and paragon keep all their data; their floor plans stay in the database and are refused by the plan (402) like any Basic restaurant's.

**Staff sign in by name + 4-digit PIN.**
- The POS (`/{slug}/pos`) on a till shows the staff as name tiles (`GET /api/public/restaurants/:slug/till/staff`, fingerprint in the `x-device-fingerprint` header — answered only to a till, names only). Tap your name, type the PIN on the keypad (auto-submits on the 4th digit; show/hide; delete; clear; keyboard works; a lockout says how long to wait). `POST /api/auth/:slug/pin` with the tapped `userId`.
- Staff have **no password** (0077 revoked every active password of an account that does not manage the restaurant). `POST /api/auth/:slug/login` and `/till` refuse a staff account with 403 `staff_use_pin`, after the password check, issuing nothing.
- Only a manager makes a browser a till (`device.register`), at `/{slug}?to=pos`, within the plan's 2 tills. A PIN never makes a till.

**The Sales person manages staff, from the console.** Restaurants → open the restaurant → **Staff**: add (name, 4-digit PIN, what they can use: POS = orders + billing, Orders & KOT, Billing), edit name or access, set/reset PIN, switch off/on. Routes `/api/platform/tenants/:id/staff` (GET, POST), `/:userId` (PATCH), `/:userId/pin`, `/:userId/active` (POST), key `platform.tenant.staff` (Sales person, Super Admin). Rules:
- Only restaurants the Sales person sold (`provisioning_request.requested_by_platform_user_id`); Super Admin reaches all through `platform.tenant.staff.any`. Anything else is the same 404.
- Never a manager account (`tenant_staff_is_manager`).
- PIN exactly 4 digits, not trivial (0000, 1234, runs); argon2id; never written to the audit log (every change is a `platform_audit_log` row naming the Sales person).
- The 4-user limit (owner included) is counted under the plan lock; switching off is never refused, switching back on is when it would go over.
- **This relaxes "nobody but the person knows their secret"** for staff PINs, on the owner's decision.

**The manager manages no staff.** Removed: Staff screen, invites and setup links, `/admin/staff` (POST), `/admin/staff/accounts`, access resets and switch-off, `/admin/users` create/edit/archive (now read only), membership grant. **Sale** (admin sidebar, formerly POS Access) is a read-only list of who can sign in on the POS.

**Removed entirely:** the kitchen screen (`/kds/*` routes, SSE stream, LISTEN listener, `kds.html`), the separate KOT and Billing apps (`/{slug}/kot` and `/{slug}/billing` now serve the POS), tablet setup codes (`POST /admin/devices`, `/api/auth/device/enrol`, `scripts/tablet-code.mts`), staff invites (`/api/auth/staff-invite/accept`). KOT is now the one place that marks food ready, on any plan version. Old slugs keep working for sign-in, the till and its staff list.

**One POS screen (2026-10-13).** The POS no longer has Dine-in, Parcel or KOT tabs. It opens on **New order**: tap items, set quantities, add a note per item, switch **Parcel** on for take-away, type a customer name if wanted, and tap **Confirm order**. That one tap opens the order (D-n, or P-n for a parcel), adds the items, records them as sent to the kitchen, and opens it for payment with the bill already made. The till then prints **three copies** in one go, each labelled: **CUSTOMER COPY** (the bill), **KITCHEN COPY** (order number, items, quantities, notes; the billing staff hand it to the kitchen) and **BILLING COUNTER COPY** (kept at the counter). Parcels say **PARCEL / TAKEAWAY** on every copy. Each copy has a **Reprint** button; reprinting never creates another order or kitchen ticket. Then **Add payment** (full, part, or card/UPI + cash with change), **Print invoice** and hand it over, **Complete payment**. Part-paid orders stay in the list ("Part paid") to finish later. *Since 2026-10-17 the payment that clears the bill completes the order by itself (Complete payment is only a fallback), and the list says Unpaid / Part paid / Paid. Since 2026-10-20 the payment panel shows a live PREVIEW while typing (Added, Balance after this payment, Change to return) and has no slip / transaction-id box -- see §8.* A double tap or a retry after a dropped connection finishes the same order -- never a second order or a second kitchen ticket. There is no kitchen screen and no "Mark ready"; closing an order needs only payment. Removed: the floor plan, the order pane (with its void / comp / discount panel), the parcel list, the KOT board and their tests.

**After pulling:** `db:migrate` (0077), `db:seed` (adds `platform.tenant.staff` / `.any`), `redis-cli FLUSHALL`. Staff whose passwords were revoked (in the dev DB: akhil and dilip at mcdonald-s) need a PIN from the Sales person before they can sign in.

### 5.3 Migrations added recently

| # | What |
|---|---|
| 0086 | Day end and bill edits. `app.day_submission`: a branch's business day as submitted (bill count, voided bills, sales, tax, payable, collected, refunded, per-method totals), status `submitted` / `reopened` / `superseded`; one live row per branch per day (`day_submission_one_live`, partial unique); a reopening stamps who, when and why on the same row; a trigger keeps the submitted figures unchangeable and lets a live row only move forward. `app.bill_revision` (append-only): the edited bill, the bill that replaced it or the supplementary bill and refund that followed it, `authority` `pos` / `manager`, the reopening a manager edit ran under, the reason, before/after images. `app.refund` gains `refund_tenant_id_key`. Reason `bill_corrected` (void, refund) seeded for every restaurant. Down drops both tables and removes the reason only where nothing used it |
| 0087 | Allow POS Bill Editing. `app.pos_edit_grant`: a manager's permission for the till to edit TODAY's submitted bills, on one day submission (`on` / `off`; who switched it on, when and why, who switched it off and when; one `on` per submission by a partial unique index; a trigger keeps who/when/why unchangeable and an `off` grant off). `app.bill_revision` gains `pos_edit_grant_id`, pinned with `day_submission_id` by a composite FK; 0086's `bill_revision_pos_never_on_submitted_day` becomes `bill_revision_pos_on_submitted_day_needs_grant` (a till edit names a submission exactly when it names a grant; a manager edit never names a grant). Down folds each used grant into its revision's after image, then drops the column and the table |
| 0088 | Bill headings. `app.branch` gains `bill_heading_unpaid` (default `BILL`), `bill_heading_part_paid` (`PART PAID`) and `bill_heading_paid` (`INVOICE`), NOT NULL, each CHECKed to 1-20 printable ASCII characters with no space at either end (room for " · COPY 12" on a 2-inch roll; code page 437 on a direct print). Existing branches take the defaults. Down drops the three columns: settings, not records |
| 0078 | Printer and bill layout. `app.printer`: `printer_type` (thermal / laser / inkjet), `paper_size` (2, 3, 4-inch roll; A5, A4), `orientation`, `margin_mm`, `font_size_px`, with CHECKs: a roll only on a thermal printer, a roll portrait only, a network printer thermal. `app.branch`: `bill_printer_id` (a printer of that branch), five `bill_show_*` flags, three `bill_copy_*` flags (at least one), `bill_auto_print`. Every existing row defaults to what printed before: thermal 3-inch, all copies, automatic |
| 0079 | `platform.tenant.theme_color_secondary`: an optional second brand colour (`#rrggbb`, CHECK `tenant_theme_color_secondary_hex`) for tinted surfaces; NULL tints from the primary as before |
| 0080 | `app.branch.bill_show_copy_label` (boolean, default true): whether a printed copy names itself at the top (CUSTOMER / KITCHEN / COUNTER); REPRINT and PARCEL print regardless |
| 0081 | Parcel charge. `app.order_line` kind `charge` (quantity 1, no menu item, guest or note; one per order, `order_line_one_charge_per_order`). `app.branch.parcel_charge_default_minor`, `parcel_charge_max_minor` (both default 0: no charge until a manager sets one), `parcel_charge_tax_class_id` (FK to `app.tax_class`); CHECKs: default ≤ max, a max above 0 needs a tax rate. Down keeps existing charge lines (old CHECKs come back NOT VALID) |
| 0077 | Staff are PIN-only: every active password credential of an account that does not manage the restaurant (no active membership whose role holds `user.view`) is revoked, never deleted. Down is a no-op: a rollback does not re-activate secrets |
| 0076 | `staff_admin` removed from every plan version and the `platform.tenant.staff` key from the catalogue (the manager manages staff on every plan); entitlement documents republished |
| 0075 | `tables` (and, until 0076, `staff_admin`) stated on every plan version (Basic `false`, others `true`); `app.table_session.seating` (`table` / `counter`), shape CHECK widened so dine-in may be numbered at the counter, counter-number uniqueness now over every counter session; entitlement documents republished |
| 0074 | `staff_tablets` stated on every plan version (Basic `false`, others `true`); entitlement documents republished and caches invalidated |
| 0073 | `platform.tenant_slug_history` (every former address, its restaurant, who retired it); `platform.tenant_id_for_slug` (current slug, else a former one); trigger `assert_slug_unclaimed` on both tables -- an advisory lock per slug, then a check of the other table -- so a former address can never be claimed by another restaurant, even concurrently |
| 0072 | `platform.tenant` constraint `tenant_slug_clean` (no `--`, no trailing `-`), NOT VALID: binds new and changed slugs only |
| 0071 | `users` limit stated on every plan version (Basic 4, Standard 8, Pro 25, others 25); every restaurant's entitlement document republished and its cache invalidated |
| 0070 | `app.tender.cash_received_minor`: the cash note handed over, beside the amount applied. Only a cash capture may carry it, and never less than it paid (`tender_cash_received_shape`). Change = received − applied, derived, never stored. Older cash rows stay NULL (not recorded) |
| 0055 | `deactivated` tenant status + reason/actor columns; `platform_user.phone` |
| 0056 | `auth_attempt` method `owner_invite` |
| 0057 | Invite stores manager name & phone (`invitee_name`, `invitee_phone`) |
| 0058 | Invite stores `reissue_reason` (required when resetting an already signed-up manager) |
| 0069 | `app.branch.phone`, `bill_address`, `bill_footer` (default 'Thank you! Visit again'); new append-only `app.bill_print` (one row per printed copy, kind `bill`/`receipt`, gapless `copy_no`) |
| 0068 | `app.sales_order.cancelled_at`, `cancelled_by_user_id`, `cancel_reason`; CHECK: `status = 'cancelled'` exactly when all three are set (reason at least 5 characters) |
| 0067 | Three plans: **Standard** added; `kds` is a plan feature (Basic/Standard `false`, Pro `true`); Basic gains `kot`; `platform.tenant.kds_enabled` dropped; every restaurant's entitlement document republished and its cache invalidated |
| 0066 | `platform.tenant.kds_enabled` (per-restaurant KDS switch) — superseded by 0067 |
| 0065 | Chef system role retired (guarded; clones repointed to KDS) |
| 0064 | Order stage `ordering` → `billing` on the session; plan terms `kot` (stock flags and the Max-only report tier removed); Max restaurants moved to Pro (segments split), Max retired; new entitlement documents |
| 0063 | Parcel/takeaway (service type, parcel number, pickup) and joined tables; closing releases tables |
| 0062 | `app.credential_setup` — one-time PIN/password reset links |
| 0061 | `app.floor_type` (+ floor.floor_type_id), table-floor same-branch FK, station code Food/Beverage, item barcode + preparation time |
| 0060 | Restaurant `address`, `theme_color`, `platform.tenant_logo`; staff invites by staff code + PIN or email + password; `staff_invite` attempt method |
| 0059 | Every plan version and entitlement document states every plan key (tablets, recipes, suppliers, purchasing, report tier); first document for restaurants that had none |

### 5.4 Key numbers

As of 2026-11-25:

- 88 migrations, all reversible (reversibility is tested on a database with data).
- 187 routes (control plane under `/api/platform/`; public prefixes `/api/auth/`, `/api/public/`, `/healthz`; the print agent's `/api/agent/poll`).
- 1,290 backend tests in 68 files passing (against `katkitchen_test`); 348 web tests in 39 files passing; typecheck, lint and the web build clean.

### 5.5 Printers: what prints where, and setting up a receipt printer on Windows

**There are three printing paths.** The server reaches network printers only; the till reaches the printer beside it.

| What | Path | Printers it reaches |
|---|---|---|
| Bill, receipt and the CUSTOMER / KITCHEN / COUNTER copies on the POS; **Print a test page** on the Printed bill page -- **when the bill printer is USB or Bluetooth, on a roll, and this till has connected it** | **Direct** (2026-10-29): ESC/POS text from the till over **Web Serial** to the printer's COM port (`print/serialPrinter.ts`, `escpos.ts`, `copyLines`). No print dialog | A Bluetooth Classic printer, through the COM port Windows makes when it is paired; a USB printer only if Windows gives it a COM port |
| The same copies otherwise (network or sheet printer, no printer chosen, till not connected, browser without Web Serial); My takings always | The browser's print dialog on the till (`print/receipt.ts`, `printHtml`) | Any printer **Windows** can print to: USB, Bluetooth (through its COM port), network |
| Kitchen tickets queued by the server at `fire` (`print_job`, `print.drain`) | Raw ESC/POS over TCP to `printer.address` (port 9100 by default, 5 s timeout) | **Network (Wi-Fi / Ethernet LAN) printers only**, and only at a LAN address (below). A USB or Bluetooth printer is refused, and the job moves to its fallback printer |
| The same kitchen tickets, at a branch that has a **print agent** (2026-11-11) | The agent on a restaurant computer takes the branch's jobs over HTTPS and sends the server-rendered ESC/POS bytes over TCP | The branch's network printers, from inside the restaurant's network. The server worker leaves that branch's jobs alone |

On Basic the kitchen gets its copy from the till (the KITCHEN copy), so a USB or Bluetooth receipt printer is enough on its own. `sendCopies` is the one place that chooses between direct and the dialog; the POS and the Printed bill page both call it.

**Direct printing has no preview (2026-11-11).** When the till prints directly (`printsDirect`: USB or Bluetooth bill printer, a roll, a port connected on this till), paid bills go straight to the printer even with automatic printing off, and **Print bill** / **Reprint … copy** do too. There is no preview and no print dialog. If the printer drops a copy, the alert offers **Retry** (the same pages) and **Use the print dialog**. The preview appears only when the copies will go through the dialog.

#### Implementation status (2026-11-11)

| Connection | What works | Tested on hardware? |
|---|---|---|
| **Bluetooth** (Classic SPP) | Search Bluetooth devices, saved printers, Connect / Disconnect / Reconnect, Test connection, Test print, direct bills and all three copies, last successful print | **No.** Tested against a simulated Web Serial port only |
| **USB** | The same, when the printer shows as a COM port (USB-serial). Otherwise the print dialog through its Windows driver | **No.** Simulated port only |
| **Wi-Fi / Ethernet LAN** | Setup → Printers: name, IP address, TCP port (default 9100), paper. Kitchen tickets through the **print agent** (hosted site) or the server's print worker (server on the restaurant's network). The agent reports whether each printer answers and runs **Test print**. Bills through the till's print dialog | Against a local TCP server standing in for the printer, including the real agent program polling the real API; **no real network printer** |

**Network printers and the hosted site: the print agent (2026-11-11, migration 0085).** The print worker runs on the server. On Render that server is in the cloud and **cannot reach a `192.168…` printer in the restaurant**. So a branch with Wi-Fi or Ethernet printers runs the **print agent** (`print-agent`): one Node.js file on a restaurant computer that polls `POST /api/agent/poll` every 2 seconds over HTTPS. Each poll reports what the agent printed and takes the next jobs, as ESC/POS bytes the server rendered, with the printer's checked address.
- **One queue.** The agent claims `print_job` rows with the worker's own functions (`claimBatch`, `jobPayload`, `markAccepted`, `recordFailure`), so attempts, backoff, the fallback printer and the FALLBACK COPY banner are unchanged. While a branch has an active agent the server worker leaves its jobs alone, and they **wait** for the agent rather than failing on a printer the server cannot reach. A stale claim is reclaimed after 2 minutes. If the agent dies between sending a ticket and reporting it, that ticket can print twice: the same trade the worker already makes. The agent remembers what it sent, so a report that was merely lost does not reprint.
- **Its credential.** Setup → Printers → **Set up print agent** (`device.register`, audited `print_agent.issued`) shows a token `<slug>.<secret>` **once**; only its SHA-256 is stored (`app.print_agent`). The agent sends it as its bearer on its own plane, `/api/agent/*` (`core/middleware/agentRoute.ts`), which takes no JWT and is checked on **every** poll. **Stop this agent** (`device.revoke`, audited `print_agent.revoked`) therefore stops it at its next poll and returns any jobs it held to the queue. A manager or till JWT is refused there, and an agent token is refused on `/api/t/*`.
- **Where it may print.** Only its own branch's active network printers, at an address that passes `parsePrinterAddress`. The server checks before handing out a job, and fails it there instead. The agent checks again before connecting, with its own copy of the rule, which `tests/ops/printAgentScript.test.ts` holds to the shared one.
- **What a manager sees.** The Printers page shows the agent Online or Offline with its last check-in, and whether each network printer answered the agent (it connects and disconnects every 30 s, sending nothing). **Test print** is sent by the agent at its next poll and its result shown.
- **Not built:** bills on a network printer through the agent (bills keep the print dialog), and a Windows installer (Task Scheduler instead). Failed agent sign-ins are not recorded in `platform.auth_attempt`. The token sits in `agent.json`, protected by file permissions, not Windows DPAPI.

**Which network addresses are allowed (2026-11-11).** A network printer's address is an IPv4 address in a private range (`10.x`, `172.16–31.x`, `192.168.x`) and a raw-printing port `9100–9109`. Hostnames, loopback, link-local (`169.254.x`) and public addresses are refused. The rule is `parsePrinterAddress` in `shared`, used three ways:
- by the setup form, as you type;
- when a printer is saved (`PrinterRepository`, `400 printer_address_invalid`), for the admin form and the Excel import;
- by the print worker before **every** connection. Rows saved before the rule are refused there, and the job moves to its fallback.

The reason: the worker writes raw bytes, including dish names a manager typed, to whatever it is pointed at. From a cloud host, a "private" address can reach the host's own services; Redis on 6379, for example, reads plain text as commands.

**Why Web Serial, not Web Bluetooth or a print agent.** A Bluetooth receipt printer is Bluetooth **Classic** (SPP), and Web Bluetooth speaks BLE only, so it cannot reach one. Windows turns a paired SPP printer into an outgoing COM port, and Chrome / Edge open COM ports through Web Serial with nothing installed. A local print agent would also work, but it is a program to install, update and secure on every till. Web Serial needs **Chrome or Edge** and **HTTPS or localhost**; anywhere else the till prints through the dialog as before.

**What direct printing sends.** Each copy starts with `ESC @` (initialise) and `ESC t 0` (code page 437). Each line then gets `ESC a` (centre), `ESC E` (bold) and `GS !` (double height), followed by a line feed. The copy ends with `ESC d 5` (feed past the tear bar) or, when **Cut the paper after each copy** is ticked on that till, `GS V 66 3` (feed to the cutter and partial cut). The cut is off until someone ticks it, because a printer without a cutter may print the command as junk.

Width is 48 characters on a 79–80 mm roll, 32 on 58 mm and 69 on 112 mm (standard font, 12 dots per character). Text uses code page 437: accents the page lacks are dropped, ₹ prints as `Rs`, and Arabic or Indic script prints as `?`. There is **no logo** in direct mode. Amounts carry no currency symbol, as on the HTML bill.

**Retries never create anything.** The copies are fetched once: one counted `POST /pos/bill/:id/print`, with the kitchen ticket READ. If the printer drops a copy, that copy and every one after it are kept. **Retry** resends those same pages, and nothing is read, billed, sent to the kitchen or charged again (asserted in `newOrderFlow`). A copy that broke part-way is **not** re-sent automatically; the alert says it "may be incomplete", and the cashier decides. **Use the print dialog** prints the same pages the old way. A serial printer reports nothing back, so "sent" never means "paper came out".

**Paper and layout.** A "3-inch" roll is 79–80 mm wide (`paper_size = thermal_80`, labelled "3-inch roll (79–80 mm)"). The print head is narrower than the paper: an 80 mm ESC/POS head usually prints **72 mm** (576 dots at 203 dpi), centred, leaving about 4 mm at each edge. 58 mm rolls print 48 mm and 112 mm rolls print 104 mm. These are the common head widths, not one model's datasheet.

The bill is laid out inside that width (`PAPER.printableMm`, `rollContent`). The side margin is the printer's `margin_mm` or half the unprintable edge, whichever is larger. Before 2026-10-28 the 80 mm bill was laid out 74 mm wide, which a 72 mm head clips or shrinks, and the right-aligned amounts and totals were the part at risk. The preview draws the bill where the head prints it. Long words wrap; amounts never break. The server's network kitchen ticket stays 32 columns, which fits both 58 mm and 80 mm heads.

**Cut and feed.** On a browser-printed bill, feeding and cutting are set in the Windows driver (paper feed / cut at end of document), not in UniversalPOS. On a direct print they follow the till's **Cut the paper** switch (above). The server's network ticket ends with four line feeds and `GS V 0` (full cut). A printer without a cutter ignores the cut, and the paper is torn at the bar.

#### The ATPOS M80 (the owner's printer, 2026-10-28)

From its label: ATPOS **M80** mobile thermal receipt printer, 79 mm paper, 80 mm/s, 5 V 1 A, **USB + Bluetooth**, RoHS / FCC / CE. The label claims **no Ethernet or Wi-Fi**, so:

- In UniversalPOS it is a **USB** or **Bluetooth** printer with **no address**: type thermal, paper **3-inch roll (79–80 mm)**, chosen as the branch's **Bill printer** on the Printed bill page. When it is set up as Bluetooth and connected on the till, it prints bills and all three copies directly; otherwise they go through the till's print dialog.
- It must **not** be set up as a **Network** printer. The server would try to send kitchen tickets to it over TCP, time out, then fall back or fail.
- Its ESC/POS behaviour (cutter, code page, Bluetooth SPP, whether its USB shows as a COM port) was **not tested**, because no unit was attached to the development PC. Direct printing is tested only against a simulated port. Browser printing does not depend on any of this: the Windows driver renders the page.

**The `192.168.1.80` port is almost certainly wrong.** "80mm Series Printer" is the generic POS-80 Windows driver, and its installer often creates a Standard TCP/IP port. A USB/Bluetooth-only printer cannot be reached over TCP/IP, so prints to that queue go nowhere. On the development PC on 2026-10-28, `192.168.1.80` answered neither ping nor TCP 9100, and that PC did not have the queue installed. To check on the till PC, run `Test-NetConnection 192.168.1.80 -Port 9100` in PowerShell. If it fails and no other device owns that IP, the port is a leftover.

#### Windows setup (the till PC)

**Over USB**

1. Connect the printer by USB and switch it on.
2. Install the maker's driver if you have it; otherwise the generic "80mm Series Printer" (POS-80) driver.
3. Settings → Bluetooth & devices → Printers & scanners → **80mm Series Printer** → Printer properties → **Ports**. Tick the **USB00x** port ("Virtual printer port for USB"), not the `192.168.1.80` TCP/IP port.
4. Print a Windows test page from the General tab.

**Over Bluetooth**

1. Settings → Bluetooth & devices → Add device → Bluetooth, then pick the printer. The pairing PIN is usually `0000` or `1234`; see its manual.
2. More Bluetooth settings → **COM Ports**: note the **Outgoing** port for the printer (e.g. COM5). If there is none, choose Add → Outgoing → the printer.
3. In the printer's properties → **Ports**, tick that **COM** port. The port settings are usually 9600 or 115200 baud, 8-N-1; check the manual.
4. Print a Windows test page.

**Direct printing over Bluetooth (no print dialog), once per till:**

1. Pair the printer in Windows (steps 1–2 above) and note its **Outgoing** COM port. Direct printing does not need a Windows printer queue.
2. Open the POS in **Chrome or Edge** at the restaurant's **https** address (or `localhost` on the till itself).
3. POS header → **Printer** → **Search Bluetooth devices** (or **Choose a USB or COM port**). The browser lists serial ports; choose the printer's Bluetooth port, shown as the printer's name or as "Standard Serial over Bluetooth link (COM5)". The browser remembers the choice, it appears under **Saved printers in this browser**, and the till reconnects by itself next time. **Test connection** sends one harmless command (`ESC @`, nothing prints); **Test print** prints a short slip. The panel shows the status (Connected / Disconnected / Error) and the **last successful print**.
4. Tick **Cut the paper after each copy** only if the printer has a cutter.
5. Manager screens → Printed bill → **Print a test page** sends the example copies to the connected printer. That page has the same Connect panel when the bill printer is USB or Bluetooth.
6. **Disconnect** closes the port but keeps it in the saved list (Connect opens it again without asking); **Forget this printer** withdraws the browser's permission.

**A Wi-Fi or Ethernet printer:**

1. Connect the printer to the router (cable) or to the restaurant Wi-Fi (the maker's tool). Print its self-test slip (usually: hold FEED while switching it on) and read its IP address.
2. In the router, give that printer a **fixed (reserved) address**, or tickets stop when the address changes.
3. Manager screens → Setup → Printers → **Add printer**: connection type **Wi-Fi / Ethernet LAN**, the IP address, the port (leave empty for 9100) and the paper.
4. From a PC on the same network, `Test-NetConnection <ip> -Port 9100` in PowerShell should report `TcpTestSucceeded : True`.
5. On the hosted site, set up the **print agent** on a computer on the same network: `print-agent/README.md` (also linked from Setup → Printers) has the steps, including starting it with Windows through Task Scheduler. Then use **Test print** on the Printers page.

A COM port can be open in only one program at a time, so close any Windows print job or other tab holding it.

**Browser print dialog (Chrome or Edge), the first time:** Destination **80mm Series Printer**; Paper size the 80 mm (72 mm printable) roll the driver offers; **Margins** None or Default; **Scale 100** (not "Fit"); **Headers and footers** off. The dialog remembers these per printer.

**In UniversalPOS**

1. Setup → Printers → Add printer: a name, Connection **USB** or **Bluetooth**, no address.
2. Printed bill → **Bill printer**: choose it. Type Thermal, paper 3-inch roll (79–80 mm). Start with margin 3 mm and font 12 px.
3. **Print a test page** prints the example copies the way the till does: directly when this computer has the printer connected, otherwise through the dialog.

#### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing prints; the Windows queue shows an error | The driver is on the TCP/IP port. Move it to USB00x or the Bluetooth COM port |
| Right edge (amounts) cut off, or everything tiny | Browser scale is not 100%, or the driver's paper is wider than the roll. Set Scale 100 and pick the 72/80 mm paper in the driver |
| Blank paper | The roll is loaded upside down: thermal paper prints on one side only |
| A Bluetooth printer worked once, then stopped | The COM port number changed after re-pairing. Re-tick it under Ports |
| Kitchen ticket shows "sent, not printed" | The printer is set up as Network in Setup with no reachable address. A USB/Bluetooth printer must not be set up as Network |
| Garbled characters on a network ticket | The server sends UTF-8. Non-ASCII item names (₹, accents, Indic script) depend on the printer's code page, which the server path does not handle |
| POS header says "Print dialog" | This browser has no Web Serial (Firefox, Safari), or the page is not on https or localhost. Use Chrome or Edge at the https address |
| Connect lists no Bluetooth port | The printer is not paired, or has no Outgoing COM port. Pair it and add an Outgoing port (More Bluetooth settings → COM Ports) |
| "The printer did not answer" | It is off, out of range, or connected to another device or a phone. Switch it on near the till and Connect |
| "The printer's port is open in another program or tab" | A Windows print job, another browser tab or a serial tool holds the COM port. Close it, then Connect |
| "Copy n of m may be incomplete" | The link dropped mid-copy. Check paper and power, then Retry (it resends from that copy on) or Use the print dialog |
| `?` in item names on a direct print | The name is in a script code page 437 cannot print (Arabic, Devanagari). Print those bills through the dialog |
| Junk characters at the end of every direct copy | The printer has no cutter and is printing the cut command. Untick **Cut the paper** |

**Not built, deliberately:**
- A server-side "check connection" for network printers. It needs a new route, permission and audit posture, and does nothing for USB/Bluetooth.
- WebUSB for a USB printer that shows up as a printer rather than a COM port. Windows' own print driver holds it, and claiming it would mean replacing that driver, so such a printer prints through the dialog.
- A logo or non-Latin script on a direct print. That needs raster printing: an image library and far more data over Bluetooth. Plain text was chosen with the owner on 2026-10-29.
- Direct printing of **My takings**: it stays on the dialog.
- Server kitchen tickets to a USB/Bluetooth printer. The server cannot reach it; Basic's kitchen copy comes from the till.

---

## 6. Pending tasks / known gaps

| # | Gap | Why it matters |
|---|---|---|
| 1 | **Merge `amruthesh` into `main`** (pushed; no PR opened yet) | The work is on the feature branch only |
| 2 | ~~**Separate test database**~~ | Done 2026-10-09: the suite runs against `katkitchen_test` (`pnpm db:test:create` once; migrated and seeded automatically before each run) and refuses to run against `katkitchen`. The dev database keeps only real data |
| 3 | **Invite email delivery** | The outbox `tenant.owner_invite` message has no link; the setup link must be copied from the console by hand |
| 4 | **No order number** | Tickets and parcels are identified by table(s) or parcel number, KOT number and send number; `sales_order` has no human-readable number, so "Order #1001" is not shown anywhere |
| 5 | **No invoice generation job** | Invoicing code exists but no scheduled job runs it, so revenue stays ₹0 and billing status stays "Not billed yet" |
| 6 | **No automatic renewal / trial end** | Periods only move when someone clicks Renew; trials expire visually but nothing bills or suspends them automatically |
| 7 | **Payment gateway not connected** | Webhooks/dunning are built but no real gateway is configured |
| 8 | **Billing role can deactivate** restaurants and plans (it held those permissions already) | Confirm whether that should be Super Admin only |
| 9 | **Tenant-visible login attempts** | Restaurant owners can't see failed PIN/password attempts (a boundary decision; see "Credential events live in their own table" in `docs/architecture/decision-history.md`) |
| 10 | **GST review before the first real invoice -- Pending qualified GST review** | The flows, sample invoices (produced and asserted by the code), assumptions and eight open questions are in `docs/backend/gst-review.md`; someone who files GST returns must review them, and record it there, before anything is called GST-approved |
| 11 | **No Reports screen in the admin** | Pro report routes (sales, staff, exception, GST) exist and are plan-gated, but only the Dashboard shows report data |
| 13 | **Local stack has no scheduler running** | A plan change reaches a restaurant within 5 minutes (cache TTL); run `corepack pnpm job outbox.drain` to apply it at once. Kitchen tickets print only when `print.drain` runs (`docker compose --profile scheduler up -d`, or `corepack pnpm job print.drain`) |
| 19 | **Printer sends are one at a time** | Each unreachable network printer costs up to 5 s per job per cycle; the dev data has ~90 pending jobs at documentation addresses (192.0.2.x) that will time out and fall back/fail on the first drain |
| 20 | **USB / Bluetooth printers** | Only network printers can be reached from the server. A Bluetooth printer connected on the till prints bills and all three copies directly over Web Serial (5.5); otherwise they go through the print dialog. **Not yet tested on a physical ATPOS M80**: pairing, the COM port, the code page and the cutter need checking on the device. A USB printer prints directly only where Windows gives it a COM port. A direct print carries no logo and no non-Latin script |
| 15 | **Retired permission keys still in the catalogue** | Stock/supplier/recipe/customer/GST keys guard nothing now; removing them rewrites the separation-of-duties rules, so it is its own change |
| 16 | **Billing screen: whole bill only** | Split by guest/item/percentage is supported by the API but not offered on the Billing screen yet. (One bill paid in parts and by several methods IS supported -- 0070.) |
| 17 | **Reopen for KOT has no button** | `POST /admin/sessions/:id/reopen` works (manager, reason); no admin screen calls it yet |
| 18 | **Parcel pickup after hand-over** | "Mark picked up" needs the KOT lease, so do it before Ready for billing |
| 21 | **Billing & Orders (`counter`) accounts on Basic** | Basic now has KOT (0067), so the Billing screen no longer offers New order there; an existing Basic `counter` account can bill but not send to the kitchen. Give that person a KOT Staff account (or use the owner's) |
| 22 | ~~**A KDS tablet left signed in after Pro → Standard/Basic**~~ (the kitchen screen was removed, 0077) | Every kitchen read is refused 402, so it shows no data, but the screen reads as "disconnected" rather than "not on your plan" until "Change kitchen" is tapped |
| 23 | ~~**A slug cannot be changed after creation**~~ | Built 2026-10-10 (0073): Super Admin renames in Edit restaurant; the old address redirects, tablets stay set up, old setup codes still redeem, and no other restaurant can take an old slug |
| 24 | **Revoking a till or tablet does not release its table leases** | Its tables stay "held by another tablet" until the lease expires (≤ 15 min) or a manager force-releases. Pre-existing behaviour, seen while testing the till |
| 25 | ~~**"Your own PIN"**~~ | Removed 2026-10-10: panel, `POST /admin/access/me/pin` and `issueOwnPinSetup`. PINs already set keep working (they are ordinary credentials) |
| 26 | ~~**docs/frontend/FRONTEND.md's "no money arithmetic" gate does not exist**~~ | Built 2026-10-10: `frontend/tests/moneyGate.test.ts`; the violations it found are fixed |
| 14 | **Only Restaurant Manager / Restaurant Admin can read the plan** (`tenant.settings.view`) | Other admin sign-ins see the full sidebar; gated screens still answer 402 |

---

## 7. Next steps (recommended order)


1. **Open a PR** from `amruthesh` to `main` and merge it.
2. **Separate test database** — point Vitest at its own database so the dev data stays clean.
3. **Split bill on the Billing screen** — offer the existing split kinds (guest, item, percentage).
4. **Invite email** — include the setup link in the outbox email (or keep manual copy, but decide).
5. **Billing automation** — schedule invoice generation and period renewal/trial-end, then connect a payment gateway.
6. Decide whether **Billing** keeps deactivate permissions.
7. **GST review** of invoices before charging real customers.
8. Production deploy plan (secrets, first Super Admin via `seed-platform-user` with a chosen password, backups).

---

## 8. Change log

| Date | Change |
|---|---|
| 2026-11-25 | **Install POS App** (no migration; one public route, 187). The manager's dashboard (`/{slug}`) opens on an **Install POS App** card: the restaurant's name and logo, a phone showing the app icon, **Install POS App** (opens `/{slug}/pos?install=1`), **Copy link**, a QR code of that link drawn on the device (the `qrcode` package; the link is sent nowhere), Android (Chrome) and iPhone (Safari) steps, and **Tills set up: n of 2** (the plan's `devices`, from `GET /admin/entitlements`). At the limit it says a further phone can install but cannot become a till until one is taken out of use under Tablets. The POS opened from that link shows install help over the till (one-tap **Install app** where Chrome offers it). The installed app is a web app, not an APK: `GET /api/public/restaurants/:slug/manifest` (public, names only, `no-cache`) gives each restaurant its own app, `{name} POS`, with `id` / `start_url` / `scope` `/{slug}/pos`, the restaurant's theme colour and a splash in the POS background. Its icon is the restaurant's logo when that is a square PNG or WebP of at least 192 px (Chrome refuses JPEG icons, found by Chrome's own installability check against paragon's logo); otherwise it is UniversalPOS's icon (`frontend/public/app-icons`, 192, 512 and maskable 512; 180 for iPhone). iPhone takes `apple-mobile-web-app-title` and `apple-touch-icon` from the page. The service worker `/pos-sw.js` is scoped to `/{slug}/pos` and **caches nothing**: it answers only page loads and only to say **No connection**, so a deploy reaches installed apps on the next launch and no restaurant data is kept by it. **Unchanged:** first launch is the existing manager set-up on `/{slug}/pos` (`?to=pos` was removed on 2026-10-16); staff PIN sign-in; an ended session returns to the PINs; a revoked till returns to the manager's set-up; the 2-till limit is the server's. **On iPhone set the till up inside the Home Screen app**: it keeps its own storage, apart from Safari's, so setting up in Safari first spends a till on Safari. Verified in Chrome (Android emulation, through nginx on the local stack): no installability errors for kfc and paragon, each its own `id` and worker scope, the worker controls the page, the start address shows no install help, and with the web server stopped the app opens on **No connection** with no caches. Not tested on a physical Android phone or iPhone. Tests: API `posAppManifest` (new: logo sizes from PNG, JPEG and WebP headers; manifest per restaurant; logo vs UniversalPOS icon; the icon files exist at their declared sizes), `staffAndBranding` (+5: the route's media type and caching; only public fields; a second restaurant never names the first; unknown slug 404; logo icon rules), `routeInventory` (187); web `posApp` (new, 39: links, phone detection, manifest link per slug, worker registration and refusal, install prompt, the worker in a sandbox, nginx locations read from `deploy/web.nginx.conf`, the POS's install help, the dashboard card). API 1,290/1,290 in 68 files, web 348/348 in 39 files; typecheck, lint and the web build clean. **Found, not changed:** `.dockerignore` leaves `frontend/public/brand` out of the web image, so `/brand/katkitchen-mark.jpg` (the mark shown for a restaurant with no logo) is served as the app's HTML in Docker and on Render; the new icons are in `public/app-icons` for that reason. `pnpm postman` has refused since 0085 (no folder for the agent plane), so the collection was not regenerated. |
| 2026-11-23 | **Thermal copies on one strip** (no migration, no API change). Printed through the browser on a roll (2, 3 or 4-inch), the customer, kitchen and counter copies no longer start a new page each -- which made the driver feed a whole paper length, or a new sheet in Print to PDF, per copy. They now follow one another on the strip, parted by a dashed **tear here** line. A5/A4 sheets keep one copy per page. Direct USB/Bluetooth printing was already one after another (a short feed, or the till's cut, after each copy) and is unchanged. Test: web `receipt` (+1). Web 309/309. |
| 2026-11-23 | **Bill headings** (migration 0088, no new route). The title at the top of a bill is now the branch's to choose: **Manager screens → Printed bill → Bill headings**, three boxes -- **Unpaid bill** (default BILL), **Part-paid bill** (PART PAID) and **Fully paid bill** (INVOICE; it was RECEIPT until earlier the same day, when the till's **Print receipt** button also became **Print invoice**) -- with suggestions (INVOICE, TAX INVOICE, CASH RECEIPT, PAYMENT RECEIPT, RESTAURANT BILL ...), one tap for the common paid headings, and **Reset to default**. 1-20 English letters, digits, spaces and common punctuation, refused on the page before Save and by the column CHECK after it (`invariant_refused`; a receipt printer's code page cannot print other scripts). The preview switches between an **Unpaid / Part paid / Paid** example and follows the heading being typed. Saved with the page's Save through `PATCH /admin/branches/:id` (three more allowlisted fields); `POST /pos/bill/:id/print` and `/admin/bills/:id/print` send them as `layout.headings`, read at print time like the footer. **Every print path** uses the one `receiptTitle`: customer and billing counter copies, the browser print and preview, direct USB/Bluetooth ESC/POS, the test page, and reprints from POS and manager Bills (the heading saved now, `· COPY n` the server's count). A Wi-Fi printer gets bills through the print dialog, the same renderer; the server's network path prints kitchen tickets only and is untouched. **Unchanged:** kitchen tickets and KOTs, REPRINT, PARCEL, the copy names, `kind`, copy counts, bill numbers, tax, payments and order status. Tests: API `serviceFlow` (+5: defaults on an existing branch; every malformed heading refused, a cleared one `field_required`; another restaurant cannot set ours (404); custom headings saved, read back and printed with the bill row untouched; the receipt carries the paid heading; a reprint takes the heading saved now and reset restores the defaults), `basicTill` (the layout a print answers now carries the default headings), `reversibility`; web `receipt` (+7), `directPrint` (+1), `printerSettings` (+5). API 1,266/1,266, web 308/308; typecheck and lint clean. **To use locally:** `pnpm db:migrate` (applies 0088) and restart the API. |
| 2026-11-21 | **Bill history, role-based bill editing and day end** (migration 0086, 13 routes). **POS → Bills** (on `bill.view`): every bill of the branch grouped by business day, filters Today / Yesterday / This week / This month / Custom date, search by bill number, `D-n` / `P-n` or pickup name (there is no other order number or customer name), each day's bills, sales, collected, outstanding or refunded and per-method totals; each bill's lines, payments, refunds and edit history (who, when, why, POS or manager edit, under which reopening); Print / Reprint; a status badge **Editable / Locked / Submitted / Manager reopened**. **Edit** (`bill.edit`, till staff): today's bills only, until the day is submitted. An unpaid bill is voided (kept with its number) and reissued under a new number; a paid bill keeps its payment and may only gain items, which go on a supplementary bill the till collects in the normal queue. **Check totals** runs the edit on the server and rolls it back; **Save edit** needs a reason and the shown version. **Submit Day Bills** (`payment.settlement.close`): shows the bill count and totals as the server has them; refused while an order of the day is open or if the figures moved; a second tap returns the same submission; then the till cannot edit that day or void its tenders. **Manager screens → Bills** (`bill.edit.any`, `payment.settlement.reopen`): any day's bills; a submitted day must be reopened with a reason first (the submission is stamped, never deleted); a manager may also take items off a paid bill, which voids the line and records a refund credit note (by the method chosen; a part refund of a bill with two tax rates is refused, as before); a manager can submit any day again. Never changed by an edit: a bill's figures, any tender row, the original lines (removals are void rows, additions are new lines sent to the kitchen). Not supported by an edit: taking a combo or a parcel charge off, a percentage-split bill, adding to a paid bill of an earlier day, emptying a bill. **Decision (separation of duties):** till roles now hold `bill.edit` and `payment.settlement.close` and see branch-wide bills and day totals, so the till can review and close its day; `bill.edit.any` and the reopen are adjustment keys no till role can hold (CLAUDE.md, "Bill history, bill edits and day end"). Tests: API `billHistory` (15: keys and separation, history and search, POS edits of unpaid/paid/previous-day bills, preview writes nothing, stale and repeated edits refused, submit refusals and idempotency, tender void locked, reopen required and reason required, manager refund, resubmission, the submission row immutable, cross-restaurant reads and edits refused), `matrix`, `rawSqlGate`, `routeInventory` (184), `countryChange`, `basicTill` (/me screens); web `billHistory` (6). API 1254/1254 in 67 files, web 291/291; typecheck, lint and the web build clean. **To use locally:** `pnpm db:migrate` (applies 0086) and restart the API; deploy re-seeds the built-in roles with the new keys. |
| 2026-11-21 | **Allow POS Bill Editing** (migration 0087, 2 routes). After **Submit Day Bills** the till is locked out of the day's bills; a manager may now let it edit TODAY's submitted bills again without reopening the day. **Manager screens → Bills**, today's card: an **Allow POS Bill Editing** ON/OFF switch (key `payment.settlement.reopen`, the manager-only key that already guards reopening; no till role can hold it). ON asks a reason (`POST /admin/days/:date/pos-editing/enable`), OFF does not (`/disable`); each is audited (`day.pos_editing.enabled` / `.disabled`) and kept as an `app.pos_edit_grant` row (who, when, why; switched off is a stamp, never a delete). Refused for any day but today (`pos_editing_today_only`) and before the day is submitted (`pos_editing_day_open`, the till can already edit). The grant belongs to the day's current submission, so it is OFF after every Submit Day Bills. **POS → Bills**: today's card says **Bill Locked** or **Editing Enabled by Manager** (who, when); a bill's badge reads Bill locked / Editing enabled by manager; the list and an open bill re-read every 15 s and on focus, so a switch shows without a new sign-in. **Enforced on the server**: `assertMayEditDay` reads the grant under the day lock on every till edit, never cached, so OFF refuses the next save (`bill_edit_day_submitted`); a previous day's bill is refused to the till whatever is switched on (`bill_edit_previous_day`). Every till edit under a grant is a `pos` revision naming the grant and the submission (a CHECK refuses a till edit of a submitted day without one); the bill's edit history shows who allowed it. All existing edit rules hold: reason, server totals, unpaid bills reissued, paid bills only gain items, tenders untouched. **Kept as it was:** a till still cannot void a tender of a submitted day, grant or not; a manager still reopens a submitted day to edit it. Tests: API `billHistory` (+7: only a manager switches it, only today, only after submission, reason required; OFF refuses the till; ON lets it edit and the revision names the grant; OFF again refuses the same signed-in till, twice is a no-op, audit rows, the grant row immutable, the CHECK refuses a grantless till edit; a previous day stays closed with a grant on; resubmission starts OFF; another restaurant's manager cannot reach ours), `routeInventory` (186), `reversibility` (the down run on data with grants used); web `billHistory` (+4: Bill Locked / Editing Enabled by Manager on the till, a change shown on focus, the manager's switch on with a reason and off without, disabled before day end, no switch on a previous day). API 1,261/1,261 in 67 files, web 295/295; typecheck, lint and the web build clean. **To use locally:** `pnpm db:migrate` (applies 0087) and restart the API. |
| 2026-11-18 | **CLAUDE.md split; AGENTS.md is a pointer; GST review pack; web tests safe from either drive spelling** (no migration, no route, UI or API change). **CLAUDE.md** (4,024 lines) moved word for word to `docs/architecture/decision-history.md`, and a new CLAUDE.md (569 lines) states only the current rules and decisions, pointing to the archive for the reasoning; what was dropped is superseded product history (Standard/Pro, the kitchen screen, tablet codes, staff invites, stock control as a live feature, phase write-ups), all still in the archive. **AGENTS.md** (1,311 lines, an older copy of CLAUDE.md, unchanged since 2026-10-03) is now a short entry point for Codex: it names CLAUDE.md as the one source of truth and repeats only the rules an agent must not break. **GST:** `docs/backend/gst-review.md` traces both flows (our invoice to a restaurant; a restaurant's bill to a diner), lists 15 sample cases with the figures the code produces, the assumptions and eight open questions -- among them that the two documents round exactly 50 paise in opposite directions, and that per-line splitting leaves a bill's CGST and SGST totals paise apart (R2: ₹7.06 / ₹7.04). Asserted by the new `backend/tests/tax/gstSamples.test.ts`. Status: **Pending qualified GST review**; no tax rule was changed. **Windows:** a working directory spelled `c:\` loaded two Reacts in the web tests (167 failed); `frontend/vitest.config.ts` now normalises it on Windows only, and `frontend/tests/reactSingleInstance.test.ts` fails if it recurs (verified: fails without the fix from `c:\`, 285/285 with it). The DEFAULT-partition alert now names the recovery script instead of a CLAUDE.md section. |
| 2026-11-18 | **Audit and cleanup 3** (no migration, no route, UI or API change). **Removed:** the `drizzle-orm` dependency (declared, imported nowhere; the query layer is `pg` with hand-written SQL), `isPermissionKey` and `PERMISSION_KEY_SET` (no caller), the platform route registry (`registeredPlatformRoutes`, `resetPlatformRegistry`: written on every platform route and read by nothing; the reset calls in 10 test files went with it), and the re-export of the POS header guards from `routes/pos.ts` (`handlers/pos.ts` now imports `posHeaders.ts` directly). **Fixed:** the `service` F "voids a tender" flake from sweep 2 -- it ordered a capture and its void by two `now()` stamps that can tie; it now orders by `voids_tender_id IS NOT NULL`, the relationship it means. **Docs:** CLAUDE.md, AGENTS.md and this file no longer name Drizzle; CLAUDE.md's code layout says 3 shells, and its streaming section says the only stream went in 0077; README rewritten where stale (product summary, clone URL, migrations to 0085, the in-container migrate path `backend/dist/core/database/migrate.js`, code tree, the documents table, "done/pending" now points at this file, the drive-letter note for web tests); docs/frontend/FRONTEND.md's last open list marked closed by removal; `docs/backend/print-agent-design.md` title no longer says "not built"; the removed `tablet-code` script marked removed in §5.2. **Kept on purpose**, as in sweeps 1 and 2: one repository per tenant table, the retired stock and offline functions (`markSyncedLate`), documented constants, unused exported types and error classes. Tests: API 1224/1224 (65 files, with the statement-mode probe up), web 284/284; typecheck, lint, API build and web build clean. |
| 2026-11-14 | **Unused-code sweep 2, reference-checked** (no migration, no route, UI or API change). Import graph from every entry (3 HTML documents, `server.ts`, every package.json script, `scripts/`, tests) plus every exported name searched across src, tests and scripts; each hit read and its git history checked before acting. Almost everything removed lost its last caller in 0077 (Basic only), which CLAUDE.md records as removed "with their routes, handlers, modules, screens and tests" but which left these behind. **Files deleted:** `modules/authz/membershipGrant.ts` (the membership-grant route went in 0077), web `services/stream.ts` + `api.stream` (the KDS SSE client), `lib/reasons.ts` (the void/comp reason sheet's cache; nothing filled it after 0077, so the sign-out call to `forgetAdjustmentReasons` went too), `app/pos/tokens.ts` (the POS colours live in `pos.css`), `components/ui/select.tsx` (shadcn primitive nothing imported). **Code removed:** duplicates `branchSupply` (`quote.ts` calls `branchTaxTerms` + `restaurantSupply` itself) and `platformPermissionGuard` (`registerPlatformRoute` already applies `platformRoleHolds`); POS kit `PrimaryButton`, `SecondaryButton`, `Field`, `Unknown`, `SectionLabel`, `Refusal`, `Chip`, `MissingRead`, `Stepper` (only `Sheet` is used); `printReceipt`, `fireableLines`, `refusalCode`, `formatQuantity`, `tabletPath`, `amono`; a duplicated `.gitignore` pair. **Kept on purpose** (same rule as sweep 1): one repository per tenant table, the retired stock functions, unused exported types and documented constants (`PRECEDENCE`, `LEASE_DURATION_MS`), the admin palette `a` (the CSS copies cite it), `pricedLines`/`effectivelyFired` (their comments are the only record of the combo-parent `fired_at` hazard), test-only modules (`billing/webhooks.ts`, `platform/money.ts`, `middleware/deps.ts`, `jobs/unattributable.ts`). **Flagged, not changed:** `drizzle-orm` is declared but imported nowhere (the code uses `pg` directly); two `cn` helpers (the `cn` package in 35 files, `lib/utils.ts` clsx + tailwind-merge in 8); unused offline/till methods `api.forgetDevice`, `lease.observeServerNow`, `lease.secondsRemaining`, `pump.kick` (possible wiring gaps rather than dead code). Docs: section 3 tree corrected (no `crm` module, current features/lib/services, migrations to 0085, `print-agent`, 3 HTML entries); CLAUDE.md quote paragraph; docs/frontend/FRONTEND.md §10c. Typecheck, lint and all three builds clean. Tests: web 283/283; API 1222/1224. The two failures are not from this change: `pooling` STATEMENT-mode needs the `stack:probe` container (it failed before the sweep too), and `service` F "voids a tender" is an ordering flake (`ORDER BY tendered_at` with two rows stamped in the same instant), which passed 42/42 on its own. |
| 2026-11-03 | **A manager created from the form can sign in; the Render bootstrap accepts a suffixed database name** (no migration). Provisioning leaves the manager `invited`, and setting their username and password revoked the setup link, the only other way out of `invited`, so their sign-in was refused. Setting the credentials now makes an `invited` manager `active`; a `disabled` manager stays disabled. `scripts/bootstrap-managed.mts` takes `UNIVERSALPOS_DATABASE_NAME` for a name Render suffixed (`katkitchen_fc08`) and still refuses any other database. Tests: API `salesStaffSignIn`. |
| 2026-10-29 | **Direct Bluetooth printing from the till** (no migration, no API change). When the bill printer is set up as USB or Bluetooth on a roll, and the till has connected it, the CUSTOMER / KITCHEN / COUNTER copies, receipts and the Printed bill test page print **straight to the printer** with no print dialog. To connect: POS header → **Printer** → **Connect printer**, then pick the printer's Bluetooth COM port (Web Serial; Chrome or Edge, on https or localhost). The paper carries the same rows as the HTML bill (shared row helpers in `receipt.ts`, `copyLines`) as ESC/POS text in code page 437, 48 columns on 79–80 mm; the kitchen copy is the server's ticket text. Cutting is a per-till switch, off by default. A dropped copy is named ("may be incomplete"), and **Retry** resends the same already-fetched pages: no new bill print, ticket, order or payment. **Use the print dialog** is the fallback. Network printers and the server's 9100 path are unchanged, and the server still never sends to a USB or Bluetooth printer. Not tested on a physical M80 (simulated port only). Tests: web `directPrint` (new: text layout, encoding, bytes, connect, permission, timeout, partial write, retry), `newOrderFlow` (direct print and Retry with no refetch; an unconnected Bluetooth printer uses the dialog). |
| 2026-10-28 | **Receipt printing fits the print head; printer setup guidance** (no migration). A bill on a 3-inch (79–80 mm) roll was laid out 74 mm wide, wider than the 72 mm an 80 mm head prints, so the right-aligned amounts could be clipped or the page shrunk. Rolls now lay out inside the head (`PAPER.printableMm` 48 / 72 / 104 mm, `rollContent`) for bills, copies, the preview and My takings; the roll is labelled "3-inch roll (79–80 mm)". Setup → Printers says the address is for network printers only. The Printed bill page tells a USB/Bluetooth printer to use its USB or Bluetooth COM port in Windows, not a TCP/IP port. New section 5.5 covers the two printing paths, the ATPOS M80 (USB + Bluetooth, no network), Windows USB/Bluetooth setup, browser print settings and troubleshooting. Not tested on an M80 (no unit on the development PC). Tests: web `receipt`, `printerSettings`, `myTakings`. |
| 2026-10-24 | **Bills are paid to the nearest rupee** (migration 0082). Under 50 paise rounds down, 50 or more up: ₹264.49 → ₹264, ₹264.50 → ₹265, ₹264.75 → ₹265, ₹267.50 → ₹268. The bill keeps its total (subtotal + tax, unchanged for GST) and gains **Round off** and **Net payable**; payment, Balance due, the queue, closing an order, the receipt (TOTAL / Round off / NET PAYABLE), the order estimate and My takings all use the payable. Bills still being paid moved onto the rule; any already paid to the rupee (e.g. ₹190 on ₹190.05) are now settled. Paid bills from before keep no round-off. The card round-off added earlier the same day is no longer offered on screen. Tests: API `service` (the four examples, the database refusing a chosen round-off), `basicTill`, `serviceFlow`, reversibility; web `newOrderFlow`, `receipt`, `myTakings`. |
| 2026-10-24 | **Card/UPI round-off.** With Balance due shown to the nearest rupee, typing ₹263 by card on a ₹262.50 bill was refused ("Card is more than the ₹262.50 left to pay"). Now the 50 paise is recorded as round-off on that payment (`tender.rounding_minor`, never sales): the preview shows it, the receipt prints "Round off" under the payment, and the bill settles. Only to the next whole rupee and only when it clears the bill; the server enforces the same rule (`payment_invalid` otherwise). Tests: API `basicTill` 3c, `service`; web `paymentPreview`, `paymentPanel`, `receipt`. |
| 2026-10-24 | **My takings on the POS** (no migration). Staff who take payments get **My takings** in the POS header: Daily / Weekly / Monthly; **Sales Summary** (bills, total sales, tax, transactions, you collected), **Bill Amount** (each bill: number, order, time or date, bill total, what you took), **Item Details** (item, quantity, amount -- e.g. Rice 1 ₹50.00) and **Transactions** (per method, from the recorded payments); **View report**, **PDF**, **Excel (.xlsx)** and **Print** (compact, for the receipt printer). Only the signed-in person's own payments -- the till's X-read; separation of duties forbids reports to anyone who takes money, and managers keep their reports on the manager screens. New key `till.summary.view` (a till key, seeded to Billing staff), new route `GET /pos/my-takings` (161 routes), new reporting module `tillSummary.ts`; PDF via jsPDF, Excel via SheetJS, both loaded only on download. **Every deploy now also re-applies each existing restaurant's built-in roles from the code** (custom roles untouched), so a new permission reaches restaurants that already exist -- before, it reached only new ones and `pnpm reconcile:roles` had to be run by hand. Tests: API `basicTill` 3d (own payments only, a second cashier excluded, totals = the tender rows, periods, refusal for the manager), `tillPeriod`, `seed` (an existing tenant gains the new key on deploy); web `myTakings`, `tillPos`. |
| 2026-10-21 | **Fixed: Printed bill → Save was refused on every real branch** (since 0078). The page sent back the whole branch row, including `code`, `state_code` and `gst_registration`, which `PATCH /admin/branches/:id` does not accept, so the server refused the whole save (`fields_not_writable`) and nothing -- layout, copies or parcel charge -- was stored. The page now sends only the fields it edits. The test missed it because its fake branch had only those fields; it now mirrors the real row and refuses any field outside the route's `editable` list, and fails against the old page. |
| 2026-10-20 | **Parcel charge, and the order's estimate** (migration 0081). Turning on **Parcel** on New order shows a **Parcel charge** box, filled with the branch's usual charge and editable up to its maximum; beside the cart a dashed **ESTIMATE** shows Items, Parcel charge, Subtotal, CGST / SGST (or the branch's heads) and **Payable**, refreshed as items, quantities or the charge change. The figures are the server's (`POST /pos/quote`, the bill's own pricing and tax functions); the screen adds nothing. Confirm saves the charge on the order (`POST /pos/order/:id/parcel-charge`, capped by the branch, under its own idempotency key); it is an order line (`kind = 'charge'`), taxed at the branch's chosen rate, so the bill, payment (Cash, UPI, Card, Other), the GST return, every printed copy and every reprint carry it -- printed as **Parcel charge** above Sub Total, never on the kitchen copy. Managers set the usual charge, the most allowed and its tax rate under **Printed bill → Parcel charge** (default: no charge). Dine-in is unchanged. **CESS is still not built** (decided earlier today). Dish sales reports leave the charge out; the sales summary's net includes it. 160 routes; Postman regenerated. Tests: API `basicTill` 3c (cap and tax-rate refusals, the estimate, CGST/SGST at a registered branch, the whole parcel → charge → kitchen → bill → card payment → receipt → reprint flow, dine-in refused, schema), `routeInventory`, `rawSqlGate`; web `newOrderFlow`, `printerSettings`, `receipt`. Run `pnpm db:migrate` to apply 0081 locally. **Also:** the bill screen keeps a Parcel charge box (Update / Remove) until money is taken -- the unpaid bill is voided and made again with the new charge; after a payment the change is refused (`parcel_charge_after_payment`). A cleared charge is kept as a 0 line (a voided bill references it) and never billed. The board no longer lists voided bills. |
| 2026-10-20 | **Hide or show the copy name on printed copies** (migration 0080, `app.branch.bill_show_copy_label`, default shown). Printed bill page → What the bill shows → **Copy name at the top (CUSTOMER / KITCHEN / COUNTER)**. Off hides the name on every copy; a reprint still prints **REPRINT** and a parcel still prints **PARCEL**. Returned in the print route's `layout.show.copyLabel`; an older answer without it prints the name. Tests: API `basicTill` 3b; web `receipt`, `printerSettings`. |
| 2026-10-20 | **Shorter labels at the top of every printed copy.** Copies: **CUSTOMER**, **KITCHEN**, **COUNTER** (were "CUSTOMER COPY", "KITCHEN COPY - hand to the kitchen", "BILLING COUNTER COPY - keep at the counter"); a reprint adds **· REPRINT**. Bill title: **BILL**, **PART PAID**, **RECEIPT**, with **· COPY n** on a counted reprint (were "PART-PAYMENT RECEIPT" and "- REPRINT (copy n)"). Parcel banner: **PARCEL** (was "PARCEL / TAKEAWAY"). Words only -- what prints, when, and the reprint count are unchanged. The server's network kitchen ticket keeps "*** REPRINT -- NOT A NEW ORDER ***". Tests: web `receipt`, `newOrderFlow`. |
| 2026-10-20 | **Tax split shown on the Tax rates page and the food item form** (no migration; billing unchanged). Each tax rate now shows what it prints as on a bill -- **CGST 2.5% + SGST 2.5%** within the state, **IGST 5%** across states; Exempt shows "No tax on the bill" -- in a new **On a bill** column on Tax rates and under the **Tax** picker on the food item form. Read from the new `GET /admin/tax-splits` (key `tax.class.view`, audit none), computed by `headRateBps`, the same function the bill uses (factored out of `splitHeads`). **Decided with the owner:** one GST rate per item stays; CGST / SGST are not typed (two inputs could be unequal and cannot express IGST), and **CESS is not built** (restaurant service carries no cess; confirm with the GST filer before adding one). 158 routes; Postman regenerated. Tests: API `taxClassSurface` (split per class, follows a rate edit, archived not offered, permission), `routeInventory`, `rawSqlGate`; web `taxSplit` (new). |
| 2026-10-20 | **POS payment panel: compact, with a live preview** (no migration, no API change). Card / UPI / Other / Cash are one short row each (label, amount box, Full / Exact); the per-row amount and the slip / transaction-id box are removed, so payments go without a `reference` (optional on the server). Under the boxes a dashed **PREVIEW** updates as the cashier types: each method as applied, **Added**, **Balance after this payment**, and **Change to return**. It is one pure helper, `previewPayment` in `frontend/src/lib/money.ts` (integer minor units), mirroring `takePayment`: non-cash first, each **refused, not capped**, above what is left (the preview says so); cash pays the rest; the excess is change. After Add payment the server's answer replaces it. See docs/frontend/FRONTEND.md §3. Tests: web `paymentPreview` (new), `paymentPanel`, `moneyGate`, `newOrderFlow`. |
| 2026-10-17 | **A full payment completes the order; the queue says how much is paid.** The payment that clears the last bill closes the order (same `DELETE /pos/session/:id`, key and lease; Complete payment stays as a fallback; the change stays on screen). `GET /billing/queue` answers `payment: none \| part \| full`, so the Orders board shows **Unpaid**, **Part paid** or **Paid** (with **Complete**) instead of calling every billed order "Part paid"; the side tab is **Billed**. A paid order closed today is listed in today's Completed whatever day it started (a cancelled leftover still leaves). Tests: API `serviceFlow`; web `newOrderFlow`, `ordersBoard`, `tillPos`. |
| 2026-10-16 | **Staff Login: staff cards, then a 4-digit PIN; the Sales person sets every sign-in.** Manager page `/{slug}` (username + password) has **Staff Login** top right, opening `/{slug}/pos`: the till's staff as cards, tap a name, type the PIN on a keypad (auto-sign-in on the 4th digit), then the POS. Manager login on that screen is the same username-and-password form; a browser that is not a till shows it (only the manager makes a till). The Sales person creates staff with username, password and PIN, resets PINs, and sets the manager's username and password (create restaurant asks for them). No `?to=pos`. Migration 0079 (revoke all PINs) was written in an earlier step and removed before deploy. Tests: API `salesStaffSignIn`, `basicTill` 4-6; web `staffPin`, `oneLogin`, `tillPos`, `staffSignIns`. 157 routes. |
| 2026-10-16 | **One till sign-in for staff and the manager; printing after payment; printer and paper settings** (migration 0078). Till: a card per staff member and one unnamed **Manager** card, then username + 4-digit PIN for both; a tapped name and a typed username must be the same person; the public list never names a manager. The manager sets their own username and PIN on **POS Access** (`POST /admin/access/me/pin`, current password required). The Sales person's staff list now shows each username. **Confirm order prints nothing**; the copies print once the bill is paid in full (automatically, or through the new print preview), and every Reprint goes through the preview. **Printed bill** page: bill printer, printer type then paper (2/3/4-inch roll, A5/A4 portrait or landscape), margins, font size, what the bill shows (logo, address and phone, customer name, tax breakdown, payments), which copies print, automatic or manual printing, live preview per copy, test print. Item notes on the POS and the food item description in Setup are folded behind a **+**. Tests: API `tillSignIn` (new), `basicTill` 3b; web `staffPin`, `newOrderFlow`, `receipt`, `printerSettings` (new). 157 routes. |
| 2026-10-13 | **Persistent-storage warning fixed.** The browser's answer to `navigator.storage.persist()` arrives after the POS first draws, and nothing redrew the warning, so "This tablet has not been granted persistent storage…" could stay up after storage was granted. Now `persisted()` is checked first, the answer is announced and the banner follows it, and a refused till offers **Keep this till's work safe** / **Ask again** (asked from a tap). Refusals and missing APIs are handled without errors; queued work is never dropped. Test: web `storageDurability`. |
| 2026-10-13 | **Three printed copies on Confirm**: CUSTOMER, KITCHEN (hand-carried to the kitchen) and BILLING COUNTER, one print dialog, labelled; PARCEL / TAKEAWAY on every parcel copy; per-copy Reprint (customer/counter = counted bill print marked REPRINT; kitchen = the ticket read again, no new job or ticket). Tests: web `receipt`, `newOrderFlow`; API `basicTill` 3b. Note: a configured network kitchen printer still gets the server ticket too. |
| 2026-10-13 | **One POS screen** (no Dine-in / Parcel / KOT tabs). New order → Confirm sends to the kitchen and opens the bill → payment → printed receipt. Parcel switch, optional name, per-item note; fixed per-step idempotency keys, an in-flight guard and a locked cart make Confirm safe to retry. Deleted Floor, Order, Parcels, KotBoard, KitchenTickets, TableActions, Adjust (and kitchenFilter / lineStates tests). Tests: web `newOrderFlow` (new), `tillPos`; API `basicTill` 3b (the exact POS sequence, ticket text, part + mixed payment, receipt, close without pickup). |
| 2026-10-12 | **Basic only; staff sign in by name + 4-digit PIN; the Sales person manages staff** (migration 0077, section 5.2c). Dev DB backed up first; kfc and paragon moved to Basic with their data; Standard and Pro retired. Removed the kitchen screen, the separate KOT/Billing apps, tablet setup codes, staff invites and the manager's staff management. New: the PIN keypad, `GET /api/public/restaurants/:slug/till/staff`, the Sales person's staff routes and panel. Tests: `salesStaffPins` (new), `basicTill`, `serviceFlow`, `planGates`, web `staffPin` (new). 156 routes. |
| 2026-10-10 | **One login page with role-based landing; the manager creates staff logins** (migration 0076). `/{slug}` for everyone; `lands` from the login response; staff go to the POS signed in on the till (`POST /api/auth/:slug/till`, which now also registers a Basic till); `POST /admin/staff/accounts` (username + password); removed `/admin/till`, `/admin/till/:id/session`, the POS's own till sign-in screen, and the Sales person's staff routes and screen. Tests: `basicTill`, web `oneLogin`, `basicPos`, `tillPos`. 170 routes. |
| 2026-10-10 | **Basic without tables** (migration 0075; its Sales-person staff management was reversed by 0076). Plan features `tables`, `staff_admin`; dine-in numbered at the counter (D-n); Sales person creates/edits staff with username + password, changes usernames/passwords, switches accounts off/on, within the 4-user limit; staff sign in at the till with username + password (`POST /api/auth/:slug/till`); Basic's manager area loses Staff, Roles and the floor plan. Also 0074: no setup codes on Basic, one `/{slug}/pos` link, a KOT tab. Tests: `basicTill` (the whole Basic flow), `planGates`, web `basicPos`, `tenantStaff`, `tillPos`. 176 routes. |
| 2026-10-10 | **A restaurant's address can change, and the old one keeps working** (migration 0073). Super Admin: Edit restaurant → Slug (restaurant address), live availability check; `POST /api/platform/tenants/:id/slug`, new key `platform.tenant.rename` (Super Admin only), audited `tenant.slug.changed`. The old slug resolves everywhere a slug is read (sign-in, tablet and staff setup codes, `/{slug}`, the logo) and can never be taken by another restaurant (enforced in the database, race-safe); the restaurant may take it back. The browser moves what it stored under the old slug and opens the same screen at the new address, from either address. Verified in a real browser: a till opened at its old address after the rename landed on the new one still set up; the old admin address redirected. **Also fixed, found by that run:** a shift whose refresh had lapsed showed "the floor has not loaded" on every panel instead of returning to sign-in; the tenant API client now announces a refused refresh (`onSessionEnded`) and every tenant shell returns to its sign-in. Tests: `restaurantAccess` (rename, old address, old sign-in and setup code, no squatting by rename or create, database refusal, take-back, refusals, concurrent renames), web `slugMove`, `slugRename`. 168 routes. |
| 2026-10-10 | **Unused-code sweep, reference-checked** (every exported name searched across src, tests and scripts; every unimported file; each hit read before acting). **Wired, not deleted:** `auth_attempt.purge` -- the 30-day sign-in telemetry purge existed since 0046 and no job ran it, so nothing was ever removed; now nightly 03:50 (owner, self-verifying: fails if an expired row survives; run once, 0 rows to purge). `forgetAdjustmentReasons` is now called on POS sign-out, the hook it was written for. **Removed:** outbox `markFailed` (an unbounded retry the worker's own bounded, dead-lettering retry replaced -- a trap if called), `assertTenantInBook` (duplicate of `lockTenant`, which scopes every Sales tenant write), `allocateComboDiscount` (a combo parent cannot be discounted; components are, each at its own tax rate), `emitFromPool`, `recentUnattributable`, `isRefreshToken`, `newLeaseId`, web `hasValue` / `mapRemote`, and five shadcn primitives nothing imported (alert-dialog, separator, tabs, toggle-group, toggle). **Kept on purpose:** one repository per tenant table (a stated design), the retired stock-control functions (`cogsForPeriod`, `markSyncedLate`; the module is deliberately kept), unused exported types and documented constants. Checked and found sound: Sales Person scope on every tenant write; tenant deactivate/reactivate is billing / Super Admin only. |
| 2026-10-10 | **The money gate docs/frontend/FRONTEND.md promised now exists** (`frontend/tests/moneyGate.test.ts`): no `/ 100`, `* 100` or arithmetic on a `minorFrom()` result outside `lib/money.ts`; CSS percentages and basis-point lines are recognised per line. It found and fixed: the console's money formatter (now `formatMinorWhole`), platform Billing and the plan editor dividing by 100, the POS discount parser and the setup price helpers (now the money module's `minorFromTyped` / `typedFromMinor`), and Billing's New order summing a cart total on the client (removed: "the total, with tax, is worked out on the bill"). |
| 2026-10-10 | **"Your own PIN" removed; the bundle gate reads what ships.** The owner's till replaced the own-PIN panel on every plan, so the panel, `POST /admin/access/me/pin` and `issueOwnPinSetup` are gone (167 routes); PINs already set keep working. The Basic/Standard flow tests now reach the counter through the till. `tests/web/bundleSeparation.test.ts` follows each entry's built imports instead of matching chunk names -- it had missed the Billing workspace hoisted into a shared chunk -- and now asserts the decided split: KOT ships the Billing workspace (the owner's till), the kitchen screen loads no money code, Billing ships no KOT order taking. |
| 2026-10-09 | **Basic as one person's POS** (migrations 0070–0072; committed locally, not pushed). Owner's till on `/{slug}/kot`: email + password, no setup code or PIN, Dine-in · Parcel · Billing tabs on one sign-in (`POST /admin/till`, `POST /admin/till/:id/session`, `GET /me` `screens`). Payments in parts, mixed methods and cash change (`POST /pos/bill/:id/payment`, `cash_received_minor`), PART-PAYMENT RECEIPT / RECEIPT. `users` plan limit (Basic 4 / Standard 8 / Pro 25). Clean new slugs (`tenant_slug_clean`). Tests: backend `basicTill` (till, both flows on one sign-in, refusals, tablet and user limits incl. a race), `service` F2, `serviceFlow` 3e, `restaurantAccess` (slug race, hyphens); web `tillPos`, `paymentPanel`, `receipt`, `slugRules`. Verified in a real browser against the test database: till sign-in, three tabs, `/billing` → `/kot#billing`, the tablet-limit message, sign-in kept across a browser restart, and a dine-in order (2 dosa + coffee) sent, handed over, billed at ₹294 and paid by card ₹100 + a ₹500 note (cash applied ₹194, change ₹306); a second bill part-paid (UPI ₹200 + cash ₹50, ₹44 due). |
| 2026-10-09 | **Tests have their own database.** `katkitchen_test`, on the same Postgres, set up by the same `01_database.sql` (it now names the database with `current_database()`, so one file serves both), reached through the same roles and the same pooler (both PgBouncer configs list it). `vitest.config.ts` re-points every `DATABASE_URL_*` at it (`TEST_DATABASE_NAME` overrides); `tests/hooks/globalSetup.ts` runs migrate, seed and partitions on it before each run and refuses to run against `katkitchen`. Create once with `corepack pnpm db:test:create` (fresh volumes create it at init). Verified: a full run (1151 tests) left the dev database at the same 3 restaurants. |
| 2026-10-02 | **Kitchen ticket (KOT) carries a full header.** The printed KOT and the KOT screen's "Print on this tablet" copy now show: restaurant name, **KOT #n** (with **send n** for later sends to the same order), date and time in the branch's timezone, table(s) + covers or **PARCEL P-n name**, waiter (who sent it), kitchen name, then qty x item with **add-ons cooked with the dish** (`+ Extra Raita` -- previously missing from paper, though the kitchen screen showed them) and notes (`* Less spicy`), and an item count. No prices. 32 columns, so it fits 58 mm and 80 mm rolls. One loader (`loadTicket` in `kitchen/printWorker.ts`) feeds both the network printer and the tablet copy, so they cannot differ. Reprint and fallback banners unchanged. Test `serviceFlow` 3. |
| 2026-10-02 | **Printed bill and receipt** (migration 0069). Billing screen: **Print bill** once a bill exists, **Print receipt** once paid -- opens the tablet's print dialog, laid out for an 80 mm thermal roll (any USB/Bluetooth/Wi-Fi printer the tablet can reach). Shows restaurant name, address, phone, GSTIN, BILL/RECEIPT title, bill no., date, table(s) or parcel no., covers, start/end time, waiter and cashier, qty / item / rate / amount with add-ons and any comp or discount, sub total, tax heads (CGST/SGST or IGST from the bill's stamped treatment, `Tax n%` when the branch never stated its GST position), TOTAL, how it was paid (receipt only) and a footer. Built server-side from the bill's own snapshots by `POST /pos/bill/:id/print` (key `bill.reprint`, audited, lease-exempt); every copy is counted, so a second copy prints as **REPRINT (copy n)**. New admin page **Printed bill**: phone, address on the bill and footer per branch, with a live preview drawn by the same renderer. Also fixed: an idempotency claim from a sign-in with no branch stored `''` in a uuid column and answered `400 field_malformed` (now null). 165 routes; tests `serviceFlow` 3d, web `receipt`. |
| 2026-10-02 | **Yesterday's orders no longer get stuck; managers can cancel an order** (migration 0068). The Billing queue and the parcel list filtered to *today's* business day, so an order handed to Billing but not paid before the day ended disappeared from Billing while its tables stayed taken on the KOT floor -- nobody could bill or free them. Both lists now show every order still open from any day (plus today's finished ones), each marked **from {date}** when left over (`leftover`, computed by the server). New admin page **Open orders** (`GET /admin/sessions/open`, key `order.view`): every open order, any day, oldest first, with **Send back to KOT** (wires the existing reopen route, which had no button) and **Cancel order** (`POST /admin/sessions/:id/cancel`, new financial key `order.cancel` for owner, Restaurant Admin and manager; an adjustment key, so never with the till). Cancel needs a written reason, is refused once any money has been taken (`409 order_has_payment` -- that is a refund), voids unpaid bills, stops kitchen lines still cooking, marks the order `cancelled` (excluded from sales reports) and frees the tables; stock deducted at send stays deducted. A cancelled order shows as **Cancelled** in Billing's Completed tab and on the parcel list. 164 routes; tests `serviceFlow` 3c, `matrix`, route count. `reconcile:roles` run to give existing restaurants the key. |
| 2026-10-01 | **Local database reset, no dummy data.** Schemas `app`, `platform`, `migration` dropped and rebuilt from all 67 migrations; Redis flushed; `db:seed` run; one Super Admin (`superadmin@universalpos.example`). Removed: 340 test restaurants, 120 test platform users (incl. Sales Person `hashim@`), 32 probe plans. It now holds exactly: the Super Admin, plans **Basic / Standard / Pro**, the permission catalogue -- 0 restaurants. `db:seed` now also seeds the three plans (`ensureStandardPlans`, idempotent, never re-prices; exits non-zero if one is missing), so a fresh database or deploy has them without `seed:dummy`. The `api` and `web` containers were rebuilt (`docker compose up -d --build api web`) -- they run built images, so code changes need a rebuild. Owner's rule: no dummy data; they create their own. |
| 2026-10-01 | **Three plans; KDS and branches decided by the plan** (migration 0067, replaces 0066's per-restaurant switch). **Basic** and **Standard**: KOT, printed kitchen tickets, Billing, one branch, no KDS. **Pro**: adds the kitchen screen and up to 3 branches. The Sales Person picks only the plan — the "KDS Required?" question and `kdsEnabled` field are gone (`KdsChoice.tsx` deleted, `platform.tenant.kds_enabled` dropped). `kds` is a plan feature in `ENTITLEMENTS`; the six KDS routes answer `402 upgrade_required` naming Pro on Basic/Standard (no more `409 kds_not_enabled`); branch create answers 402 past the plan's `branches` limit. Admin menu, Staff screen (KDS type hidden, not disabled) and tablet links read the same entitlement. Without KDS, KOT marks food ready (unchanged). Plan changes move both: upgrade at once, downgrade at period end. Tests: `planGates` (three-plan matrix, Basic→Standard→Pro→Standard→Basic), `serviceFlow` 6b (Basic and Standard full KOT→print→ready→bill), web `kdsByPlan`. |
| 2026-10-01 | **KDS optional per restaurant** (migration 0066) — *superseded the same day by 0067*. Create restaurant asks **KDS Required? Yes / No** for a plan with KOT (required, no default; hidden on Basic); Edit restaurant can change it (republished at once). Stored as `platform.tenant.kds_enabled` (existing restaurants: `true`, unchanged), published as `features.kds`; the six kitchen-screen routes gate on it (`409 kds_not_enabled` when off). **Without KDS**, KOT's Kitchen tickets panel shows **Mark ready** → **Ready** (`POST /pos/kot/:id/ready`, new key `kot.ready` for KOT Staff, manager, Restaurant Admin, owner), so the floor and parcel hand-over work with no kitchen screen; refused where a screen runs. Admin hides KDS staff and KDS tablet links when off. 162 routes; tests in `planGates`, `serviceFlow`, `kdsOptional`. |
| 2026-10-01 | **A table whose lease expired can be picked up again.** `claimLease` treated an expired-but-unreleased lease as held: the same tablet was sent to renew it (`409 lease_not_held`, "no live lease to renew") and any other tablet was told it was held, so "open, unheld — tap to pick it up" could only be cleared by a manager's force release. A claim now closes the expired row and starts a NEW lease with a new token (work queued under the old token stays refused); a live lease is unchanged. `offlinePos` tests. |
| 2026-10-01 | **KOT menu kitchen filter**: an "All kitchens / {kitchen}" select beside the KOT order screen's Menu heading, shown only when the branch's menu spans more than one kitchen; narrows the items shown, nothing else. The menu read (`menu/read.ts`, shared by the board and `GET /pos/menu`) now returns each item's `kitchen_station_id` / `kitchen_name`, resolved exactly as `kitchen/fire.ts` routes (branch routing exception, else the branch's active station for the item's code). Combos route per component, so they show only under All kitchens. `kitchenFilter` test. |
| 2026-10-01 | KOT/Billing tablets forget a lease the server refuses to renew with `lease_not_held` (expired, released, or a session no longer in the database) instead of renewing it every minute forever — the repeating `409` on `/pos/session/:id/lease`. Offline and every other failure still keep the lease; queued work still carries its own token. `leaseRenewal` test. |
| 2026-09-30 | **Super Admin at `/superadmin`**, one address per menu (`/superadmin/dashboard`, `/restaurants`, `/sales-persons`, `/plans`, `/billing`, `/staff`), reloadable, Back-able, unknown section → dashboard. Same `platform.html` document and components — no copy; nginx and Vite route `/superadmin[/section]` to it. `superadmin` reserved (`SUPERADMIN_SEGMENT` in `@universalpos/shared`). Sales Person and other platform roles unchanged at `/platform.html`. Tests in `areas`, `platformLoading`, `adminNavigation`, `restaurantAccess`. |
| 2026-09-30 | **Loading skeletons everywhere**: the restaurant admin, the KOT/KDS/Billing tablets and now the Super Admin and Sales Person console show skeletons shaped like the content while it loads, inside the shell (sidebar, branding and sign-out stay). A skeleton appears only while a read is out; a failed read shows its message and an empty list its empty text. No artificial delay: the skeleton is painted only once a wait passes 150 ms, so fast reads never flash it. Shared shapes live in `components/ui/skeleton.tsx`, admin ones in `components/admin/skeletons.tsx`, console ones in `components/platform/skeletons.tsx`. 57 web tests. |
| 2026-09-30 | **Console tables: search, filter, 10 per page**: Platform staff (search name/email/role, role + status filters), Sales persons (search name/email/phone, status filter), Billing's dunning queue (search restaurant/invoice) and invoice ledger (search number/restaurant, status filter beside *Overdue only*) now show 10 rows a page with the shared pager. One hook, `useClientTable` + `TableToolbar` in `components/platform/Pagination.tsx`, filters the list the server already returned and resets to page 1 when the search or a filter changes. Restaurants already had this. |
| 2026-09-29 | **Who is signed in, on every screen**: a badge in the KOT, KDS, Billing and admin headers shows name · role and staff code (or email) · branch · tablet; tap it for every role and branch held. Read from new `GET /api/t/me` (key `user.self.view`, added to every built-in role by derivation, not per role), which answers only for the verified token. Access tokens now carry `device_id` so the badge can name the tablet. 159 routes; 1120 backend tests. |
| 2026-09-29 | **Basic: Billing accounts take orders**: new system role `counter` (**Billing & Orders**) = Billing Staff + open an order/parcel, add items, hand over; no kitchen send, no report or adjustment key. The Staff screen's **Billing** account type uses it on Basic and `cashier` (Billing Staff, bills only) on Pro. Billing Staff on Basic was refused 403 at New order. Access list's KOT badge now means *sends to the kitchen* (`kot.fire`). 1118 backend tests. |
| 2026-09-29 | **Tablet sign-in after "Take out of use"**: a PIN from a tablet the server does not know (taken out of use, or set up against a database since reset) now answers `tablet_not_set_up` instead of the uniform `authentication_failed`; KOT, KDS and Billing then forget the stale tablet identity and return to "Set up this tablet" with an explanation. A setup code typed into the staff-code box is caught with its own message. Wrong staff code / wrong PIN stay indistinguishable. Test in `serviceFlow`; 1117 backend tests. |
| 2026-09-29 | **Persistence verified, two restart defects fixed**: database reset again after the test run; a restaurant, KOT/KDS/Billing staff, setup and one paid order created through the API behind nginx, read back after restarting every service and after restarting Postgres alone. Browser storage audited: it holds only sign-in, tablet identity, leases, the offline queue and the KDS screen's own notes — no business data. Fixed: an idle pooled connection dropped by Postgres crashed the whole API (pools had no `'error'` listener); the KDS LISTEN connection stayed dead after a drop (now reconnects with backoff); a sign-in with no branch on a tablet route answered 500 (now 422 `branch_scope_required`). Tests `kdsListenerReconnect` and a service-flow case. |
| 2026-09-29 | **Local database reset**: schemas `app`, `platform`, `migration` dropped and rebuilt from all 65 migrations; base catalogue seeded; one Super Admin (`superadmin@universalpos.example`); plans Basic and Pro; Redis cache flushed. All test, demo and dummy restaurants, users and orders removed. |
| 2026-09-29 | **Staff accounts and kitchen printing** (migration 0065): Create staff by account type (KOT / KDS / Billing) with an Account ready screen; Access page filters; Chef role retired; KDS picks its kitchen from a list (`kitchen.station.view` for KDS Staff); network printer transport (ESC/POS over TCP) in the print worker; KOT order screen shows kitchen tickets with printer status, Print again and Print on this tablet (`GET /pos/order/:id/tickets`, `kot.reprint` for KOT Staff); `/{slug}/pos` redirects to `/{slug}/kot`; 1114 backend tests passing; Postman 158 requests. |
| 2026-09-26 | Restaurant operations flow: join/unjoin tables on one party (one order, one bill), guest count edit, parcel/takeaway orders (numbered per day, pickup name, derived status New→Preparing→Ready→Picked up→Completed, hand-over refused until the kitchen is done), kitchen tickets show Dine-in tables or PARCEL P-n, send number ("Additional · send 2"), add-ons and notes; POS Dine-in / Parcel tabs, floor selector, floor cards with amount, joined label and kitchen status; tablet setup code from the admin (POS & KDS Access → Set up a tablet); POS/Kitchen access derived from role permissions; closing a table now releases it (5 stuck tables repaired); migration 0063; `serviceFlow` tests; Postman 196 requests. |
| 2026-09-29 | **KOT + Billing product model** (migration 0064): order stage KOT → Billing enforced in the domain (ready-for-billing, stage-aware lease claims, reopen), Billing app at `/{slug}/billing` with its own theme and queue, Basic bills directly (New order), KOT app at `/{slug}/kot`; plans Basic + Pro only (Max retired, restaurants moved to Pro, `kot` feature); roles KOT Staff / Billing Staff; stock, purchasing, suppliers, recipes, customers, GST registration removed; own-PIN link; tablet codes per branch; seed, Postman and tests updated (1104 passing). |
| 2026-09-26 | POS/KDS sign-in refusal banner readable on the dark kitchen theme (tinted background instead of a fixed pale pink that hid the light text). |
| 2026-09-25 | POS & KDS Access screen: list sign-ins, reset PIN/password by one-time link (`app.credential_setup`, migration 0062), switch staff off/on, with authority checks; `/admin/access` routes; `accessFlow` tests. |
| 2026-09-25 | POS/KDS per restaurant at `/{slug}/pos` and `/{slug}/kds`: restaurant looked up from the address, branding applied, tablet storage scoped per restaurant, codes for another restaurant refused; `tablet-code` script. |
| 2026-09-25 | Manager setup flow: floors, floor types, tables, printers, kitchens (with printer + Food/Beverage), categories, food items (barcode, prep time, add-ons, combos) and add-on groups — create/edit/archive routes, guided Setup page with popups and required marks; migration 0061; `setupFlow` tests; Postman 186 requests. |
| 2026-09-25 | Console shows only the three plans (Basic, Pro, Max) on the Plans page, dashboard and every plan picker, via `standardPlans()` over the shared `PLAN_KEYS`; probe plans the test suite leaves in a dev database are no longer offered. |
| 2026-09-25 | New onboarding flow: restaurant address/logo/theme colour (console create + edit, public logo route, admin theming); staff invites with self-set PIN/password (`POST /admin/staff`, `POST /api/auth/staff-invite/accept`), Staff screen, Chef role; branch-less owner can name the branch for a role; admin add/edit in popups with required-field marks derived from NOT NULLs; migration 0060; `staffAndBranding` tests. |
| 2026-09-25 | `scripts/seed-dummy.mts` (`corepack pnpm seed:dummy`): 10 dummy restaurants across Basic/Pro/Max with menu, staff, stock, suppliers and recipes via the real tables; two Sales Persons recreated. |
| 2026-09-25 | Postman collection + local environment in `docs/api/postman/`, generated from the route table by `corepack pnpm postman` (150 requests, sample bodies and token auto-save on the main flows). |
| 2026-09-24 | Plan-based entitlements: shared `ENTITLEMENTS` + `getAdminMenu`; route-level `plan` gates (402 `upgrade_required`); branch and tablet limits; admin sidebar gated by plan, new Suppliers/Recipes sections; console plan editor for all keys; entitlement documents now published at provisioning and on every plan switch, cache refilled from the database on a miss; migration 0059 backfill; `planGates` tests. |
| 2026-09-24 | Setup link now ends signed in to the new restaurant and opens `/{slug}`, instead of falling back to whatever restaurant session the browser already held. |
| 2026-09-24 | Restaurant URL `/{slug}` with its own sign-in and 404 for unknown slugs; auto slug + live availability + exact duplicate message; reserved slugs; optional legal name; post-creation shows URL + login email (no password); post-sign-up password reset via new setup link with required reason (migration 0058); admin CRUD returns 404 for rows outside scope; new `restaurantAccess` tests (cross-restaurant login, token scope, cross-restaurant edit). |
| 2026-09-24 | Added fresh-clone setup steps and the `brandm` remote (brandmsystems/katkitchen); verified a clean clone installs, typechecks, lints, builds and passes the gate tests. |
| 2026-09-24 | Root cleaned: removed `_to_delete/`, `APPLY_PENDING.md`, `APPLY_PHASE9.md`, `COMMIT_MESSAGE.txt`; the unmerged Phase 10 notes (`add4-claude.md`, `add4-frontend.md`) were merged into CLAUDE.md (Phase 10) and docs/frontend/FRONTEND.md (§10d) first. |
| 2026-09-24 | Restructure stage 3: frontend into `app/` (4 shells), `features/` (per-app subfolders), `components/`, `services/`, `lib/`, `hooks/`, `types/`, `styles/`; `packages/eslint-config` with ESLint on api and web (lint clean; it found a collision test that checked 4 of the 11 handler maps it imported). |
| 2026-09-24 | Restructure stage 2: backend into `core/` (database, errors, middleware, security), `modules/` (18 domains incl. platform, authz, notifications) and `routes/`; imports and gate paths rewritten; the thin-handler gate now scans everything outside the domain roots (fails closed); new gate: every file a package.json script runs must exist. |
| 2026-09-24 | Restructure stage 1: monorepo layout — `backend`, `frontend`, `shared`, `packages/tsconfig`; Dockerfiles, crontab, scripts and test gates repointed; shared `EXPIRING_WITHIN_DAYS`; crontab paths now verified by a test; stale bundle-separation markers replaced. |
| 2026-09-24 | Committed and pushed the control-plane / sales work (§5.2) to `origin/amruthesh`. |
| 2026-09-24 | Created this document. Covers Phases 0–23 plus uncommitted control-plane work: plans redesign, restaurant management, deactivation, sales persons, sales dashboard, setup links, renew, change plan, profile & password change, security fixes, migrations 0055–0057. |
