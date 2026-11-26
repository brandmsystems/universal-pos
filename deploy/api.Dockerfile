# The API.
#
# Two stages, because the runtime image must not carry a compiler or the dev
# dependencies: a smaller image is a smaller thing to patch, and tsx in
# production is a way to ship a syntax error to a customer.
#
# The repo is a pnpm workspace: the api (backend) depends on shared,
# which is compiled to JavaScript first because Node does not import
# TypeScript from another package at runtime.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/check-lockfiles.mjs ./scripts/
RUN node scripts/check-lockfiles.mjs
COPY backend/package.json ./backend/
COPY packages ./packages
COPY shared ./shared
# Scripts are skipped: the root postinstall compiles shared with the
# root's tsc, which a filtered install does not provide. It is built below.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @universalpos/api...
RUN pnpm --filter @universalpos/shared build
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src
RUN pnpm --filter @universalpos/api build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY packages/tsconfig/package.json ./packages/tsconfig/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @universalpos/api...
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/backend/dist ./backend/dist
# Migrations are NOT run here by default. They are a deliberate act against a
# database that may be shared, and a container that migrates on boot races every
# other replica -- the paid Blueprint migrates in its preDeployCommand. The free
# Blueprint (one instance, no pre-deploy step) sets MIGRATE_ON_START=1: see
# deploy/api-start.sh. migrate.js finds them by walking up to /app/db.
COPY database ./database
COPY deploy/api-start.sh ./deploy/api-start.sh
# Never root: the process needs no privilege it cannot get from its connection
# string, and the database roles are where the real least-privilege lives.
USER node
EXPOSE 8080
CMD ["sh", "deploy/api-start.sh"]
