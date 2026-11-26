# Project: Multi-tenant Restaurant POS SaaS (UniversalPOS)

**This file is the single source of truth for project rules**, for Claude Code and
for every other agent (`AGENTS.md` points here). It states what is true and binding
NOW. The reasoning behind each rule -- the defect that forced it, the alternatives
rejected, the sections since superseded -- is in **`docs/decision-history.md`**
(the archive of this file to 2026-11-18). Search it by the heading named in
*(history: ...)* when you need the why. Where the two disagree, this file wins.

Code comments and migrations older than 2026-11-18 that say "see CLAUDE.md" mean the
passage now in `docs/decision-history.md` (migrations are checksummed and cannot be
re-worded).

Companion documents: `FRONTEND.md` (client rules), `universalpos.md` (current status,
local credentials, printers, change log), `README.md` (setup and commands),
`docs/` (deploy, billing terms, print agent, scheduler, GST review).

---

## What the product is today

**Only the Basic plan is sold (0077).** Standard and Pro are retired plan versions,
never deleted. One restaurant runs:

- **Restaurant manager** screens at `/{slug}` (username + password), including Bills
  (any day's bills, manager edits, reopen and submit a day).
- **The POS** at `/{slug}/pos` (`/{slug}/kot` and `/{slug}/billing` serve the same
  page): one screen -- New order, then the bill and payment -- plus Bills (history,
  today's edits, Submit Day Bills).
- **Control plane** at `/superadmin` (Super Admin) and the Sales console.
- **Print agent** (`print-agent`): an on-premises Node script that prints
  kitchen tickets to Wi-Fi/Ethernet printers (0085).

Removed, with their routes, handlers, screens and tests: the kitchen screen (KDS,
SSE stream), the separate KOT and Billing apps, tablet setup codes and enrolment,
staff invites, staff management on the manager screens (0077); stock, purchasing,
suppliers, recipes, customers/loyalty screens (0064). **Their tables and permission
keys stay** -- rows are records, and separation-of-duties rules are written in the
keys. Retired keys are listed in `KEYS_WITHOUT_ROUTES`.

---

## Business types (0089, 2026-11-26)

UniversalPOS serves more than restaurants; a restaurant is the one type with a
complete workflow today.

- **The registry is the one definition** (`shared/src/constants/businessTypes.ts`):
  per type, its words (`terms`), the manager sections it shows (`nav`, a subset of
  `ADMIN_SECTION_KEYS`), their titles, its modules and its theme. The API and every
  web client read it; **no screen branches on a type's name**.
- **The database stores only the key**: `platform.tenant.business_type`, text + CHECK,
  default `restaurant` (every tenant before 0089). A test asserts the CHECK lists
  exactly the registry's keys. A table copy of the registry is not built.
- **`status`** is what a type can honestly do: `available` (own workflow end to
  end: restaurant), `preview` (selectable, runs on the shared order flow: general
  retail), `planned` (defined, cannot be selected). `selectableBusinessTypes()` is what
  every picker and `checkedBusinessType` accept; a planned type is refused by name
  (`business_type_unavailable`).
- **Control plane only.** Provisioning (`POST /tenants`) and the tenant edit
  (`PATCH /tenants/:id`) take `businessType`; no tenant request names it. The type is
  **fixed once the business has taken an order** (`business_type_locked`, counted
  from `app.table_session`). The create form has no preselected type, as it has no
  preselected country.
- **What follows the type today:** the manager sidebar (sections, order, titles),
  the accent colour (a colour the business chose itself wins; `null` = the product's
  own, which is a restaurant's) and the corner radius (`data-radius`, from
  `styles/business-themes.css`). **Not yet:** the words inside screens and the POS
  checkout stay restaurant-shaped until a type's own workflow ships.
- **`workflow`** (`kitchen_order` | `counter_sale`) picks the shape of the till's order
  screen; the screen reads it from the registry, never a type's name. `counter_sale`
  is `NewOrder` without table, parcel or kitchen, with a scan box (Enter adds the
  barcode that matches exactly, or the one product a name matches).
- **Item kind `product` (0090)** is a thing sold over a counter and never cooked: no
  station (the routing CHECK is unchanged -- a station exists exactly for `single`),
  no kitchen ticket. `fireOrder` skips product lines (and stamps them sent with the
  rest), `markReadyForBilling` does not count them unsent, and **void, comp and
  discount may act on an unfired product line** (a dish still must be fired first).
  The cap and the reason requirement apply as ever. A product may sit on a
  restaurant's order beside dishes. **Not built:** stock deduction for a sold product
  (stock is recipe-driven and deducts at KOT fire; a sale movement is its own slice),
  and a server-side barcode lookup -- the scan matches the branch menu already
  loaded, which suits a small shop, not a supermarket's catalogue.
- Adding a type: one registry entry; the tests that walk the registry (complete
  terms, real sections, unique theme id, a radius rule per radius, a CHECK equal to
  the keys) fail until the migration's CHECK and the stylesheet agree.

---

## Stack

- Backend:      Node 22 + Fastify 5 + TypeScript (ESM)
- Database:     PostgreSQL 15+ (15 is the floor: `NULLS NOT DISTINCT`; 13+ for row
                triggers on partitioned parents)
- Query layer:  `pg` and hand-written SQL through the base repository; no ORM
- Migrations:   hand-authored SQL, numbered, reversible (see Migrations)
- Cache:        Redis
- Frontend:     React 19 + Vite + TanStack Query; three HTML entries
- Auth:         JWT access + refresh; argon2id for passwords and PINs
- Package mgr:  pnpm (one lockfile; a second one fails `preinstall` and CI)
- Tests:        vitest (API against a real Postgres; web in jsdom)

### Code layout (pnpm monorepo)

```
backend/src/    app.ts, server.ts, config/, jobs/
                core/      database/ errors/ middleware/ (registrars) security/ (guards)
                modules/   auth authz billing inventory kitchen menu metering
                           notifications offline orders payments platform privacy
                           reporting restaurants tax users
                           (inventory keeps only deduct/reconcile, which the jobs call)
                routes/    route tables + handlers/ (the thin route layer)
backend/tests/  vitest, run from backend
frontend/src/   app/ (3 shells: platform admin pos), features/<domain>/<app>/,
                components/ services/ lib/ hooks/ types/ styles/
shared/         code both sides import (@universalpos/shared)
print-agent/    the on-premises printer bridge
packages/       tsconfig, eslint-config (workspace tooling)
database/       bootstrap/ migrations/ pgbouncer/
deploy/ docs/ scripts/   repo root
```

`modules/platform`, `modules/notifications` (the outbox) and `modules/billing` are
the control plane; everything else in `modules/` is the tenant plane.

---

## Architecture: two separate planes

The single most important rule. **Control plane** (superadmin, Sales): tenants,
plans, subscriptions, billing, platform staff, audit. **Tenant plane** (restaurant
staff): branches, menu, orders, kitchen tickets, bills, payments.

### Hard boundaries

1. Separate session cookies, separate auth tables, separable deployments.
2. A `platform_user` is **never** a row in `app_user`. No shared identity table, no
   `is_superadmin` flag.
3. Control-plane routes live under `/api/platform/*` and **reject any JWT carrying a
   `tenant_id`**.
4. Tenant routes **reject any JWT carrying a `platform_role`**.
5. Only two things cross: **entitlements flow down** (a cached
   `entitlement_document`), **usage flows up** (daily aggregate rollups only). The
   control plane never queries orders.
6. The one exception is a time-boxed impersonation token.

The control plane MAY set a restaurant's staff PINs and the manager's username and
password (the owner's decision, 2026-10-16). It never reads tenant order data.

### Schema split

Two Postgres schemas. **Every table in `app` has `tenant_id NOT NULL`, RLS enabled,
and a policy with both `USING` and `WITH CHECK`** -- parents and partitions,
asserted by an introspection test. The invariant is one-directional:
`platform.tenant_owner_invite` has a `tenant_id` and stays in `platform`.

- `app -> platform` FKs are permitted (`platform.tenant`, immutable reference data).
- **`platform -> app` FKs are forbidden, without exception** (asserted). A
  control-plane row pointing at tenant data keeps a documented **soft reference**,
  validated in the repository.

### Database roles

| Role | Purpose | Grants |
|---|---|---|
| `katkitchen_owner` | owns all objects; migrations, seeds, partition job | full; not `BYPASSRLS` |
| `katkitchen_app` | the application, both planes | CRUD on `platform` + `app`; **no UPDATE/DELETE/TRUNCATE on either audit table**; not `BYPASSRLS`; never the owner |
| `katkitchen_platform_readonly` | control-plane reporting | `SELECT` on `platform` only; **no `USAGE` on `app`, ever** |

`citext` lives in schema `extensions`; `public` has its privileges revoked; every
role has `extensions` on its `search_path`.

### Tenant isolation

- Shared database, `tenant_id` column; **the base repository is the primary
  enforcement and RLS the backstop**. The repository refuses to query when the
  tenant GUC is unset -- loud, not empty.
- Raw SQL against a tenant table without a `tenant_id` predicate fails a test gate.
- **Never accept `tenant_id` from a body, query or header.** It comes from the
  verified JWT. Pre-auth routes resolve the tenant from the path slug
  (`/api/auth/:tenantSlug/...`) or from a verified token; nothing else.
- RLS policies declare `USING` **and** `WITH CHECK`, and call
  `app.current_tenant_id()`, which **raises** when the GUC is unset (`STABLE`).
- `FORCE ROW LEVEL SECURITY` is **off** (the owner runs migrations); running the app
  as the owner is caught by the startup probe instead.

### Connection pooling and the startup probe

`SET LOCAL` needs **transaction-mode** pooling. Startup aborts unless: a `SET LOCAL`
canary reads back inside a transaction and is gone after `COMMIT`; `current_user` is
not `BYPASSRLS` and does not own the `app` tables; the app role has no
UPDATE/DELETE on either audit table. The local stack runs PgBouncer in transaction
mode, plus a deliberately misconfigured statement-mode pooler (`probe` profile) so the
failing direction is exercised. **Session advisory locks need a DIRECT connection**,
never the pooler. *(history: "Connection pooling", "The local stack runs as the three
roles, through the pooler")*

---

## Migrations

- Hand-authored SQL, numbered, **every migration has a reversible `down`**, and
  `reversibility.test.ts` **executes** every down on a database with data and compares
  a schema digest. A rollback must not destroy a record of something that happened.
- Applied state in `migration.applied` with a checksum; editing an applied migration
  is an error. One transaction per migration. The API does not migrate on boot.
- Status columns are `text` + `CHECK`, never a native enum.
- Uniqueness over tables that keep inactive history is a **partial** index on
  `status = 'active'`.
- Before partitioning, ask what uniqueness the table depends on and whether the
  partition key is inside it (`request_claim` is hash-partitioned for that reason;
  `stock_movement` is not partitioned at all). *(history: "Partitioning a table whose
  correctness rests on a unique constraint")*

---

## Roles, permissions and granting

A user **holds a role at a scope**: `membership(user_id, tenant_id, branch_id NULL =
tenant-wide, role_id, role_assignable_scope)`. Effective permissions are the union of
active memberships in scope.

- Permissions are flat keys (`order.void`, `bill.reprint`). **Never check a role
  name; check the key.**
- System roles (owner, branch_admin, manager, cashier, counter, waiter, kds,
  accounts) are **locked** by a trigger on `app.role` and `app.role_permission`
  conditioned on `current_user` -- a guardrail, not a security boundary. Customise by
  clone-then-edit (`cloned_from_role_id`).
- **System roles are re-seeded idempotently on every deploy, for every existing
  tenant** (`reconcileAllTenantSystemRoles`); custom roles never gain a key
  automatically. New keys default deny.
- `role.assignable_scope` is denormalised onto `membership` behind a composite FK
  `ON UPDATE CASCADE` with an in-row CHECK, so a contradicting membership aborts the
  role change.
- `permission.risk_class` is `none | financial | escalation | privacy`
  (`is_dangerous` is a generated column). Financial keys need a reason code and reach
  the exception report (`risk_subclass` `transaction | configuration` decides the
  section). **No escalation, privacy or adjustment key is seeded into a broadly
  assigned role.**
- **A mutating route guarded by a key `read_only` holds is wrong** -- asserted over
  every mutating platform route.
- Discount authority is a **cap on the role** (`discount_percent_cap NOT NULL DEFAULT
  0`, `discount_amount_cap` nullable as an extra ceiling). There is no unlimited.
- Platform roles: `super_admin`, `sales`, `support`, `billing`, `read_only`.

### The subset rule and separation of duties

- **A user may grant only a role whose keys are a subset of their own effective
  permissions in that scope**; the same rule governs authoring roles.
- `SEPARATION_RULES` (`modules/authz/separation.ts`): no single role holds both the
  till (`TILL_KEYS`) and any report or adjustment key; no role holds both the vendor
  master and purchase-order approval; no role holds both `inventory.waste` and
  `inventory.adjust`.
- `owner` withholds the operational side of each rule (derived, never enumerated);
  an owner who works the till holds a second membership (provisioning creates owner
  tenant-wide **and** cashier at the first branch).
- A delegator may delegate keys it is denied *only* because it holds the other side
  of a rule. A role that violates a rule cannot be authored or assigned by anyone.
- Both `OWNER_WITHHELD` and the delegation exemption are **computed from the rule
  set**; a test adds a synthetic rule and asserts the machinery follows.
- `tenant_audit_log.authorising_membership_id` records the membership whose role
  allowed the action (narrowest scope wins). A person holding both sides through two
  memberships is reported nightly, not blocked.

---

## Identity and sign-in (current since 2026-10-16/17)

- `credential` is authentication (typed `password` | `pin`, one active of each per
  user, lockout counters on the credential). `membership` is authorisation.
  `app_user.email` is nullable; `employee_code` is the staff username.
- **The Sales person who sold a restaurant (Super Admin: any) sets every sign-in**:
  the manager's username and password, and each staff member's username and 4-digit
  PIN (`/api/platform/tenants/:id/staff...`, keys `platform.tenant.staff[.any]`).
  Never a manager's PIN; staff have **no password** (`tenant_staff_uses_pin`). Audit
  rows are written from the RESULT, never the request body.
- **Manager:** `/{slug}`, username + password (`POST /api/auth/:slug/login`). Staff
  are refused there (`staff_use_pos`). **Managers never sign in on the POS**, enforced
  on the server (`manager_use_login`).
- **Staff:** `/{slug}/pos` lists the till's staff as cards
  (`GET /api/public/restaurants/:slug/till/staff`, names only, never a manager); the
  tapped person types a 4-digit PIN (`POST /api/auth/:slug/pin`). On Basic a correct
  staff PIN on a browser that is not a till yet registers it as one, within the plan's
  device limit; a revoked till stays revoked.
- PIN policy: 4 digits, no trivial sequences, not equal to the staff code or a run in
  the phone number. Lockout 60 s doubling, capped at 15 min, never indefinite.
- Tokens: access 15 min, refresh 12 h, sliding; refresh re-reads `device.status`.
  `typ: 'refresh'` is rejected as an access token on both planes.
- Password login answers unknown-email and wrong-password **identically**, including
  the argon2 work.
- Credential events go to `platform.auth_attempt` (security telemetry, 30-day
  retention), **never** the audit log. Which tenant statuses may authenticate is an
  allowlist: `active`, `past_due`, `soft_lock`.
- `GET /me` answers `screens` from permission keys (`SCREEN_KEYS`) and `lands`
  (`admin` | `pos`) from `user.view`. *(history: "One login page; the manager creates
  staff logins", "The Sales person sets every sign-in; staff use a PIN on the till")*

---

## Audit

- **One** audit middleware; every route declares its audit posture explicitly
  (`audit: { action, target }` or `audit: 'none'`); a missing field refuses the boot.
- The audit row is written **in the same transaction** as the mutation.
- `platform_audit_log`, `tenant_audit_log` and `impersonation_session` are
  append-only: no UPDATE/DELETE grant plus a `BEFORE UPDATE OR DELETE` trigger.
- Order inside the unit of work: set the tenant GUC; resolve authority and snapshot
  the actor; permission check (403, no audit row); resolve the authorising membership
  (null -> 403, logged at alert level, never a distinct status); capture BEFORE with
  `SELECT ... FOR UPDATE` through the handler's repository; run the handler; capture
  AFTER; write the audit row; COMMIT.
- `tenant_audit_log.actor_kind` is `user | impersonation | system`, with a CHECK
  requiring exactly the matching column; `system` must name its job.
- Audit at the **domain-event** level (one row per decision), payloads capped at 64 KB
  per side with `payload_truncated`.
- **Partitioned monthly on `occurred_at`**; PK `(id, occurred_at)`; a `DEFAULT`
  partition is mandatory and must stay empty (asserted after every test file). The
  partition job runs as the owner and enables RLS, creates the policy and revokes the
  app role **in the same transaction** as each new partition. Recovery is
  `scripts/recover-default-audit-partition.mts` (`--dry-run` first).
- Fixtures **upsert; they never delete a tenant or a membership**. A membership that
  has acted is pinned by `ON DELETE RESTRICT`; revocation is `status = 'revoked'`.
- **Staff erasure is anonymisation in place** at day 135; audit-row actor snapshots
  are the financial record and are not scrubbed. Deletion is never offered.

---

## Impersonation

- Max 60 minutes (a CHECK on the session row), mandatory reason, revocable, the owner
  notified through the outbox, a banner from `x-impersonation-*` headers.
- Read-only by default; write is a separate flag with its own reason, enforced at the
  guard before any connection is taken.
- The token is its own shape (`typ: 'impersonation'`, `act_tenant_id`, `sid`), inert
  against both plane guards, which also reject the type explicitly. `sid` is resolved
  against `platform.impersonation_session` **on every request and never cached**;
  `act_tenant_id` must equal the session's tenant.
- `purged` refuses; `hard_lock` permits; `retention` / `purge_pending` read-only.
- Impersonated writes are tagged in the tenant's own audit log
  (`actor_kind = 'impersonation'`, soft reference to the session).

---

## Suspension ladder and entitlements

- `past_due` (day 0) -> `soft_lock` (7, read-only) -> `hard_lock` (15, login blocked)
  -> `retention` (45) -> `purge` (135, anonymise). Thresholds are platform settings.
- `tenant.delinquent_since` is the truth (`(status = 'active') = (delinquent_since IS
  NULL)`), `status` the cache. **Dunning never suspends**; only the ladder job does.
  **A billing job must never take a restaurant offline.**
- Provisioning is one idempotent, rollback-safe transaction; side effects go to the
  outbox. `tenant_owner_invite` stores only a SHA-256 `token_hash`.
- `ENTITLEMENTS` in `shared/src/constants/plans.ts` is the one definition of
  what a plan includes; every plan version states every key (`validTerms`). Read
  through `entitlementsFromTerms`; the API gates and `getAdminMenu` read the same
  function.
- `RouteDefinition.plan` declares the gate on the route (`{ feature }`, `{ reports }`,
  `{ limit }`, a list, or `'document'`); the registrar checks it after permission and
  before the handler. Breach is `402 upgrade_required` naming the cheapest plan.
- Limits (`branches`, `devices`, `users`) are counted under a transaction-scoped
  advisory lock; only ADDING is refused, never existing use. Basic: one branch, no
  staff tablets, no tables (the `tables` feature is off).
- The tenant plane caches the entitlement document in Redis (5 min); a miss or a Redis
  error reads the newest document on the request's connection. Only a restaurant with
  no document fails closed (503).

---

## The menu and the priced-document rule

> **Every number that can appear on a bill is snapshotted onto the order line at the
> moment of order. A bill never dereferences a catalogue row for a value.**

Snapshotted: unit price, every modifier delta, display name, tax class and rate, the
component split. `menu_item_id` / `modifier_option_id` are kept for reporting joins,
never read for a number. **A unit price is never accepted from a request**; a tender
amount, a discount amount and a parcel charge may be (a person decided them, and each
is bounded by the domain).

- The menu is a tenant-level catalogue; branch differences are listing, price
  (overrides may only RAISE), availability and routing.
- Combos: a money-less parent with components at allocated prices, largest-remainder
  rounding, verified by a deferred constraint trigger before COMMIT.
- Availability: listed -> in service -> sold out (by business date), three tables.
- Routing: items name a `station_code`; **there is no default-station fallback**.
- Tax class lives on the item, never the category. Rates are integer basis points.
- **CGST, SGST and IGST are SHOWN, never typed**: a dish has one GST rate; heads are
  derived per bill (`headRateBps`, the one function the screens and the bill share).
  CESS is not built.

---

## Operations (the POS)

- **The POS is one screen** (`BillingWorkspace`): New order; Confirm runs open, lines,
  `fire`, `ready-for-billing` in order, then the bill. Each step carries an
  idempotency key fixed for the attempt. Basic seats at the counter: dine-in `D-n`
  beside parcels `P-n`, from one gapless counter (`table_session.seating` is the
  positive discriminator).
- Ownership of an order is `table_session.stage` (`ordering` | `billing`), enforced
  **in the domain** (`assertTakesOrderChanges`, `assertInBilling`), because the offline
  sync path replays the same functions.
- **Stock deducts at KOT fire, not at payment.** Voids, comps, discounts and refunds
  are **new rows**, never updates (`void` quantity < 0, `comp` quantity 0). Pre-fire
  correction mutates the line (`fired_at IS NULL`, trigger-enforced).
- Gapless numbers people read aloud use a **counter row**, never a `SEQUENCE`. The
  identity is the UUID; a display number may be null where stated.
- **Global lock order** for multi-lock paths: `request_claim -> table_session ->
  fire_sequence -> station counters (by id) -> inserts`.
- Deferred constraint triggers (`DEFERRABLE INITIALLY DEFERRED`): combo allocation
  balances; adjustments do not exceed the original; tenders equal the payable.
- The session lease is a bearer credential minted per claim, resolved **from the
  token** in the registrar; every leased route declares its subject.
- A handler takes the branch from the token and the session from the lease; a request
  body never names `branchId`, `sessionId`, `businessDate`, `tenantId` or
  `...ByUserId` (gated by `requestProvenance.test.ts`).
- The parcel charge is an `order_line.kind = 'charge'`, capped by
  `branch.parcel_charge_max_minor` (default 0) and taxed with the food.
- **Round off**: an Indian restaurant bill is paid to the nearest rupee
  (`round_off_minor` -49..+50, `payable_minor` generated; 50 paise rounds UP,
  `nearestRupeeRoundOff`); the UAE pays to the fils. `bill.total_minor` stays the tax
  document.
- **My takings** (`till.summary.view`, a TILL key): the signed-in person's own drawer
  for a day, week, month or From/To range. It is not a report.

### Bill history, bill edits and day end (0086, 0087)

- **Day end is the commitment point.** The till submits a business day
  (`payment.settlement.close`, `POST /pos/day/submit`): refused while an order of the
  day is open, and refused (`day_changed`) unless the bill count and payable the
  person confirmed are the figures now. `app.day_submission` keeps what was handed
  over (immutable by trigger); one live row per branch per day (partial unique
  index), so a repeat returns the same submission. Bills made later the same
  business day are locked too; the day may then be submitted again (the earlier
  row `superseded`).
- **Who edits what** is `assertMayEditDay` (`payments/dayEnd.ts`), under one advisory
  lock per branch per day that submit, reopen, Allow POS Bill Editing, every edit and
  every tender void take: the **till** (`bill.edit`) edits only TODAY's bills, while
  the day is not submitted or while a manager's Allow POS Bill Editing is on --
  never a previous day; a **manager** (`bill.edit.any`, on `/admin/`) edits any day,
  a submitted day only after reopening it with a reason (`payment.settlement.reopen`;
  the submission row is stamped `reopened`, never removed). A till may not void a
  tender of a submitted day, grant or not.
- **Allow POS Bill Editing (0087)** lets the till edit TODAY's submitted bills
  without reopening the day for managers. A manager switches it
  (`payment.settlement.reopen`, `POST /admin/days/:date/pos-editing/enable` with a
  reason, `/disable` without); refused for any day but the branch's today and for a
  day not yet submitted. It is an `app.pos_edit_grant` row on the day's CURRENT
  submission (off stamps it, never deletes; one `on` per submission), so it is off
  after every Submit Day Bills. Read under the day lock on every edit, never cached:
  off refuses the next save. A till edit of a submitted day names its grant
  (`bill_revision.pos_edit_grant_id`, pinned with the submission by a composite FK;
  a CHECK refuses a till edit of a submitted day without one).
- **An edit never rewrites a bill or a payment** (`payments/billRevision.ts`). Unpaid:
  the bill is voided (kept, numbered) and reissued from the order lines. Paid: the
  bill and its tenders stand; added items go on a supplementary bill the till
  collects normally (added to a paid bill only on its own day); items taken off are a
  void row plus a refund credit note, by a manager only, on a fully paid bill.
  Additions are ordinary order lines, fired to the kitchen. A combo or charge is not
  taken off by an edit. Every edit needs a reason, carries `expectedVersion` (a stale
  or repeated one is refused) and writes an append-only `app.bill_revision`
  (`authority` `pos` | `manager`, the reopening or grant it ran under, before/after
  images).
  Preview is the same edit run in a savepoint and rolled back.
- **Decided relaxation of till-vs-record (2026-11-21):** the till roles hold
  `bill.edit` and `payment.settlement.close` (financial keys, not adjustment keys:
  corrections before the commitment point), and read branch-wide bills and day
  totals (`bill.view`, `GET /pos/bills`) to review the day. `bill.edit.any` and
  `payment.settlement.reopen` are ADJUSTMENT_KEYS, so no till role may hold them.
- Search finds a bill number, a `D-n`/`P-n` number or a pickup name: there is no
  other order number and no other customer name.
- Cash handed over (`cash_received_minor`) is recorded beside the applied tender;
  change is derived, never stored.

### The installable POS app (2026-11-25)

- The POS installs as a web app; there is no APK. Each restaurant has its own manifest
  (`GET /api/public/restaurants/:slug/manifest`, public, names only), with `id`,
  `start_url` and `scope` set to `/{slug}/pos`. A home-screen icon therefore opens that
  restaurant's POS, and the till's identity, under `pos:{slug}`, decides the rest.
  Installing grants nothing: first launch, PIN sign-in, an ended session, a revoked
  till and the plan's till limit are the POS's existing flows, unchanged.
- The icon is the restaurant's logo only when it is a PNG or WebP, square, and at
  least 192 px. Chrome refuses a JPEG icon. Otherwise it is UniversalPOS's own
  `public/app-icons/`.
- `public/pos-sw.js` **caches nothing**. It answers only page loads, and only to say
  there is no connection. The API never passes through it.
- The manager's dashboard card (`InstallPosApp`) shows the link and a QR code drawn
  on the device, plus tills used out of the plan's `devices`. `/{slug}/pos?install=1`
  shows install help; the installed app's start address never carries that query.

### Offline (server rules)

An operation may go offline only when its invariant is **local** to the aggregate the
device holds (the session lease guarantees one writer). Bill generation, tender,
refund, void of a fired line, comp and discount are **never** offline. Quarantine
keeps the whole batch verbatim; `OFFLINE_WINDOW_HOURS * 3 < REQUEST_CLAIM_RETENTION_DAYS
* 24` is asserted at module load. Manual settlement records a card slip or cash
envelope online, after the fact. *(history: "Offline POS (Phase 5A)")*

---

## Tax

- **Restaurant bills** (`modules/payments/billing.ts`, `modules/tax/`): the place of
  supply is the **branch's own state**, so a GST bill is CGST + SGST
  (`resolveIndianSupply`); a branch with no state code that charges tax is stamped
  `unstated` and the GST return refuses the period; no tax is `none`.
- How a branch charges tax (0083): `tax_enabled`, `tax_account_type` (`none | gst |
  vat | others`), `tax_calculation_mode` (`forward | reverse`), written only by
  `POST /admin/branches/:id/tax` while no order is open. `lineTax` is the one
  forward/reverse rule. The order snapshots the mode; the bill snapshots the account,
  mode, registration number and currency.
- **Our invoices to restaurants** (`modules/billing/placeOfSupply.ts`, control plane):
  the GSTIN is the authority; outside India decides before SEZ, and both before
  comparing states (an SEZ unit in our own state is inter-state); zero-rating is LUT
  only and needs a platform user to have seen evidence. The two planes share no code;
  a test asserts they split a rate identically.
- A restaurant's country (`IN`, `AE`) and currency are chosen at creation and
  changeable only until the first bill (0084).
- **GST status: Pending qualified GST review.** Nothing here is claimed compliant.
  See "Before the first real invoice" below.

---

## Printing

- **Printing is a queue, not a call.** The `print_job` row is created in the fire
  transaction; delivery is async with retry and a fallback printer.
- The server worker sends raw ESC/POS over TCP to network printers only. A branch with
  a live **print agent** has its network jobs claimed by the agent
  (`POST /api/agent/poll`, every 2 s, `claimed_by = 'agent:<id>'`); kitchen tickets
  only. Addresses must pass `parsePrinterAddress` on the server and in the agent.
- The **till** prints bills itself: to a USB/Bluetooth printer over Web Serial when one
  is connected (`sendCopies` is the one choice), otherwise the browser dialog. On a
  phone or tablet (touch with no hover, or under 1024 px) a receipt roll never opens
  the preview or the dialog: it goes to the device's printer, or the till says why not.
- Copies print once the bill is PAID; reprints say REPRINT. A roll is laid out inside
  the print head (`PAPER.printableMm`). The branch's layout settings (0078) travel with
  the bill; the till keeps no copy of them.
- **Bill headings (0088)** are branch wording, not bill data: `bill_heading_unpaid`
  (BILL), `bill_heading_part_paid` (PART PAID), `bill_heading_paid` (INVOICE), each 1-20
  printable ASCII characters by CHECK (a direct print is code page 437). They travel as
  `layout.headings` and are read at print time like the footer, so a reprint carries the
  heading saved now. WHICH heading is the server's `kind` and the paid amount; the words
  head the customer and counter copies only (`receiptTitle`, the one function every
  print path calls), never a kitchen ticket.

---

## Billing automation and reporting

- Invoice numbers are gapless per tenant per series per financial year by counter
  row, and carry a series code. Credit notes have their own series.
- Segments, not proration; upgrades immediate, downgrades at the period boundary; a
  downgrade over the target's limits **fails to apply** and notifies.
- Webhooks: constant-time signature check (unverified events recorded and confined to
  `rejected`), idempotency on the gateway's event id, a monotonic timestamp guard; a
  reconciliation job asks the gateway directly. **Never store a card number** (three
  layers, asserted).
- **Every report reads snapshots; nothing recomputes from current configuration.**
  The reporting gate is an **allowlist** of readable tables plus a column gate and an
  import-graph gate; `EXPECTED_REPORTING_MODULES` is an exact count.
- The exception report ranks each actor against their own prior baseline; privacy
  access is a separate table read by a separate function.

---

## The API surface

- **The route layer holds no logic**: a handler reads the request, calls one domain
  function and returns its answer (the offline sync path calls the same functions).
  It may issue no SQL and do no money arithmetic (gated with a synthetic violation).
- `mergeHandlers` refuses a duplicate handler name.
- **Every named error code is either mapped in `ERROR_CONTRACT` or listed in
  `BOOT_REFUSALS`** (read from the source). Postgres refusals are classified by
  SQLSTATE (`invariant_refused`, `already_exists`, `reference_invalid`, ...); the
  message is never forwarded.
- Admin CRUD is generated from `adminResources.ts`: fields are an allowlist and
  anything else is **refused, not filtered**; columns are checked against
  `information_schema`; the predicate carries the branch.
- `ROUTES_WITHOUT_HANDLERS`, `KEYS_WITHOUT_ROUTES` and `EXPECTED_ROUTE_COUNT` are
  ratchets; `assembly.test.ts` boots the real server.

---

## Data quality checks (nightly, alerting)

An active `app_user` with no active credential; a non-empty `DEFAULT` audit partition;
a stock moving average outside every price paid; a stock balance that disagrees with
the fold of `stock_movement` (reported, never repaired); any `platform -> app` FK; any
`app` table without `tenant_id NOT NULL`, RLS or a `WITH CHECK` policy; anyone who
exercised both sides of a separation rule.

---

## Domain rules that are easy to get wrong

1. Stock deducts at KOT fire, not at payment.
2. Printing is a queue, not a call.
3. `kitchen_station` is a resource; `kds` is a role.
4. Customers are not staff.
5. **Money is integer minor units.** Never float. Currency is `text CHECK (~
   '^[A-Z]{3}$')`, never `char(3)`.
6. Timestamps are UTC `timestamptz`; the business date comes from the branch timezone
   plus `business_day_starts_at`, never UTC midnight.
7. Voids, comps and refunds are new rows.
8. Status columns are `text` + `CHECK`.
9. Retained-but-inactive rows must not block re-creation (partial unique indexes).

---

## Testing standards

- **A test that verifies zero things and passes is worse than no test.** Introspection
  tests assert a minimum count and named members of the checked set before asserting
  no violations. Floors are ratchets: raise them, never lower them.
- **A test of a rule runs a fixture built to violate it**; seed data that complies is
  evidence about the seed, not the rule.
- **A denial must pin WHICH denial.** Wherever NULL means "inherited default", assert it
  is non-NULL first.
- Jobs assert positive postconditions and exit non-zero if the state is absent.
- **Dump the actual rows before trusting a probe.** An intermittent failure is evidence
  about the test: find what differs, then assert the relationship the constraint
  enforces (not two `now()` stamps, not a clock across a VM).
- A `down` is exercised on a database WITH DATA or not at all.
- The suite has its own database, `katkitchen_test`; fixtures never delete a tenant.
- Never weaken, skip or delete a test to get a pass.

### Standing review questions

- **Derived, or merely adjacent to something derived?** For every list of keys, tables,
  roles, columns or paths: is it computed from the source of truth, or a copy that
  agrees today? A copy needs a test that adds a synthetic entry and asserts the copy
  follows. *(history: "Standing review question: derived, or merely adjacent to
  something derived?")*
- **A blocklist fails open; an allowlist fails closed.** Where the guarded set can grow,
  name what is permitted.
- **The relaxation that makes the error go away is the one that removes the
  guarantee.** When a constraint fails, name what it protects before narrowing it.
- **Pinned, or snapshotted?** Pin (composite FK, cascade) a copy that must track its
  source; snapshot (plain column) one that must not.
- **Absence is never a discriminator.** A CHECK or branch exempting on NULL has a hole
  the size of the rows that can be made NULL; use a positive column.
- **Code that is never reached**: a symbol that exists, is tested in isolation and is
  joined to the running system by nothing. Run the thing in its production posture
  early; a runbook nobody has executed is unexecuted code. *(history: "The fifth gate
  family")*
- An owner-posture exemption is a claim about callers and needs re-checking when the
  callers change.

---

## Commands

```bash
pnpm stack:up            # Postgres, PgBouncer, Redis, API, web (docker compose)
pnpm stack:probe         # the statement-mode pooler that tests/db/pooling.test.ts needs
pnpm db:migrate          # also db:rollback, db:status, db:seed
pnpm reconcile:roles     # after any permission key or description change
pnpm typecheck           # not implied by `pnpm test`
pnpm test                # API suite against katkitchen_test
pnpm test:web            # web suite (jsdom)
pnpm build:web
```

The web suite runs the same from any working-directory spelling: on Windows,
`frontend/vitest.config.ts` normalises a lowercase `c:\` drive before Vite resolves
anything, asserted by `frontend/tests/reactSingleInstance.test.ts`.

## Before the first real invoice

**Pending qualified GST review.** The place-of-supply logic and one sample invoice of
each treatment must be reviewed by someone who files GST returns, as must one sample
bill with a Round off line and, before a Dubai restaurant goes live, a UAE VAT
invoice. The samples, assumptions and open questions are in `docs/gst-review.md`; the
reviewer checklist is at the foot of `docs/billing-terms.md`. Do not describe any of
it as GST-approved until that review is recorded there.

## Working agreement

- **Plan before code.** For any non-trivial task, state the plan and wait for approval.
- **Ask, don't assume.** One specific question rather than building the wrong thing.
- **Stay in scope.** No placeholder or mock implementations unless asked.
- **Every migration is reversible.**
- **Tests for the isolation guard are non-negotiable**: a cross-tenant read attempt
  has a failing test proving it is blocked.
- Prefer clean, minimal code. Comment only the non-obvious *why*.
- When a decision is made, state the current rule here, briefly. Long reasoning and
  the change record go in `universalpos.md`'s change log; `docs/decision-history.md` is
  an archive and is not extended.
