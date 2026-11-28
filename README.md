# UniversalPOS

A multi-tenant restaurant POS SaaS. What is sold today is the **Basic** plan
(0077): one POS per restaurant -- new order → kitchen ticket → bill → payment,
with printed copies -- plus the restaurant manager's admin screens, and a
control plane (Super Admin and Sales) that provisions, configures and bills the
restaurants. Kitchen tickets for Wi-Fi/Ethernet printers go through an
on-premises print agent (`print-agent`). The kitchen screen, the separate
KOT and Billing apps, tablet setup codes and the stock screens were removed;
their tables stay, because rows are records.

Current status, recent work and the change log are in **`docs/development/universalpos.md`**.

This file is the handover: how to get it running, what exists, and what does
not. The reasoning behind the design lives in `CLAUDE.md` — read it before
changing anything structural.

---

## 0. One thing to know before you clone

`.gitattributes` pins the whole tree to LF, and it needs to stay that way. One
file makes this more than cosmetic: `database/bootstrap/init/00_bootstrap.sh` executes
*inside* the Postgres container, and a shebang followed by `\r` fails with
`bad interpreter: /bin/sh^M` — on a fresh environment, i.e. at the worst possible
moment and to the person least able to diagnose it.

If a Windows checkout ever shows a pile of modified files with identical
insertion and deletion counts, that is carriage-return churn and not work.
Confirm before you commit any of it:

```bash
git diff --stat --ignore-cr-at-eol      # empty output = nothing real changed
```

---

## 1. What you need installed

| Requirement | Version | Notes |
|---|---|---|
| Node | ≥ 22 | `engines` enforces it |
| pnpm | 9.15.4 | pinned via `packageManager`; `corepack enable` is the easy route |
| Docker Desktop | current | the whole local stack is containers |
| psql | 16 (client) | only if you want to inspect the database by hand |

There is **one lockfile for the whole repo** (`pnpm-workspace.yaml` covers `.`
and `web`). A `preinstall` hook (`scripts/deployment/check-lockfiles.mjs`) fails the install
if a second one appears — a second lockfile lets the dependency set that was
verified and the one that gets installed drift apart silently.

---

## 2. First-time setup

```bash
git clone https://github.com/brandmsystems/universal-pos.git
cd universal-pos

pnpm install

cp .env.example .env                    # Windows: Copy-Item .env.example .env
```

Then **edit `.env`**. Every value in it matters; the two that always need
changing are:

- `JWT_SIGNING_KEY` — at least 32 characters. There is deliberately **no default
  in the code**: a signing key with a fallback is one that every deployment which
  forgot to set it shares. Generate one with `openssl rand -base64 48`.
- the four `DATABASE_URL_*` passwords — `.env.example` ships `change_me`.

Bring the stack up and build the database:

```bash
pnpm stack:up                           # docker compose up -d --wait
pnpm db:migrate                         # applies 0001 … 0088
pnpm db:seed                            # permission catalogue, plans, reference data
pnpm seed:demo                          # a demo tenant you can actually sign into
pnpm db:test:create                     # once: katkitchen_test, the database `pnpm test` uses
```

`pnpm seed:demo` is idempotent on the slug and prints the credentials it created
(defaults: slug `spicegarden`, owner `owner@spicegarden.test`). It runs the
**real** `provisionTenant` path inside one owner transaction, so your local
tenant is shaped exactly like a production one — RLS applies, the suspension
ladder applies, the audit log has the same attribution. It is not a fixture.

Verify:

```bash
pnpm typecheck                          # must be clean — see §4, this one is load-bearing
pnpm test                               # backend suite (65 files, 1,224 tests, against katkitchen_test)
pnpm build:web
```

---

## 3. What runs where

`pnpm stack:up` starts five containers. The ports are all deliberately off the
defaults, because the defaults are routinely taken by another project's stack and
a collision that *half* works is worse than one that fails to start.

