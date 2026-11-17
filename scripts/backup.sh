#!/bin/sh
# Nightly backup, run by the `backup` service in docker-compose.yml.
#   backup.sh          take one backup now
#   backup.sh <label>  take one backup now, named ..._<label> (restore.sh uses "before-restore")
#   backup.sh loop     take one backup per day after BACKUP_HOUR (local time), forever
# Writes /backups/db_<stamp>.dump (pg_dump custom format) and /backups/uploads_<stamp>.tar.gz, <stamp> being
# YYYY-MM-DD_HHMMSS[_label], then deletes backups older than BACKUP_KEEP_DAYS.
# Safety rules:
# - one backup at a time (a lock), each written to its own temp file and renamed only when complete,
#   so a half-written or failed backup never looks like a good one;
# - an existing backup file is never overwritten (restore.sh may be about to read it);
# - old backups are only pruned after a new one succeeded.
set -eu

KEEP="${BACKUP_KEEP_DAYS:-30}"
HOUR="${BACKUP_HOUR:-2}"
LOCK=/tmp/backup.lock # the nightly loop and restore.sh's safety copy both run in this container

# Every step is checked by hand: in the loop this runs as `backup_once || ...`, where `set -e` is off.
backup_once() {
  label=${1:+_$1}
  exec 9>"$LOCK"
  flock 9 || return 1
  stamp=$(date +%Y-%m-%d_%H%M%S)$label
  while [ -e "/backups/db_${stamp}.dump" ] || [ -e "/backups/uploads_${stamp}.tar.gz" ]; do
    sleep 1
    stamp=$(date +%Y-%m-%d_%H%M%S)$label
  done
  db="/backups/db_${stamp}.dump"
  up="/backups/uploads_${stamp}.tar.gz"
  if ! { pg_dump -Fc -f "$db.part" && mv "$db.part" "$db" \
      && tar -czf "$up.part" -C /uploads . && mv "$up.part" "$up"; }; then
    rm -f "$db.part" "$up.part"
    exec 9>&-
    echo "$(date '+%F %T') backup ${stamp} FAILED" >&2
    return 1
  fi
  find /backups -maxdepth 1 -type f \( -name 'db_*.dump' -o -name 'uploads_*.tar.gz' \) -mtime +"$KEEP" -delete
  find /backups -maxdepth 1 -type f -name '*.part' -mtime +1 -delete
  exec 9>&-
  echo "$(date '+%F %T') backup ${stamp} done"
}

# True if tonight's plain nightly backup exists (HHMMSS, or HHMM from older versions of this script).
# A labeled one-off like _before-restore doesn't count.
has_nightly() {
  for f in /backups/db_"$1"_[0-9][0-9][0-9][0-9][0-9][0-9].dump /backups/db_"$1"_[0-9][0-9][0-9][0-9].dump; do
    [ -e "$f" ] && return 0
  done
  return 1
}

if [ "${1:-}" != "loop" ]; then
  case "${1:-}" in
    *[!a-z0-9-]*) echo "label must be lowercase letters, digits and dashes" >&2; exit 1 ;;
  esac
  backup_once "${1:-}" || exit 1
  exit 0
fi

echo "$(date '+%F %T') backup loop started: daily after ${HOUR}:00, keeping ${KEEP} days"
# After the PC (or Docker) restarts, every container starts at once; wait for the database before the first try.
for _ in $(seq 1 60); do pg_isready -q && break; sleep 5; done
while true; do
  today=$(date +%Y-%m-%d)
  hour=$(date +%H)
  hour=${hour#0}
  if [ "$hour" -ge "$HOUR" ] && ! has_nightly "$today"; then
    backup_once || echo "$(date '+%F %T') backup FAILED, will retry in 10 minutes" >&2
  fi
  sleep 600
done
