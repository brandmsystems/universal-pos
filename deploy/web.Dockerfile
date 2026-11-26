# The web clients (POS, KDS, restaurant admin, control plane).
#
# Built to static files and served by nginx, which is the honest shape: it has no
# server-side logic, and the API is a separate origin it reaches by relative path.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/deployment/check-lockfiles.mjs ./scripts/deployment/
RUN node scripts/deployment/check-lockfiles.mjs
COPY frontend/package.json ./frontend/
COPY packages ./packages
COPY shared ./shared
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @universalpos/web...
RUN pnpm --filter @universalpos/shared build
COPY frontend ./frontend
# The admin's Printers page offers the print agent program as a download.
COPY print-agent/universalpos-print-agent.mjs ./print-agent/
RUN pnpm --filter @universalpos/web build

FROM nginx:1.27-alpine AS runtime
# A template: the entrypoint substitutes the environment variables it names
# (API_UPSTREAM, and NGINX_LOCAL_RESOLVERS read from /etc/resolv.conf) into
# conf.d at start, so one image serves locally and on Render.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY deploy/web.nginx.conf /etc/nginx/templates/default.conf.template
# Runs before the template is filled (15-local-resolvers < 18 < 20-envsubst).
COPY --chmod=755 deploy/web-api-upstream.envsh /docker-entrypoint.d/18-api-upstream.envsh
COPY --chmod=755 deploy/web-wake-api.sh /docker-entrypoint.d/40-wake-api.sh
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
