#!/bin/sh
set -eu

if [ "${TASKARA_RUN_MIGRATIONS:-true}" = "true" ]; then
  bun prisma migrate deploy --schema packages/db/prisma/schema.prisma
fi

exec "$@"
