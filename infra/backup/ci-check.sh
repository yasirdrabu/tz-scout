#!/usr/bin/env bash
# CI harness for backup.sh and restore-check.sh. Needs a reachable, migrated and seeded
# Postgres (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) and pg_dump/pg_restore/psql on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export BACKUP_DIR="$work/backups"
unset BACKUP_REMOTE

rows="$(psql -X -At -c 'select count(*) from tenancy.membership')"
if [ "$rows" -eq 0 ]; then
  echo "ci-check: tenancy.membership is empty; seed the database first" >&2
  exit 1
fi

bash "$here/backup.sh"
ls "$BACKUP_DIR"/scout-*.dump >/dev/null

out="$(bash "$here/restore-check.sh")"
echo "$out"
case "$out" in
  *"Restore check passed"*) ;;
  *) echo "ci-check: expected 'Restore check passed'" >&2; exit 1 ;;
esac

bad="$work/truncated.dump"
pg_dump -Fc --exclude-table-data tenancy.membership -f "$bad"
set +e
out="$(bash "$here/restore-check.sh" "$bad" 2>&1)"
code=$?
set -e
echo "$out"
if [ "$code" -ne 1 ]; then
  echo "ci-check: expected exit 1 for the truncated dump, got $code" >&2
  exit 1
fi
case "$out" in
  *tenancy.membership*) ;;
  *) echo "ci-check: failure did not name tenancy.membership" >&2; exit 1 ;;
esac
echo "ci-check: ok"
