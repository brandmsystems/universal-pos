# AGENTS.md -- for Codex and any other coding agent

**`CLAUDE.md` is the single source of truth for this project's rules.** Read it
before changing anything structural; it applies to every agent, not only Claude
Code. This file exists so an agent that loads `AGENTS.md` automatically finds that
pointer, plus the rules it must never miss. It is deliberately short: a second copy
of the rules is a copy that drifts (it did -- this file was a 1,300-line copy of an
older CLAUDE.md until 2026-11-18).

| Read | For |
|---|---|
| `CLAUDE.md` | the current rules and decisions (the spec) |
| `FRONTEND.md` | client rules: truth model, money, idempotency keys, printing |
| `katkitchen.md` | what exists now, local credentials, printers, the change log |
| `README.md` | setup, ports, day-to-day commands |
| `docs/decision-history.md` | the reasoning behind past decisions (archive; do not extend) |
| `docs/gst-review.md` | GST samples and open questions -- **pending qualified review** |

## Rules an agent must not break (each is explained in CLAUDE.md)

- **Two planes.** Control-plane routes reject a JWT with `tenant_id`; tenant routes
  reject one with `platform_role`. No FK from schema `platform` into schema `app`.
- **Tenant isolation.** Never take `tenant_id` from a request body, query or header.
  Every `app` table has `tenant_id NOT NULL`, RLS, and a policy with `USING` and
  `WITH CHECK`. Raw SQL on a tenant table needs a `tenant_id` predicate.
- **Money is integer minor units**; never float. A unit price is never accepted from
  a request; a bill reads only values snapshotted onto the order line.
- **Voids, comps, discounts and refunds are new rows**, never updates or deletes.
- **Every route declares an audit posture**; the audit row is written in the same
  transaction as the mutation; audit tables are append-only.
- **Check permission keys, never role names.** Respect the subset rule and the
  separation-of-duties rules; never seed an escalation, privacy or adjustment key
  into a broadly assigned role.
- **Migrations** are hand-written SQL with a reversible `down`; never edit an applied
  migration; status columns are `text` + `CHECK`, not enums.
- **Never claim GST compliance.** GST logic is pending qualified review.
- **Tests:** never weaken, skip or delete a test to get a pass; a rule's test uses a
  fixture built to violate it; fixtures never delete a tenant or a membership.

## Commands

```bash
pnpm stack:up && pnpm stack:probe     # local stack (+ the statement-mode probe pooler)
pnpm db:migrate && pnpm db:seed
pnpm typecheck                        # not implied by pnpm test
pnpm test                             # API, against katkitchen_test
pnpm test:web                         # web, jsdom
pnpm build:web
```

## Working agreement

Plan before code on anything non-trivial and wait for approval; ask one specific
question rather than guess; stay in scope; no placeholder implementations. Record a
new decision in `CLAUDE.md` (and its long form in `katkitchen.md`'s change log), not
here.
