#!/bin/sh
# The database the API test suite runs against: katkitchen_test, set up by the
# same 01_database.sql as katkitchen. Idempotent -- safe on every run.
#
# The suite provisions hundreds of probe restaurants per run. Pointed at the
# development database it buried the owner's real restaurants under them, so
# it gets its own, and vitest.config.ts points every DATABASE_URL_* here.
#
# Run inside the postgres container (`pnpm db:test:create`); a fresh volume
# runs it from init/00_bootstrap.sh.
set -e
psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres <<'SQL'
SELECT 'CREATE DATABASE katkitchen_test OWNER katkitchen_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'katkitchen_test') \gexec
ALTER DATABASE katkitchen_test SET timezone = 'UTC';
SQL
psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d katkitchen_test -f /bootstrap/01_database.sql
echo "katkitchen_test ready"
