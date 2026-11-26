# Deployment guide

Images: `deploy/api.Dockerfile`, `deploy/web.Dockerfile` (nginx), `deploy/scheduler.Dockerfile`
(cron jobs). The Render blueprints are `render.yaml` and `render.free.yaml`; the
step-by-step is `docs/deployment/deploy-render.md`, job monitoring is
`docs/deployment/scheduler-monitoring.md`.

1. Create the database and the three roles (`scripts/deployment/bootstrap-managed.mts`
   on a managed Postgres that gives no superuser).
2. Apply migrations as the owner role: `pnpm db:migrate` (the API never migrates on boot,
   except `MIGRATE_ON_START=1` on the free blueprint, one instance only).
3. Seed the permission catalogue and plans: `pnpm db:seed`.
4. Create the first Super Admin with a password someone chose
   (`scripts/development/seed-platform-user.mts`); never use the development seed in
   production - it refuses when `NODE_ENV=production`.
5. Run `scripts/deployment/probe-host.mts` against the pooled and direct URLs.

Secrets come from the platform's secret store, never from the repository.
