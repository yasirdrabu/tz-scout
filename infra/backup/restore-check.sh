#!/usr/bin/env bash
# Proves a backup restores: restore a dump into scratch database scout_restore_check and
# compare row counts with the live database for every table in platform, tenancy,
# integrations and ai.
#
# Usage: restore-check.sh [dump]    (default: newest scout-*.dump in $BACKUP_DIR, default /backups)
# Connection: standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
# The user must be able to create databases and read every row (the superuser, in practice).
#
# Rule per table (live count L, restored count R):
#   fail when the table is missing from the restore
#   fail when R > L             (the dump cannot hold more rows than the live database)
#   fail when R = 0 and L > 0   (data lost from the dump)
#   pass otherwise, so L >= R is allowed: the live database grows after the dump
# Exits 1 naming the first failing table. The scratch database is always dropped on exit.
set -euo pipefail

SCRATCH=scout_restore_check
BACKUP_DIR="${BACKUP_DIR:-/backups}"

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -1 "$BACKUP_DIR"/scout-*.dump 2>/dev/null | sort | tail -n 1 || true)"
fi
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "Restore check failed: no dump found (looked in $BACKUP_DIR)" >&2
  exit 1
fi

live() { psql -X -v ON_ERROR_STOP=1 -At "$@"; }

cleanup() {
  live -c "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

live -c "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null
live -c "CREATE DATABASE $SCRATCH" >/dev/null
echo "restore-check: restoring $dump"
pg_restore --no-owner --no-privileges --exit-on-error -d "$SCRATCH" "$dump"

tables="$(live -F '|' -c "
  select format('%I.%I', n.nspname, c.relname), n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p') and n.nspname in ('platform','tenancy','integrations','ai')
  order by 2")"

count=0
while IFS='|' read -r quoted name; do
  [ -n "$name" ] || continue
  l="$(live -c "select count(*) from $quoted")"
  if ! r="$(psql -X -v ON_ERROR_STOP=1 -At -d "$SCRATCH" -c "select count(*) from $quoted" 2>/dev/null)"; then
    echo "Restore check failed: $name is missing from the restore" >&2
    exit 1
  fi
  if [ "$r" -gt "$l" ]; then
    echo "Restore check failed: $name has $r rows in the restore but only $l live" >&2
    exit 1
  fi
  if [ "$r" -eq 0 ] && [ "$l" -gt 0 ]; then
    echo "Restore check failed: $name has 0 rows in the restore but $l live" >&2
    exit 1
  fi
  count=$((count + 1))
done <<< "$tables"

if [ "$count" -eq 0 ]; then
  echo "Restore check failed: no tables found in the live database" >&2
  exit 1
fi
echo "Restore check passed: $count tables"
