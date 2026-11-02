#!/usr/bin/env bash
# Nightly backup: pg_dump -Fc of the control plane database to $BACKUP_DIR/scout-<UTC timestamp>.dump
# and of every workspace database (D35) to $BACKUP_DIR/<database>-<UTC timestamp>.dump, copy offsite,
# prune.
#
# Connection: standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE). PGDATABASE
# is the control plane; the workspace databases are every scout_t_* database on the same server but
# the template (SCOUT_WORKSPACE_TEMPLATE_DATABASE, default scout_t_template), listed from pg_database.
# BACKUP_DIR     where dumps are kept (default /backups)
# BACKUP_REMOTE  optional rclone destination such as r2:scout-backups. Unset means local only.
# Retention is 14 days, local and remote. A database that fails to dump does not stop the others;
# the script then exits 1.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS=14
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
control="$(psql -X -v ON_ERROR_STOP=1 -At -c 'select current_database()')"
template="${SCOUT_WORKSPACE_TEMPLATE_DATABASE:-scout_t_template}"
# psql does not expand variables inside -c, so the query goes in on stdin.
workspaces="$(psql -X -v ON_ERROR_STOP=1 -At -v template="$template" <<'SQL'
select datname from pg_database
where datname like 'scout\_t\_%' and datname <> :'template' and not datistemplate
order by 1
SQL
)"

partial=""
# Write to a partial name so a failed dump is never mistaken for a backup.
trap 'if [ -n "$partial" ]; then rm -f "$partial"; fi' EXIT
failed=0
# dump <database> <file name prefix>
dump() {
  local file="$BACKUP_DIR/$2-$stamp.dump"
  partial="$file.partial"
  if pg_dump -Fc -d "$1" -f "$partial"; then
    mv "$partial" "$file"
    partial=""
    echo "backup: wrote $file"
    if [ -n "${BACKUP_REMOTE:-}" ]; then
      rclone copy "$file" "$BACKUP_REMOTE"
      echo "backup: copied $file to $BACKUP_REMOTE"
    fi
  else
    rm -f "$partial"
    partial=""
    echo "backup: FAILED to dump $1" >&2
    failed=1
  fi
}

dump "$control" scout
while IFS= read -r db; do
  [ -n "$db" ] || continue
  dump "$db" "$db"
done <<< "$workspaces"

find "$BACKUP_DIR" -maxdepth 1 \( -name 'scout-*.dump' -o -name 'scout_t_*.dump' \) -mtime "+$((RETENTION_DAYS - 1))" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'scout*.dump.partial' -mtime +0 -print -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone delete "$BACKUP_REMOTE" --min-age "${RETENTION_DAYS}d" --include '/scout-*.dump' --include '/scout_t_*.dump'
fi
if [ "$failed" -ne 0 ]; then
  echo "backup: done, with failures" >&2
  exit 1
fi
echo "backup: done"
