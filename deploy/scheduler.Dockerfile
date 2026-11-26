# The scheduler is a THIN container: cron, and the same source the app uses. It
# contributes no logic -- every job is a plain function in apps/api/src/jobs, and
# this file only decides when they are invoked.
#
# Swapping to EventBridge or Cloud Scheduler means deleting this file and writing
# a different projection of the same registry. No job changes.
FROM node:22-alpine

RUN apk add --no-cache dcron tini
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/check-lockfiles.mjs ./scripts/
COPY apps/api/package.json ./apps/api/
COPY packages ./packages
# The root's tsx runs the jobs (see deploy/crontab); the api's own dependencies
# are what the jobs import.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter universalpos --filter @universalpos/api...
RUN pnpm --filter @universalpos/shared build

COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY db ./db
COPY deploy/crontab /etc/crontabs/root
# A Windows editor saving this file with CRLF makes every line end `2>&1\r`,
# which sh refuses with exit 2 before the job starts -- every job silently
# never runs, and nothing reaches the log.
RUN sed -i 's/\r$//' /etc/crontabs/root

RUN touch /var/log/jobs.log

# tini reaps the children cron forks; without it a crashed job leaves a zombie
# and the container slowly runs out of process slots.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "crond -f -l 8 & tail -F /var/log/jobs.log"]
