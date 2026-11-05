#!/usr/bin/env bash
# Paperless-ngx backup — full document_exporter snapshot as a dated zip.
#
# Run on the Docker host. Writes into the NFS export share,
# so the archive lands on the NAS rather than the local volume it is backing up.
#
#   ./backup.sh                 # snapshot, prune archives older than KEEP_DAYS
#   KEEP_DAYS=90 ./backup.sh    # keep three months
set -euo pipefail

CONTAINER="${CONTAINER:-paperless-webserver}"
# Path inside the container; bind-mounted to EXPORT_PATH on NFS.
EXPORT_DIR="${EXPORT_DIR:-../export}"
# Same directory as seen from the host, used for pruning.
HOST_EXPORT="${HOST_EXPORT:-/mnt/nfs/appdata/paperless-ngx/export}"
KEEP_DAYS="${KEEP_DAYS:-30}"

stamp="$(date +%Y-%m-%d)"
name="paperless-backup-${stamp}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '$CONTAINER' is not running" >&2
  exit 1
fi

docker exec "$CONTAINER" python3 manage.py document_exporter \
  "$EXPORT_DIR" --zip --zip-name "$name" --no-progress-bar

archive="${HOST_EXPORT}/${name}.zip"
[ -f "$archive" ] || { echo "error: expected archive not found: $archive" >&2; exit 1; }

find "$HOST_EXPORT" -maxdepth 1 -name 'paperless-backup-*.zip' -mtime "+${KEEP_DAYS}" -delete

echo "backup complete: ${archive} ($(du -h "$archive" | cut -f1))"
