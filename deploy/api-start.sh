#!/bin/sh
# The API container's start command.
#
# MIGRATE_ON_START=1 (the free Blueprint) applies the migrations and the seed,
# as the owner role from DATABASE_URL_OWNER, before the API starts. Free Render
# services have no pre-deploy step, so without this nothing ever migrated a free
# database and new code met an old schema. Safe only where ONE instance runs:
# the paid Blueprint migrates in preDeployCommand instead and leaves this unset.
#
# A script rather than a chained Docker Command: Render passes that field to the
# container without a shell's quoting, so `sh -c "a && b"` arrived as one word
# and failed with "not found".
set -e
if [ "${MIGRATE_ON_START:-}" = "1" ]; then
  node apps/api/dist/core/database/migrate.js up
  node apps/api/dist/core/database/seed.js
fi
exec node apps/api/dist/server.js
