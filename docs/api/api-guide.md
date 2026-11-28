# API guide

Fastify 5, TypeScript. Routes are tables (`backend/src/routes/*.ts`); handlers
(`backend/src/routes/handlers/`) read the request, call one domain function and
return its answer. A handler holds no SQL and no money arithmetic.

- **Planes:** `/api/platform/*` (control plane), `/api/t/*` (tenant), `/api/auth/*`,
  `/api/public/*` (unauthenticated, names only), `/api/agent/*` (print agent).
- **Every route declares** its plane, permission key (or none), audit posture
  (`audit: { action, target }` or `audit: 'none'`), and optionally a plan gate
  (`{ feature }`, `{ reports }`, `{ limit }`). A missing field refuses the boot.
- **Never accept `tenant_id`** from a body, query or header; it comes from the token
  or the path slug. A request body never names `branchId`, `sessionId`,
  `businessDate` or `...ByUserId`.
- **Errors:** every named code is mapped in `ERROR_CONTRACT`
  (`backend/src/utils/errors/errors.ts`) with status, retryable and a client action.
- **Idempotency:** every POS mutation carries an idempotency key.
- **Collection:** `docs/api/postman/` (generate with `pnpm postman`).

The route table is the source of truth; list it with the Postman generator rather
than copying it here.
