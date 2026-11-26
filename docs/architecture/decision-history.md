# Decision history (archive of CLAUDE.md to 2026-11-18)

> **This is an archive, not the spec.** It is `CLAUDE.md` as it stood on 2026-11-18,
> word for word: every decision with the reasoning, the defects that forced it, and
> the sections later superseded (Standard and Pro, the kitchen screen, tablet setup
> codes, staff invites, stock control). The current rules are in `CLAUDE.md`, which
> points here for the *why*. Where this file and `CLAUDE.md` disagree, `CLAUDE.md`
> wins. Search it by heading; do not edit it except to correct a mis-copy.

---

# Project: Multi-tenant Restaurant POS & Kitchen Management SaaS

## Stack

- Backend:            Node 22 + Fastify 5 + TypeScript (ESM)
- Database:           PostgreSQL 15+ (15 is the floor: `NULLS NOT DISTINCT`; 13+ for row triggers on partitioned parents)
- Query layer:        `pg` and hand-written SQL through the base repository; no ORM
                      (migrations are hand-authored SQL too, see Migrations)
- Cache / queue:      Redis + BullMQ (Phase 1)
- Frontend (admin):   React 19 + Vite + TanStack Query (Phase 1)
- Frontend (POS):     React + IndexedDB for offline (Phase 5)

### Code layout (pnpm monorepo)

```
apps/api/src/   app.ts, server.ts, config/, jobs/
                core/      database/ errors/ middleware/ (registrars) security/ (guards)
                modules/   auth authz billing inventory kitchen menu metering
                           notifications offline orders payments platform privacy
                           reporting restaurants tax users
                           (inventory keeps only deduct/reconcile, which the jobs call)
                routes/    route tables + handlers/ (the thin route layer)
apps/api/tests/ vitest, run from apps/api
apps/web/src/   app/ (3 shells: platform admin pos; /kot and /billing serve the POS),
                features/<domain>/<app>/,
                components/ services/ lib/ hooks/ types/ styles/
packages/       shared (code both sides import), tsconfig
db/ deploy/ docs/ scripts/   repo root
```

`modules/platform`, `modules/notifications` (the outbox) and `modules/billing` are
the control plane; everything else in `modules/` is the tenant plane.

The frontend has its own guardrails file: `docs/frontend/FRONTEND.md` -- the client truth model,
provenance, money, optimistic-write locality, idempotency-key custody, the
draft/queued/committed ladder and the degradation vocabulary. Rules there name
their enforcement mechanism the same way rules here do.
- Auth:               JWT access + refresh; argon2id for password and PIN credentials
- Package manager:    pnpm
- Test runner:        vitest

---

## Architecture: two separate planes

This is the single most important rule in the project. Everything else follows from it.

**Control plane** (`admin.app.com`) — superadmin. Runs the business of the platform:
tenants, plans, subscriptions, billing, platform staff, audit, governance.

**Tenant plane** (`app.app.com`) — restaurant staff. Runs the restaurant:
branches, menu, orders, KOT, KDS, inventory, payments.

### Hard boundaries

1. Separate deployments, separate domains, separate session cookies, separate auth tables.
2. A `platform_user` (superadmin) is **NEVER** a row in the tenant `app_user` table. No shared identity table, no `is_superadmin` boolean, no exceptions.
3. Control plane routes live under `/api/platform/*` and **reject any JWT carrying a `tenant_id`**.
4. Tenant plane routes live under `/api/t/*` and **reject any JWT carrying a `platform_role`**.
5. Only two things cross the boundary:
   - **Entitlements flow down** — plan limits + feature flags + status, as a cached `entitlement_document`.
   - **Usage/metering flows up** — daily aggregate rollups only.
6. The one exception is a time-boxed impersonation token (see Impersonation below).

---

## Database schema split

Two Postgres schemas. This replaces any notion of a base-repository exception list —
a list drifts, a schema boundary is mechanical.

| `platform` | `app` |
|---|---|
| `platform_role`, `platform_user`, `platform_audit_log`, `tenant`, `tenant_owner_invite`, `permission` | `branch`, `app_user`, `credential`, `role`, `role_permission`, `membership`, `tenant_audit_log` |

**The invariant: every table in schema `app` has `tenant_id NOT NULL`, has RLS enabled,
and has a policy with both a `USING` and a `WITH CHECK` clause.** Asserted by an
introspection test over `information_schema` and `pg_policies`, covering partitions as
well as parents.

The invariant is one-directional. Not every table with a `tenant_id` lives in `app` —
`tenant_owner_invite` has one and stays in `platform`, because the control plane writes
it and has no tenant context with which to set the RLS GUC. Stating this as a
biconditional would force that table into `app` and break provisioning.

### Cross-schema foreign keys are one-directional

- **`app` -> `platform` FKs are permitted.** The tenant root (`platform.tenant`) and
  immutable reference data (`platform.permission`) are legitimate targets.
- **`platform` -> `app` FKs are forbidden, without exception.**

An FK from the control plane into tenant data makes hard boundary #1 unachievable:
`app` could never be moved to its own database without dropping it. This mirrors
entitlements-flow-down. Where a control-plane row must point at a tenant row —
`tenant_owner_invite.accepted_user_id` — the column is kept as a **documented soft
reference**, validated in the repository, not by an FK.

Mechanically asserted: no FK in `information_schema` may originate in `platform` and
terminate in `app`.

---

## Database roles

Three roles. If the host cannot provide them, that is a hosting decision to change,
not a design to degrade.

| Role | Purpose | Grants |
|---|---|---|
| `katkitchen_owner` | Owns all objects; runs migrations, seeds, partition job | Full. Not `BYPASSRLS`. |
| `katkitchen_app` | The application, both planes | CRUD on `platform` + `app`. **No `UPDATE`/`DELETE`/`TRUNCATE` on either audit table.** Not `BYPASSRLS`. Never the table owner. |
| `katkitchen_platform_readonly` | Reporting against the control plane | `SELECT` on `platform` only. **No `USAGE` on `app`, ever.** |

The readonly role is named for its plane on purpose. A generic `readonly` is how
someone grants it `app` access in eighteen months believing it is the general
reporting role. Tenant-side reporting is served by `katkitchen_app` under RLS.
**There is no cross-tenant reader of `app`.**

### Extensions and search_path

`citext` lives in a dedicated `extensions` schema, not `public`. `public` has its
privileges revoked. Every role gets `extensions` on its `search_path` explicitly —
nothing relies on `public` being present or usable.

---

## Tenant isolation

- Strategy: **shared database, `tenant_id` column, base repository as the primary
  enforcement, row-level security as the backstop.**
- Isolation is enforced at the **repository/query layer**, not by developer discipline.
  The base repository injects `tenant_id` into every query automatically and **refuses
  to issue a query when the tenant GUC is unset** — the failure is loud, not empty.
- Raw SQL against a tenant table without a `tenant_id` predicate must fail a test/lint
  gate. Do not rely on code review to catch this.
- Never accept `tenant_id` from a request body, query param, or header. It comes from
  the verified JWT only.

### RLS rules

- Policies declare **both `USING` and `WITH CHECK`**. `USING` alone lets a request
  write a row into a tenant it cannot read.
- `FORCE ROW LEVEL SECURITY` is **off**. FORCE subjects the table owner to the policies,
  and the owner runs migrations and backfills. Ordinary RLS already applies fully to
  `katkitchen_app` because it is not the owner. The risk FORCE was covering — running
  the app *as* the owner in dev — is caught by the startup check instead.
- Policies call `app.current_tenant_id()`, which **raises** when the GUC is unset rather
  than returning NULL. `current_setting(..., true)` on an unset GUC yields NULL,
  `tenant_id = NULL` is NULL, and the row is silently filtered — a zero-row answer
  instead of an error. The function converts that into a labelled failure. It is
  `STABLE`, so the planner hoists it to an InitPlan and evaluates it once per query.
- Writes fail loudly either way: RLS `WITH CHECK` treats a non-true result as a
  violation, unlike a table `CHECK` constraint, which treats NULL as satisfied.

### Connection pooling

`SET LOCAL` requires **transaction-scoped pooling**. Under PgBouncer in statement mode,
`SET LOCAL` is discarded and RLS silently stops working. This is asserted at startup by
functional probe, not documented in a README:

1. `BEGIN; SET LOCAL app.tenant_id = <canary>;` read back — must equal the canary.
2. `COMMIT;` read again on the same connection — must be unset (no GUC leak across
   transactions on a pooled connection).
3. `rolbypassrls` for `current_user` must be false.
4. `current_user` must not own the `app` tables.
5. `has_table_privilege(current_user, '<audit table>', 'UPDATE'/'DELETE')` must be false
   for both audit tables — re-verifying the append-only grants on every boot rather than
   trusting that a migration ran.

Failing any probe aborts startup.

---

## Migrations

- Hand-authored SQL, numbered, **every migration has a reversible `down`**. There is no
  ORM and no schema generator: a generator does not produce RLS policies,
  partitions, grants, composite FKs or partial indexes, so it would cover a
  fraction of the DDL. (`drizzle-orm` was declared for a long time and imported
  nowhere; it was removed on 2026-11-18.)
- Applied state tracked in `migration.applied` with a checksum per file; editing an
  applied migration is an error, not a silent no-op.
- One transaction per migration.

---

## Roles and scope

A user is **not** a role. A user **holds a role at a scope**.

```
membership(user_id, tenant_id, branch_id NULLABLE, role_id, role_assignable_scope)
```

- `branch_id = NULL` means tenant-wide scope (owner).
- The same user can be Manager at Branch A and Cashier at Branch B. The model expresses
  this as two rows. **Effective permissions are the union of all active memberships in
  scope.**
- Permissions are **flat string keys**: `order.void`, `menu.edit`, `report.sales.view`,
  `user.invite`.
- Roles hold sets of permission keys. Seeded system roles per tenant (owner,
  branch_admin, manager, cashier, waiter, kds, accounts) plus tenant-created custom roles.
- Never hardcode a role name in a permission check. Always check the permission key.
- System roles are **locked** — no rename, no permission edits, no delete. Customisation
  is clone-then-edit, recorded in `role.cloned_from_role_id` so support can reason about
  drift and so you know which custom roles should be offered a newly added key.
  Enforced by a trigger on **both** `app.role` and `app.role_permission` — locking the
  role alone reaches the same result through the other door. The trigger is conditioned on
  `current_user` rather than being a blanket denial, because the seed reconciliation must
  still push newly added keys into system roles; same shape as RLS not applying to the
  owner.

  **This trigger is a guardrail, not a security boundary.** Anything connecting as
  `katkitchen_owner` can rewrite system roles freely — that is the design, because the
  seed must. It stops the application and its users from drifting a seeded role; it stops
  nothing that holds the owner credential. Do not cite it as protection against a
  compromised owner connection, and do not build a control that depends on it.

### Scope enforcement is declarative, not documentation

`role.assignable_scope` (`tenant_only` | `branch_only` | `any`) is **denormalised onto
`membership` and pinned by a composite FK** on `(tenant_id, role_id, assignable_scope)`,
with an in-row CHECK that `branch_id` agrees with the scope. A CHECK cannot reference
another table, so without this, `membership(role_id=owner, branch_id=<uuid>)` is
insertable.

The FK is `ON UPDATE CASCADE`. Narrowing a custom role from `any` to `tenant_only`
cascades into every membership row, each re-checked against the in-row constraint — so
if any branch-scoped membership contradicts the narrowing, **the role UPDATE itself
aborts**, transactionally, with no trigger and no application check.

### Platform roles (control plane, fixed set, not user-creatable)
`super_admin`, `sales`, `support`, `billing`, `read_only`

Platform permission keys are **Phase 1**. Phase 0 seeds the five roles as a lookup only;
nothing here specifies what `sales` may do that `support` may not, and guessing would be
worse than waiting for the routes to exist.

---

## Permission catalogue evolution

When `order.refund` is added in month six:

- **New keys default deny.** Absence of a grant is a denial; there is no implicit grant.
- **System roles are re-seeded idempotently on every deploy** from the typed constant.
  The constant is the source of truth; the table is a projection of it.
- **Custom roles never gain a key automatically.** Not on deploy, not on clone, never.
- The admin UI surfaces **"N permissions added since this role was created"**, backed by
  `permission.created_at > role.created_at` and dismissible via
  `role.permissions_reviewed_at`.

`permission.created_at` is set by the idempotent seed when a key is *first* inserted into
that database. On an existing install a new key carries its deploy timestamp and the diff
is exact; on a fresh install every key shares one timestamp and no role predates it, so
the diff is correctly empty. No catalogue version column is needed.

---

## Risk classes

`permission.risk_class` is `none | financial | escalation | privacy`. One boolean was
carrying three meanings with three different audiences and three different controls, and
a single exception report mixing till fraud with PII access serves neither reader.

| Class | Control | Audience |
|---|---|---|
| `financial` | reason code mandatory; surfaces in `report.exception.view` | owner, loss prevention |
|  | *includes `supplier.create`/`supplier.edit`: a new supplier appearing shortly before a large PO is the primary fake-vendor signal, so it must reach the exception report. **No role may hold a vendor master with zero financial-class keys.*** | |
| `escalation` | the subset-grant rule applies; approval path | security |
| `privacy` | logged per record viewed | DPO — **never** joined into the loss-prevention report |

#### Per-record PII logging is fixed in the API shape, not the audit layer

"Logged per record viewed" collides with domain-event granularity the moment there is a
list endpoint: either 500 audit rows, or one row whose id list gets truncated — and
truncating the id list destroys the only thing a privacy log is for. So the shape of the
API carries the rule:

- **List and search endpoints return non-PII projections** — name initial, masked phone,
  id. No `customer.pii.view`, no audit row.
- **PII reveal is a single-record action.** One request, one record, one audit row.
  Per-record logging falls out naturally instead of being enforced.
- **Bulk access is a separate key**, `customer.pii.export`, **owner only**, mandatory
  reason code. Its audit payload is a query descriptor plus a result count, **never an
  id list**.

A compromised manager session therefore cannot page through the customer table without
leaving one audit row per record.

`is_dangerous` survives as a **generated column** — `GENERATED ALWAYS AS (risk_class <>
'none') STORED` — so it can never disagree with `risk_class`. Seeds and reports read
`risk_class`; callers that only need "is this risky" keep working.

Current split: 18 financial, 6 escalation, 2 privacy.

**No escalation, privacy or adjustment key is ever seeded into a broadly assigned role.**
A *financial* key may be, where the reason code is genuinely the control —
`payment.tender.void` on `cashier` is the deliberate case, because a cashier who cannot
correct a mis-tender before close is unworkable.

`menu.price.edit` and `recipe.edit` are financial but **config-class rather than
transaction-class**: a standing change, not a per-event exception. That distinction wants
a second dimension eventually. Not now.

For every risky key the real control is a mandatory reason code plus a report — not the
permission itself. The key decides who may act; the reason code and the report decide
whether they get away with it.

### Wastage is not adjustment, and it is not a formality

`inventory.waste` is its own key rather than a mode of `inventory.adjust`, for the
same reason as vendor-master-versus-approval: **the two keys held together let one
person make stock disappear and then make the number agree.**

Waste writes off stock that existed and is gone. Adjustment reconciles the number to
a count. Someone holding both can walk out with a case of prawns, post it as waste,
and — if the waste figure later looks implausible — adjust the balance to a shape
nobody queries. Separately, each is visible: waste is a line on the wastage report
that a chef has to explain, and adjustment is a correction with a name on it.

So they are separated the same way `payment.collect` is separated from the reports:
**no single role holds both `inventory.waste` and `inventory.adjust`.** Waste sits
with the kitchen, which is the only party who knows a tray was dropped. Adjustment
stays with the manager.

Financial-transaction class, not configuration: a write-off is a per-event loss, not
a standing setting, so it belongs in the transaction section of the exception report
next to voids and comps.

### A read key on a write route is an escalation, not a typo

`POST /dunning/:tenantId/outreach` was guarded with `platform.payment.view`. The key
is about the right subject and completely the wrong shape — `read_only` holds every
`.view` key by construction, so the weakest role in the catalogue could write.

The tell is mechanical and worth checking directly: **a mutating route guarded by a
key that `read_only` holds is wrong by definition**, because `read_only` is defined
as the role that changes nothing. That is asserted, not reviewed — the test walks
every mutating platform route and refuses any that `read_only` can reach, so a
future route guarded by a convenient nearby read key fails at test time rather than
sitting there.

Recording the outreach earned `platform.dunning.outreach`. Adding a key was the
cheap half; the expensive half would have been discovering, later, that support
staff had been reading a page that also wrote.

### `order.void` is two permissions, not one

- **`order.line.remove`** — pre-fire. Removing a line before the KOT fires is correcting
  a typo. The waiter who entered it should fix it. Waiter and up.
- **`order.void`** — post-fire. Voiding after the KOT fires writes off cooked food. That
  is a cost event, not a correction. Manager and up.

Both are seeded and visible. A tenant where nobody can void is broken on day one, so
neither is opt-in.

### Discount authority is a cap, not a key

A permission key is binary; discount authority is a limit. Granting `order.discount`
with no ceiling grants unlimited comp, so the key alone is not the control.

The cap is **policy data on `role`**, not a catalogue entry:

```sql
discount_percent_cap smallint NOT NULL DEFAULT 0 CHECK (BETWEEN 0 AND 100)
discount_amount_cap  bigint   NULL              CHECK (> 0)   -- minor units
```

The two columns are deliberately asymmetric, and the asymmetry is the whole design:

- **`discount_percent_cap` is `NOT NULL DEFAULT 0`** — this is the authority. Zero means
  no discount authority. A role holding `order.discount` with the default can discount
  nothing until a cap is set deliberately. Same direction as new keys defaulting deny.
- **`discount_amount_cap` is nullable** — this is an *additional* ceiling, not the
  authority. NULL does not mean unlimited: the percentage still binds. It means the
  percentage is the only ceiling.

Both apply when both are set: a discount must satisfy the percentage **and** the absolute
ceiling. **There is no way to express unlimited discount authority**, because the
percentage cap is `NOT NULL` and capped at 100 of a bill that is itself finite.

Making both columns `NOT NULL DEFAULT 0` would have been simpler and wrong — it cannot
express `owner`, who needs full percentage authority with no absolute ceiling, without
seeding an arbitrary large number that then reads as policy.

Amounts are minor units of `tenant.default_currency`. A tenant has one currency, so the
cap needs no currency column; multi-currency would require one.

Per-membership overrides are **deliberately not modelled**. An override that can raise
authority above the role's cap is itself an escalation path, and enforcing "override may
only lower" declaratively would mean denormalising both caps onto `membership` behind a
widened composite FK, cascading on every cap change. Until there is a demonstrated need,
the cap lives in one place.

### Refunds are three permissions, not one

- **`payment.collect`** — cashier.
- **`payment.tender.void`** — cashier, same open session only, pre-close.
- **`payment.refund`** — manager. Requires a reason code and a reference to the original
  bill. Cash refunds above a threshold escalate to `branch_admin`.

Refund fraud is the most common till fraud in restaurants: ring a refund, pocket the cash.
**A cashier who can refund a closed bill is the till.**

---

## Granting: the subset rule

A manager who can invite users and assign roles can grant themselves — or a confederate —
a second membership carrying a superset role. Without a rule in the grant path,
`user.invite` is effectively `owner`. This is not expressible as a permission key.

> **A user may only grant a role whose permission set is a subset of the union of their
> own effective permissions in that scope.**

The same rule governs role authoring: **you cannot create or edit a role containing a
permission you do not hold.** Both are enforced in the grant path, in the same step as
the seeds, and tested — the canonical test is *"manager invites a user as owner, rejected."*

### Separation of duties

**No single role holds both `payment.collect` and any report or adjustment key.** The
person taking money is not the person who can reconcile or amend the record of it. This
is asserted against the seeded matrix, not left to whoever edits it next.

An **adjustment key** changes a money or stock record *after* it was committed:
`order.void`, `order.comp`, `order.discount`, `order.reopen`, `bill.void`,
`payment.refund`, `inventory.adjust`, `inventory.count.approve`,
`purchase.order.approve`.

Pre-commitment corrections are **not** adjustments and stay with the person doing the
work: `order.line.remove` (pre-fire) and `payment.tender.void` (same open session,
pre-close). This is the same line the `order.void` split draws.

### The second rule: vendor master versus approval

**No single role may both maintain the supplier master and approve a purchase order.**
Inventing a supplier and approving the order that pays it is fake-vendor fraud in one
role — the accounts-side equivalent of the till problem.

So `accounts` owns `supplier.create`/`supplier.edit` and raises orders, but holds neither
`purchase.order.approve` nor `purchase.receive`. Approval sits with `branch_admin` and
`owner`, who hold no vendor-master key.

### Dual capacity is two memberships, never one role

This is the general pattern, not a workaround for one case. **No role is exempt** — an
exemption is the precedent that gets widened, and "owner is special" is how every RBAC
system rots.

`owner` therefore withholds the **clerical side of each separation rule** and keeps the
principal's side: it gives up `payment.collect`, `payment.tender.void`,
`supplier.create` and `supplier.edit`, and keeps the reports and the approvals. An owner
who rings sales or maintains vendors personally takes a second membership.

The till capacity is **two keys**, not one. `payment.tender.void` is only meaningful to
whoever took the tender, in the session they took it — it travels with the till, and is
withheld and delegated alongside it.

### Both are derived from the rule set, never enumerated

`OWNER_WITHHELD` and the delegation exemption are both computed from
`SEPARATION_RULES` at runtime. A hardcoded key list in either place would leave
`owner` silently violating any rule added later, or leave the newly separated role
unassignable by anyone. A test introduces a **synthetic fourth rule** and asserts the
machinery adapts with no edit to the delegation code — if that test ever requires
`grant.ts` to change, the exemption has been enumerated and is wrong.

By convention a rule's `trigger` is the **operational half** (ringing the sale,
maintaining the vendor master) and `conflicts` is the **oversight half** (reading the
reports, approving the spend). The principal withholds the operational half.

### Delegation authority is not exercise authority

Separation of duties denies every membership-granting role the till, and the subset rule
says you may only grant what you hold. Together those made **the `cashier` role
unassignable by anyone, forever** — the system could not onboard a cashier at all.

The fix is structural, not an exemption:

> A delegator may also delegate the keys it is denied **purely because it holds the other
> side of a separation-of-duties rule**.

`owner` is denied `payment.collect` only because it holds reports and adjustments, so it
may still delegate it. It is not denied `role.create` on those grounds, so nothing is
widened there. Gated on actually holding `membership.grant`, which is what keeps *manager
cannot grant cashier* true **and true for the right reason**: manager has no delegation
authority at all. Onboarding is `branch_admin`'s job.

What makes this safe: **a role that violates separation of duties may not be authored or
assigned by anyone, at any seniority.** Owner can hand out `cashier`; owner cannot author
a till-plus-reports role.

### The rule constrains roles; the audit log constrains people

A person can still accumulate both sides through two memberships. That is legitimate in a
small restaurant and illegitimate in a large one, so it is **reported, not blocked**.

But a union alone cannot say which capacity someone was acting in — so
`tenant_audit_log.authorising_membership_id` records **the specific membership whose role
held the permission that allowed the action**. The permission check already knows; it
returns it rather than discarding it. Where several memberships qualify, **the narrowest
scope wins** (branch over tenant-wide), because that is the capacity the person was
acting in.

Without that column separation of duties is a comment. With it, *"the owner collected cash
at Branch 2 as that branch's cashier"* is an auditable fact rather than an inference, and
the nightly report moves from who **could** exercise both capacities to who actually
**did**.

---

## Identity model

**`credential` is authentication — who you are. Tenant-scoped.**
**`membership` is authorization — where you may act. Branch-scoped.**

Revoking a waiter at one location revokes a *membership*, not a credential.

`app_user` holds no secret. Credentials are rows in `credential`, typed
`password` | `pin`, one active credential of each type per user.

- `app_user.email` is **nullable**. A waiter who only ever taps a PIN has no email, and
  forcing a fake one to satisfy `NOT NULL` puts `waiter3@nowhere.local` in production.
  `employee_code` is the alternative human identifier.
