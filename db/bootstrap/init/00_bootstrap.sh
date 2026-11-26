#!/bin/sh
# Runs once, on first cluster init, as the superuser.
#
# The point of this file is that `docker compose up` produces a stack where the
# application connects as katkitchen_app through the pooler -- NOT as a
# superuser directly. A local stack that runs as postgres is a local stack where
# the RLS backstop, the append-only grants and the ownership probe are all
# inert, and every one of them would first fail in production.
#
# 00_roles.sql creates the database as well as the roles, so nothing here does.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -f /bootstrap/00_roles.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d katkitchen -f /bootstrap/01_database.sql
sh /bootstrap/test_database.sh
