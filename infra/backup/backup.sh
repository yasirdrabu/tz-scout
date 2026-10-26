#!/usr/bin/env bash
# Nightly backup: pg_dump -Fc to $BACKUP_DIR/scout-<UTC timestamp>.dump, copy offsite, prune.
#
# Connection: standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
# BACKUP_DIR     where dumps are kept (default /backups)
# BACKUP_REMOTE  optional rclone destination such as r2:scout-backups. Unset means local only.
# Retention is 14 days, local and remote.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS=14
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/scout-$stamp.dump"

mkdir -p "$BACKUP_DIR"
# Write to a partial name so a failed dump is never mistaken for a backup.
trap 'rm -f "$file.partial"' EXIT
pg_dump -Fc -f "$file.partial"
mv "$file.partial" "$file"
echo "backup: wrote $file"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$file" "$BACKUP_REMOTE"
  echo "backup: copied to $BACKUP_REMOTE"
fi

find "$BACKUP_DIR" -maxdepth 1 -name 'scout-*.dump' -mtime "+$((RETENTION_DAYS - 1))" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'scout-*.dump.partial' -mtime +0 -print -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone delete "$BACKUP_REMOTE" --min-age "${RETENTION_DAYS}d" --include '/scout-*.dump'
fi
echo "backup: done"