- Lockout counters live on `credential`, not `app_user`. A user-level counter means five
  bad PIN guesses at a terminal lock the manager out of the web admin, and lets anyone at
  a shared POS lock out a colleague.
- `sso` is deliberately **not** a credential type yet. Real SSO needs per-tenant IdP
  config, domain verification and JIT provisioning rules; two nullable columns without
  those is the half of the design someone builds against. Adding a CHECK value plus
  columns later is a one-line reversible migration — the cheap-to-change case.

### PIN login is identified, not anonymous

Staff tap name/photo, **then** enter the PIN. The PIN disambiguates one already-known
user; it is not a lookup key.

This is why there is no `secret_lookup` column, no HMAC, and no pepper. Anonymous
PIN-only login needs database-enforced uniqueness over a salted hash, which is impossible
without a deterministic second column keyed by an application-held pepper — and pepper
custody is a permanent liability taken on to satisfy a requirement that identified login
removes. Verification is one argon2id check against one known row.

### PIN policy (application-enforced)

- Minimum 4 digits, 6 permitted.
- Reject trivial sequences: `0000`, `1234`, runs, repeats.
- Reject a PIN equal to `employee_code`, or to any digit run within the phone number.

### PIN lockout

**Short, exponential, never indefinite:** 60s, doubling, capped — plus a manager
override. Per-credential lockout alone still lets someone lock out a branch's staff one
at a time, and an indefinite lock on a PIN mid-service is an outage.

---

## Audit

- **One** audit middleware handles all mutations. Not per-controller implementations.
- A route that can write and is not audited **does not ship** — enforced by a route
  registrar that **refuses to boot** when a non-`GET`/`HEAD`/`OPTIONS` route is
  registered without an audit descriptor. Mechanical gate, not a review convention.
- The audit row is written **in the same transaction as the mutation**. A rolled-back
  write cannot leave a phantom audit row, and a failed audit rolls back the write.
- `platform_audit_log`, `tenant_audit_log` and `impersonation_session` are
  **append-only**: no `UPDATE`/`DELETE`/`TRUNCATE` grant for `katkitchen_app`, plus a
  `BEFORE UPDATE OR DELETE` row trigger on the partitioned parent (row triggers
  propagate to partitions, including ones created later — PG13+).
- Audit rows store: actor, action, target tenant, before/after JSON, IP, user agent,
  request id, timestamp, and — on the tenant plane — `authorising_membership_id`, the
  membership whose role held the permission that allowed the action. NULL only for system
  and scheduled-job actors, which hold no membership. A write the permission check allowed
  but cannot attribute must be refused, never written unattributed.

### The audit posture gate is inverted, not method-scoped

**Every route declares its audit posture explicitly**, reads included:

```ts
audit: { action: 'customer.pii.viewed', target: 'customer' }
audit: 'none'
```

A missing field fails at **registration**, regardless of HTTP method. This is
stronger than "mutating routes must be audited", not weaker: `'none'` is greppable
and shows up in a diff, and silence does not.

### Ordering inside the unit of work

```
BEGIN
  set_config('app.tenant_id', tenantId, true)      ← before any query
  resolve authority + actor snapshot
  permission check          → 403, ROLLBACK, no audit row
  resolve authorising membership
    → null                  → 403, ROLLBACK, no audit row, no mutation
  capture BEFORE (FOR UPDATE on the target row)
  run handler
  capture AFTER
  write audit row
COMMIT
```

**Attribution is resolved before the handler runs.** Resolving after would mean the
mutation has already happened when we discover it cannot be attributed, leaving only
a rolled-back write that looks like a bug, or an unattributed audit row.

**The before-image is taken with `SELECT … FOR UPDATE`, through the same repository
the handler writes through.** A plain read is not enough: under READ COMMITTED a
concurrent transaction can commit between the read and the mutation, and the audit
row then records a before-state the mutation never applied to — an audit log that is
wrong in a way nothing downstream can detect. There is a test asserting a concurrent
mutation of the same row **blocks** rather than interleaving.

**An unattributable action returns `403`, never a distinct status.** The permission
check passing on a union no single membership supplies is an internal invariant
violation; a `409` would hand a prober a signal. It is logged at alert level with the
full authority resolution and should page someone.

**The actor name is snapshotted at authority resolution, not at write time.** If a
route mutates `app_user`, a write-time read under READ COMMITTED sees the handler's
own write and stamps the *new* name as the actor of the change. Reading before the
handler captures the actor as they were when they acted.

### A fixture upserts; it never deletes a tenant

Deleting a tenant to reset a fixture means enumerating every table that
references it, and that enumeration is a hand-maintained list next to a growing
schema — the same shape as `OWNER_WITHHELD`. It broke twice when
`platform.usage_counter` was added, in two different suites.

**Production never deletes a tenant either**: the ladder anonymises at day 135
and every FK to `platform.tenant` is `ON DELETE RESTRICT` on purpose. A fixture
that deletes one is testing a path that does not exist. Use a fresh id per run,
or upsert a fixed one.

### A membership that has acted cannot be deleted

`authorising_membership_id` is `ON DELETE RESTRICT` and audit rows are append-only, so
the history pins the membership in place permanently. That is the design working —
revocation is `status = 'revoked'`, never deletion. Test fixtures must upsert, never
tear down memberships.

### Erasure: deletion of staff records is not available, by design

This is a **stated position**, not an accident of two schema decisions colliding.

`tenant_audit_log` holds `actor_name` and `actor_email` snapshots. That is personal data,
in an append-only table, under a seven-year retention period. Two consequences follow and
both are deliberate:

