# Database guide

PostgreSQL 15+ (16 in the local stack), hand-written SQL, no ORM.

## Layout (`database/`)

- `bootstrap/` - roles and the database, run once on first init of the local stack.
- `migrations/` - numbered `NNNN_name.up.sql` / `.down.sql`, applied in order.
- `pgbouncer/` - the transaction-mode pooler config and the deliberately
  misconfigured statement-mode one used by the pooling probe.

## Rules that matter

- Every migration has a reversible `down`; `backend/tests/db/reversibility.test.ts`
  executes each one on a database with data and compares a schema digest. A
  rollback must not destroy a record of something that happened.
- Applied migrations are checksummed; editing one is an error. One transaction per
  migration. The API never migrates on boot.
- Status columns are `text` + `CHECK`, never a native enum. Money is integer minor
  units.
- Roles: `katkitchen_owner` (migrations, seeds), `katkitchen_app` (the application,
  subject to RLS), `katkitchen_platform_readonly`. The role and database names keep
  their original spelling because applied migrations reference them.

## Business-type columns

`platform.tenant.business_type` (0089) holds a registry key. `app.menu_item.kind`
is `single | combo | product` (0090); a station is required exactly for `single`.

## Commands

```
pnpm db:migrate     # apply pending migrations
pnpm db:status      # what is applied
pnpm db:rollback    # undo the latest
pnpm db:seed        # permission catalogue, plans, reference data
```

Back up before a risky change: `docker exec <postgres> pg_dump -U postgres -Fc <db>`.
