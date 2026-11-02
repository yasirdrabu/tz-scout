#!/usr/bin/env bash
# CI harness for backup.sh and restore-check.sh. Needs a reachable, migrated and seeded
# Postgres (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) and pg_dump/pg_restore/psql on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Static checks first: syntax, and a guard against a call lost its argument.
for f in backup.sh restore-check.sh ci-check.sh; do bash -n "$here/$f"; done
if grep -n "to_regclass()" "$here/restore-check.sh"; then
  echo "ci-check: restore-check.sh has to_regclass() with no argument" >&2
  exit 1
fi
work="$(mktemp -d)"
# Databases this check made, dropped again on exit.
made=""
cleanup() {
  for db in $made; do psql -X -q -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
export BACKUP_DIR="$work/backups"
unset BACKUP_REMOTE

rows="$(psql -X -At -c 'select count(*) from tenancy.membership')"
if [ "$rows" -eq 0 ]; then
  echo "ci-check: tenancy.membership is empty; seed the database first" >&2
  exit 1
fi

# A workspace database (D35) is dumped to a file of its own; the template is not dumped.
for db in scout_t_ci_check scout_t_template; do
  if [ "$(psql -X -At -c "select count(*) from pg_database where datname = '$db'")" -eq 0 ]; then
    psql -X -q -c "create database $db"
    made="$made $db"
  fi
done
psql -X -q -d scout_t_ci_check -c "create table if not exists ci_rows as select 1 as id"

bash "$here/backup.sh"
ls "$BACKUP_DIR"/scout-*.dump >/dev/null
ws_dump="$(ls "$BACKUP_DIR"/scout_t_ci_check-*.dump)"
if ! pg_restore -l "$ws_dump" | grep -q "TABLE public ci_rows"; then
  echo "ci-check: the workspace database's dump has no ci_rows table" >&2
  exit 1
fi
if ls "$BACKUP_DIR"/scout_t_template-*.dump >/dev/null 2>&1; then
  echo "ci-check: the template database was backed up" >&2
  exit 1
fi

out="$(bash "$here/restore-check.sh")"
echo "$out"
case "$out" in
  *"Restore check passed"*) ;;
  *) echo "ci-check: expected 'Restore check passed'" >&2; exit 1 ;;
esac

# A table created after the dump must be skipped, not fail the check.
trap 'psql -X -q -c "drop table if exists platform.ci_extra" >/dev/null 2>&1 || true; cleanup' EXIT
psql -X -q -c "create table platform.ci_extra as select 1 as id"
out="$(bash "$here/restore-check.sh")"
echo "$out"
case "$out" in
  *"Restore check passed"*"1 skipped"*) ;;
  *) echo "ci-check: expected pass with 1 skipped for a table created after the dump" >&2; exit 1 ;;
esac
psql -X -q -c "drop table platform.ci_extra"

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