| Service | Port | Why that port |
|---|---|---|
| Postgres | **5433** | 5432 is always taken; the app talks to the pooler anyway |
| PgBouncer (transaction mode) | **6432** | what the application connects through |
| Redis | **6380** | 6379 is always taken |
| API | 8080 | `/healthz` is public and unaudited, which is why it can be a health check |
| POS web | 127.0.0.1:**9180** | bound to the specific address on purpose — see below |

Two more services exist under Docker Compose profiles and do **not** start with
`stack:up`:

```bash
docker compose --profile probe up -d pgbouncer-statement    # port 6433
docker compose --profile scheduler up -d scheduler          # cron jobs
```

`pgbouncer-statement` is **deliberately misconfigured** and is never used by the
application. It exists so the *failing* direction of the pooling probe can be
exercised: a safety check that has only ever been observed to pass is one nobody
has shown to work. You need it running for `tests/db/pooling.test.ts`
(`pnpm test:pooling`); the rest of the suite skips those tests without it.

The `scheduler` profile is off during tests on purpose — a background drain
competing with a test's own drain is a source of flakiness nobody would enjoy
diagnosing.

### Why the POS binds to `127.0.0.1:9180` and not `0.0.0.0`

On Windows, a socket bound to the specific address `127.0.0.1:<port>` takes
precedence over one bound to `0.0.0.0:<port>`. If another project's dev server is
already on the port, Docker still reports its own binding as successful while the
browser quietly serves the *other* project — and the resulting error looks like
ours. Binding the same way means a collision **fails to start** instead.

### Why the app's database URL goes through the pooler

`DATABASE_URL_APP` goes through PgBouncer, which must be in **transaction** mode:

- `SET LOCAL` requires **transaction-scoped** pooling. Under statement mode it is
  discarded, `app.current_tenant_id()` raises on every query, and **RLS stops
  working** — the single most dangerous misconfiguration in the system. A startup
  probe checks this.