- **A staff erasure request cannot be satisfied by deletion.** The lawful basis for
  continued processing is **legal obligation** — statutory retention of financial and
  point-of-sale records (books and records retention; the exact instrument is
  jurisdiction-specific and must be named per deployment in the tenant's DPA). Audit rows
  attributing a void, a discount or a refund to a named person *are* the financial record;
  removing the actor removes the control.
- **Purge at day 135 anonymises `app_user` in place.** Name, email and phone are scrubbed;
  the row, its memberships and every audit row survive. Referential integrity holds, the
  ladder completes, and the person is no longer identifiable from the live record while
  the historical attribution remains.

Anonymisation is the erasure mechanism. Deletion was never available and must not be
offered, promised in a DPA, or implemented later as a "hard delete" flag.

The `actor_name`/`actor_email` snapshots on audit rows are **not** scrubbed by purge:
they are the record. Where a jurisdiction requires their removal, that is a retention-policy
change with legal sign-off, not a code change.

### Audit at the domain-event level, not per row

A 40-item order writes **one** `order.confirmed` row, not 40, and the payload is the
aggregate root plus a line summary. The route's audit descriptor names one action; there
is no per-row capture hook to misuse.

This is safe because rule 9 below already makes voids, comps and refunds *new rows*
rather than mutations — **the domain tables are the fine-grained history.** The audit log
records who decided what, not what changed per row.

Payloads are capped at **64KB** per side, application-side, setting `payload_truncated`.
A pathological payload degrades to a marked row instead of bloating the write path.

### Audit tables are partitioned from the first migration

Monthly `RANGE` partitions on `occurred_at`, created while both tables are empty.
Converting a large table to partitioned later is a maintenance window, and in Phase 3
every order becomes an audit write.

- **The partition key must be in the primary key**, so the PK is `(id, occurred_at)`.
  This is a Postgres requirement, not a preference.
- **A `DEFAULT` partition is mandatory.** An insert with no matching partition raises;
  because the audit row shares the mutation's transaction, a missing partition does not
  fail auditing, it fails **every write in the product**. Monitoring asserts the default
  partition stays empty — a non-empty default is the alert that the partition job stopped.
- **Grants do not propagate to new partitions.** `ALTER DEFAULT PRIVILEGES` only affects
  objects created *afterward, by that role* — so the partition job **must run as
  `katkitchen_owner`** or the revokes silently do not apply.
- **RLS does not propagate to new partitions either.** Enabling RLS on the parent governs
  access *through* the parent; a partition accessed directly enforces its own
  `relrowsecurity` and its own policies, and a fresh partition has neither. The partition
  job therefore runs `ENABLE ROW LEVEL SECURITY` and creates the `tenant_isolation`
  policy on every new partition **in the same transaction as `CREATE TABLE`**, and
  `REVOKE ALL` on the partition from `katkitchen_app` so direct access is impossible
  regardless of policy state.

#### Runbook: recovering a stopped partition job

`ATTACH PARTITION` **fails if the default partition holds rows belonging to the new
range.** Recovery is move-then-attach, not attach:

1. `BEGIN;`
2. Create the target partition as a standalone table with the right bounds as a CHECK.
3. `INSERT ... SELECT` the matching rows out of the default partition and `DELETE` them
   from it — as `katkitchen_owner`, the only role that can delete from an audit table, and
   with the append-only trigger disabled for the duration of this transaction.
4. `ATTACH PARTITION`, re-enable the trigger, apply revokes and RLS.
5. `COMMIT;`

Write this down before you need it at 2am.

---

## Impersonation

- Max 60 minutes. Mandatory typed reason. Revocable.
- Tenant owner receives an email notification (via the outbox, never inline).
- Banner visible in the tenant app for the entire session, fed by the
  `x-impersonation-*` response headers the guard sets on every impersonated response.
- Read-only by default. Write access is a separate explicit flag with its own reason.
- Every write during impersonation is tagged `via_impersonation = true` in the **tenant's
  own** audit log.

### The token is a third shape, not a stripped tenant JWT

```jsonc
{
  "typ": "impersonation",       // discriminator, checked FIRST
  "sub": "<platform_user_id>",  // the human; never a tenant user
  "act_tenant_id": "<uuid>",    // NOT tenant_id
  "sid": "<impersonation_session_id>",
  "write": false,
  "iat": "...", "exp": "..."
}
```

`act_tenant_id` rather than `tenant_id` makes the shape **inert against both existing
guards without changing them**: no `tenant_id` so `/api/t/*` rejects it, no
`platform_role` so `/api/platform/*` rejects it. Adding a token type must not widen an
existing surface. Both guards *also* reject `typ === 'impersonation'` explicitly —
"rejected because a field happened to be absent" is the kind of accident that survives a
refactor; "rejected because it is the wrong token type" is not.

### The session row is authoritative; the token is only a reference

A signed JWT is a bearer credential and cannot be revoked. So `sid` is resolved against
`platform.impersonation_session` on **every request**, and the row — not the token —
decides `revoked_at`, `expires_at` and `write`. Server time decides expiry, so a
clock-skewed or reissued token cannot outlive the row.

- **The 60-minute cap lives on the row**, as `CHECK (expires_at <= created_at + interval
  '60 minutes')`. `exp <= iat + 3600` caps a *token*; reissue for eight hours and the cap
  is decorative.
- **Read-only is enforced at the guard**, before the handler and before a pooled
  connection is taken — not by a check inside handlers, which is one forgotten call away
  from a silent write.
- **The token's `act_tenant_id` must equal the session's `tenant_id`.** They originate
  separately; a reissue bug that let them diverge would be cross-tenant impersonation, so
  it gets its own error code rather than being folded into "not live".
- The session is **append-only with exactly one permitted transition**: the one-way
  revocation stamp. Not the reason, not the expiry, not the write flag — a session cannot
  be quietly widened after the fact.

### Availability coupling — accepted, and never cached

The per-request session read **couples impersonated tenant-plane requests to
control-plane availability**. This is the one place the tenant plane reads the control
plane per request, and it is deliberate: failing closed is correct, and immediate
revocation is the *entire* justification for the read.

**Never cache the session.** Any TTL is a window in which a revoked superadmin is still
inside a tenant. If the read becomes a performance problem the answer is a faster read,
not a cached one.

### What the ladder permits

| Tenant status | Impersonation |
|---|---|
| `purged` | **Refused outright.** There is nothing left to see. |
| `hard_lock` | **Permitted.** That is precisely when support is needed. |
| `retention`, `purge_pending` | **Permitted, read-only regardless of the write flag.** |

### Attribution during impersonation

A superadmin holds no membership, so `authorising_membership_id` is null for
impersonated writes. Rather than making null attribution legal again,
`tenant_audit_log.actor_kind` is an **explicit discriminator**:

```sql
actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'impersonation', 'system'))
```

with a three-way CHECK requiring exactly the right column populated for each kind —
`authorising_membership_id`, `impersonation_session_id`, or `actor_system_job`.

Keying on nullness would make **absence** the discriminator, and absence is never a good
one: the same reasoning that made `audit: 'none'` beat a missing field, and a NULL ACL on
schema `public` a failure rather than an absence of grants. `'system'` is a positive
declaration and **must name the job** — "the system did it" is as useless as unattributed.

`impersonation_session_id` is a **soft reference**, not an FK. The direction rule would
permit `app → platform`, but that rule is a proxy for what actually matters: `app` must
remain separable into its own database. `tenant` is unavoidable (it is the root) and
`permission` is immutable data seeded by migration; `impersonation_session` is neither —
mutable operational control-plane state, on the hottest path in the product. Validated in
the repository, like `tenant_owner_invite.accepted_user_id`.

Tenant permission checks are **skipped** during impersonation: there is no membership to
check against. The controls are elsewhere and stronger — the platform permission that
started the session, the guard's read-only enforcement, the cap on the row, and every
write tagged to the session in the tenant's own audit log.

---

## What superadmin can and cannot see

| Can see | Cannot see (outside impersonation) |
|---|---|
| MRR, invoices, payments, refunds | Individual orders or line items |
| Daily/monthly sales **aggregates** | Item names, discounts, voids |
| Order counts, average ticket | Customer names, phones, addresses |
| Branch-level totals, trends | Staff-level activity |

Sales aggregates reach the control plane via a **daily rollup job** writing to
`usage_counter`. The control plane **never queries the `orders` table.** Different access
path entirely.

---

## Suspension ladder — nothing is ever hard-deleted on day one

```
past_due    day 0    banner only, full access
soft_lock   day 7    read-only, no new orders
hard_lock   day 15   login blocked, data intact
retention   day 45   export available on request
purge       day 135  anonymise + drop, logged
```
Thresholds are configurable in platform settings, not constants in code.

### `tenant.status` is a cache; `delinquent_since` is the truth

Every threshold is measured from **day 0**. `status_changed_at` cannot supply it — once a
tenant moves `past_due -> soft_lock`, `status_changed_at` becomes the soft_lock date and
day 0 is lost.

`tenant.delinquent_since` is set on entry to `past_due`, cleared on return to `active`,
and **never touched by intermediate transitions**. `status` is the materialised result the
per-request auth path reads cheaply; `delinquent_since` plus the configurable thresholds
is what it is derived from.

```sql
CONSTRAINT tenant_delinquency_consistent CHECK (
  (status = 'active') = (delinquent_since IS NULL)
),
CONSTRAINT tenant_delinquency_ordering CHECK (
  delinquent_since IS NULL OR delinquent_since <= status_changed_at
)
```

A biconditional, deliberately — it catches both directions. `active` with a non-NULL
`delinquent_since` is a stale day 0 that will mis-date the next delinquency; any ladder
status with a NULL one has no computable threshold at all. Both operands are always
proper booleans (`status` is `NOT NULL`, `IS NULL` never yields NULL), so the constraint
can never evaluate to NULL — which a CHECK would silently treat as satisfied.

The ordering predicate guards a bug rather than a state: `delinquent_since` equals
`status_changed_at` at entry and stays put while `status_changed_at` advances, so it can
only ever be less-or-equal. If code reassigns it on an intermediate transition, this
catches it on write instead of silently re-basing day 0.

`purged` therefore requires a non-NULL `delinquent_since` — purge arrives only via the
ladder. Voluntary termination gets its own status in Phase 1 and this predicate relaxes to
set-membership then. Strict now, because relaxing a CHECK is a trivial reversible
migration and tightening one requires a backfill.

---

## Provisioning

Creating a tenant is a **single transaction**: tenant + subscription + seeded defaults
(system roles, permissions, tax slabs, base categories, units) + owner invite.

- Must be **idempotent** — safe to retry.
- Must be **rollback-safe** — partial failure creates nothing.
- Side effects (invite email, webhooks, search index) go to an **outbox table** drained by
  a worker. Never inline in the transaction.
- Superadmin **cannot set** a tenant user's password. Invite token only; the client sets
  their own. **One exception since 0077:** the Sales person (and Super Admin) set the
  4-digit PIN of a restaurant's STAFF -- never a manager's credential, never a password --
  see "Basic only" below. The control plane never sets a password. `tenant_owner_invite` has no secret column at all — the schema enforces this,
  not a code review. Only the SHA-256 `token_hash` is stored; the raw token never is.
- Provisioning creates **two** memberships for the owner, not one: `owner` tenant-wide
  **and** `cashier` at the first branch. Owner deliberately does not hold
  `payment.collect`, and most of the market is single-outlet — an owner-operator who
  cannot take a payment on day one is a broken first run, not a support ticket.
  Phase 4 adds a third (`accounts`) once the vendor master exists, for the same reason.

---

## Entitlement enforcement

- Control plane publishes an `entitlement_document` per tenant on every subscription
  change -- provisioning, a plan switch (immediate upgrade or deferred downgrade),
  deactivation, dunning -- through `publishAndAnnounce`, in the same transaction,
  with an `entitlement.invalidate` outbox message.
- Tenant plane caches it (Redis, 5 min TTL). The invalidation consumer DELETES the
  entry; it never writes one.
- Breach returns `402 upgrade_required`, naming the cheapest plan that includes it.

### What a plan includes is one definition

`ENTITLEMENTS` in `packages/shared/src/constants/plans.ts` -- branches, tablets
(`devices`), `kot` (the separate order-taking flow: KOT Staff, kitchen tickets,
the billing hand-over), `kds` (the kitchen screen) and a report tier (`basic` |
`advanced`, stored as the boolean flag `reports_advanced`). It seeds Basic,
Standard and Pro (0067) -- Max was retired in 0064 -- after that the published plan version is
the truth, and everything reads a version through `entitlementsFromTerms`. The API
gates and the admin menu (`getAdminMenu`) read the same function, so a menu entry
that always refuses, or a paid feature with no menu entry, cannot happen.

**Every plan version states every key** (`validTerms` refuses one that does not).
An absent key denies, so a version missing `devices` would silently stop every
restaurant later moved onto it from enrolling a tablet.

### The gate is declared on the route

`RouteDefinition.plan` is `{ feature }` | `{ reports }` | `{ limit }` | a LIST of those
(all must hold; features and tiers are checked before limits, so a plan that excludes the
thing outright says so rather than quoting a limit) | `'document'`,
checked by the tenant registrar after the permission check and before the handler.
Same reasoning as the lease: a check a handler performs is one a handler can forget.
`tests/http/planGates.test.ts` asserts every route whose permission key is in a
plan-decided namespace (`kds.`, `kot.`, `report.`) declares the matching gate,
with a synthetic route written without one. A gate registered with no cache refuses to boot.

`{ reports: 'basic' }` is every plan and checks nothing -- declared so the route is
visibly decided. The dashboard's sales report and the offline-sync quarantine list
(which borrows the exception report's KEY, not its tier) are the two.

**Limits are counted under a transaction-scoped advisory lock** (`planUsage.ts`), or
two concurrent creates both count below the limit. Tablets count at TOKEN ISSUE, and
unused unexpired tokens count too: the public enrolment route has no plan to check,
and an unused token is a tablet waiting to happen. A downgrade does not compare
`devices` (it is not a metered usage counter), so existing tablets keep working and
only new enrolments are refused -- a billing job must never take a restaurant offline.

### The kitchen screen is a plan term (DECIDED, 0067; replaces 0066)

> **Superseded (0077): the kitchen screen was removed and only Basic is sold.** The
> `kds` feature is still stated on every plan version (`validTerms` requires every
> key) but no route reads it. The table below is the history of what was sold.

| | Basic | Standard | Pro |
|---|---|---|---|
| KOT, printed kitchen tickets, Billing | yes | yes | yes |
| Kitchen screen (`kds`) | no | no | yes |
| Branches | 1 | 1 | 3 |
| Tablets / reports | 2 / basic | 4 / advanced | 6 / advanced |
| Restaurant users (0071) | 4 | 8 | 25 |
| Staff tablets with setup codes (`staff_tablets`, 0074) | no | yes | yes |
| Floors, floor types and tables (`tables`, 0075) | no | yes | yes |

0066 made the kitchen screen a per-restaurant switch (`platform.tenant.kds_enabled`)
the Sales Person set at the sale. 0067 dropped the column: a switch beside the plan
is a second opinion that can disagree with what was sold. `kds` is now a
`PlanFeature` every version states, `entitlementsFromTerms` derives
`kds = kot AND features.kds`, and the six `kds.*` routes gate `{ feature: 'kds' }`
-- so Basic and Standard get the ordinary `402 upgrade_required` naming Pro.
"Additional branches" is the existing `branches` limit (1 on Basic and Standard),
gated on branch create. 0067 gave every existing version `kds = kot` (what every
restaurant effectively had) and Basic `kot`, so nothing was taken away.

A plan change moves both with nothing else to touch: an upgrade publishes at once,
a downgrade at the period boundary (`applyDueChanges`), each through
`publishAndAnnounce`. Asserted end to end, Basic -> Standard -> Pro -> Standard ->
Basic, in `tests/http/planGates.test.ts`.

Without a screen nobody advances kitchen lines, and a line left `queued` reads as
cooking forever: parcel hand-over refuses, the floor says "cooking". So KOT holds
`kot.ready` and `POST /pos/kot/:id/ready` moves a ticket's live lines to `ready`.
It used to be refused (`kitchen_screen_marks_ready`) where a screen ran, so one place
said "ready". With the screen removed (0077) KOT IS that one place, on every plan
version: a retired version still naming `kds` would otherwise leave nobody able to
release food. The refusal and its error code are gone.

### A cache miss is filled from the document table (DECIDED)

The cache was warmed at boot and every entry expired after five minutes with nothing
to refill it; nothing read it, so nobody noticed. A strict fail-closed read would
have refused every gated route five minutes after each deploy, and a restaurant
created after boot would never have had an entry. `resolveEntitlement` therefore
reads the newest document on a miss, on the request's own connection, and puts it
back: at most one read of `platform.entitlement_document` per restaurant per TTL.
A Redis ERROR is treated the same way -- Redis down is a reason to go to the source,
not to switch off stock control for every restaurant. Only a restaurant with no
document at all fails closed (503 `entitlement_unavailable`).

This relaxes "the tenant plane never reads the control plane per request" to **"at
most once per restaurant per TTL, on a miss"**. It is a read of the published
document, the one thing that flows down; it is not a call into control-plane logic.

---

## Data quality checks (nightly, alerting — not test-only)

- **An active `app_user` with no active `credential`.** This is cross-table cardinality
  and cannot be a CHECK; a deferred constraint trigger fires on both tables and deadlocks
  under concurrent credential rotation. It is a silent lockout and it *will* happen during
  rotation, so it alerts rather than merely failing a test.
- **A non-empty `DEFAULT` audit partition.** Means the partition job has stopped.

  **This alert was unfalsifiable for most of the project's life, and that is the more
  important lesson than the alert itself.** The reporting fixtures write *backdated*
  audit rows — the exception report ranks an actor against their own prior baseline, so
  it must — and `ensure_audit_partitions` loops from the current month **forward**, so
  there was no partition for those months and 280 rows sat in the default permanently.

  A permanently dirty default is worse than no monitoring: on the day the job really
  stops, someone looks at a non-empty default and recognises the noise they have been
  ignoring for months. This is the same argument that put a deliberately misconfigured
  statement-mode PgBouncer in the local stack — **a check whose failing direction is
  never observed is a check nobody has shown to work** — and the default partition had
  no equivalent.

  Fixed in the **fixtures, not the check**: `app.ensure_audit_partition_for(ts)` (0045)
  factors the per-month DDL out of the forward-window loop so a month can be addressed
  directly, and a fixture writing a backdated row calls it. There is still exactly one
  copy of the `CREATE TABLE`, the `REVOKE` and the RLS policy — a second copy in a test
  helper would be the derived-versus-adjacent failure, drifting the first time a grant
  changes. `tests/hooks/defaultPartitionEmpty.ts` then asserts the default is empty
  after **every test file**, so a future fixture that backdates without a partition fails
  in the suite that did it rather than accumulating into unattributable noise.
- **A `stock_balance` moving average outside the range of every price ever paid for
  that product at that branch.** Two distinct bugs have produced this, so it is an
  envelope check rather than a regression test. Alert-only, never auto-corrected.
- **A `stock_balance` that disagrees with the fold of `stock_movement`.** Reported,
  never repaired: the gap is the diagnostic.
- **Any FK originating in `platform` and terminating in `app`.**
- **Any `app` table without `tenant_id NOT NULL`, RLS, or a `WITH CHECK` policy** —
  parents and partitions alike.
- **Anyone who exercised both sides of a separation rule.** Not who could — who did:

  ```sql
  SELECT actor_user_id, count(*) FILTER (WHERE action LIKE 'payment.collect%') AS collected,
         count(*) FILTER (WHERE action = ANY($adjustment_actions))              AS adjusted
    FROM app.tenant_audit_log
   WHERE tenant_id = $1 AND occurred_at >= now() - interval '1 day'
   GROUP BY 1 HAVING count(*) FILTER (WHERE action LIKE 'payment.collect%') > 0
                 AND count(*) FILTER (WHERE action = ANY($adjustment_actions)) > 0;
  ```

  `authorising_membership_id` makes the same question answerable per capacity.

---

## The menu catalogue

The menu is a **tenant-level catalogue**. A two-outlet tenant maintains one menu and
charges more at the airport. Branch differences are listing, price, availability and
routing exceptions — never a second menu.

### The priced-document rule

> **Every number that can appear on a bill is snapshotted onto the order line at the
> moment of order. A bill never dereferences a catalogue row for a value.**

Snapshotted: `unit_price_minor`, **every selected modifier's `price_delta_minor`**,
`display_name`, `tax_class_key`, `tax_rate_bps` and the component split.

Modifier deltas are the ones that get forgotten because they *feel* like configuration.
They are not: "extra cheese +₹30" is a line on the bill, and when it becomes +₹40 the
historical bill stops reconciling to its own line items.

Tax rate is snapshotted for the same reason — GST rates get revised, and a reprint must
match the paper. Display name too: items are archived rather than renamed, but a display
name change is legitimate, and a reprint that disagrees with the original is a problem in
a dispute.

Kept as a reference but **never read for a number**: `menu_item_id`, `modifier_option_id`.
They exist for reporting joins, not arithmetic. The order line is wide and denormalised on
purpose; that is not sloppiness to be normalised away later.

This is what makes catalogue price, modifier deltas and tax rates safely **mutable**.

### Combos: components at allocated prices, under a money-less parent

A combo is priced as a unit at a discount to component sum. Where components carry
different tax rates — food 5%, beverage 12%, ordinary in most Indian states — the combo
**cannot be taxed as an opaque unit**.

```
order_line (kind='combo_parent')   price=NULL  display_total=29900
  |- (kind='combo_component')  allocated=20930  tax=food_5       station=grill
  +- (kind='combo_component')  allocated= 8970  tax=beverage_12  station=cold
```

The bill **displays** one line; the GST return **reads** the components. One priced line
with non-priced children is not an option: the allocation would have to be recomputed at
return time from live catalogue prices, which violates the priced-document rule and
produces a return that disagrees with the bill it came from.

Allocation is **pro-rata by extended list price with largest-remainder rounding**, ties
broken by `display_order`. Naive rounding leaves components summing to 298.99 or 299.01;
over a month that is thousands of one-paise discrepancies in a return that must balance
exactly. A line-level discount on a combo allocates identically, or discounting changes
the tax mix.

**The allocation invariant is verified before COMMIT, by a `DEFERRABLE INITIALLY DEFERRED`
constraint trigger on `order_line` firing over the parent's component set.** Not a nightly
check. The precedent of "an active user with no credential" does not transfer: that is
recoverable — you notice, you fix it — whereas a combo whose components do not sum to the
parent has already been printed on a bill and filed in a GST return. Nightly is too late.
The rows are inserted in one transaction, so this is enforceable at write time.

### Branch overrides: listing and price are separate tables

`branch_menu_listing` and `branch_menu_price`, not one table. Combining them looked tidy
until the FK proved otherwise: the pinned catalogue copy exists so a catalogue rise
re-checks every override, and a delisting row — which exists solely to say "we don't sell
this here" — would be dragged into that cascade, could abort a price change it has no
opinion about, and would carry a `NOT NULL` price copy it will never use.

**Overrides may only RAISE**, enforced by a CHECK against a pinned catalogue copy behind
`ON UPDATE CASCADE` — the same mechanism as `role_assignable_scope` on `membership`. A
catalogue rise that would strand an override below it **aborts, naming the conflict**,
rather than silently lifting branch prices nobody was looking at.

A lower branch price would be an uncapped discount channel with no reason code, routing
around everything built for `order.discount`. Lowering is a **promotion**: Phase 5, own
key, own audit trail.

**Branch modifier deltas are deliberately absent, and `branch_modifier_override` is the
wrong extension.** What an operator wants is "everything +15% at the airport" — a branch
price **multiplier**, not forty individual override rows. When it is built, it is a
multiplier.

### Availability is three concerns and they do not share a table

| Concern | Table | Grain | Lifecycle |
|---|---|---|---|
| **Listed** | `branch_menu_listing` | branch x item | permanent, configuration |
| **In service** | `service_period` + attachment | item x period | a schedule |
| **Sold out** | `branch_item_availability` | branch x item x **business date** | resets daily |

Absence means listed, unrestricted and available — sparse tables with no N x M maintenance.

Service periods are **named tenant reference data**: define "Breakfast 07:00-11:00" once
and attach forty items, rather than editing forty rows to move breakfast to 07:30. Periods
wrap midnight (`starts_at > ends_at`) and evaluate in **branch-local** time.

Sold-out is keyed by **business date**, which is what makes "resets daily" true with no
reset job. The business date is **not UTC midnight**: a restaurant's day ends at 3am, so it
derives from branch timezone plus `branch.business_day_starts_at`.

**Precedence at order time is most-permanent-first**: listed -> in service -> sold out. All
three deny, so the order does not change *whether* the item sells; it changes what the
waiter is told, and that drives what they do next. An item both out-of-hours and 86'd must
say "available from 07:00" — "sold out" implies come back later today, which is wrong.

One boolean across all three is what makes a POS wrong at 11:01am, because whoever cleared
the sold-out flag at closing also cleared the breakfast restriction.

### Routing: a tenant vocabulary realised per branch

The menu is tenant-level; `kitchen_station` is branch-scoped. So an item names a
`station_code` from `app.station_code`, and each branch realises the codes it has.
`branch_item_routing` is the exception.

**A modifier option routes independently** — "add a lassi" on a thali is prepared where the
thali is not. So **station routing is a property of the resolved line component, not the
menu item, and KOT splitting groups by resolved station across the item and its selected
modifiers.** One order line can produce two KOT entries.

**There is no default-station fallback.** A default means food silently appears at the
wrong counter: the cook does not know it is wrong, the waiter does not know it is coming,
and it surfaces as a customer complaint an hour later. Unroutable is refused at **listing
time**, where someone is looking at a setup screen. The reverse is enforced too: archiving
a station that listed items still route to is refused, **naming the items**.

### Tax class on the item, never the category

`menu_category` carries **no** tax class, no station, no availability, no price. Categories
are merchandising and get reorganised; a tax class that moves when someone renames a
category is a GST return that stops reconciling. Rates are in **basis points**, integer,
with the CGST/SGST split as a child table because it varies by jurisdiction.

Effective-dating of rate changes is not needed for historical correctness — the
priced-document rule handles that.

**CGST, SGST and IGST are SHOWN, never typed (DECIDED 2026-10-20).** A request for
CGST % / SGST % / CESS % fields on the menu item was declined in that form: a food
item keeps ONE GST rate (its tax class), and the heads stay derived per bill from
the place of supply (migration 0050 removed owner-typed heads because a free-text
head made returns report zero). Two inputs would allow unequal halves -- illegal
-- and cannot express IGST. Instead `GET /admin/tax-splits` (`tax.class.view`,
`modules/tax/taxSplits.ts`, through `TaxClassRepository`) returns each active
class's heads per taxing treatment, computed by `headRateBps` -- the ONE function
`splitHeads` also uses for the printed rate, so the screen and the bill cannot
disagree. The Tax rates page ("On a bill" column) and the food item form show it
read only. **CESS is not built**: restaurant service carries no compensation cess
as far as anyone here knows; adding one is a new head that ADDS a rate rather than
sharing one (catalogue, `assert_bill_line_heads_match_treatment`, billing, print,
the GST return), and it is a change for a GST filer to confirm first.

### Modifier groups are reusable and tenant-level

"Sugar level" belongs to every drink. The **attachment** is per item, with per-attachment
`COALESCE` override of the bounds; overrides may widen or narrow, since selection counts
are not money. `max_select` NULL means "the other bound binds", not unlimited — the same
reading as a NULL discount amount cap. Negative deltas are allowed ("no cheese -30"); the
invariant that a line total cannot go below zero belongs to Phase 3.

Copying groups per item would also give "less sugar" forty different ids, making "how often
do people order less sugar" unanswerable.

A combo **choice** option must be a menu item, not a modifier option — it needs its own tax
class and station routing — which is why `modifier_group` cannot serve and
`combo_choice_group` exists.

### The exception report has two sections

`permission.risk_subclass` is `transaction | configuration`, required exactly when
`risk_class = 'financial'` and forbidden otherwise. `report.exception.view` derives its
sections from that column, not from an enumerated key list, so a new financial key lands in
the right section without anyone editing anything.

An owner scanning for till fraud should not have to page through menu edits; someone
auditing configuration drift should not have to page through voids.

---

## Operations (Phase 3)

Phases 0-2 were configuration: forgiving, single-user, no money. This is concurrent, has
money in it, and runs on a terminal with bad wifi in a room where nobody can stop to debug.

### Partitioning a table whose correctness rests on a unique constraint

> **A partitioned table's PRIMARY KEY and UNIQUE constraints must contain the partition
> key. So partitioning a table whose correctness depends on uniqueness requires the
> partition key to be part of that constraint — otherwise the constraint is gone.**

`request_claim` is the case that makes this concrete. The obvious move is to partition by
`created_at` and drop old partitions, which is cheap and idiomatic. It also silently
destroys the guarantee: the PK becomes `(tenant_id, idempotency_key, created_at)`, two
claims with the same key at different times both insert, and the deduplication the whole
mechanism rests on stops working. It would look like a working system for months and then
double-charge someone.

So `request_claim` is `PARTITION BY HASH (idempotency_key)`. The partition key is already
in the PK, the same key always routes to the same partition, and **global uniqueness is
preserved**. Retention is a batched `DELETE` per partition rather than a `DROP` — more
expensive, parallelisable, and correct. Window: **7 days**; a "retry" after seven days is
a new request.

Before partitioning anything, ask what uniqueness that table depends on, and whether the
partition key is inside it.

### Display numbers may gap; identities may not

`kot.sequence_no` is a **display** number. The identity is the UUID.

If the sequence were the identity, an offline terminal could not fire at all — gaplessness
is a global property and a disconnected terminal cannot see the other tickets. Keeping
identity separate from the display number is the decision that keeps offline possible, and
it is why `sequence_no` is **nullable**.

Generally: anything a human reads aloud may be null and may gap. Anything a foreign key
points at may not.

### Gapless sequences use a counter row, never a SEQUENCE

Kitchens call numbers out loud, and a gap means someone believes a ticket was lost and
re-cooks it. Gaplessness has to be provable, not likely.

A Postgres `SEQUENCE` is **disqualified**: sequences deliberately do not roll back, so
every aborted fire burns a number. `SELECT MAX(seq)+1` races into duplicates.

The mechanism is an ordinary counter row, `UPDATE … SET next_no = next_no + 1 … RETURNING`.
It is gapless *because it is an ordinary row update* — the increment participates in the
transaction, so an aborted fire aborts the increment. Counter value is the count of
committed tickets, by construction.

Two sequences, for two different readers:

- **`fire_sequence`** — per branch per business date, allocated once per fire and stamped
  on every KOT in it. This is the number a dispute is traced by and the number the
  exception report shows. Without it, "the thing the waiter sent at 20:14" is a four-way
  join through `order_id` — a fire touching four stations allocates four independent
  station numbers and none of them identifies the fire.
- **`kot_sequence`** — per station per business date, for the kitchen's verbal use.

### The global lock order for the fire transaction

Sorting station counters by id stops two fires deadlocking against each other. It does
**not** stop a fire deadlocking against the fire counter, the session's optimistic update,
or the claim row. A fire acquires four kinds of lock in one transaction, so the order is
global and written down:

```
request_claim  ->  table_session  ->  fire_sequence
               ->  station counters (sorted by station id)  ->  inserts
```

Every path that touches more than one of these acquires them in that order. The written
rule is worth more than the sort, because the sort only covers one of the four pairs.

### Void, comp and discount are new rows with an explicit kind

| kind | quantity | money |
|---|---|---|
| `item` | > 0 | > 0 |
| `combo_parent` | > 0 | NULL (display total only) |
| `combo_component` | > 0 | allocated |
| `void` | **< 0** | < 0 |
| `comp` | **0** | < 0 |
| `discount` | **0** | < 0 |

Positive rows create obligation; negative rows reduce it; `kind` says which kind of
reduction. **`SUM(quantity)` is the truth, and it is the truth because the sign is real** —
the discriminator is what stops a void being mistaken for a sale, so the sign does not have
to carry that job as well.

**Void is `quantity < 0`; comp is `quantity = 0`.** A void means the food was not delivered
or was binned, so sales quantity falls. A comp means it *was* delivered, free, so sales
quantity stands and only money goes to zero. "How many did we make" and "how many did we
sell" are different questions and this is where they separate.

**Neither reverses a stock deduction**, because the kitchen consumed the ingredients when
it started cooking. That is the same rule that forbids deducting at payment.

The adjustment's money is **pinned to the row it adjusts** by composite FK
(`adjusts_line_id`, `adjusted_unit_price_minor`), so it cannot be re-derived from a live
catalogue price.

### Pre-fire correction mutates the line; post-fire does not

3 samosas to 2, before the ticket fires, is an **edit** — `order.line.remove` — not an
adjustment.

The justification is not that it is cheap. It is that **the exception report's value is
inversely proportional to the noise in it.** Force pre-fire typo corrections into void rows
and every waiter generates a dozen "voids" a shift; within a week nobody reads the report,
and the actual fraud is sitting in it unnoticed. That boundary is the entire reason
`order.line.remove` and `order.void` are two keys.

`fired_at IS NULL` is the gate, enforced by a `BEFORE UPDATE` trigger — a temporal
immutability rule no CHECK can express.

### Adjustment reasons are typed, tenant-extensible, and scoped by kind

Four free-text columns nobody can aggregate is exactly the outcome to avoid; the exception
report is worthless without a groupable reason. `adjustment_reason` is tenant reference
data like `table_type`, seeded with a default set, and **scoped by which adjustment kinds
each reason applies to** — enforced by composite FK, so "customer walked out" cannot be
selected for a discount.

### print_job: row in-transaction, delivery async

The `print_job` **row** is created inside the fire transaction. The print **attempt** is
not.

Printing is I/O against a device that fails constantly, and holding the fire transaction
open across it puts a paper jam in the critical path of the till. Retry comes from the
queue with backoff; on exhaustion the job moves to the station's fallback printer. A job
that never succeeds must be visible in Operations/System health — the print-job failure
rate is its consumer.

**The transport (0065) is network-only, and refusing the rest is the design.** The
worker sends `renderTicket`'s text as raw ESC/POS over TCP to `printer.address`
(`host[:port]`, 9100 default, 5 s timeout). A USB or Bluetooth printer hangs off a
device in the restaurant and cannot be reached from the server, so the send
**throws** -- which is what walks the job to its fallback. A transport that
"succeeded" for a printer it cannot reach would mark the ticket accepted and lose it.
The KOT screen reads the same jobs (`GET /pos/order/:id/tickets`) and its tablet
copy is the same `renderTicket` text, marked a reprint once the kitchen has one:
there is one renderer and one queue, never a second printing path.

### Deferred constraint triggers: one family, three members

`DEFERRABLE INITIALLY DEFERRED`, firing at COMMIT:

1. **Combo allocation balances** — sum of components equals the parent's display total.
2. **Adjustments do not exceed the original** — net quantity and net money per line stay
   at or above zero.
3. **Sum of tenders equals the bill total.**

Same reasoning for all three: the rows are written in one transaction, and by the time a
nightly check runs the bill is printed and the return is filed. Nightly is too late for
money.

---

---

## Inventory (Phase 4)

### Two things that look like bugs and are not. Do not "fix" either.

**1. Cross-dimension unit conversion is legitimate.** `product_unit` converts a
`count` unit to a `mass` unit — `bunch` -> `g` — and that is the entire reason
conversions are per-product rather than global. A bunch of coriander is a weight
that varies by supplier, so a global `bunch = 80g` is wrong for everyone the
moment there is a second supplier. `unit.dimension` exists for UI grouping and for
seeding standard conversions; it is **not** an integrity rule. Adding a CHECK
requiring the unit's dimension to match the product's base dimension looks like
tightening and would forbid the only interesting conversions.

**2. The recipe-level graph may cycle; the version-level graph cannot.** Recipe A
version 2 may reference recipe B, while recipe B version 1 references recipe A
version 1. Drawn at the recipe level that is a cycle, and a cycle-detection pass
over `recipe` will report one. It is not a defect: every `recipe_line` references
a specific **published version**, and `recipe_line_references_backwards` requires
`sub_publication_seq < parent_publication_seq` against a tenant-wide monotonic
counter. A version can only ever reference versions published before it, so the
version graph is a **DAG by construction** — no recursive cycle search, no runtime
check. Do not add cycle detection over `recipe`; it will fire on legitimate data,
and the thing it claims to protect is already impossible.

### Yield is a product property, snapshotted but NOT pinned

`product.yield_bps` is one number per product; if it lived on the recipe, every
recipe using onion would carry its own copy of 0.85 and they would drift.
`consumed_base = quantity_base * 10000 / yield_bps` is computed **once, at
publish**, so per-order deduction is a pure integer multiply with no rounding
drift accumulating into variance.

`recipe_line.product_yield_bps` records which yield produced that figure. It is a
**plain column, deliberately not a composite FK** to `product(yield_bps)`.

The denormalise-and-pin pattern (`membership.role_assignable_scope`,
`branch_menu_price`) constrains a **current** relationship and cascades. A yield
snapshot is a **historical** record. Pinning a historical value to the live one is
self-contradictory, and it makes `product.yield_bps` uneditable outright: every
published recipe holds the old value, so the FK rejects the UPDATE.

That failure mode is precisely what makes people compute yield at deduction time,
which destroys the whole design. So correcting a yield is a **bulk republish**
(`republishForYieldChange`), which walks the dependents by recursive CTE and
publishes a new version of each. History keeps the old figure; new orders use the
new one.

### The missing-recipe gate is entitlement-scoped, not absolute

The station-routing check can refuse a listing outright because stations and menu
items are both Phase 2 — the tenant has both in front of them. Recipes are Phase
4, and blocking listing on a published recipe would mean nobody can sell anything
until every recipe is written: weeks of work for a 200-item menu, and an abandoned
onboarding.

- `features.inventory` **off** -> warn.
- `features.inventory` **on** -> block. A tenant paying for stock control and
  silently getting no deduction is worse than a blocked listing.

Same machinery as every other entitlement check; no new concept.

### The stock ledger

`stock_movement` is append-only and `stock_balance` is its fold, maintained by
trigger. The balance is a **cache** that exists so the POS does not sum a million
rows to decide whether it can sell a dish; the nightly reconciliation is what
proves it still agrees.

**`stock_movement` is deliberately NOT partitioned.** The `request_claim` rule
applies and gives the opposite answer, which is exactly why it is asked rather
than assumed: correctness rests on `UNIQUE (tenant_id, dedupe_key)`, so time
partitioning would make that uniqueness per-partition and a retry across a month
boundary would double-deduct. Hash partitioning by `dedupe_key` would preserve it,
but `dedupe_key` is NULL for manual adjustments and counts. And the retention
story differs in kind — audit partitions can be dropped because nothing derives
from them, whereas the balance *is* the fold of this table and dropping old
movements destroys its provenance.

#### No path reverses a deduction

`consumption` and `waste` are **structurally negative** in
`stock_movement_shape_exact`. There is no positive counterpart and no
`consumption_reversal` kind, so a reversal is not merely something no caller
currently does — it is not a state the schema can hold. A returned dish is
`waste`: the ingredients were consumed, and the loss must appear on **both** the
stock number and the wastage number rather than vanish from each.

#### Costing: weighted average, and the two places naive WAC breaks

Value is carried as `value_micro` (minor units x 10^6) because a per-unit cost is
a division, and rounding it at every issue accumulates into precisely the variance
the report exists to explain. Rounding happens once, at presentation.

Naive WAC breaks in two reachable places, and neither is clamped:

1. **Issuing against a zero or negative balance has no cost basis.**
   `(old_qty * cost + new) / new_qty` with `old_qty` negative produces a unit cost
   **outside the range of every price ever paid**.
2. **`new_qty` can be exactly zero** — a division by zero, not a rounding
   question.

The issue is split where the balance runs out. The backed part is valued at the
running average; the remainder accumulates into `unbacked_qty_base` /
`unbacked_value_micro` at the sticky `last_unit_cost_micro`.

**A zero-clamp alone understates COGS permanently.** So when a receipt lands
against unbacked quantity, the true cost is finally known and a **retrospective
`cost_adjustment` movement** is emitted: quantity zero, value
`fill_qty * (actual_unit - assumed_unit)`. `cogsForPeriod` includes those rows;
excluding them would restore the understatement they exist to remove.

Two consequences that are easy to get backwards:

- **The filled portion never becomes stock on hand.** It was consumed before it
  arrived, so its value leaves the balance with it. Otherwise the correction is
  counted **twice** — once in COGS now, and again in the inflated unit cost of
  every later issue. (Caught by test, not by review: on-hand came out at 3.75 a
  unit when 3.00 was the only price ever paid.)
- **Only a `receipt` carries price information.** Stock *appearing* at a count, or
  arriving on a transfer, is not a purchase: valuing it at zero would reset the
  cost basis to zero. Non-receipt inbound is valued at the running average and
  leaves `last_unit_cost_micro` alone.

### Reconciliation alerts. It never corrects.

When the cached balance and the ledger disagree, one of them is wrong and the job
**cannot know which**. A silent re-fold papers over the bug that caused the drift
and leaves the next stock take measured against a number nobody can trace to a
movement.

Worse, auto-correction **destroys the evidence**. The gap between ledger and cache
*is* the diagnostic; overwriting it erases the only signal, and the same bug then
runs for another month unobserved.

A drift that is real and understood is corrected by an `adjustment` movement with
a reason and an actor, posted by a human — a stock correction has to be a decision
with a name on it. There is a test asserting `reconcile.ts` contains no
`INSERT`/`UPDATE`/`DELETE` against `app.` at all.

**`inventory.negative` is a BRANCH alert, not platform system health.** It belongs
on the branch's own Operations screen, in front of the manager who can fix it.
Routing it to the control plane would be a stock-data leak into a plane not
permitted to see stock outside impersonation — and a superadmin cannot act on it
anyway.

### Counts value against the snapshot, never the live balance

`stock_count_line.expected_qty_base` is captured when the sheet is generated.
Service continues while someone counts the walk-in, so re-reading the balance at
approval time charges the counter for every sale that happened during the count.
Only approval posts; a counted-but-unapproved sheet moves nothing, which is what
makes `inventory.count.approve` a real second key rather than a formality on top
of `inventory.count.perform`.

### Purchasing

**Partial receipt is the normal case**, not an exception — a supplier short-ships
and the kitchen still needs what arrived. So a receipt is its own document with
its own lines and a PO may have many; "fully received" is computed from the lines
rather than tracked in a counter that would drift on the first cancelled receipt.

**Stock is valued from the invoiced line total, not the PO line.** Valuing a
receipt at the ordered price hides every supplier price rise inside stock
variance, which is the one report where nobody would think to look for it. The
total is the authority and the per-unit price is informational: an invoice states
a line total, and deriving it from a rounded per-unit price over a fractional
quantity disagrees with the paper by a few paise on every line.

**Over-receipt is permitted, bounded and explained.** Refusing it outright means
the goods are in the walk-in and not in the system, which is worse than a recorded
exception. The tolerance is `branch.over_receipt_tolerance_bps` — tenant policy,
not a constant in code, same reasoning as the ladder thresholds — and any
over-receipt within it still requires a reason.

`supplier` uniqueness is partial on `status = 'active'`, per rule 11.

---

## Offline POS (Phase 5A)

### The locality rule

> **An operation may go offline when its invariant is LOCAL to the aggregate the
> device holds. It may not when the invariant is GLOBAL across devices.**

"Anything touching money" was the original heuristic and it is a *proxy*:
settlement is forbidden because closing a bill is a **consensus** act, not
because money is special. Stating it as consensus is what lets you place the next
operation without re-litigating a list of forbidden nouns — and it catches what
the money framing misses: **firing a KOT is not local either**, unless something
guarantees a single writer. Two terminals holding one session offline both fire
the same lines: two KOTs, two stock deductions, one order.

| Entity | Offline | Policy |
|---|---|---|
| session open | yes | lease claim; conflict → new session, flagged |
| order line add | yes | append; disjoint client UUIDs |
| order line pre-fire edit / remove | yes | no conflict possible — only the lease holder writes |
| fire / KOT | yes | idempotent on client fire id; `sequence_no` assigned at sync |
| stock deduction | queued | outbox, drained in business-date order |
| bill generation, tender, refund | **no** | consensus |
| void of a fired line, comp, discount | **no** | adjustments need live authority and the exception report |

**The forbidden set is internally coherent, and that is not a coincidence:
everything in it is downstream of settlement.** A waiter who cannot void a burned
dish offline has lost nothing, because they could not have settled the bill
either — the void is recorded on reconnect, before anything is owed.

### The session lease is the single mechanism

Everything in the allowed column rests on this and nothing else.

- **Keyed on the SESSION, never the table.** A party moving from table 4 to
  table 7 keeps one session; `table_session_table` already models that as a
  relation. A table-keyed lease would split at the move, hand table 7 to another
  device, and reintroduce the double writer it exists to prevent.
- **15 minutes, renewable.** A long lease means a dead tablet blocks a table for
  the length of the lease. The failure mode of "too short" is a renewal round
  trip; the failure mode of "too long" is an unusable table mid-service.
- **The cap is on the ROW**, as `expires_at <= COALESCE(renewed_at, claimed_at) +
  interval '15 minutes'` — same reasoning as the impersonation cap living on the
  session row rather than the token. Note the `COALESCE`: capping against
  `claimed_at` alone makes renewal impossible, because the second grant is already
  past it. That turns "short and renewable" into "short and then dead".
- **Expiry is absolute and only renewal moves it**, which is what makes *a device
  going offline gets its REMAINING window, not a fresh one* true with no separate
  mechanism to get wrong: a disconnected device cannot renew.
- **Server time decides**, never the device clock.
- **A lease has its own id; the session does not key it.** Per rule 11 — a session
  is leased many times over its life, and a PK on `session_id` would let exactly
  one lease ever exist, silently making the partial `one live lease` index
  decorative.

**Force release** (`table.session.lease.force_release`, escalation-class, manager,
reason required) deliberately creates the split the lease prevents: for a window,
two parties believe they own the session. That is survivable **only** because
everything the stranded device later sends is **quarantined, never merged**.

### The offline window and claim retention are ONE constraint

Sync idempotency rests on `request_claim`. Once those claims are purged, a
resynced batch applies again as if new — against money and stock. So:

```
OFFLINE_WINDOW_HOURS * 3 < REQUEST_CLAIM_RETENTION_DAYS * 24
```

asserted **at module load**, so raising one without the other fails the boot
rather than only a test. The 3x margin exists because the clocks do not start
together: the device's window begins when it loses connectivity, the purge runs on
its own schedule, and a batch is presented at the far end of the window.

### Quarantine is a holding area, not a rejection

Five reasons, and the reason is reported rather than a boolean — an operator
resolving one needs to know which of five things happened. The batch payload is
kept **verbatim**: a quarantined batch is evidence, and paraphrasing evidence
destroys it. A batch row is written either way, or a device retries forever.

**The whole batch is quarantined, never the allowed prefix.** Applying half a
batch leaves the device's view and the server's permanently divergent.

### Late sync: ordering fixes the common case, not the general one

Draining by business date handles a device syncing several days at once. It
**cannot** fix a device syncing after newer movements already moved the average
cost — that would need retroactive re-folding, which contradicts the append-only
ledger. So:

- Within the window: accepted and marked `stock_movement.synced_late`, so the
  variance report can explain itself instead of being quietly wrong.
- Beyond the window: **quarantined for manual review.** Silently absorbing a
  week-old batch that corrupts the cost basis is worse than making someone look
  at it.
- The cost-envelope check is the backstop.

### Manual settlement is NOT offline settlement

The bill is generated and the tender recorded **online, after the fact**. What is
recorded is that a manual card machine or a cash envelope took the money while the
terminal was down — a different and auditable thing. No device ever decides
offline that a bill is settled.

It exists because the alternative is not "this never happens". Staff **will** take
money on a manual card machine during an outage; without a home for it they invent
one — a note in the till, a figure keyed in as cash days later. `payment.settle.manual`
is financial-transaction class with a mandatory operator reference (card slip,
cash envelope id), an authorising manager and a reason code, so an off-book
workaround becomes a reportable line in the exception report's transaction section.

Every element or none, by CHECK: a manual tender with no reference is an
unverifiable assertion that money arrived, which is the thing it exists to prevent.

### Offline settlement: the ONLY sound way to revisit it

Someone will ask for this in year two, and the wrong answer is easy to reach for.
The accepted cost today is that **a branch with no connectivity cannot take payment
in the system**; manual settlement above is the workflow, not a relaxation.

If it is ever revisited, the only sound form is **lease-scoped**: settlement
permitted solely under an unexpired exclusive lease on a session the device itself
opened. That reduces the double-settle risk exactly to lease-expiry correctness,
which is a bounded and testable property. Anything that does not reduce to a
single-writer guarantee admits double settlement, which is unrecoverable — the
customer has paid twice and both records look valid.

### A KOT always carries something a human can read aloud

`sequence_no` is nullable precisely so an offline terminal can fire;
`local_reference` (`L-<device>-<n>`) is what the kitchen holds until sync assigns
the sequence. `CHECK (sequence_no IS NOT NULL OR local_reference IS NOT NULL)` —
one or the other, never neither, or the paper in the kitchen cannot be traced to a
row.

---

## Billing automation (Phase 5B)

Control plane throughout. Nothing in `src/modules/billing/` reads schema `app`, and a test
asserts it.

### GST place of supply

**The failure this prevents is not an arithmetic one.** Charging CGST+SGST where
IGST was due misstates no total — 18% is 18% either way. It breaks the
**recipient's input tax credit**: credit claimed under the wrong head is
disallowed, and their only remedy is for us to credit-note and reissue every
invoice we ever sent them. The amount is right and the document is worthless.

- **Our own registration is data, not a constant.** Hardcoding one state breaks
  the day a second registration exists, and there will be one.
- **The GSTIN is the authority; the address never overrides it.** Characters 1–2
  carry the state. A profile whose GSTIN state contradicts its stated state is
  **refused at entry** — one of the two is wrong and we cannot know which, and
  guessing produces invoices confidently addressed to the wrong jurisdiction.
- **Order of determination is statutory, not convenient**: outside India decides
  before SEZ, and both decide before comparing states. An SEZ unit *in our own
  state* is still inter-state, which is the case a naive comparison gets wrong.
- **Everything is snapshotted** — both parties' GSTINs, states, place of supply,
  treatment, per-component rates. A tenant relocating must not retroactively
  convert two years of documents.
- **A deferred constraint trigger makes a defective invoice unissuable**: the
  component set must match the declared treatment, per line. Same family as combo
  allocation and tender balance.
- **Tax is computed per line and summed**, never as a percentage of a rounded
  subtotal. That removes the discrepancy at source instead of reconciling it.
- **Round Off is its own line**, bounded to ±0.50, and the invoice total is
  asserted to be a whole currency unit — which is what makes the round-off real
  rather than decorative.

**Zero rating is not self-service.** `is_sez` and a non-IN `country_code` both
mean "charge no tax", and if the claim is wrong *we* carry the liability. Both
require a platform user to have seen evidence. The mechanism is that the grant
**names a platform user**: the tenant plane holds no platform user id and cannot
forge one past the FK, so the write is structurally unavailable rather than
forbidden by convention. A trigger additionally requires the grant to be
*re-stated* when either field changes, so a stale grant cannot carry a new claim.

**LUT only, deliberately.** The pay-IGST-and-claim-refund route means funding the
tax and chasing a refund — a treasury decision, not a feature. Its absence is a
recorded exclusion, not an oversight.

**A GSTIN supplied after B2C invoicing does not trigger reissue.** Those invoices
were correct for the facts at the time — the same reasoning that rejects
credit-and-rebill. Input tax credit for those periods is lost to the tenant, and
that is a consequence of registering late rather than a defect in our document.
**It is stated in the billing terms** (`docs/backend/billing-terms.md`), because a tenant
will ask and the answer has to have been given in advance.

### Numbering

Gapless per tenant per series per financial year, by counter row. A `SEQUENCE` is
disqualified for the same reason it was for KOT tickets: sequences do not roll
back, so every aborted run burns a number — and here a burned number is a gap a
tax officer will ask about.

**The number carries a series code**, and that is not cosmetic. Rule 46 wants the
*supplier's* numbering unique for the financial year; parallel per-tenant counters
satisfy that only if each series is identifiable in the number. Without the code
two tenants both issue `INV/2026-27/000001` and our own books carry duplicates.

Credit notes have their own series. Interleaving would make neither contiguous.
The financial-year boundary is per tenant, not hardcoded to April.

### Segments, not proration

> **A segment is a contiguous span during which the plan and quantity were
> constant. An invoice bills a set of segments.**

A mid-period change creates a second segment, not an adjustment — so there is no
proration concept to choose a form for.

**Credit-and-rebill was rejected on a statutory ground.** A credit note under
Section 34 records a *reduction in the taxable value of a supply already made*.
Routine proration is not that: the earlier invoice was correct for the facts at the
time, so a credit note against it asserts an error that did not occur — and burns
a number in a statutory series to do it. At seat-change frequency that fills the
credit-note series with hundreds of documents that are not credits.

Segment charges use **largest-remainder allocation**, the same allocator as combo
components and percentage bill splits, so charges sum exactly to the period price.

**Cancellation is a billing event**: it closes the open segment and issues a final
invoice for everything uninvoiced. That closes the one cash-flow hole the model
has — a tenant who churns before the next invoice.

**Generation is idempotent per period by construction**, not by a guard: a billed
segment carries the invoice that billed it, so a retried job finds nothing to bill.
That matters more here than anywhere else, because the gapless series makes a
duplicate a permanent visible defect rather than a row to delete.

### The expand/contract asymmetry

**Upgrades and seat increases are immediate. Downgrades and seat decreases wait
for the period boundary.** The direction that expands what the customer has is
immediate; the direction that contracts it waits.

This *dissolves* the refund-or-credit-or-lapse question rather than answering it:
if the contraction happens at the boundary, no unused value ever exists. "Lapse"
would have been a forfeiture and reads as one; deferral gives the identical cash
outcome and is defensible.

Seat changes are the same mechanism, because the segment does not care whether it
was plan or quantity that changed. Direction is classified by total value.

A scheduled change is **visible and revocable** — a tenant who downgrades in error
and finds out at renewal has a legitimate complaint, and "you clicked it six weeks
ago" is not an answer. One pending change per subscription: a queue of
contradictory downgrades has no defensible resolution order.

**A downgrade that would leave the tenant over the target plan's limits FAILS TO
APPLY.** The subscription stays put and the tenant is notified through the outbox.
It does not shrink entitlements and hope: the entitlement document fails closed, so
over-quota already means *cannot add* — but if enforcement reached existing
branches, applying the downgrade would silently disable locations that are open and
trading. **A billing job must never take a restaurant offline.**

The quota check reads `platform.usage_counter`, the daily rollup. **Never schema
`app`.** Usage flows up as aggregates; that is the whole rule.

### Webhooks are hostile input

Delivery is at-least-once, out of order, and replayable by anyone who can reach the
endpoint. Three defences, none optional:

1. **Signature verification, constant-time.** An unverified event is *recorded* as
   evidence of an attempted forgery, and a CHECK confines it to `rejected` — it
   cannot reach any other terminal state, so no code path can process one by
   omission.
2. **Idempotency on the gateway's own event id.**
3. **A monotonic guard on the gateway's timestamp**, so a late-delivered older
   event cannot undo a newer one. Same protection as `entitlement_document.version`.

**Recording and processing are separate**, so a slow processor cannot make the
gateway retry forever.

**A webhook is never the sole source of truth.** A system that only learns by
webhook cannot discover what it never received, so a reconciliation job asks the
gateway directly and a missed webhook self-heals.

**Never store a card number.** Absolute, at three layers: the application refuses
a PAN-shaped token, a CHECK on the column refuses any 13–19 digit run, and
`redactPan` is applied at the logging boundary. A test asserts all three.

### Dunning never suspends

Nothing in `src/modules/billing/dunning.ts` holds a threshold, and a test asserts it reads
`ladderThresholds()` rather than defining its own. Exhausting retries does not
suspend — it stops retrying.

**A gateway outage produces a burst of declines. If declines could suspend
directly, the outage would lock every restaurant on the platform out mid-service.**
Suspension goes through the ladder job, which owns the thresholds and the audit
trail. A test strips comments from `webhooks.ts` and asserts no reference to
`platform.tenant`, the ladder, or `delinquent_since` survives.

Retry uses backoff, because a first failure is usually a bank decline rather than a
delinquent customer.

`delinquent_since` is set on the first failure — the ladder derives status *from*
day 0, so something must establish day 0, and the failed payment is that event. It
clears **only** on return to active, per the Phase 0 biconditional.

**Recovery is immediate and complete or it is not recovery.** In one transaction:
status recomputes, day 0 clears, the entitlement document republishes with a new
version, and an invalidation goes to the outbox for the tenant plane's cache. A
message rather than a call, because the control plane never reaches into the tenant
plane synchronously. The whole chain is tested, not the first step.

The dunning queue computes `daysUntilSoftLock` from the *same* configurable
thresholds the ladder uses. A second copy would drift and the screen would
confidently show a date the ladder disagrees with. One-click contact-owner **logs**
the outreach: one nobody recorded is one the next person repeats.

---

## Reporting (Phase 5C)

> **Every report reads snapshots. Nothing recomputes from current
> configuration.** That single rule is what makes a report from last March still
> true today, and it is the payoff for every snapshot decision made since Phase 2.

### The assertion was written before the reports

`tests/reporting/snapshotOnly.test.ts` scans `src/modules/reporting/` for reads of a
catalogue price, a current tax rate, a live recipe, a current plan price, or the
live `stock_balance` inside a period-scoped function. It existed while the
directory was empty, so it constrained what got built rather than being
retrofitted around it.

**The table gate is an ALLOWLIST, because a blocklist fails open.** Phase 6 adds a
promotion table with `discount_price_minor`, nobody thinks to edit the scanner,
and a report reads live promotional pricing while every test stays green — the
same shape as `OWNER_WITHHELD` and the `APP_TABLE` regex. So a reporting module
may read the named snapshot, label and reference tables and **nothing else**; a
new table is denied until someone justifies it there, in the same direction as a
new permission key defaulting deny.

A second, column-level gate survives underneath it, because a label table joined
for its name may still carry money: `menu_item` is allowlisted for `name` and is
still refused `price_minor`. Word boundaries carry that distinction —
`\bprice_minor\b` does not match `unit_price_minor`, so the catalogue column is
banned while the order-line snapshot stays legal.

**The import graph is gated too.** The table scan is lexical and stops at the
directory boundary: a report calling `pricing.currentPrice(itemId)` reads a
catalogue price and the scanner sees a function call. So `reporting/` may import
only from an allowlisted set — repositories, the tenant context, permission keys —
and never from pricing, recipe, plan, catalogue, inventory or billing modules,
which is where the live-configuration reads live. Tested with a synthetic module
that imports a forbidden one.

Two things keep it honest while the directory is small:

- The scanner is a pure function **tested against synthetic modules built to
  violate each rule**, so it is non-vacuous independently of what has been built.
- `EXPECTED_REPORTING_MODULES` is an **exact count, not a floor**. A floor of zero
  is vacuous; an exact count means a new report cannot land without someone
  raising it deliberately.

It has already caught two things in this project's own code: an alias
(`bl.tax_rate_bps AS rate_bps`) that renamed a snapshot to look like the
catalogue column, and — via its own fixture — a signature-parsing bug that made
the period-scoped rule silently never fire.

### The exception report ranks against the actor, not a threshold

Sections come from `permission.risk_subclass`, so a financial key added in month
nine lands in the right one with no edit. There is a test that inserts a
synthetic key and asserts exactly that.

**A waiter who voids twice a shift is normal; the one who STARTED voiding twice a
shift last Tuesday is the finding.** So the report ranks by each actor's lift
against their own prior baseline, computed over the window BEFORE the period —
including the period in its own baseline would dilute the spike being looked for.
A global threshold surfaces the busy waiter every day, and after a week nobody
opens the report. Same reasoning as keeping pre-fire corrections out of the void
rows.

An actor with no history is treated as having one baseline occurrence, not as
infinitely unusual — otherwise every new starter tops the list in their first
week.

**Privacy-class access is in neither section.** `app.pii_access_log` is a separate
table read by a separate function returning a separate shape, so there is no call
site at which the two could be folded together. One row per record revealed; a
bulk export carries a query descriptor and a count, and the CHECK refuses an id
list outright.

### Sales: made and sold are different questions

`quantityMade` counts what the kitchen produced; `quantitySold` counts what was
charged for.

- A **comp** is quantity 0, money negative: delivered free. Made, not sold — and
  it contributes zero to sold *by construction* rather than by a filter.
- A **void** is quantity negative and **post-fire by definition**, since the
  pre-fire correction mutates the line and never becomes a row. So the dish was
  cooked and then written off: it counts as **made**, and reduces **sold**.

That last point was wrong in the first implementation, which subtracted voids
from production too. Everything is on **business date**; a report that splits a
Friday night at midnight is wrong in a way that gets reported as a bug forever.

Combo parents carry no money and are excluded from every sum; components carry
the allocated price, so a thali's lassi reaches the beverage category at its
allocated value rather than at zero or at the whole combo price.

**The label for a dimension comes from the entity, not the line.** Grouping the
item dimension on `display_name` split one item into "Biryani", "Biryani void"
and "Biryani comp" — three rows sharing one key, and a caller looking up by key
silently got whichever sorted first.

### The GST return shares no code with the platform's invoicing

`src/modules/reporting/gstReturn.ts` computes the TENANT's outward supplies to THEIR
customers from `app.bill`. `src/modules/billing/` computes OUR supply to the tenant from
`platform.invoice`. Different supplier registration, different recipient,
different tables, different consequences. A shared "tax engine" would mean a
change made for one silently altering the other's filed returns. Asserted.

**It reconciles exactly to the bills, summed independently** — off `bill_line`
directly rather than through the bucketing, so it cannot agree merely by sharing
arithmetic. That check found a real defect: exploding each line into its tax
components with a LATERAL join and then summing `amount_minor` multiplied the
taxable value by the number of components, reporting exactly double while the tax
total stayed correct. Components are now folded to one row per line before
anything is summed.

Because rates are snapshotted per line, a mid-period revision produces a return
with **both** rates in it, which is what reconciling to the paper requires.

### Variance reports its own caveats

Valued from the `count_variance` movement the ledger posted at approval, against
`expected_qty_base` from the sheet — never the live balance, which has moved.

**Late-synced and quarantined movements are surfaced on the report itself.** A
variance figure that silently includes a late-synced batch is a figure someone
will act on wrongly, and an unresolved quarantine means movements that belong in
the period are missing by an unknown amount.

**Recipe edits in the period appear on the same screen.** That adjacency is the
whole reason `recipe.edit` is financial-class: reducing a recipe quantity makes
variance vanish, and two numbers on one screen is what makes the control real
rather than theoretical.

---

## The local stack runs as the three roles, through the pooler

`docker compose up` brings up Postgres and **PgBouncer in transaction mode**, with
the three roles created on first init. The application connects as
`katkitchen_app` through the pooler; only migrations connect directly, as the
owner.

This is not a production detail imported early. **A local stack that runs as a
superuser is one where the RLS backstop, the append-only grants and the ownership
probe are all inert** — and every one of them would first fail in production,
which is the worst place to discover them.

The pooler holds **no superuser**: the config is ours rather than generated from
environment variables, because the image's generator injects `auth_user=postgres`
and turns on an auth_query, which needs a role that can read `pg_authid`.

### The probe is tested in BOTH directions

A `pgbouncer-statement` service, deliberately misconfigured and never used by the
application, runs under the `probe` profile purely so the FAILING direction is
exercised. **A safety check that has only ever been observed to pass is a check
nobody has shown to work** — the same reasoning as testing the snapshot-only
scanner against fixtures built to violate it.

Confirmed locally: transaction mode passes every probe; statement mode aborts
startup. Note *how* it aborts — PgBouncer rejects the probe's `BEGIN` outright
("transaction blocks not allowed in statement pooling mode") rather than allowing
it and discarding the `SET LOCAL`, so our own typed `DatabaseSafetyError` is not
the thing that fires for this particular pooler. Startup still refuses, which is
the requirement, and the test accepts either while asserting it is one of them —
never a silent pass.

## Domain rules that are easy to get wrong

1. **Stock deducts at KOT confirm, not at payment.** The kitchen consumed the ingredients
   when it started cooking. Deducting at payment corrupts inventory on every void and comp.
2. **`menu_item -> recipe_line -> product`** must exist. Without the BOM link, the
   inventory module is a spreadsheet nobody updates.
3. **Printing is a queue, not a call.** `print_job(status, attempts, station_id,
   fallback_printer_id)` with retry. Thermal printers fail constantly.
4. **`kitchen_station` is a resource. `kds` is a role.** Never the same entity.
5. **Customers are not staff.** Separate table. No login, phone-identified.
6. **POS must work offline.** Order lines created locally, queued, synced with an
   idempotency key.
7. **Money is integer minor units.** Never float. Never `double`. Currency is
   `text CHECK (~ '^[A-Z]{3}$')` — never `char(3)`, which pads with spaces and has
   surprising comparison semantics for no performance gain.
8. All timestamps stored UTC (`timestamptz`, database `timezone = UTC`). Branch timezone
   applied at presentation only.
9. Voids, comps, and refunds are **new rows**, never updates or deletes on the original.
10. Status columns are `text` + `CHECK`, never native Postgres `enum`. `ALTER TYPE … ADD
    VALUE` is not transactional and cannot be reverted, which breaks the reversible-`down`
    rule.
11. Retained-but-inactive rows must not block re-creation. Every uniqueness constraint over
    a table that keeps revoked history is a **partial** index predicated on
    `status = 'active'`.

---

## Before the first real invoice

**The place-of-supply logic and one sample invoice of each treatment must be
reviewed by someone who actually files GST returns.** Not because the model looks
wrong, but because it is the one piece in this project where an error has a legal
consequence rather than a technical one, and it is cheap to check now and
expensive to unwind later. The reviewer checklist is at the foot of
`docs/backend/billing-terms.md`.

## Build order — do not skip ahead

| Phase | Scope |
|---|---|
| **0** | Tenant/branch/user/credential/role/permission schema, isolation guard, audit log. Nothing else. |
| **1** | Control plane: provisioning, plans, subscriptions, entitlements, impersonation. |
| **2** | Tenant setup: branches, floors, tables, kitchen stations, printers, devices, menu. |
| **3** | Operations: table session -> order -> KOT -> KDS -> bill -> payment. **This is the product.** |
| **4** | Inventory, recipe/BOM, auto stock deduction, suppliers, purchase orders. |
| **5** | Billing automation, dunning, reporting, offline POS. |

---

## Testing standards

**A test that verifies zero things and passes is worse than no test**, because it reports
coverage that does not exist. Over-matching a filter fails loudly and gets fixed;
under-matching greens forever.

Every introspection or set-based test asserts on **the set it checked**, not only on the
violations it found:

1. a minimum expected count, and
2. an explicit list of names that MUST appear in the checked set, failing if any is absent.

Only then does it assert the violation list is empty.

Jobs assert **positive postconditions**, not just absence of error. A job that exits 0
having done nothing is indistinguishable from a job that worked, so it must verify the
state it was supposed to produce and exit non-zero if that state is absent. Idempotent
*and* self-verifying.

Regression tests target the surface the bug lived on. If the bug was in objects created
*later*, testing objects created by the migration proves nothing.

**A passing test can still be testing the wrong thing.** Two cases already caught here,
both of which would have greened forever:

- *Refused for the wrong reason.* Asserting that the app role cannot read an audit
  partition directly passed — but on `app.tenant_id is not set`, raised by the RLS policy
  function before the privilege check was ever reached. The revoke it claimed to test was
  untested. Assertions about a denial must pin **which** denial.
- *NULL as absence.* Checking schema `public` for grants to PUBLIC by scanning `nspacl`
  passes trivially when `nspacl` is NULL — and NULL means *database default*, which in
  PG15+ still grants `USAGE` to PUBLIC. NULL is the failure, not the absence of one.
  Wherever a NULL means "inherited default" rather than "nothing", assert it is non-NULL
  first.

**When a synthetic probe agrees with the code and disagrees with the real data, the probe
inherited the bug.** You built the fixture from your mental model, and the mental model is
the thing under test.

The KDS ticket-state derivation failed a test. A hand-written SQL probe of the same
derivation passed, which read as "the logic is fine, the test is wrong". It wasn't: the
probe used the line states the ladder happened to handle (`preparing, queued`) while the
real rows were `ready, queued` — a ticket whose one started item was already plated
derived as `queued`, so the expo would look at food sitting under the pass and see
"not started".

The rule: **dump the actual rows before trusting a probe.** Both prior instances of this
pattern in the project — the partition test refused for the wrong reason, the audit
assertion that greened over an empty set — would have produced double food or a silent
security hole had they been argued from a fixture instead of from data.

Package manager is pnpm. A `package-lock.json` or `yarn.lock` in the tree fails
`preinstall` and fails CI: a second lockfile means the verified dependency set and the
installed one can silently diverge.

### Standing review question: derived, or merely adjacent to something derived?

**This class of bug has now been caught FIVE times.** At two it read as a coincidence;
at five it is the default failure mode of this codebase and worth checking for by
reflex. Every instance was a derivation **half done**, where the hardcoded half was the
load-bearing one:

1. `OWNER_WITHHELD` sat beside `delegableKeys`, which iterated `SEPARATION_RULES`. The
   delegation was derived; the owner exclusions were a copy of the same keys. A fourth rule
   would have left `owner` silently violating it.
2. The raw-SQL gate's `APP_TABLE` pattern sat beside `APP_TABLES`, which the other
   assertions used. A new tenant table would have escaped the `tenant_id`-predicate check
   entirely while every neighbouring test kept passing.
3. The fixture teardown's enumeration of every table referencing a tenant — a
   hand-maintained list beside a growing schema. It broke twice when
   `platform.usage_counter` was added, in two different suites, and the fix was to stop
   deleting tenants at all.
4. `STORAGE_TABLES` in the usage rollup. Legitimate as a judgement about which volumes a
   tenant drives, which is why it carries an `ENUMERATED-LIST-OK` marker rather than being
   silently a copy — the marker is the mechanism that keeps the exception visible.
5. **The thin-handler gate named `src/http/handlers/`, one directory beside
   `src/http/routes/`.** `readBoard` — six queries including a live catalogue price —
   lived in `routes/pos.ts`, and `handlers/pos.ts` imported it. The handlers were
   SQL-free **by geography**, so the gate passed while the rule it claimed to enforce did
   not hold over the layer it named. Adding any file to `routes/` widened the ungated
   surface with every test green.

The tell is the same in all five: **a list sitting next to something that expands.** In
(5) the expanding thing was a directory rather than a set of keys, which is why it read
as different — it is not.

So, for every list of keys, tables, roles, columns **or paths**: is this computed from the
source of truth, or is it a second copy that happens to agree today? If it is a copy, the
test that proves it stays in step must exist — and the strongest version introduces a
synthetic entry and asserts the copy follows without an edit. For a path-shaped list, the
synthetic entry is a file at the path the old scope would have missed.

Non-vacuity floors (`minimum:` in `assertCheckedSet`) are the exception: they are a
**ratchet**, not a copy. Raising them as the schema grows is correct; lowering one is the
smell.

### A blocklist fails open; an allowlist fails closed

A list of forbidden things is only correct against the things that existed when it
was written. Whatever breaks it is added later, by someone who never opens the
file — and every test stays green, because the list still agrees with itself.

Wherever the guarded set can GROW — tables, permission keys, movement kinds,
report modules — name what is PERMITTED and deny the rest until justified. Same
direction as new permission keys defaulting deny, `audit: 'none'` being an
explicit declaration rather than an absence, and an unroutable item being refused
at listing time. Reserve blocklists for closed sets that genuinely cannot grow.

The tell is the derived-versus-adjacent tell again: **if adding a row somewhere
else would silently widen this list's meaning, it is the wrong polarity.**

### The relaxation that makes the error go away is the one that removes the guarantee

Twice now the obvious fix to a failing constraint would have silently deleted the
thing the constraint existed for:

- **`request_claim` partitioned by time rather than hash.** Cheap, idiomatic, and
  it makes `(tenant_id, idempotency_key)` per-partition — so deduplication stops
  working and a retry across a boundary double-charges. It would have looked like
  a working system for months.
- **`invoice.number` relaxed from globally unique to `(tenant_id, number)`.** The
  duplicate-key error disappears and our own books carry two
  `INV/2026-27/000001`, which is the exact defect Rule 46 exists to prevent.

Both relaxations pass every test. So: **when a constraint fails, ask what it was
protecting before asking how to satisfy it.** If the fix narrows the constraint's
scope, name the guarantee that just became narrower and say out loud whether that
is acceptable. The fix that widens the *data* to fit the constraint — a hash
partition key, a series code inside the number — is usually the one that keeps the
guarantee intact.

### Standing review question: pinned, or snapshotted?

> **Pin a copy when it MUST track the source. Snapshot a copy when it must NOT.
> Same shape, opposite intent. An `ON UPDATE CASCADE` FK on a historical
> snapshot inverts the guarantee it appears to provide.**

Both are a denormalised copy of a value that lives elsewhere, and they are
indistinguishable by looking at the column. The tell is **whether the source is
allowed to change**:

- Narrowing `role.assignable_scope` **should** abort against a contradicting
  membership. The copy constrains a *current* relationship, so it is pinned by
  composite FK and cascades. Same for `branch_menu_price`'s catalogue copy and
  `order_line`'s adjustment pin.
- Changing `product.yield_bps` should **not** abort. That is what versioning is
  for. `recipe_line.product_yield_bps` is a record of what the yield *was*, so it
  is a plain column with no FK.

Pinning a historical snapshot does not merely fail to help — it makes the source
column **uneditable outright**, because every historical row holds the old value
and the FK rejects the UPDATE.

**When copying a constraint, name the property that made it correct at the
original site, and verify that property holds at the new one.** The lease
duration cap was copied from the impersonation cap as `expires_at <= claimed_at +
interval '15 minutes'`. That is correct for impersonation *precisely because those
sessions are never renewed* — and renewability is the whole point of a lease, so
the copied form is satisfiable exactly once and the second grant always fails.
"Short and renewable" became "short and then dead", losing a terminal its table
mid-service. The property was invisible at the source, where nothing exercised it.
 The pressure that creates is what makes someone
compute the value at read time instead, which destroys the reason the snapshot
existed. Four correct applications and one wrong one, and the wrong one looked
exactly like the other four.

### An owner-posture exemption is a claim, not a permanent grant

`runReconciliationJob` had been broken since Phase 4: it iterated tenants and
never set the GUC, so it raised on its first read as the app role. It shipped
green because its test passed a context whose client was the OWNER, which is
exempt from RLS by table ownership — and it survived the owner-client audit
because it was already on the allowlist with a plausible reason.

> **An entry on the owner-posture allowlist is a claim about who calls a
> function, and it needs re-checking whenever the callers change.** It is not a
> permanent exemption. A function that was legitimately owner-only in one phase
> becomes a bug the moment a worker calls it as the app role.

**All four instances of this bug were found by RUNNING the thing, not by testing
it.** A job with no runner, a check with no caller and a route with no server are
all code that has never executed in its production posture. Wire the entry point
early enough that the first real invocation happens during development.

Phase 7 produced three more of exactly this shape, and none was found by a test:

- **`buildServer` had no caller** — not in `src/`, not in `tests/`. Every HTTP test
  hand-built a Fastify instance and called `registerTenantRoute` directly, so the
  assembly (prefixes, guard mounting, `assertAllServed`, the public branch) had never
  run. It hid a live defect: the public branch registered its routes through the
  **tenant** registrar, which reads `tenant_id` from a verified JWT and 401s without
  one — so **every login would have failed**, and `registerPublicRoute`, written
  specifically to refuse an audited public route, was never reached. Both now have
  callers in `tests/http/assembly.test.ts`.
- **The partition-recovery runbook had never been executed.** It was written down,
  ending "write this down before you need it at 2am", and the first attempt to follow
  it failed on the second step: `ALTER TABLE … ATTACH PARTITION … FOR VALUES FROM ($1)`
  takes no bind parameters, so the bounds must be resolved to literals first. A written
  procedure nobody has run is a procedure nobody has shown to work. It is now
  `scripts/recover-default-audit-partition.mts`, with `--dry-run`, and it has been run.
- **The non-empty-default-partition alert could never fire honestly.** See the
  default-partition note under Data quality checks.

The general form: **a procedure counts as unexecuted code too.** A runbook, a recovery
sequence and a boot path are all things whose first real invocation should happen while
someone is watching, not during the incident they exist for.

### Session advisory locks and a transaction-mode pooler are incompatible

`pg_try_advisory_lock` is session-scoped, and that is exactly why it is the right
overlap guard: Postgres releases it when the connection ends, so a crashed worker
needs no timeout and no reclaim sweep — unlike a row-based claim.

**But through PgBouncer in transaction mode the pooler hands the server
connection to another client between statements**, so the lock would be held by
whichever client inherited it and released at a moment nobody chose. The job lock
therefore takes a DIRECT connection; the job's own work may still use the pooler.

This would have been found in production if the pooler were not in the local
stack.

### An intermittent failure is evidence about the TEST, not the environment

Two instances now, and the explanation was wrong in the same direction both times:

- The KDS probe. A hand-written SQL probe agreed with the code and disagreed with
  the test, which read as "the logic is fine, the test is flaky". The probe had
  inherited the bug from the same mental model that wrote the code.
- The impersonation cap. A test failed on re-runs and passed clean-room twice, and
  was twice blamed on leftover database state. It was comparing a
  SERVER-generated `expires_at` against the CLIENT's `Date.now()` across a Docker
  VM whose clock drifts either way by tens of milliseconds — flaky at exactly the
  boundary it was testing, and asserting the wrong relationship besides.

> **A test that fails intermittently and passes clean-room is telling you
> something about itself.** "Leftover state", "timing", "the container" are
> hypotheses, not findings, and reaching for one is how a real defect gets
> shrugged off twice.

Do not re-run until it goes green. Find what differs between the two runs and
name it, then fix the test so the difference cannot matter — usually by asserting
the relationship the constraint actually enforces rather than a proxy computed on
the other side of a clock, a connection or a transaction boundary.

### An assertion about a rule is tested against a fixture built to violate it

Three tests in this project have now passed for the wrong reason, and all three
were caught by probing rather than by the test:

- the partition test that passed because access was refused by the RLS function
  before the privilege check it claimed to test was reached;
- the audit assertion that greened over an empty set;
- the separation-of-duties assertion whose rule named only
  `purchase.order.approve` while CLAUDE.md required `purchase.receive` too — the
  seeded matrix satisfied both, so it greened while testing less than it claimed.

> **A test of a rule must run a fixture CONSTRUCTED to violate it, never
> production seed data that happens to comply.** Seed data agreeing with a rule is
> evidence about the seed, not about the rule.

The seeded matrix is still worth asserting — it catches the seed drifting — but it
cannot be the only assertion, because it can only ever fail when the seed is
wrong, never when the *rule* is too narrow. Pair every rule assertion with a
synthetic case at the boundary, the same way the synthetic fourth separation rule
proves the delegation machinery is derived.

### Absence is never a discriminator

Three instances now, each a hole in something that looked complete:

- A NULL `nspacl` read as "no grants" when it means *database default*, which
  still grants `USAGE` to PUBLIC.
- Keying audit attribution on which id column was NULL, instead of an explicit
  `actor_kind`.
- `recipe_line_references_backwards` exempting rows where
  `parent_publication_seq IS NULL` — so appending a line to an already-published
  version passed the cycle check vacuously.

Stated generally: **a CHECK, policy or branch that exempts on NULL has a hole
exactly the size of the rows that can be made NULL.** Before writing `x IS NULL
OR <predicate>`, establish who can produce a NULL `x` and whether that path is
closed by something else. If it is not, the discriminator belongs in a positive
column — `actor_kind`, `component_kind`, `audit: 'none'` — and the NULL case
becomes a failure rather than an exemption.

The same reasoning gives the testing rule that a denial must pin *which* denial:
"it was refused" and "it was refused for the reason I claimed" are different
assertions, and only one of them keeps working after a refactor.

### A number outside the range of its own inputs is a standing check, not a test

A moving average cost outside `[min, max]` of every price ever paid cannot be
produced by any sequence of purchases. **Two different bugs have produced that
violation** — naive WAC against a negative balance, and a retrospective
correction counted twice into on-hand value — which is the evidence that there is
probably a third.

So it is asserted **nightly, per product per branch, alert-only**, alongside the
balance reconciliation, rather than as a test of the two cases already known. The
general form: where a derived figure has a computable envelope from its own
inputs, check the envelope on a schedule. A test proves the bugs you thought of
are gone; an envelope check catches the ones you did not.


---

---

## The API surface (Phase 7)

### The route layer holds no logic, and the reason is the sync path

Every handler reads the request, calls one domain function, and returns what it
returned. This is not a style preference: **`receiveBatch` replays the same
operations from a tablet that was offline, and it calls the same functions.** A
rule implemented in a handler is a rule the offline path does not get — so a
snapshot taken in `addLine`'s handler would mean a synced line written with no
snapshot at all, discovered weeks later as a bill that will not reconcile.

Enforced, not reviewed: the route layer (everything under `apps/api/src` outside
`modules/`, `core/database/`, `config/`, `jobs/` and `server.ts`) may issue no SQL, do no money
arithmetic, and never take a catalogue price from a request body. The gate runs a
**synthetic handler written the wrong way** and asserts all three patterns fire,
because production files agreeing with a rule is evidence about those files.

The reporting scanner does not transfer here and the difference is the point: a
report *reads*, and its risk is dereferencing a live value, so its gate is an
allowlist of readable tables. A handler *writes*, and its risk is taking the
snapshot itself. An allowlist of readable tables says nothing about the second.

**A tender amount and a discount amount legitimately come from the request** —
the customer handed over that cash, a manager decided that discount, and each is
bounded by the domain (the tender by the deferred balance trigger, the discount
by the role's cap). A **unit price** is different in kind: nobody states it, it is
looked up, and accepting one lets a tablet decide what the customer pays.

### A streaming response holds no database connection between events

> **The only stream went with the kitchen screen (0077)**: no route streams today, and
> the LISTEN connection, its reconnect and `tests/ops/kdsListenerReconnect.test.ts`
> are gone. The rule below stands for any stream that comes back.

Take a connection, read the snapshot, **release it**, then wait on an in-process
emitter. Cross-process notification is **one** direct LISTEN connection per
process — direct, because LISTEN is session-scoped and a transaction-mode pooler
hands the session away at COMMIT, so the subscription appears to succeed and then
silently receives nothing.

**The LISTEN connection re-opens itself.** A Postgres restart ends it, and a
listener that only logs the drop leaves every kitchen screen calm and stale for
the rest of the service. It reconnects with backoff (1 s doubling to 30 s),
asserted in `tests/ops/kdsListenerReconnect.test.ts` by terminating the backend
server-side. Both request pools carry an `'error'` listener for the same restart:
without one, an IDLE pooled connection being dropped is an unhandled `'error'`
event and takes the whole API down.

A kitchen screen is open for a whole service. The failure mode of holding a
pooled connection is not a slow display: it is `pool.connect()` blocking, and the
symptom is **"the till has stopped"** while the cause is a screen nobody is
looking at. Asserted by opening more boards than the pool has connections and
requiring POS writes to succeed — with a companion test that holds every
connection and confirms the next one fails, so the pool really is that small.

### Credential events live in their own table

**DECIDED: a separate `platform.auth_attempt` table. The audit log is not extended
and `actor_kind` gains no fourth value.**

`tenant_audit_log_attribution_exact` requires a membership for `actor_kind =
'user'`. A login holds none and a failed login holds no user at all, so the
constraint was never the obstacle — it was correctly describing what the audit log
is. **The audit log answers "who changed what, under whose authority". A failed
login has no who, changed nothing, and had no authority.** Forcing it in would
have meant either inventing an attribution or relaxing the one column that makes
separation of duties auditable.

`actor_kind = 'anonymous'` was the alternative and it fails on the shape this
codebase now recognises: a fourth enum value is a value every existing
attribution query, every report and every future join must remember to exclude.
That is a list sitting next to something that expands, and the fifth query is the
one somebody forgets — it would put a permanent tax on the audit log to save one
table.

**It is in `platform`, not `app`, and that fell out of writing the migration
rather than the design.** Every `app` table is tenant-isolated by RLS and is
asserted to be. This one cannot be, for the same reason it is not in the audit
log: a failed login has no established tenant, and the rows with the most
security value are exactly the ones with none — an unknown email, an unenrolled
device, a PIN walked against three branches. A `NOT NULL tenant_id` would drop
those rows silently, and an RLS policy would reject them at insert, because the
pre-auth registrar holds a plain pool connection with no `app.current_tenant_id()`
set. There is no tenant GUC at login time, by definition.

The cost is named rather than hidden: **a tenant owner cannot yet see failed PIN
attempts against their own devices**, which is a real operational question —
shared PINs, someone walking the manager PIN space. The read path is
superadmin-only today and a tenant-visible view is deferred, below.

So credential events are **security telemetry with their own retention, their own
shape and their own read path**: attempt time, outcome, method (`password`, `pin`,
`refresh`, `device_enrol`), the subject *claimed* rather than resolved, device and
tenant where known, and the rejection reason from the existing `PinRejection` /
`EnrolmentFailure` unions. Nothing here is an attribution, so nothing here needs a
membership.

Consequences to hold onto:

- `registerPublicRoute` keeps refusing an audited public route. That refusal is
  now correct rather than a blocker, and the auth handlers do not ask for it.
- **A successful login writes to `auth_attempt`, not to the audit log.** The
  audit log's first entry for a session is the first thing the user *changes*.
- **Lockout stays where it is.** `app_user_credential.failed_attempt_count` and
  `locked_until` are not a denormalised aggregate of a log — they are the state
  machine, written in the same statement that verifies the secret, which is what
  makes the lockout atomic under concurrent attempts. Deriving it from
  `auth_attempt` instead would be a rewrite of working, tested logic and would
  make the check a second round trip. `auth_attempt` records what happened;
  the credential row decides what happens next.
- Retention is its own decision and shorter than the audit log's. Telemetry ages
  out; an audit record does not. **30 days, a fixed constant** rather than tenant
  policy, because there is no tenant-visible read path to tune it against yet.
- **No `deny_mutation` trigger, and that is not an oversight.** The trigger fires
  for every role, so on a table with a retention window it would block the purge
  as surely as a tamper. The audit log is never purged and can afford it; this
  cannot. The posture here is grants — the app may INSERT and SELECT and nothing
  else, and the purge runs as the owner.
- **Not partitioned**, unlike the audit log, and the reason is the write path
  rather than the volume: an audit row shares a transaction with every mutation
  in the product, so a later conversion would be a maintenance window on the
  busiest table in the schema. This one is written once per login.
- **OPEN: a tenant-visible view of a tenant's own attempts.** Needs a
  cross-schema read from the tenant plane, which hard boundary #1 forbids as
  written, so it is a boundary decision rather than a view definition.

### The pre-auth surface resolves its tenant explicitly

**Every function the auth routes call takes a `TenantContext`, and an
unauthenticated request has nothing to build one from.** `tenantContext.ts` states
the rule the isolation model rests on: a tenant id comes only from a verified
JWT, never from a body, query param or header. A login has no JWT. That is what a
login is for.

Enrolment was the sharpest case, because no amount of tablet-side memory fixes
it: `device_enrolment.token_hash` is looked up as `WHERE tenant_id = $1 AND
token_hash = $2`, and the token is 32 random bytes naming no tenant. A staff
member types it into a fresh tablet that knows nothing, so the query could not be
issued at all. **The function was correct, tested, and unreachable** -- the fifth
instance of the family above, and the one that made the family worth naming.

**DECIDED, and the shape is one sentence: the tenant always comes from something
verified, or from something a human typed in full.**

| Route | Where the tenant comes from |
|---|---|
| `POST /api/auth/:tenantSlug/login` | the path |
| `POST /api/auth/:tenantSlug/pin` | the path |
| `POST /api/auth/device/enrol` | inside the token, as `<slug>.<secret>` |
| `POST /api/auth/refresh` | the verified refresh token -- no exception needed |

A slug rather than a uuid, because a uuid in a URL is an oracle: it resolves or
it does not, and it is guessable in bulk. A slug is already public, already
unique, already format-checked by `tenant_slug_format`, and already typeable.

A path segment rather than a body field, because it makes the tenant part of the
route surface instead of something smuggled through a payload -- greppable in the
route table, visible in a log, and impossible to forget to read.

The composite enrolment token is the only place a secret carries routing
information, and the split is unambiguous: `tenant_slug_format` permits only
`[a-z0-9-]`, so a slug contains no dot. Only the secret half is hashed and
stored, so the composite form can change without a migration.

**Nothing here authorises anything.** Resolving a tenant decides whose
credentials the presented secret is checked against; the check is unchanged.

### Which tenant statuses may authenticate

An **allowlist** -- `active`, `past_due`, `soft_lock` -- because a blocklist fails
open: an eighth status added to `tenant_status_known` later would be silently
admitted, the same polarity mistake as the reporting table gate and
`OWNER_WITHHELD`. The boundary is the ladder as already specified above:
`soft_lock` is "read-only, no new orders", which still requires being able to log
in and see why; `hard_lock` is "login blocked".

### Two token lifetimes, and the short one is what makes revocation mean anything

**Access: 15 minutes. Refresh: 12 hours, about one shift.**

An access token carries no revocation check -- that is the point of a signed
token, and a per-request lookup would undo it. So the window in which a revoked
device still works is exactly the access lifetime, and fifteen minutes is what
that window is worth. Refresh **re-reads `app.device.status`**, so revoking a
terminal ends its session within fifteen minutes rather than twelve hours;
without that, `revokeDevice` would be decorative for half a day.

**`typ: 'refresh'` is enforced, not decorative.** Both tokens are HS256 under the
same key and a refresh token carries `tenant_id`, so without a discriminator it
would pass every plane check as a twelve-hour access token -- a long-lived bearer
credential handed out on purpose and honoured everywhere by accident. `checkPlane`
rejects it on both planes with its own code, asserted in both directions.

**Sliding, not rotating.** Refresh re-issues both tokens with no server-side
record of the old one. **Residual risk, stated rather than hidden: a stolen
refresh token stays usable until the device is revoked or twelve hours pass.** A
rotation table with reuse detection is the fix if that becomes unacceptable; it
is not built, because the device re-check already bounds the realistic case (a
stolen tablet) and a rotation table that nothing revokes is theatre.

### Password login answers unknown-email and wrong-password identically

`app_user.email` is per-tenant citext, so an address can exist in one tenant and
not another. A distinguishable "unknown email" turns `/api/auth/<slug>/login`
into a membership oracle: who works at a named restaurant, one address at a time.

So the reason is uniform **and the work is uniform** -- an unknown email still
pays for one argon2 verification against a decoy hash computed once per process,
or the timing answers the question the status code refused to. Asserted by
comparing the two responses byte for byte.

**A PIN from a tablet that is not set up answers `tablet_not_set_up` (DECIDED).**
The device is resolved BEFORE the staff code or PIN, on nothing but the
fingerprint the tablet sent, so naming that refusal tells the tablet a fact about
itself and nothing about who works here. Folded into `authentication_failed`, a
tablet taken out of use -- or left holding an identity from a reset database --
kept its PIN screen and refused every PIN as "not accepted", with no route back
to setup; a manager then typed the setup code into the staff-code box. The
client forgets its identity on this answer and returns to setup. Unknown and
revoked stay one answer, because the recovery is the same.

`credential_locked` is deliberately not folded in: a locked-out caller needs to
be told to wait, and it leaks only about an account whose password they have
already been getting wrong. `user_inactive` likewise -- that is a state the
person's own manager set.

**Password login is on the critical path to Phase 8**, which was not obvious.
The admin UI is Phase 10, but `issueEnrolmentToken` takes an `issuedByUserId`, so
a human must be authenticated before a tablet can be handed a token. Without
password login there is no way to bootstrap a device at all.

**Platform (superadmin) login is deliberately NOT built.** It needs its own route
with no tenant slug, and nothing calls it until Phase 11. Building it now would
add a fifth member to the family above: correct, tested, unreachable.
- The exception report gains a section for repeated failures against one device or
  one subject, which is the actual operational question — nobody reads a login
  log, they read an anomaly.

---

## The fifth gate family: code that is never reached

Every gate before this one asserts a property of code **that runs**. The raw-SQL
scanner, the thin-handler gate, the owner-posture check, the snapshot allowlist,
the derived-vs-adjacent scanner — each takes code that executes and constrains
what it may do. **None of them asserts that the code executes at all**, and that
blind spot held four defects at once while 614 tests passed:

- `closeSession` and `moveSession` were implemented, tested at the domain level,
  and had no route. The functions were correct and unreachable.
- `buildServer` had no caller anywhere in the tree.
- `registerPublicRoute` had no caller either, because `app.ts` registered public
  routes through the *tenant* registrar, which 401s without a `tenant_id` from a
  JWT. **Every login would have failed**, and the registrar written specifically
  to refuse an audited public route was itself unreachable — so the refusal it
  exists for could never have fired.
- The partition-recovery runbook had never been executed and failed on its second
  step: `ATTACH PARTITION … FOR VALUES FROM ($1)` takes no bind parameters.

Four instances is past coincidence, on the same reasoning that took the
derived-vs-adjacent rule from two to five. The tell is uniform: **a symbol that
exists, is correct, is tested in isolation, and is joined to the running system by
nothing.** A unit test proves the function works. Nothing proved anyone calls it.

Three members exist now.

- `ROUTES_WITHOUT_HANDLERS`, a ratchet enforced three ways — undeclared-unserved
  fails, served-but-listed fails, phantom entries fail.
- `assembly.test.ts`, which boots the real server rather than a fixture of it.
- `reversibility.test.ts`: **every migration's `down` is executed, not merely
  present.** See below — it found two broken rollbacks on its first run.

Two candidates listed here earlier turned out to be **already covered**, which is
worth recording so nobody builds them twice:

- *Every scheduler job is invoked by the runner* is true by construction —
  `runner.ts` dispatches from `JOBS` through `jobByName` and calls `job.run`
  generically, so there is no per-job dispatch table to fall out of step, and the
  crontab↔registry test already closes both directions. A second gate here would
  be the theatre the testing standard warns about.
- *Every exported domain function is reachable* was the `closeSession`
  generalisation, and the handler↔route correspondence gate already covers that
  exact shape in both directions. What remains uncovered is only the weaker
  question of dead exports, which is hygiene rather than a live hazard.

*Every runbook has been executed* remains uncovered and is deliberately NOT built
as a gate: there is one runbook, it is already a script, and a gate over a
one-element set that will not grow is a test that verifies nothing.

### What the reversibility gate found immediately

The working agreement says every migration is reversible and has a `down`.
`loadMigrations` enforces PRESENCE at load time — and presence is not
reversibility. Two rollbacks could never have worked:

- **0042's down deleted two `usage_metric` catalogue rows** that
  `usage_counter_metric_fk` (added by 0040, with no `ON DELETE` action) points at.
  The delete is refused the moment any tenant has metered one print job, so
  rolling back the print worker was impossible in every real deployment. Fixed by
  leaving the rows: **a rollback must not destroy a record of something that
  happened**, and deleting the dependent counters to make the statement succeed
  would throw away billing input to undo a code change.
- **0030's down narrowed `adjustment_reason_kind_known`** back to a set that
  excludes `'refund'`, which Postgres refuses while any row holds that value —
  every deployment that seeded reason kinds. Fixed by deleting those mappings
  first, and the contrast with 0042 is the rule: that row is **configuration for
  the feature being removed**, not a record of anything, and `app.refund` is
  dropped a few statements above it anyway.

Both are the same shape as the recovery runbook that failed on its second step:
correct-looking SQL nobody had executed. **A `down` is exercised on a database
WITH DATA or it is not exercised at all** — both defects are invisible on an empty
schema, which is the only place a rollback had ever been imagined.

The gate runs the whole cycle in one transaction and rolls back, so no suite sees
a dropped schema, and it compares a schema digest over columns, constraints,
indexes, policies, RLS flags, functions, triggers and grants — because a round
trip that loses a REVOKE or an RLS policy and throws nothing is the failure that
matters. Job-created dated audit partitions are excluded, since no migration owns
them; the `_default` partitions are not.

The synthetic-violation rule applies as everywhere else: the digest is proven
sensitive by adding one table and requiring the comparison to fail, and a `down`
that is valid SQL doing nothing is refused by asserting the schemas really do
empty out between the two halves.

---

## Phase 8: what the first real client found

Five decisions, in the order they were forced.

## The session lease is a bearer credential, minted per claim

`app.table_session_lease` gains `token uuid NOT NULL DEFAULT gen_random_uuid()`
with a unique index on `(tenant_id, token)`. Migration 0047.

**What was there before.** Thirteen POS routes declared `lease: 'required'`.
That declaration bought a header-presence check — any non-empty `X-Lease-Token`
satisfied it — and `requireLease`, the function that resolves the lease row and
refuses, had exactly one caller in the whole tree: a test.

Worse: the presence check never ran either. The hook in `app.ts` read
`request.routeOptions.config.posLease`, and the registrar never set `posLease`
in `config`. `undefined !== 'required'` is silently false. So the entire lease
declaration was read by nothing that executed, and a device could add lines to
any order in its tenant by sending any non-empty string.

Verified by hand before the fix: release the lease, then
`POST /pos/order/:id/line` with `X-Lease-Token: not-a-real-lease` → `200`, line
created.

**Why the device id cannot be the credential.** Two reasons, and the second is
the operative one.

It is not secret: it appears in audit rows, in KOT local references
(`localKotReference`), and in logs.

It is *stable across claims*. A token that does not change cannot distinguish
"you still hold the lease you queued this operation under" from "the lease was
taken away from you and later granted back to you". The client queue already
assumes it can — `apps/web/src/services/queue.ts` attaches the token an operation was
**enqueued** under, precisely so a stranded batch arrives carrying the old one
and is refused rather than merged. That assumption was unmet server-side, and
under a device-id credential it is unmeetable.

**The epoch rule.** One token per CLAIM row. A claim mints it; renewal carries
it unchanged (a terminal renewing mid-service must not have to re-plumb its
queue); release and force release end that row, and the next claim — same device
or another — is a new row with a new token. So the token is simultaneously a
secret (what the online write path needs) and a lease-epoch identifier (what the
quarantine rule needs).

Asserted end to end in `tests/http/leaseEnforcement.test.ts`: a token stranded by
a force release stays dead after the table is re-granted to another terminal,
and the new terminal's token works.

---

## The lease is resolved in the registrar, and the route declares its subject

`LeaseRequirement` is no longer `'required' | 'exempt'`. It is:

```ts
type LeaseSubject = 'session' | 'order' | 'bill';
type LeaseSubjectSource =
  | { in: 'param'; name: string }
  | { in: 'body'; name: string };
type LeaseRequirement = 'exempt' | { subject: LeaseSubject; at: LeaseSubjectSource };
```

with four named shapes in `leasedOn` that the route table uses.

**Why the subject was the missing half.** `'required'` could only ever buy a
presence check, because the registrar had no way to know *which session* a write
to `/pos/order/:id/line` belonged to. Making the subject a required field means
the compiler refuses a leased route that does not say how to reach its session.
There is no default to fall back to and nothing to forget.

`POST /pos/bill` is why the source is declared rather than assumed to be `:id`:
it is leased and it names its session in the **body**, because a bill does not
exist when it is generated. That shape is now visible in the route table instead
of special-cased in the registrar.

**Where the check runs.** Inside the transaction the registrar opens, after
authorisation, before the handler. Not in the handler — a check a handler
performs is a check a handler can omit, across fourteen routes. Not in the
`onRequest` hook — that runs before a pooled connection is taken, deliberately,
and the lease lives in the database. The cheap presence check stays in the hook
(and now actually fires); the authoritative resolution is in the registrar.

**Resolution order matters.** `requireLeaseByToken` resolves the lease **from
the token**, then compares its session to the one the URL's subject resolves to.
Resolving by `(session, device)` taken from the request would let the client name
its own device — the same mistake in a smaller form. The token yields both the
session and the device, so a request can neither assert a session it does not
hold nor borrow another terminal's identity to hold one.

Errors: `lease_token_unknown` (409) is uniform across expired, released and
force-released — the three are only distinguishable to someone guessing tokens,
and the recovery is identical in all three: claim. `lease_subject_mismatch` (409)
is separate because its client action differs: do not re-claim, reload.

---

## Two handler maps may not supply the same name

`mergeHandlers(...)` refuses a duplicate key. `DuplicateHandlerKeyError`.

**What this found.** `{ ...posHandlers(), ...kdsHandlers(), ... }` is how
`GET /pos/session/:id/board` served the **kitchen** board for its entire life.
Both maps had a `board` key, the spread kept the second, and the POS's single
most important read answered `200 []` — a valid, empty, entirely wrong response.

Nothing caught it. The handler existed. The route existed. The
handler↔route correspondence gate saw a name it could resolve. 662 tests passed.
It was found by a screen asking for its own data and getting somebody else's.

The lookup is by string, so the compiler cannot help. This can: a duplicate is a
boot refusal, in the same class as a route with no audit posture. The cost is
that two surfaces may not both call something `board` — the KDS handler is now
`kdsBoard` — which is a small price for a read that cannot be quietly swapped.

Gated in `tests/http/thinHandlers.test.ts` with a synthetic violation: two maps,
one shared name, two different implementations.

---

## Every named refusal is either told to a client or refuses the boot

`ERROR_CONTRACT` gains 35 mappings. `BOOT_REFUSALS` names the six codes that
never reach a client. `tests/http/errorContract.test.ts` reads `src/` for
`readonly code = '...'` and asserts every one is in exactly one bucket.

**What this found.** 41 declared error codes were unmapped, so every one of them
reached a client as `500 internal_error, retryable: false`.

`session_version_conflict` was among them — the refusal two waiters at one table
produce on the ordinary path. So was `line_already_fired`,
`menu_item_not_orderable`, `discount_exceeds_authority`, `bill_already_tendered`
and 36 others. The domain had gone to the trouble of naming each refusal and
distinguishing it; the HTTP layer discarded all of them and told the tablet the
server was broken.

Nothing was wrong with any individual error class. The gap was that nothing
compared the set of *declared* codes to the set of *mapped* ones. The fallback
to 500 was correct — loud and safe beats presenting our bug as the caller's
mistake — but a fallback was carrying the product.

The gate reads the source rather than an inventory, so a new error class fails
on the commit that introduces it. Two buckets, no third: "nobody got round to
it" is not a bucket, and that silence is what this cost.

`session_version_conflict` is mapped `409, retryable: false` specifically. A
queue that retried it would hold the shift's work behind a request that can
never succeed: the client has to re-read and compose a new one.

---

## A handler takes the branch from the token and the session from the lease

Two new helpers in `src/routes/handlers/pos.ts`, and the body fields they replace
are gone:

- `branchOf(request)` — the branch from the verified token. `openSession`,
  `claimLease` and `fire` took `branchId` from the **body**. The permission was
  resolved against the token's branch; accepting the body's would mean a till
  enrolled at one branch could write at another, with the authorisation check
  having passed against the first.
- `leasedSession(request)` — the session from `request.heldLease`, which the
  registrar resolved from the order in the URL and verified against the token.
  `fire` took `sessionId` from the body: a second, unchecked opinion about which
  table a write is for, sitting next to a checked one.

`sessionVersion` stays a body field. That one *is* the client's to assert — it is
the version the waiter composed against, and the point of optimistic concurrency
is that the client says which one it saw.

---

## Also

`GET /pos/floor` returns `order_id` alongside `line_count`. Both come from the
same LATERAL, because a client that got a count without an id to act on it with
would have to make a second call, and a second call is a second instant. The
predicate is `status NOT IN ('closed','cancelled')` — the same one the write path
uses. Filtering to `'open'` would strip the order id off every table that had
fired, which is most of them mid-service.

---

## Phase 8b: the money half, the admin surface, and what they found

Six decisions. The pattern from Phase 8 held: every defect below was in code that
passed the whole suite, and every one was found by a screen or a route asking for
something real.

### The body is the one part of a request nobody verified

Three POS handlers read their own attribution out of it:

| handler | took from the body |
|---|---|
| `generateBill` | `branchId`, `sessionId`, `businessDate`, `generatedByUserId` |
| `tender` | `tenderedByUserId` |
| `settleManual` | `tenderedByUserId` |

A bill and a tender are what a till-shortfall investigation reads. The tenant
audit log was always right — the registrar takes the actor from the token — so
the discrepancy would have been *between the audit trail and the money rows*,
found by someone trying to work out who was on the till.

It reached three handlers because `body<Parameters<typeof f>[1]>` looks like a
way to avoid restating a type, and what it actually says is "the client supplies
every argument."

`tests/http/requestProvenance.test.ts` now reads the type argument of every
`body<...>` in the handler layer and refuses `branchId`, `sessionId`,
`businessDate`, `tenantId` and any `...ByUserId`. Two escape hatches, both
narrow:

- `THIRD_PARTY_ATTRIBUTION` — `authorisedByUserId` on a manual settlement names
  the **manager**, who is by definition not the cashier keying it in. That one
  cannot come from the token.
- `PRE_AUTH_HANDLER_FILES` — `auth.ts` reads `branchId` from the body because at
  login there is no token; that is what `resolveTenantForAuth` exists for. It is
  a cross-check, not a scope, and the last test in the file asserts those
  handlers serve nothing but the public plane, so the exemption cannot quietly
  widen.

### A constraint refusing a write is not an internal error

`toErrorResponse` matched our own string codes; Postgres errors carry a
five-character SQLSTATE. So every CHECK, unique index and deferred constraint
trigger in the schema — a good deal of this system's correctness — answered
`500 internal_error, retryable: false`.

Generating a second whole bill for one table, refused correctly by
`assert_billing_invariants`, came back as an internal error with the trigger's
message and an order-line UUID in it.

Now classified by SQLSTATE: `23514`/`23P01` → 409 `invariant_refused`, `23505` →
409 `already_exists`, `23503` → 422 `reference_invalid`, `23502` → 400
`field_required`, `22P02` → 400 `field_malformed`. The message is **not**
forwarded; the constraint name (or the column, for a not-null) is, because that
is a schema identifier and the only part of a Postgres error that helps.

Fastify's own `FST_ERR_CTP_EMPTY_JSON_BODY` is mapped too — a DELETE with a JSON
content-type and no body was a 500, and a queue retrying a 500 forever over a
missing body is a queue that never drains.

Separately, `generateBill` now refuses over-allocation **up front** with
`lines_already_billed`, so a cashier gets a sentence. The deferred trigger stays
the authority, and `tests/ops/service.test.ts` proves it by inserting
`bill_line` directly, bypassing the application — otherwise the early check
would have turned the trigger into unreached code, which is the family this
whole phase keeps finding.

### The KDS event had a silent no-op in it

`emit` read `request.body.stationId` and, if it was absent, `return`ed. So a
client that bumped a ticket without naming the station got a 200, the ticket
really advanced, and **no event was published** — every other screen in the
kitchen kept showing it queued until someone reloaded. The one mechanism the
whole SSE design rests on could be skipped by omitting a field.

The station is not the caller's to supply: it is a property of the `kot_line`
being advanced. `advanceLine`, `advanceTicket` and `recallTicket` now return it,
`emit` takes it from there, and there is no branch that skips the notify.

### The bills had no read

`recordTender` returned `outstandingMinor` in its own response, and that was the
only way a client could ever learn it. A tablet that took a partial cash tender
and reloaded — or a second tablet asked to finish a settlement — had no way to
find out that ₹100 of ₹388.50 was already in the till. It would have shown the
full total again.

`readBoard` now returns `bills` with their tenders, `paid_minor`,
`outstanding_minor` and `settled`, computed server-side in the same transaction
that reads the tender rows. Note that a void is a **negative tender row** with
`voids_tender_id` set, not a flag on the row it cancels — the ledger is
append-only and signed — so "paid" is a plain sum with no filter to get wrong,
and both the capture and its void come back so a cashier reconciling a drawer
sees two events rather than an absence.

### `POST /pos/bill` moved to `POST /pos/session/:id/bill`

It was the only route leased on a **body** field, which needed an `in: 'body'`
arm in `LeaseSubjectSource` — one route, one branch, and a branch inside the
guard that decides whether a write is allowed, exercised by one caller. Putting
the session in the path made the arm unnecessary and it was deleted. An
unreached path in a security guard is not worth keeping for symmetry.

### The admin CRUD is generated from a declaration

`src/modules/restaurants/adminResources.ts` states, per resource: the columns a list returns, the
fields a create may set, the fields an edit may set, whether rows belong to a
branch, and what a delete means. `src/routes/handlers/admin.ts` is one
implementation per verb. 21 routes served from ~200 lines.

Forty hand-written CRUD handlers are forty chances to forget the branch scope,
return a column that should not leave the server, or pass the body into an
UPDATE. The seventh copy does all three. But a generated handler is also one
mistake applied twenty-one times, so the three hazards are gated explicitly in
`tests/http/adminSurface.test.ts` — and all three return **200** when they go
wrong:

- **Mass assignment.** `PATCH /admin/devices/:id` with `{"status":"active"}`
  un-revokes a stolen terminal through a route whose key is only `device.edit`.
  Fields are an allowlist and anything else is **refused**, not filtered —
  dropping a field silently is the worst of the three options, because the caller
  gets a 200 and believes it landed. Structured values are refused too: a nested
  object reaching a jsonb column through a route that has no idea the column is
  jsonb.
- **Column leakage.** `SELECT *` returns `device.fingerprint` (what a PIN login
  is checked against — `device.view` would become a way to impersonate a
  terminal) and `app_user.email` (PII, whose reading belongs in
  `app.pii_access_log`, which the generic handler does not write, so it does not
  return the field).
- **Scope escape.** A branch-scoped session editing another branch's row by
  naming its id. The predicate carries the branch as well as the id.

The schema corrected this table three times while it was being written, and each
correction is recorded in it:

- `app.device` refused a status-only revocation:
  `device_revocation_consistent` requires `status`, `revoked_at` and
  `revoked_by_user_id` to move together. It was right — a revocation with no name
  against it is not something anyone can investigate — so an archive is now a
  **set** of assignments, with `now` and `actor` filled from the transaction
  clock and the verified token.
- `branch_status_known` permits `active`/`inactive`, not the `archived` this
  table had invented; `app_user` permits `disabled`, and deliberately not
  `suspended`, which is `user.suspend`'s own reversible decision.
- The primary key has no default, so the generic create mints the id
  server-side — which is right anyway: a caller-supplied primary key is a way to
  probe for existing rows.

`roles` is the one **hard** delete, and it is safe for one reason: every
`app.membership` row references `app.role` with ON DELETE RESTRICT, so a role
anybody holds cannot go. The constraint is the authority; the route is only the
request. `devices` has an empty `editable` because there is no `device.edit`
permission key — renaming a till is the most ordinary admin task there is, and
adding the key is a catalogue change that belongs with the Phase 1 decisions
rather than smuggled in behind a CRUD table.

---

## Phase 9: the KDS client, and what it found

### An unknown station returned an empty board

`stationBoard` filtered by `station_id` and returned whatever matched. For a
station that does not exist — or exists at another branch — that is zero rows,
which is exactly what a station with nothing on it returns.

So a kitchen screen configured with the wrong id showed a calm, empty, entirely
wrong pass for the rest of the service, and the only symptom was food nobody
cooked.

This is the client doc's own rule — *absence is never a discriminator* — violated
on the side that can actually tell the difference. `GET /kds/station/:id/board`
now 404s `station_unknown`, scoped by **branch** as well as tenant, because a
station id from a sister branch is well-formed, real, and the mistake a chain
makes when it copies a screen's configuration.

Found by building the KDS setup screen, which verifies its station by reading the
board and cheerfully accepted a bogus uuid.

### The KDS role lists its branch's stations (DECIDED, 0065)

Superseded: the `kds` role originally lacked `kitchen.station.view` and the screen
took a pasted station id. In practice a manager pasted a tablet setup code into
it. `KITCHEN` now holds `kitchen.station.view` -- a read of names, branch-scoped by
the token through `GET /admin/stations` -- and the screen offers the branch's
kitchens as buttons. The choice is still **verified by reading that board** before
it is remembered, because an empty pass and a refused read look the same.

### What the SSE design looks like now it has a consumer

The design was built in Phase 6 and had no client until now. It held up: read the
snapshot, release the connection, wait on the emitter, one LISTEN connection per
process. Two things the client had to be built around rather than against:

- **The event is a poke, not a patch.** `{kind, stationId, at}` and no board. A
  client applying diffs would have a screen whose state is the sum of every frame
  it has seen, so one missed frame is a screen quietly wrong for a whole service.
  The client re-reads instead, which is idempotent.
- **`EventSource` cannot send an Authorization header.** The stream is consumed
  with `fetch` + `ReadableStream`. A token in the query string would end up in
  access logs; a cookie would give the API a CSRF surface the token design exists
  to avoid.

Verified in a browser: a ticket fired from the POS over HTTP appeared on the
kitchen board with no reload, was advanced line by line, and was bumped away.
That is the first time the LISTEN → emitter → SSE path has been exercised end to
end by a real consumer.

---

## Phase 10: the admin UI, and the declaration that named columns the table did not have

### `pick()` turned a nonexistent column into a null

The generic list handler built its response with
`out[column] = row[column] ?? null`, and that `??` covered two completely
different facts: a real column holding NULL, and a column name the table does not
have at all.

The `menu/items` declaration named `tax_class_key` and `is_combo`. The real
columns are `tax_class_id`, and there is no combo flag on that table. So two
columns of every row came back null and the admin screen rendered an em-dash
meaning "not set" — sixteen rows of it, entirely plausible.

Nothing failed. The list returned 200. The shape was consistent across rows. The
column-allowlist test passed, because it compared the response to the same wrong
declaration. It was found by looking at a screenshot.

This is the same defect the resource table was written to prevent — a silent
absence presented as a value — committed by the resource table. Two fixes, and
the second is the one that matters:

- `pick()` now uses `column in row` and throws `declared_column_missing` on an
  absent key. A NULL value still passes through as null.
- `tests/http/adminSurface.test.ts` reads **information_schema** and checks every
  declared `columns`, `creatable`, `editable`, `orderBy`, `branchColumn` and
  archive column against the real table. It also checks that an archive sets
  every column the table pairs with a status (`archived_at`, `revoked_at`), and
  that each status value it writes satisfies the table's own CHECK.

That last one is worth stating plainly: `app.device` caught its own version of
this with a CHECK constraint, and `app.menu_item` would not have — it has an
`archived_at` with nothing tying it to `status`, so a row reading `archived` with
a null `archived_at` would have sat there indefinitely. The gate covers the case
the schema cannot.

### The list response declares what is writable

`GET /admin/:resource` now returns `editable`, `creatable` and
`deletes: 'archive' | 'remove' | 'none'` alongside the rows.

Without it an admin form has two bad options: render every column as an input and
have the **whole** request refused because one of them is not writable — including
the field the manager actually changed — or keep its own copy of the writable set,
which is a second declaration and drifts. Sending it keeps the allowlist a single
fact.

It leaks nothing. A caller who can read the list can already discover the writable
set by trying, and `fields_not_writable` names it in the refusal.

`deletes` exists because "Take out of use" and "Delete permanently" are not
interchangeable words to put in front of a manager, and only the server knows
which one a resource does.

---

## Staff onboarding and restaurant branding (migration 0060)

### Staff set their own secret from a setup code

Until 0060 a staff member created in the app could never sign in: the only
code that wrote a credential was the owner's setup-link redemption, and
`app.staff_invite` (0018) required an email, which a waiter or cashier
usually does not have. Correct, tested, unreachable -- the family again.

Now `POST /admin/staff` issues an INVITE naming the person, the role, where
it is held, and how they sign in: `password` (needs an email) or `pin` (needs
a staff code). `POST /api/auth/staff-invite/accept` takes the setup code and
the secret the person chose, and only then writes the user, credential and
membership. Nobody but the staff member ever knows the secret -- the same rule
as the owner invite, for the same reason: actions under a secret someone else
also knows cannot be attributed with certainty.

- The code is `<restaurant-slug>.<secret>`, the tablet setup-code shape: the
  redeeming page has no sign-in and so no restaurant. Only the secret is
  hashed and stored.
- The role is checked when the invite is ISSUED, by `authoriseGrant` -- the
  same function the direct grant uses, extracted so the two cannot disagree.
- The PIN's general policy is answered before the code is looked at; its
  personal checks (staff code, phone) need the invite and are answered to the
  holder of a valid code only.

### A branch-less session may name the branch a role is held at (DECIDED)

The grant path used to require a branch-scoped session to grant a
`branch_only` role, so the owner at the admin screen (password sign-in, no
branch) could not add a waiter at all. Now a branch-LESS session names the
branch in the query string (`?branchId=`), the same rule as the stock screens'
`requiredBranch`; a branch-scoped session always uses its own and cannot name
another (`grant_branch_conflict`). The named branch is trusted for placement
only: the subset rule is resolved AT that branch, and it must be an active
branch of this tenant.

Who may add staff is `user.invite` -- owner and Restaurant Admin. The manager
role still cannot: a manager who could create a cashier could create an
accomplice and approve their refunds.

### Roles

Staff accounts are created by **type**: KOT (`waiter`, shown **KOT Staff**), KDS
(`kds`, **KDS Staff**) and Billing (`cashier`, **Billing Staff**); anything else is an
"office account". The keys are unchanged.

`chef` was added here and **retired in 0065**: stock control left the product with
0064, which left it the kitchen screen and nothing else -- a duplicate of `kds`. The
migration refuses to run while anyone holds or is invited to it, and repoints
`cloned_from_role_id` at `kds` rather than deleting custom roles.

### Branding lives on the tenant row and is read publicly

`platform.tenant.address`, `platform.tenant.theme_color` (`#rrggbb` only -- a
free-text colour is a CSS injection point) and `platform.tenant_logo` (PNG,
JPEG or WebP, 256 KB, bytes checked against the declared type, SVG excluded
because it can carry script and is served from our origin). The tenant plane
never reads them per request: the admin app takes them from the PUBLIC
restaurant lookup it already makes for `/{slug}`, and sets `--color-primary`
(and `--primary`) on the document root.

A SECOND colour, `theme_color_secondary` (0079, same `#rrggbb` CHECK, nullable),
is the tinted surfaces (`--color-accent`, `--color-brand-secondary`); the primary
stays the buttons. NULL keeps the old behaviour: the tints come from the primary.
Both are set on the restaurant create and edit forms beside a live preview of the
staff login, through the existing provision and `PATCH /api/platform/tenants/:id`.

### Admin forms mark required fields from the table itself

`GET /admin/:resource` returns `required`: the writable columns that are NOT
NULL without a default, read from information_schema and cached per table.
Derived, not declared -- a hand-kept list would drift the first time a
migration relaxed a column.

---

## The manager's setup flow (migration 0061)

Floors, tables, stations, printers, categories, items and add-ons existed from
Phase 2; what a restaurant created from the console lacked was any way to
CREATE most of them -- stations and printers could only be renamed, and
floors, tables, categories and add-ons had no route. The demo seeds wrote them
straight into the database. Now every one has create, edit and archive, and the
admin's **Setup** page walks them in dependency order: floors, floor types,
tables, printers, kitchens, categories, food items (with add-ons).

- **Floor types** (`app.floor_type`, AC / Non AC / VIP / Rooftop seeded per
  restaurant) sit on the FLOOR, not the table.
- **A table's floor must be at the table's branch** -- a composite FK closes
  what the id-only FK left open.
- **Food / Beverage is on the station CODE**, not the branch station: items
  route by code, and a code's type must not differ between branches.
- **A kitchen is created with its printer**, in one step (code + branch
  station + primary printer link). A kitchen with no printer cannot print.
- **Food items**: name, description, barcode (unique among active items),
  category, single/combo (a combo is fixed single dishes), kitchen, price,
  preparation time in minutes, add-on groups. The KEY IS DERIVED FROM THE NAME,
  never typed. Create lists the item at its branch: an unroutable kitchen is
  refused by name; a missing recipe on a plan with stock control saves the item
  OFF SALE with the reason, because the recipe needs the item to exist first.
  `POST /admin/menu/items/:id/listing` puts it on sale later, strictly.
- **Add-on options are archived, never deleted** when a group is edited: kitchen
  tickets reference them.
- A branch-LESS session (the owner) names the branch with `?branchId=` on the
  generic admin create and list too -- the same rule as staff and stock.
- `UnroutableAtBranchError` and `StationStillRoutedError` had no error code, so
  the first real caller of each would have shown a manager "internal error".

---

## Joined tables and parcels (migration 0063)

### A party is a session; tables and parcels are how it is seated

**Joining is an attachment, never a second order.** `table_session_table` always
allowed several live tables per session and the one-live-attachment index already
made "one table, one party" the database's decision -- only the route was missing.
`POST /pos/session/:id/tables` adds one; the order, every KOT and the one bill stay
with the session, so a second group sitting at T06 is send 2 of the same order,
not a new one.

**Unjoin frees the table and moves NO lines (DECIDED, option A).** Separate
payment is Split bill's job, which already divides one bill by guest, line or
amount. Moving lines between orders would be a new money-moving operation across
two leases; nothing needs it yet. A party keeps at least one table
(`session_last_table`) -- to change table it is moved, not emptied.

**A parcel is a session with no table**, `service_type = 'parcel'`. Lease, fire,
KOT, bill, tender and close all key on the session and work unchanged. The
number is a counter row (`parcel_sequence`), gapless per branch per business day,
because it is called out at the counter. The status is DERIVED, never stored --
new / preparing / ready from the kitchen lines, picked up from the stamp,
completed from the session closing -- so there is no second opinion to drift.
Hand-over is refused while anything is unsent or cooking.

**The pickup name is a label; the phone is not stored on the session.** A phone
goes on the bill through the existing customer attach, which is where
`customer.create` is checked and where masking and erasure live. `table.session.open`
must not become a back door to creating customer records.

### Closing a session releases its tables

`closeSession` never detached, and the one-live-attachment index counts a closed
session's attachment as live -- so every table whose party had paid could never
be seated again. Found by counting rows while designing join, not by a test: five
tables in the dev database were stuck. `closeSession` now detaches; 0063 repairs
existing rows. `serviceFlow.test.ts` re-seats a table after closing it.

### The kitchen ticket says who it is for

`stationBoard` returns the tables (or parcel number and name), the order's send
number and, per dish, the add-ons. **An add-on without its own station had never
reached a kitchen ticket at all**: `fire` writes a kitchen line only for an add-on
routed elsewhere, so "Extra raita" was on the bill and nowhere in the kitchen.
The board now reads those from the order line's snapshot. No money is returned
to a kitchen screen.

### A branch-less owner names the branch for a tablet code

`POST /admin/devices?branchId=` -- the same rule as staff and setup. The branch
must be active and this restaurant's (`activeBranchFor`, shared with the generic
admin create so the rule has one copy); a branch-scoped session cannot name
another. The plan's tablet limit still gates the route.

---

## KOT and Billing: one order, two owners (migration 0064)

The product is three apps: **KOT** (Kitchen Order Tracking -- taking and
managing orders, `/{slug}/kot`), **Billing** (`/{slug}/billing`) and the
**Restaurant Manager** admin. The kitchen screen (`/{slug}/kds`) stays for kitchen
staff on Pro. Basic is one person: Manager -> Billing -> Payment. Pro is
Manager -> KOT Staff -> Kitchen -> Ready for billing -> Billing Staff -> Payment.

### Ownership is a stage on the ONE order, enforced in the domain

`table_session.stage` is `ordering` | `billing`, a positive column with its stamps
(`billing_ready_at`, `billing_ready_by_user_id`) tied by a CHECK. There is no
KOT copy and no Billing copy: the same session, order, lines and bills.

- `markReadyForBilling` (route `POST /pos/session/:id/ready-for-billing`, key
  `order.handover`, KOT's lease) moves it to `billing` and **ends every live lease**
  on the session. On a `kot` plan it refuses while any item is unsent -- an item the
  kitchen never saw. Basic sends nothing, so it does not ask.
- `assertTakesOrderChanges` is called FIRST in add/edit/remove line, fire, void,
  comp and discount; join, unjoin, move and guest count check the stage under their
  own session lock. **In the domain, not the route**, because the offline sync path
  replays the same functions -- a route guard is one a tablet coming back online
  walks past. It locks the session row, the head of the documented lock order, so a
  hand-over cannot land between the check and the write.
- `generateBill` calls `assertInBilling`: Billing cannot bill an order KOT owns.
- `claimLease` takes the stage it claims for and locks the session first (same order
  as the hand-over: session, then lease). KOT claims through `/lease`
  (`table.session.open`); Billing through `/billing-lease` (`bill.generate`). Each is
  refused the other stage, so neither can take the order back from the other.
- The way back is a manager decision: `POST /admin/sessions/:id/reopen`
  (`order.reopen`, written reason, refused once a bill exists -- the bill is a
  snapshot of the lines). Under `/admin/`, not `/pos/`: a manager at the admin holds
  no tablet, and every `/pos/` write claims an idempotency key against one.

### Basic has no KOT, and that is a gate, not a hidden menu

`fire`, KOT reprint and every `kds.*` route declare `{ feature: 'kot' }`; Basic gets
402 naming Pro. The Billing screen reads `kot` from `GET /billing/queue` (resolved
from the entitlement document) and, without it, offers **New order**: a counter
(parcel) or table session, lines, hand-over and bill in one flow on the same
domain functions. The owner signs in to Billing with their own PIN
(`POST /admin/access/me/pin` issues a set-up link to the TOKEN's subject only).

### What was removed, and what deliberately stayed

Stock, purchasing, suppliers, recipes, customers/loyalty, GST registration and
premises class, and the company-GSTIN option lost their screens, routes, handlers
and every module nothing else imported (found by an import-graph sweep, not by
hand). **Their tables stay** -- rows are records -- and so do their permission keys:
the separation-of-duties rules are written in them and custom roles hold them by FK,
so removing keys is a catalogue change of its own. They are listed as RETIRED in
`KEYS_WITHOUT_ROUTES`, which is why that ratchet's ceiling rose from 35 to 55.

**Basic's Billing account is `counter` (Billing & Orders, DECIDED).** On Basic
nobody else takes the order, so the Billing account holds the till plus
`table.session.open`, `order.create` and `order.handover` -- no `kot.fire`, no
report, no adjustment key. A separate role rather than order keys on `cashier`,
because a role's keys cannot depend on the plan and on Pro Billing Staff must not
open orders past KOT. The Staff screen picks it for a Billing account when the
plan has no `kot`. `payment.collect` is therefore held by an allowlist of two
roles, both branch-only, asserted in `tests/authz/matrix.test.ts`.

Role keys are unchanged (`waiter`, `cashier`, `kds`); only names changed: **KOT
Staff**, **Billing Staff**, **Kitchen**. `scripts/reconcile-system-roles.mts` pushes
names and keys to existing restaurants.

---

## Basic as one person's POS (0070–0072)

### The owner's till is a device registered by a signed-in person (DECIDED; routes replaced in 0076)

> **Superseded in part (0076):** `/admin/till` and `/admin/till/:id/session` were
> folded into `POST /api/auth/:tenantSlug/till`, the POS half of the one login page --
> see "One login page" below. The reasoning here (a till is an ordinary device, the
> session is the same user narrowed to it) still holds.

Every POS write is leased and claimed against an `app.device`, so a browser
that takes orders has to BE a device. A staff tablet becomes one by redeeming a
setup code; the owner would be issuing that code to themselves. So
`POST /admin/till` lets a person holding `device.register` (escalation-class:
owner, Restaurant Admin) register the browser they are signed in on -- the same
row, fingerprint index, tablet limit and revocation as any tablet.

**The answer is a session for the SAME USER at the till's branch and device.**
Nothing is granted: their union of memberships at that branch decides what the
screens may do, exactly as for a PIN sign-in. On Basic that union is owner +
the cashier membership provisioning already gives the owner, so one person
takes the order and the money while `authorising_membership_id` still records
which capacity acted. Separation of duties is untouched: no role holds both.

A route that answers with a session refuses, before anything else:
- **an impersonation session** -- its subject is a platform user, and an
  ordinary tenant session for one would outlive and escape the impersonation
  row that makes impersonation revocable;
- **a session already on a tablet** -- a till is set up from a sign-in;
- **an `Idempotency-Key`** -- the registrar stores a keyed response in
  `request_claim` for seven days, and this response is a credential.

Signing an existing till back in (`/admin/till/:id/session`) adds no device and
so carries no limit gate: a restaurant at its tablet limit must still open its
own till.

### Which screens a sign-in may open is read from keys, never names

`GET /me` returns `screens` from `SCREEN_KEYS` (the Access list's map) over the
session's effective permissions. The POS shows its Billing tab on
`screens.billing`; Pro's KOT Staff hold no bill key and see what they always
saw. It is a permission answer, not a plan answer -- the owner holds `kds.view`,
and the plan is what refuses the kitchen screen on Basic, with 402.

### Restaurant users are a plan limit, and only ADDING is refused

Counted under the plan-limit lock: active and invited accounts plus pending
staff invites (an invite becomes an account on a route with no plan to check --
the same reasoning as unused setup codes). Gated: staff invite, the generic user
create, and switching an account back ON (`toggleAccess`, from the plan the
registrar loads with `plan: 'document'`). Switching OFF is never refused, and
nothing is checked at sign-in: a plan term must never lock a working restaurant
out. `planUsage` is a `Record<PlanLimit, sql>` so a new limit cannot compile
without its own count -- the ternary it replaced would have counted users as
tablets with every test green.

### Cash handed over is not cash taken

`tender.amount_minor` is what the tender APPLIED to the bill -- the only figure
sales, the invariants and reconciliation read. A cash note is recorded beside
it (`cash_received_minor`, cash captures only, never less than applied); change
is derived, never stored. `takePayment` locks the bill, applies non-cash parts
first (none may exceed the balance) and the one cash note last; the deferred
trigger stays the authority and is proven by a direct insert.

### New slugs must be clean; a renamed restaurant's old address keeps working (0073)

`SLUG_PATTERN` is also the routing rule, so it keeps accepting every existing
slug; `slugProblem` adds the clean rule (single hyphens between letters or
digits) for new slugs only, and `tenant_slug_clean` holds the database to it
for new and changed rows (NOT VALID).

**A Super Admin may rename** (`POST /api/platform/tenants/:id/slug`, key
`platform.tenant.rename`, held by Super Admin only). The slug is in every
tablet's setup code, stored identity and PIN URL, so the OLD slug is kept in
`platform.tenant_slug_history` and still resolves: `platform.tenant_id_for_slug`
is the one resolver every slug read goes through (sign-in, setup codes, staff
codes, the public lookup, the logo). **An old slug is never free for another
restaurant** -- handing it on would hand over every old link, QR code and
stranded tablet -- and that is the database's rule, not the application's: a
trigger on both tables takes an advisory lock on the slug and checks the other
table, so two concurrent renames cannot both win. Only the restaurant that had
an address may take it back.

Sessions carry the tenant id, never the slug, so nothing signed in breaks. The
client moves what a browser stored under the old slug (`moveRestaurantStorage`)
whenever the public lookup reveals one -- asked by an old address, or answering
with `formerSlugs` at the new one -- so a tablet stays set up either way.

### Basic has no staff tablets: one POS link, one sign-in (DECIDED, 0074)

`staff_tablets` is a `PlanFeature` every version states (Basic `false`, Standard and
Pro `true`). It gates ISSUING a tablet setup code: `POST /admin/devices` declares
`[{ feature: 'staff_tablets' }, { limit: 'devices' }]`, so Basic gets 402 naming
Standard. Enrolment itself is untouched -- an unused code issued before 0074 still
redeems, and nothing already enrolled stops working: a plan term never takes a
restaurant offline. The till (`POST /admin/till`) is not a setup code and is not
gated by it; it still counts against `devices`.

The admin reads the same flag: on Basic the access page shows one link,
`/{slug}/pos`, and no code panel; Standard and Pro keep the three tablet links and
"Set up a tablet". `/{slug}/pos` is SERVED (nginx and Vite), no longer redirected to
`/kot` -- same document, same per-restaurant storage, so either address opens the
same till. The POS tabs are **Dine-in · Parcel · KOT · Billing**: KOT gathers every
open order with something in the kitchen (from `/pos/floor` and `/pos/parcels`)
and shows each one's ticket panel, on `screens.kot`; Billing on `screens.billing`.

`GET /admin/entitlements` returns `usage` (`usageNow`: the same counts the gates
refuse on, without the lock), so the Staff screen shows "N of M restaurant users" and
stops offering Create staff at the limit. The server still refuses; the client only
stops offering a button that would be refused.

### Basic has no tables (DECIDED, 0075)

`tables` is a plan term every version states, off on Basic. Rows a Basic
restaurant already holds are left; only ADDING is refused, with the ordinary 402
naming Standard.

The floor-plan routes (`/admin/floors`, `/admin/floor-types`, `/admin/tables`)
gate `{ feature: 'tables' }`, and so do seating, moving and joining at the POS
(`POST /pos/session`, `PATCH /pos/session/:id/table`, `POST /pos/session/:id/tables`).
Unjoining is not gated -- freeing a table is never refused. The Excel import
refuses a Floors or Tables sheet on such a plan rather than writing past the gate.
Dine-in on Basic is **numbered at the counter** (`POST /pos/dine-in`,
`GET /pos/dine-ins`), from the SAME counter as parcels, so two orders called out at
one counter never share a number: `D-4` beside `P-5`. `table_session.seating`
(`table` | `counter`) is the POSITIVE discriminator -- "has no table row" is
absence, which a CHECK cannot see -- and the shape CHECK ties the counter number to
it. A counter session refuses join, unjoin and move in the domain
(`session_at_counter`), not only at the route. Every label (kitchen ticket, KDS
card, billing queue, receipt, open orders) goes through the one `describePlace` in
`packages/shared`. `GET /me` answers `seatsAtTables` from the plan, so the POS
Dine-in tab shows the counter or the floor.

### One login page; the manager creates staff logins (DECIDED, 0076)

> **The staff half is superseded by 0077 (below):** staff are PIN-only, the Sales person
> manages them, and the manager screens manage no staff. The manager's half -- one login
> page at `/{slug}`, `lands`, the till at `POST /api/auth/:slug/till` -- stands.

0075 briefly made staff management a plan term (`staff_admin`) and handed Basic's
staff to the Sales person. That was reversed the same day: **the restaurant's own
address, `/{slug}`, is the one login page for the manager AND the staff**, and the
manager creates staff usernames and passwords from the Staff screen. 0076 drops
`staff_admin` from every plan version and the Sales person's `platform.tenant.staff`
key from the catalogue. The control plane never sets a tenant user's password.

**Where a person lands is the server's answer.** `POST /api/auth/:slug/login`
returns `lands: 'admin' | 'pos'` (`landingFor`, modules/users/me.ts): whoever holds
`user.view` at any branch or tenant-wide manages the restaurant (owner, Restaurant
Admin, Manager -- `SCREEN_KEYS.admin`) and lands on the manager screens; everyone
else lands on the POS. The same sign-in carries a branch when, and only when, every
role the person holds is at ONE branch and none is tenant-wide -- a scope they were
granted, not one minted at login -- so a branch-held person's own reads resolve.
`GET /me` also answers `screens.admin`.

**The POS half is one route.** For `lands: 'pos'` (or a manager arriving with
`?to=pos`) the login page calls `POST /api/auth/:slug/till` with the SAME username
and password and this browser's fingerprint, and sends the person to `/{slug}/pos`
signed in on the till; staff keep no manager-screens sign-in. The password is checked
FIRST. An existing till is resolved by fingerprint, as for a PIN; a browser that is
not a till yet becomes one there (`registerTillAtSignIn`) for: anyone holding
`device.register` (Restaurant Manager, Restaurant Admin), on any plan; and, on a plan
WITHOUT staff tablets (Basic), anyone who works the POS (`kot.fire` or
`bill.generate`). That is bounded by the plan's tablet limit, counted under the same
lock, and by revocation under Tablets. Standard and Pro staff still set a tablet up
with a setup code -- a staff password there does not make a terminal
(`till_not_permitted`). This REPLACED `POST /admin/till` and
`POST /admin/till/:id/session`, and the POS's own till sign-in screen: one
authentication flow, not two. `/{slug}/pos` has no sign-in screen of its own; whoever
is not signed in goes to `/{slug}?to=pos`.

**The manager's staff login** is `POST /admin/staff/accounts` (`user.invite`, the
`users` limit, `modules/users/staffAccounts.ts`): name, username (the staff code,
`STAFF_CODE`, unique among people and live invites), password (8+), and an access
level from an allowlist -- `pos` (waiter + cashier: orders, KOT and billing on one
sign-in), `orders`, `billing`, `kitchen`, `manager`; never owner. Every role passes
`authoriseGrant`, so the subset and scope rules are the invite's. **This relaxes
"nobody but the staff member ever knows their secret" for these accounts** -- the
manager typed it -- and that is named rather than hidden: the creation is an audit
row naming the manager, the request body (the password) is never recorded (the audit
row is written from the result; request claims are `/pos/` only and hashed), the
password is argon2id, and the manager can reset it. On Basic the Staff screen offers
only this form; Standard and Pro keep the invite (the person chooses their own PIN
or password) for their tablets.

Password sign-in takes an email OR a username, told apart by the "@", which a staff
code cannot hold.

### Basic only: staff are PIN-only and the Sales person manages them (DECIDED, 0077)

**Only Basic is sold.** Standard and Pro are retired (`setPlanStatus`), never deleted; the
restaurants on them were moved with `scripts/move-to-basic.mts` through the ordinary
plan-change path, so every move is a segment and a new entitlement document. Their data
stays: floors and tables a restaurant already holds are refused by the plan (402), not
removed.

**Removed, with their routes, handlers, modules, screens and tests:** the kitchen screen
(`/kds/*`, the SSE stream and its LISTEN connection, `kds.html`), the separate KOT and
Billing apps (`/{slug}/kot` and `/{slug}/billing` serve the POS), tablet setup codes
(`POST /admin/devices`, `/api/auth/device/enrol`), staff invites and setup links
(`/api/auth/staff-invite/accept`), and every staff-management route on the manager
screens (`/admin/staff` POST, `/admin/staff/accounts`, access resets and switch-off,
membership grant, `/admin/users` writes). Their tables stay -- rows are records -- and so
do their permission keys, listed as RETIRED in `KEYS_WITHOUT_ROUTES` (ceiling 55 -> 65).
`device.register` is listed there too: no route declares it, but `registerTillAtSignIn`
still reads it.

**Staff sign in by name and a 4-digit PIN.** The till lists its staff from
`GET /api/public/restaurants/:slug/till/staff` -- a READ, so it is off `/api/auth/`, where
every route must record an attempt. The fingerprint travels in `x-device-fingerprint`,
never the query string, so it stays out of access logs; the answer is names only, and
only to a till. That route's registrar opens no transaction, and the tenant GUC is
`SET LOCAL`, so `readTillStaff` holds its own short read-only transaction for the GUC to
live in (found by test: without it the read answered 500 `tenant_context_missing`).
Staff have no password: 0077 revokes every active password of an account that does not
manage the restaurant (no active membership whose role holds `user.view`), and
`/login` and `/till` refuse a staff account with 403 `staff_use_pin`, after the
password check, issuing nothing. Only a manager (`device.register`) makes a browser a
till; a PIN never does.

**The Sales person manages staff** (`modules/platform/tenantStaff.ts`, routes
`/api/platform/tenants/:id/staff...`, key `platform.tenant.staff`):

- **Only restaurants they sold**, by `provisioning_request.requested_by_platform_user_id`.
  `platform.tenant.staff.any` (Super Admin) widens it to every restaurant -- a key, never
  a role name. It is decided in the handler from the token's role, like the subject: it
  scopes WHICH restaurant, it does not refuse the route. "Not yours", "no such
  restaurant" and "no such person" are one 404.
- **Never a manager account** (`tenant_staff_is_manager`), and only the access levels in
  `ACCESS` (`waiter` + `cashier`, `waiter`, `cashier`): the control plane holds no
  tenant permissions, so the subset rule has nothing to measure against, and an
  allowlist of ordinary staff roles is all it may hand out.
- PIN exactly 4 digits and `checkPinPolicy`; argon2id. The audit row is written from the
  RESULT (`afterIsResult`), which carries no PIN.
- The `users` limit is counted under the plan lock; switching off is never refused.
- It runs as the APP role under the tenant's own GUC (`adoptTenantContext` inside the
  platform transaction), so RLS applies exactly as for a tenant request.

**This relaxes "nobody but the person knows their secret"** for staff PINs, on the
owner's decision. What keeps it accountable is the audit row naming the platform user,
and that a manager's credential is out of reach.

**One POS screen (2026-10-13).** The POS is `BillingWorkspace` only: New order, then
the bill and payment. Confirm runs the existing routes in order -- open, lines, `fire`,
`ready-for-billing` -- then the bill; nothing new on the server. Every step carries an
idempotency key fixed for the attempt, so the request-claim replay is what makes a
retry safe, not a client check. No route marks food ready on this path, and none needs
to: `closeSession` requires only that nothing is owed. Void, comp and discount had
their only screen in the deleted order pane, and the domain refuses them once the
order is in billing anyway -- so on Basic they are not offered at all now.

The till prints the labelled copies (customer, kitchen, counter -- docs/frontend/FRONTEND.md) once
the bill is PAID, never on Confirm (0078): the two bill copies are ONE counted
`POST /pos/bill/:id/print`, and the kitchen copy is the ticket text READ from
`GET /pos/order/:id/tickets`, so a reprint of it creates no print job and no ticket
(asserted in `basicTill` 3b). `fire` still queues the server's own job for the
kitchen's configured printer.

### The printed layout is the branch's, and type comes before paper (DECIDED, 0078)

`app.printer` states `printer_type` (thermal | laser | inkjet) and `paper_size`
(thermal_58 | thermal_80 | thermal_112 | a5 | a4), plus orientation, margin and font.
Type is not size: `printer_paper_fits_type` ties a roll to a thermal printer and
only to one, `printer_roll_is_portrait` gives a roll no landscape, and
`printer_network_is_thermal` holds because the print worker sends raw ESC/POS --
a laser on the network would accept bytes it cannot print. USB and Bluetooth stay
browser-printed; nothing claims the server reaches them.

**A roll is laid out inside the print HEAD, not the paper (2026-10-28).** A 79-80 mm
roll prints about 72 mm, centred; content laid out 74 mm wide lost its right edge --
the amounts. `PAPER.printableMm` (48 / 72 / 104, the common ESC/POS head widths, not
one model's datasheet) and `rollContent` widen the side margin to the head's edge;
the bills, copies, preview and My takings all go through it. Windows setup for a
USB/Bluetooth receipt printer (and why a TCP/IP port on one prints nothing) is in
`katkitchen.md` 5.5.

**The till prints to its own USB/Bluetooth printer directly (DECIDED 2026-10-29).**
The server still reaches network printers only; the TILL writes ESC/POS text to the
printer beside it over **Web Serial** -- a Bluetooth Classic (SPP) printer through
the COM port Windows makes on pairing. Not Web Bluetooth (BLE only), not a local
agent (a program per till to install and secure). `sendCopies`
(`print/serialPrinter.ts`) is the one choice between that and the dialog: direct only
for a USB/Bluetooth bill printer, on a roll, with a port connected in this browser.
It takes copies ALREADY fetched, so Retry resends the same pages and creates no
counted print, ticket, order or payment; a copy cut short mid-write is reported,
never re-sent on its own. Plain text, decided with the owner: code page 437, no logo,
non-Latin script prints `?`. The cutter is a per-till switch, off by default. The
rows come from the same helpers as the HTML bill, so the paper and the page cannot
disagree. **Not yet run on a physical printer.**

`app.branch` gains `bill_printer_id` (composite FK to a printer OF THAT BRANCH; NULL
is the stated choice "this computer's dialog, 3-inch roll"), five `bill_show_*`
flags, three `bill_copy_*` flags (`branch_bill_prints_a_copy`: at least one) and
`bill_auto_print`. All are written through the generic admin PATCH; the print route
answers them as `layout` beside the bill, so the till never keeps its own copy.
Turning the tax breakdown off prints the bill's own `tax_minor` (`taxMinor`); the
GSTIN always prints. `bill_show_copy_label` (0080) hides the copy's name at the top
(CUSTOMER / KITCHEN / COUNTER) and never REPRINT: the reprint word is what stops a
second copy passing for the first, so it is not a show option.

### A parcel charge is a line on the order, typed and capped (DECIDED 2026-10-20, 0081)

**A line, not a bill column.** Packing on a restaurant parcel is part of the one
supply and is taxed with it, so the charge is `order_line.kind = 'charge'`
(quantity 1, its own price, no menu item, no guest, no note -- `order_line_shape_exact`),
one per order (`order_line_one_charge_per_order`). The bill, the paper and the GST
return already read every taxed figure from `bill_line -> order_line`, so
`billableLines` takes `charge` and nothing else had to learn a new figure. It is
never an adjustment target and never reaches the kitchen: every kitchen and item
path selects an ALLOWLIST of kinds this one is not on. The dish reports
(`salesBy`) were the one `<>` blocklist and now name their kinds; the summary's
net includes the charge.

**The amount is typed, so the branch caps it.** A price from a tablet is what the
priced-document rule refuses; this one is permitted for the reason a discount
amount is -- a person decided it -- and bounded the same way.
`branch.parcel_charge_max_minor` is the authority and defaults to 0, so a branch
charges nothing until a manager decides it does (the `discount_percent_cap`
direction). `parcel_charge_default_minor` is what the till fills in
(`branch_parcel_charge_default_within_max`), and `parcel_charge_tax_class_id` is the
rate, resolved through `TAX_RATE_RESOLUTION` like a dish (an unregistered branch
charges no tax on packing either) and snapshotted on the line. A cap above 0 with no
tax rate is refused by `branch_parcel_charge_taxed`: an untaxed charge is the silent
under-collection. All three are written through the generic branch PATCH.

`POST /pos/order/:id/parcel-charge` (`order.create`, the order's lease, audited
`order.parcel_charge.set`) sets or clears (0) it, only on a parcel
(`parcel_charge_not_parcel`), **until money is taken**. With Billing already, the
unpaid bill is a snapshot of the old charge, so it is voided (the step
`cancelOrder` takes) and the till makes the bill again; once any tender is in it
is refused (`parcel_charge_after_payment`) -- undoing it is the refund path. The
line is UPDATED in place, never deleted: a voided bill's `bill_line` still
references it (ON DELETE RESTRICT, a record), so clearing sets 0, which the shape
CHECK permits for `charge` and `billableLines` (bills > 0) never bills. The board
leaves voided bills out.

**The order screen's totals are the server's estimate.** `POST /pos/quote`
(`modules/payments/quote.ts`, a declared `POS_POST_READS` entry, audit `none`)
prices a cart that does not exist yet through the SAME functions the write and the
bill use: `priceRequestedLine` (factored out of `addLine`, combos included),
`priceParcelCharge`, `taxOnLine`, `headsForLine` under `restaurantSupply` (from the
branch's `branchTaxTerms`). It writes
nothing and is labelled an estimate on screen; the bill is the record.

**CESS is still not built** (see "CGST, SGST and IGST are SHOWN"): the estimate and
the paper show the heads the treatment derives, nothing more.

### A bill is paid to the nearest rupee: Round off is its own line (DECIDED 2026-10-24, 0082)

Under 50 paise rounds DOWN, 50 or more UP: 264.49 -> 264, 264.50 -> 265, 190.05 -> 190.

- **The total stays the tax document.** `bill.total_minor` is still subtotal + tax from
  the lines; the GST return and invariant (1) read it. `round_off_minor` (-49..+50) is
  not a supply and carries no tax. `payable_minor` is GENERATED (total + round off) and
  is what is collected: `takePayment`, invariant (3), the board, the billing queue,
  open orders, closing a session, the printout and My takings all measure against it.
  Dish sales reports are unchanged.
- **The rule is a positive column.** `rounding_rule` is `none` (a bill made before 0082
  -- correct when made, so a paid bill never starts owing paise) or `nearest_rupee`;
  `bill_round_off_matches_rule` DERIVES the round-off from the total, so no writer
  chooses it. `nearestRupeeRoundOff` (payments/billing.ts) is the one code copy, used
  by `generateBill` and the order screen's estimate. The platform invoice's Round Off
  is the precedent.
- 0082 moved bills still being paid onto the rule and settled any already paid to the
  rupee (190 on 190.05). Its down carries a collected round-off onto the bill's last
  tender as `rounding_minor`, so the money record survives a rollback.
- **The card round-off of the same day is superseded.** With every payable a whole
  rupee, the screen no longer offers a tender round-off; `takePayment` keeps its narrow
  rule (under a rupee, on a whole rupee, clearing the bill) as a defence only.
- **Before real invoices**, a GST filer should see one sample bill with a Round off
  line (see "Before the first real invoice").

### How a branch charges tax: on/off, account, forward/reverse (DECIDED 2026-10-26, 0083)

Three settings on `app.branch`, beside the GST position they generalise:
`tax_enabled`, `tax_account_type` (`none | gst | vat | others`) and
`tax_calculation_mode` (`forward | reverse`), plus `tax_registration_no` (a VAT
TRN or other-tax number; the GSTIN keeps its own column and rules).

- **The rate is always the dish's tax class.** Nothing here holds a rate.
  `TAX_RATE_RESOLUTION` snapshots 0 when tax is off or the account is NONE; VAT
  and OTHERS take the class rate (the GST position and premises class are GST's
  questions only).
- **Written only by `POST /admin/branches/:id/tax`** (`tax.setting.edit`, no longer
  retired), refused while the branch has an open session
  (`tax_settings_while_orders_open`) -- the gst-registration route's reason: it
  decides what diners are charged. Not generic PATCH fields. `openSession` reads
  the mode `FOR SHARE` on the branch row, so a change racing an opening order is
  ordered against it.
- **The order snapshots the mode** (`sales_order.prices_include_tax`, at open), so
  every line of one order is priced one way. **The bill snapshots** the account
  (`bill.tax_account_type`, `none` when off), the mode and the registration
  number. Both NOT NULL with no default after the backfill (`gst`, forward).
- **`lineTax` (modules/tax/taxHeads.ts) is the one rule**: forward adds tax to the
  amount; reverse finds it inside (`round(a × r / (10000 + r))`), taxable the rest,
  so the two sum back to the price to the paisa. Bill, estimate and paper use it;
  heads are `splitHeads` of THAT tax, never re-derived from the taxable value.
- **Heads by account**: GST -> the jurisdiction's own (CGST+SGST / IGST); VAT -> one
  `VAT` head; OTHERS -> one `TAX` head (`singleHeadSupply`); NONE -> none. A bill
  outside GST carries no GST identity (`bill_treatment_fits_tax_account`).
- **The GST return reads only `tax_account_type = 'gst'` bills.** Dish sales
  (`salesBy`, `salesSummary`) are EX-TAX under either mode, from the line's own
  snapshotted rate and the order's snapshotted mode.
- **The UAE (`AE`) is an implemented jurisdiction**: accounts NONE / VAT / OTHERS,
  never GST (`tax_account_not_offered`, refused in `resolveSupply`). A UAE
  restaurant starts on VAT with `vat_5` / `vat_0` classes it edits. Screens show
  AED and UAE bills are paid to the fils since 0084 (below). Still wanted before a
  Dubai restaurant goes live: a UAE tax filer's look at a sample VAT invoice.
- **Company details on the bill**: `bill_name` (over the restaurant's name, as
  `bill_address` is over its address) and `email` are generic branch fields; the
  paper prints only what is set, the registration labelled GSTIN / TRN / Tax No.

### A restaurant's country and currency (DECIDED 2026-10-26, 0084)

The country is `platform.tenant.tax_jurisdiction`, the currency
`default_currency`. What a country MEANS is code: `COUNTRIES` in
`packages/shared` (code, name, currency, locale, timezone), which each
`JurisdictionDefinition` spreads, plus its tax accounts, heads, starting tax
classes and `billRounding` (IN `nearest_rupee`, AE `none`: paid to the fils).
What the platform OFFERS is `platform.platform_setting` (`country.offered`,
`country.default`, `country.sales_may_change`), on the Super Admin's
**Countries** screen (`PATCH /api/platform/settings/countries`,
`platform.settings.edit`, audited).

- **Chosen at creation, never defaulted on the server.** The form starts on the
  default country and fills its currency and timezone; provisioning still
  requires `taxJurisdiction` and refuses a country or currency not offered
  (`country_not_offered`, `currency_not_offered`).
- **Changeable only until the first bill** (`country_locked_after_billing`), never
  with an order open (every branch locked FOR UPDATE first, the lock `openSession`
  takes FOR SHARE), and only with `confirm: true` after the preview
  (`GET /tenants/:id/country-change`, writes nothing). `POST /tenants/:id/country`
  (`platform.tenant.country`, audited with the result). Sales: only restaurants
  they sold and only while `country.sales_may_change` is on;
  `platform.tenant.country.any` (Super Admin) needs neither.
- **No exchange rate unless one is typed.** With one, `CONVERTED_MONEY_COLUMNS`
  are multiplied in the same transaction (dish, branch, add-on and combo-choice
  prices, parcel charges, custom roles' discount caps -- system roles are locked
  and their caps are the seed's). Records and snapshots are never touched;
  `tests/platform/countryChange.test.ts` holds every `_minor|_micro|_cap` column
  in schema `app` to exactly one of the two lists, with a synthetic new column.
- **On a country move** the new country's starting tax classes are seeded or
  re-activated, dishes on the old country's starting classes move to the class at
  the same rate (else the first), those classes are archived (an owner's own
  class is a rate and stays), and every branch takes the new default account with
  its registration number cleared.
- **A bill stamps its currency** (`app.bill.currency`, frozen once tendered); the
  paper reads it, not the restaurant.
- **The screens** format every restaurant amount in the currency and locale from
  the public restaurant lookup the admin and the till already wait on
  (`setRestaurantMoney`, lib/money.ts); a headline is rounded to the whole unit
  only where bills are.
- **Not in scope**: our subscription invoicing of a restaurant abroad. Plans keep
  their own currency, and invoicing a UAE restaurant is an export of services
  under the evidence-backed zero-rating grant -- a GST filer's question first.

### My takings: the till's own X-read, not a report (DECIDED 2026-10-24)

A request for Reports in the POS header -- daily, weekly, monthly; bills and
items; PDF, Excel and a thermal copy -- met separation of duties head on: the
only people on the POS take payments, `till-vs-record` denies them every
`report.*` key, and managers never sign in on the POS. So the POS has no
reports. It has **My takings**: what the SIGNED-IN person took.

- **`till.summary.view` is a TILL key** (in `TILL_KEYS`, beside `payment.collect`),
  not a report. It reads only tenders the person recorded
  (`tender.tendered_by_user_id`), so it is their own drawer, not the books. Being a
  till key, it is withheld from the owner by the same derivation as the till and
  delegable by whoever may delegate the till -- nothing enumerated. Seeded to
  `cashier` and `counter`; `GET /me` answers `screens.takings` from it.
- `GET /pos/my-takings?period=day|week|month` (`modules/reporting/tillSummary.ts`,
  audit `none`): the bills at the token's branch, in the period's business dates,
  on which this person took a payment -- each bill's own total, tax and printed
  lines, and only this person's tenders (net of the voids they recorded) for what
  they collected and the method totals. Weeks start Monday, months the 1st. The
  person and branch are the token's; only the period is asked.
- **A From/To range (DECIDED 2026-10-26)**: `?from=&to=` (business dates) instead
  of `period`, answered as `period: 'custom'`. It widens WHEN, never who or where.
  Refused `till_range_invalid` (400) when incomplete, not a real date, reversed,
  past today or over 366 days (`TILL_RANGE_MAX_DAYS`) -- refused, not clamped, so
  the screen never labels a range it did not read. A named period beside a range
  is `till_period_unknown`, never silently preferred. The screen checks the same
  rules first (`rangeProblem`); the server is the authority.
- Inside the reporting gates (snapshot tables only, `EXPECTED_REPORTING_MODULES` 5).
- **The deploy now reconciles every existing tenant's SYSTEM roles** (core/database/
  seed.ts -> `reconcileAllTenantSystemRoles`, the loop `pnpm reconcile:roles` also
  runs). "System roles are re-seeded idempotently on every deploy" above was true of
  the catalogue only: a new key reached no restaurant that already existed, so
  `till.summary.view` would have reached no Billing role on the live site. Custom
  roles are never touched; one transaction per tenant; asserted in
  `tests/authz/seed.test.ts`.
- PDF and Excel are built in the browser from the figures shown (jsPDF, SheetJS,
  each loaded only on download); the Basic plan's report tier is untouched, and
  the advanced-tier `/admin/reports/sales/export` is unchanged.

### The Sales person sets every sign-in; staff use a PIN on the till (DECIDED 2026-10-16)

> **Supersedes** the manager's own PIN and the Manager card of 0078, and **relaxes
> "the control plane never sets a password"** for these accounts, on the owner's decision.

- **Who sets them:** the Sales person who sold the restaurant (Super Admin: any).
  `POST /api/platform/tenants/:id/staff/:userId/credentials` sets a username and
  password -- staff AND the manager (it revokes any pending setup link, so the
  password the Sales person set is the one in force, and it moves an `invited`
  manager to `active`, because that link was the only other way out of `invited`;
  a `disabled` manager stays disabled). Creating staff takes a
  username and 4-digit PIN; `POST .../staff/:userId/pin` sets or resets a
  staff PIN (never a manager's). **Staff have no password (DECIDED 2026-10-17):**
  create refuses a `password` field and the credentials route refuses a staff
  account, both 409 `tenant_staff_uses_pin` (refused, not dropped); a staff
  username changes through the PATCH. The PIN is required at create, so no staff
  account is made with no credential. Passwords set for staff before this stay
  until revoked. The create-restaurant form sets the manager's
  username and password. The manager screens have no credential route. Audit rows
  are the RESULT, never the body.
- **Screen 1, the manager:** `/{slug}`, username and password
  (`POST /api/auth/:slug/login`, managers only -- staff are refused `staff_use_pos`).
  **Staff Login** sits top right and opens `/{slug}/pos`.
- **Screens 2 and 3, staff, on a till:** `/{slug}/pos` lists the till's staff as
  cards (`GET /api/public/restaurants/:slug/till/staff`, answered only to a till,
  never naming a manager); the tapped person types their 4-digit PIN
  (`POST /api/auth/:slug/pin`, which keeps its lockout and till check). **Manager
  login** on that screen is the same username-and-password form signing in on the
  till. A browser that is not a till shows that form: only the manager makes a till.
  No `?to=pos` anywhere.
- A staff password set before 2026-10-17 still signs in on an existing till (the
  till route); no new one can be set.
- **Staff Login opens straight onto the staff cards, with no manager set-up first
  (DECIDED 2026-10-16, reversing the till-only list).** The staff list answers a
  browser that is not a till yet, at the restaurant's one branch; a correct staff PIN
  on such a browser registers it as a till (`registerTillAtSignIn`: a manager, or on a
  plan without staff tablets anyone who works the POS), within the plan's device limit
  (402 past it). Accepted cost, stated: anyone with the restaurant's link sees its staff
  names and may try PINs from any browser; the per-credential lockout (60 s doubling,
  capped at 15 min) is the control. A till a manager took out of use stays refused and
  is not forgotten by the client, so a PIN cannot undo the revocation; a restaurant with
  several branches still needs its till set up.
- **Managers never sign in on the POS, enforced on the server.** `authenticatePin`
  refuses an account holding `user.view` before the PIN is checked (`manager_use_login`,
  answered as a wrong PIN, no lockout counted); the till route registers or confirms
  the till for a manager and answers `{ tillOnly, deviceId, branchId }` with NO tokens;
  refresh refuses to renew a device-bound session held by a manager. The staff screen
  links to the Manager Login page instead of offering a manager form.
- A migration revoking PINs (0079) was written and REMOVED before deploy -- it ran
  only on the local dev and test databases, where it was rolled back (its down is a
  no-op, so local staff need their PIN set again).

### The manager has a till PIN of their own; the till never names them (DECIDED, 0078 -- superseded 2026-10-16, above)

The till's sign-in is a card per staff member plus ONE unnamed Manager card, then a
username and PIN for both. `tillStaff` excludes anyone holding `user.view` --
the owner holds the cashier membership too, which would otherwise list them -- because
this read is answered before anyone signs in. `authenticatePin` given both a tapped
`userId` and a typed `employeeCode` requires them to be one person
(`subject_unknown` otherwise). The manager sets their own username and PIN at
`POST /admin/access/me/pin` (`user.view`, the key that makes someone a manager; the
subject is the token's; the current password is required again; audited as the
`app_user` row, never the body). The Sales person's refusal of a manager's
credential (`tenant_staff_is_manager`) is unchanged: this is the manager choosing
their own secret. `replacePin` (deviceAuth.ts) is the one copy both paths use.

`platform_audit_log.target_tenant_id` is set only from a `:tenantId` path parameter; these
routes, like every `/tenants/:id` route, record the restaurant in `target_id`.

### The test suite has its own database

`katkitchen_test`, set up by the same `01_database.sql` (now named by
`current_database()`), reached through the same roles and pooler. Every
`DATABASE_URL_*` is re-pointed in `vitest.config.ts`; `tests/hooks/globalSetup.ts`
migrates and seeds it and refuses to run against `katkitchen`. Fixtures never
delete a tenant, so a shared database fills with probe restaurants -- it did,
326 of them beside the owner's real ones.

## Working agreement

- **Plan before code.** For any non-trivial task, state the plan and wait for approval.
- **Ask, don't assume.** If a requirement is ambiguous, ask one specific question rather
  than guessing and building the wrong thing.
- **Stay in scope.** Do not build Phase 3 entities while working on Phase 0.
- **No placeholder or mock implementations** unless explicitly asked. If something can't be
  built yet, say so.
- **Every migration is reversible** and has a `down`.
- **Tests for the isolation guard are non-negotiable** — cross-tenant read attempts must
  have a failing test proving they are blocked.
- Prefer clean, minimal code. No verbose comments explaining what the code obviously does.
  Comment only non-obvious *why*.
