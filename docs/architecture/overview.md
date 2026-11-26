# Architecture overview

UniversalPOS is a multi-tenant POS and billing SaaS. One common POS engine serves
several kinds of business; each business type adds its own words, navigation,
theme and workflow on top. The binding rules are in `CLAUDE.md`; this page is the map.

## Two planes

- **Control plane** (Super Admin, Sales): tenants, plans, subscriptions, billing,
  platform staff, audit. Routes live under `/api/platform/*` and reject any token
  carrying a tenant.
- **Tenant plane** (a business's staff): branches, catalogue, orders, bills,
  payments. Routes reject any token carrying a platform role.

Only two things cross: entitlements flow down, usage rollups flow up. Postgres has
two schemas, `platform` and `app`; every `app` table has `tenant_id`, row-level
security and a policy with both `USING` and `WITH CHECK`.

## Packages (pnpm workspace)

| Folder | Package | Role |
|---|---|---|
| `backend/` | `@universalpos/api` | Fastify 5 API, domain modules, jobs |
| `frontend/` | `@universalpos/web` | React 19 + Vite, three entries: platform, admin, POS |
| `shared/` | `@universalpos/shared` | code both sides import (plans, business-type registry, slugs, countries) |
| `packages/` | `tsconfig`, `eslint-config` | workspace tooling |
| `database/` | not a package | bootstrap SQL, numbered migrations, PgBouncer config |
| `print-agent/` | not a package | on-premises kitchen-ticket printer bridge |

## Business types

The registry (`shared/src/constants/businessTypes.ts`) is the one definition of
each type: its words, manager navigation, theme, modules, status and workflow.
The database stores only the key (`platform.tenant.business_type`). See
`docs/business-modules/business-module-guide.md`.

## The common engine

Order -> bill -> tender -> receipt, with discounts, taxes, day-end and audit, is
shared by every type. A type does not fork it: it chooses which screens and
catalogue kinds feed it (`single`/`combo` dishes with a kitchen, or `product`
items with none).