(A second, direct app URL, `DATABASE_URL_APP_DIRECT`, existed only for the kitchen
screen's `LISTEN` connection. It went with the kitchen screen and is no longer read.)

---

## 4. Day-to-day commands

```bash
# the app
pnpm dev:api                # tsx watch backend/src/server/server.ts
pnpm dev:web                # vite dev server
pnpm api                    # run once, no watch

# the database
pnpm db:status              # which migrations are applied
pnpm db:migrate             # apply pending
pnpm db:rollback            # revert the most recent
pnpm db:partitions          # audit partitions ahead of now()
pnpm reconcile:roles        # after ANY permission key or description change

# background jobs (also available via the scheduler profile)
pnpm job:outbox-drain
pnpm job:print-drain
pnpm job:usage-rollup
pnpm job:health

# checks
pnpm typecheck
pnpm test
pnpm test:web               # the client suite: jsdom, no database
pnpm test:pooling           # needs the probe profile up
```

### The verification routine, in order

```
pnpm db:migrate  →  pnpm reconcile:roles  →  pnpm typecheck  →  pnpm test
                 →  pnpm test:web  →  pnpm build:web
```

**`pnpm typecheck` is not optional and is not implied by `pnpm test`.** `pnpm
test` is `vitest run`, which transpiles *without* type checking. This project
leans hard on `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`verbatimModuleSyntax`, and for a stretch of this year none of them were running:
1,113 tests passed green while the repo did not compile. Run the type checker.

### Do not run the Docker `api` service and `pnpm dev:api` at the same time

Compose publishes the api container on `0.0.0.0:8080` **and** `[::]:8080`.
Windows lets `pnpm dev:api` bind `127.0.0.1:8080` on top of that rather than
refusing it, so both run, both report healthy, and **which one answers depends on
how the client spells the host** — `localhost` resolves to `::1` first and
reaches the container; `127.0.0.1` reaches the dev server.

That cost real time once already: the dev proxy was reaching a container built
from an older image, so a route that existed in the source fell through to a
parametric one and refused with a reason about tenants. A `curl` to
`127.0.0.1:8080` returned a token on the same port at the same moment.

The dev proxy is pinned to `127.0.0.1` so this cannot recur through the browser.
Before running `pnpm dev:api`, stop the container anyway:

```bash
docker compose stop api
```

It is the same family as the POS port note in `frontend/vite.config.ts`, and worse:
that collision serves the wrong app, this one serves the wrong VERSION of the
right app.

### Two things that will surprise you

**Migrations are checksummed.** Edit a migration that has already been applied
and the runner refuses to touch it — *"has been edited since it was applied.
Write a new migration instead."* That is correct behaviour. If you genuinely need
to re-apply an unshipped migration locally: restore the file to its applied text,
`pnpm db:rollback`, restore your edit, `pnpm db:migrate`. Do not defeat the
checksum.

**The API does not migrate on boot.** Migrations are a deliberate act against a
database that may be shared, and a container that migrates on start races every
other replica of itself:

```bash
docker compose run --rm api node backend/dist/database/migrate.js up
```

### Production: Render

Everything -- web, API, scheduler, Postgres and Redis -- is one Render Blueprint
(`render.yaml`). The web service is the same nginx image as the local stack and
forwards `/api/*` to the API over Render's private network. The steps, including
the one-time role bootstrap a managed Postgres needs, are in
[docs/deployment/deploy-render.md](docs/deployment/deploy-render.md).

---

## 5. How the code is organised

Two planes, and the separation is enforced rather than reviewed:

- **`platform`** — the control plane and immutable global reference data:
  tenants, plans, subscriptions, entitlements, impersonation, the tax
  jurisdiction catalogue.
- **`app`** — the tenant plane: everything a restaurant owns. Isolated by
  row-level security keyed on the `app.tenant_id` GUC.

```
backend/src/
  app.ts server.ts config/ jobs/
  core/       database/ (migrate, seed, pooling, tenant context, unit of work)
              errors/ (the error contract) middleware/ (registrars) security/ (guards)
  modules/    auth authz billing inventory kitchen menu metering notifications
              offline orders payments platform privacy reporting restaurants tax users
              (inventory keeps only deduct/reconcile, which the jobs call)
  routes/     route tables + handlers/ -- the thin route layer
frontend/src/
  app/        platform/ admin/ pos/ -- one shell per app (3 HTML entries;
              /{slug}/kot and /{slug}/billing serve the POS)
  features/   access auth billing dashboard orders restaurants settings users
              -- one subfolder per app inside each
  components/ services/ lib/ hooks/ types/ styles/
print-agent/  the on-premises bridge to Wi-Fi/Ethernet kitchen printers
packages/     shared/ (code api and web both import), tsconfig/, eslint-config/
```

`backend/tests/` holds 65 files, 1,224 tests (2026-11-18), all against a **real Postgres** —
there are no database mocks in this project. Run them with `pnpm test`.

### The documents that matter

| File | What it is |
|---|---|
| **`CLAUDE.md`** | The current rules and decisions, for every agent. **This is the spec.** |
| `docs/architecture/decision-history.md` | The reasoning behind them: CLAUDE.md as it stood to 2026-11-18, word for word, including superseded decisions. An archive; not extended |
| **`docs/development/universalpos.md`** | What exists now: who uses what, local credentials, implementation status, printers and Windows printer setup, pending work, the change log |
| **`AGENTS.md`** | The entry point for Codex and other agents: points to CLAUDE.md and repeats only the rules an agent must not miss |
| **`docs/frontend/FRONTEND.md`** | The client rules: the `known`/`stale`/`unknown` truth model, provenance, money, optimistic rendering, idempotency keys, degradation vocabulary |
| `docs/deployment/deploy-render.md` | Deploying to Render, including the one-time role bootstrap |
| `docs/backend/print-agent-design.md`, `print-agent/README.md` | Why the print agent exists, and installing it on a restaurant PC |
| `docs/backend/gst-review.md` | GST flows, sample invoices produced by the code, assumptions and open questions -- **Pending qualified GST review** |
| `docs/backend/billing-terms.md` | Billing vocabulary — and the GST reviewer checklist at its foot |
| `docs/deployment/scheduler-monitoring.md` | What the cron jobs do and how to tell they stopped |

---

## 6. What is done, and what is pending

The build order in `CLAUDE.md` (phases 0 → 5) is built, plus the API surface,
the three web apps and everything recorded since. The product has since been
narrowed to the Basic plan (0077); what was removed and what stayed is recorded
in CLAUDE.md ("What the product is today"), with the reasoning in
`docs/architecture/decision-history.md` ("Basic only"), and in `docs/development/universalpos.md` §5.2c.

**`docs/development/universalpos.md` is the status document**: §5 for what is implemented, §6 for
pending tasks and known gaps, §8 for the change log. It is kept current; this
file is not a second copy of it.

One item belongs here as well, because it has a legal rather than a technical
consequence: **before the first real invoice, the place-of-supply logic and one
sample invoice of each treatment must be reviewed by someone who files GST
returns** (the checklist is at the foot of `docs/backend/billing-terms.md`, and the samples and open questions in
`docs/backend/gst-review.md` -- **Pending qualified GST review**). The same
goes for one sample bill with a Round off line, and for a UAE VAT invoice before
a Dubai restaurant goes live.

### The testing posture, so you know what the green tick means

This project asserts structure, not just behaviour. A meaningful share of the
suite exists to catch one defect family: **a guard that exists, is correct, and
is joined to the running system by nothing.** Concretely, there are gates that

- count the routes, so a new one has to be added deliberately;
- refuse any raw SQL outside a named list of files, each with a justification;
- require every error code to appear in the error contract;
- require every column on `app.bill` to be written by a named path **or carry a
  written reason for staying null**;
- assert the app database role can read every table it needs and write none it
  must not, by name;
- read CHECK constraints out of the catalogue and assert the client's copy of
  that vocabulary against them;
- prove themselves non-vacuous by committing a synthetic violation and checking
  it is refused.

When one of these fails after your change, it usually wants a sentence from you,
not a code change. Read what it is asking before you edit it.

---

---

## 7. Working notes for whoever picks this up

**Windows / PowerShell**, all of these cost real time at least once:

- PowerShell has no heredoc. Build a commit message with a here-string (`@'` …
  `'@`, closing delimiter at column 1) and `git commit -F`, or repeat `-m`.
- PowerShell 5.1's `Set-Content -Encoding utf8` writes a **BOM**, which ends up
  in your commit subject. Use
  `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))`.
- `cd` does **not** change .NET's current directory, so `[IO.File]::*` resolves
  relative paths against the process directory. Set
  `[Environment]::CurrentDirectory`, or just use `Get-Content`/`Set-Content`.
- **The drive letter's case used to break the web tests.** From a working directory
  spelled `c:\...` (VS Code and Git Bash hand one over) Vite resolved `react` under
  `c:\` while Node resolved react-dom's own `react` under `C:\`; Node's module cache
  keys those apart, so there were two Reacts and most render tests failed with
  `Cannot read properties of null (reading 'useState')`. `frontend/vitest.config.ts`
  now normalises the working directory on Windows (a no-op elsewhere), and
  `frontend/tests/reactSingleInstance.test.ts` fails if two Reacts ever load again.
  `pnpm test:web` works from either spelling.

**Conventions worth absorbing from `CLAUDE.md` before you write code:**

- A priced document is a **snapshot**, never a join at print time. A bill
  reprinted after a rate or a tenant setting changed must show what it was issued
  under.
- Use the **business date**, never the calendar date. A 2am settlement belongs to
  the night before.
- Nothing is hard-deleted on day one — there is a suspension ladder.
- A fixture may set up state; it may **not** inherit state it then measures.
- Assert **through the reader**, not beside it. A test that checks the database
  and a test that checks what the production code *sees* are two different tests,
  and only the second catches a query that silently dropped a column.
