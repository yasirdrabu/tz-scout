#!/bin/sh
# Usage: entrypoint.sh <role> [args]
# Roles: web, worker, scheduler, relay, all-background, migrate, seed, keys:create, tenants:create
set -e
if [ "$#" -eq 0 ]; then
  echo "usage: entrypoint.sh <role>" >&2
  exit 64
fi
exec node dist/cli.js "$@"
