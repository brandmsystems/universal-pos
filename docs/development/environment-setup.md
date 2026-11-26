# Environment setup

Requirements: Node >= 22, pnpm 9.15.4 (`corepack enable`), Docker Desktop.

```
pnpm install
cp .env.example .env        # then set JWT_SIGNING_KEY (>= 32 chars) and the DB passwords
docker compose up -d --wait # Postgres 5433, PgBouncer 6432, Redis 6380, API 8080, web 9180
pnpm db:migrate && pnpm db:seed
pnpm seed:demo              # a demo business; prints its generated secrets once
```

- Nothing in the repository holds a real secret. `.env` is git-ignored;
  `.env.example` has placeholders only. Seed scripts generate secrets and print them
  once, or read `DEV_SUPER_ADMIN_PASSWORD`, `DEMO_PASSWORD`, `DEMO_PIN`.
- If another project already uses compose project name `universal-pos`, start with
  `COMPOSE_PROJECT_NAME=<name> docker compose up -d --wait`.
- Checks: `pnpm typecheck`, `pnpm test`, `pnpm test:web`, `pnpm build`, `pnpm build:web`.
- The pooling test needs `pnpm stack:probe`.
