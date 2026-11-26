# Frontend development guide

`frontend/` is `@universalpos/web` (React 19, Vite, TanStack Query, Tailwind 4).
The detailed client rules are in `docs/frontend/FRONTEND.md`.

```
frontend/src/
  app/         three shells: platform, admin, pos
  features/    <domain>/<app>/   (billing, orders, settings, restaurants ...)
  components/  shared UI (ui/ primitives, admin/, platform/, pos/)
  lib/         pure logic: money, theme, business (registry helpers), paths
  services/    API clients, offline queue, lease, storage
  styles/      one Tailwind theme per app + business-themes.css
```

- **Business type:** a shell reads the type from the public restaurant record,
  wraps its tree in `BusinessProvider`, and uses `useBusiness()` / `useTerms()`.
  Sections come from `visibleSections()`, titles from `titleFor()`, the accent from
  `accentFor()`. No component compares a type's name.
- **Money** is integer minor units, formatted by `lib/money.ts`.
- Commands: `pnpm dev:web`, `pnpm build:web`, `pnpm test:web`.
