#!/usr/bin/env bash
# Run on the Aetherhost Docker host before replacing the live container.
set -euo pipefail
umask 077

container="${1:-aetherhost-smart-crawler-app-1}"
backup_root="${2:?Usage: bash scripts/backup-aetherhost.sh [container] /private/backup-directory}"
mkdir -p "$backup_root"
backup_dir="$(mktemp -d "$backup_root/smartcrawl-XXXXXXXX")"
snapshot="/tmp/smartcrawl-snapshot-$(date +%s)-$$.sqlite"

# Save the image reference and mount metadata only, never environment secrets.
docker inspect --format '{{.Image}}' "$container" > "$backup_dir/image-id.txt"
docker inspect --format '{{json .Mounts}}' "$container" > "$backup_dir/mounts.json"

docker exec "$container" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  import { closeSync, openSync } from "node:fs";
  const destination = process.argv[1];
  closeSync(openSync(destination, "wx", 0o600));
  const database = new DatabaseSync(process.env.JOBS_DB || "/app/data/jobs.sqlite", {readOnly:true});
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.prepare("VACUUM INTO ?").run(destination);
  } finally { database.close(); }
  const snapshot = new DatabaseSync(destination, {readOnly:true});
  try {
    if (snapshot.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
      throw Error("Snapshot integrity check failed");
    }
  } finally { snapshot.close(); }
' "$snapshot"

docker cp "$container:$snapshot" "$backup_dir/jobs.sqlite"
chmod 600 "$backup_dir/jobs.sqlite"
# Remove only the temporary snapshot created by this invocation after copying it.
docker exec "$container" node -e 'require("node:fs").unlinkSync(process.argv[1])' "$snapshot"
printf 'Verified database snapshot and rollback metadata saved in %s\n' "$backup_dir"
printf 'Keep this directory private and copy it to durable backup storage.\n'
