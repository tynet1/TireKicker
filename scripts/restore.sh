#!/bin/sh
# Restore a backup into the running stack. Run from the repo folder (on Windows, from Git Bash):
#   sh scripts/restore.sh backups/db_2026-11-10_0200.dump backups/uploads_2026-11-10_0200.tar.gz
# This REPLACES the current database and uploaded files. Before touching anything it saves the current data as
# db_<now>_before-restore.dump / uploads_<now>_before-restore.tar.gz in the backup folder, so a wrong restore
# can be undone by restoring those.
set -eu
# Git Bash on Windows rewrites arguments that look like Unix paths (/bin/sh, /data/...); stop it.
export MSYS_NO_PATHCONV=1

DUMP="${1:?usage: sh scripts/restore.sh <db_*.dump> <uploads_*.tar.gz>}"
TARBALL="${2:?usage: sh scripts/restore.sh <db_*.dump> <uploads_*.tar.gz>}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 1; }
[ -f "$TARBALL" ] || { echo "No such file: $TARBALL" >&2; exit 1; }
# Absolute path of the tarball for docker -v (a Windows path on Git Bash, where Docker Desktop needs one).
tar_dir=$(cd "$(dirname "$TARBALL")" && (pwd -W 2>/dev/null || pwd))
tar_abs="$tar_dir/$(basename "$TARBALL")"

printf 'This replaces the live database and photos with %s and %s. Type RESTORE to continue: ' "$DUMP" "$TARBALL"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

echo "Saving the current data first (before-restore backup)..."
docker compose exec -T backup /bin/sh /backup.sh before-restore

docker compose stop app
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DUMP"
docker compose run --rm --no-deps -T -u root --entrypoint sh \
  -v "$tar_abs":/restore.tar.gz:ro \
  app -c 'find /data/uploads -mindepth 1 -delete && tar -xzf /restore.tar.gz -C /data/uploads && chown -R node:node /data/uploads'
docker compose start app
echo "Restore finished. If it was the wrong backup, restore the *_before-restore files the same way."
