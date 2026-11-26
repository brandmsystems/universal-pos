# Backend development guide

`backend/` is `@universalpos/api`. Run from the repo root: `pnpm api`, `pnpm dev:api`,
`pnpm typecheck`, `pnpm test` (needs the Docker stack and `katkitchen_test`).

```
backend/src/
  app.ts, server.ts, config/, jobs/
  core/      database/ errors/ middleware/ (registrars) security/ (guards)
  modules/   the domain: auth authz billing inventory kitchen menu metering
             notifications offline orders payments platform privacy reporting
             restaurants tax users
  routes/    route tables and thin handlers
```

- Tenant isolation: the base repository refuses to query without the tenant GUC;
  RLS is the backstop. Raw SQL against a tenant table needs a `tenant_id` predicate
  (a test gates it).
- One audit middleware; the audit row is written in the same transaction.
- Tests use a real Postgres (`katkitchen_test`); a test of a rule runs a fixture
  built to violate it, and a denial pins which denial.
- After adding a permission key: `pnpm reconcile:roles`.

Business-specific behaviour goes behind the registry's `status`/`workflow` and the
catalogue `kind`, not into `if (type === ...)` branches.
