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
#   skip (print "skipped (not in dump)") when the dump TOC does not list the table, e.g. it was
#     created by a migration after the dump
#   fail when the TOC lists the table but the restore lacks it
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

# Strip double quotes so mixed-case names compare as plain text.
toc="$(pg_restore -l "$dump" | tr -d '"')"
count=0
skipped=0
while IFS='|' read -r quoted name; do
  [ -n "$name" ] || continue
  # psql does not expand variables inside -c, so the query goes in on stdin.
  present="$(psql -X -v ON_ERROR_STOP=1 -At -d "$SCRATCH" -v rel="$quoted" <<< "select to_regclass(:'rel') is not null")"
  if [ "$present" != "t" ]; then
    schema="${name%%.*}"
    rel="${name#*.}"
    if grep -Fq " TABLE $schema $rel " <<< "$toc"; then
      echo "Restore check failed: $name is in the dump but missing from the restore" >&2
      exit 1
    fi
    echo "skipped (not in dump): $name"
    skipped=$((skipped + 1))
    continue
  fi
  l="$(live -c "select count(*) from $quoted")"
  r="$(psql -X -v ON_ERROR_STOP=1 -At -d "$SCRATCH" -c "select count(*) from $quoted")"
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

if [ "$((count))" -eq 0 ]; then
  echo "Restore check failed: no tables found in the live database" >&2
  exit 1
fi
echo "Restore check passed: $count tables, $skipped skipped"
