#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_root="${SMARTCRAWL_BACKUP_ROOT:-/var/backups/smartcrawl}"
container="${SMARTCRAWL_CONTAINER:-aetherhost-smart-crawler-app-1}"
mkdir -p "$backup_root"
exec 9>"${SMARTCRAWL_BACKUP_LOCK:-/run/lock/smartcrawl-daily-backup.lock}"
flock -n 9 || { printf 'Another backup is already running.\n'; exit 0; }

python3 - "$backup_root" <<'PY'
import shutil, sys
if shutil.disk_usage(sys.argv[1]).free < 1024 * 1024 * 1024:
    sys.exit('Backup refused: less than 1 GiB of free disk space remains.')
PY

run_dir="$(mktemp -d "$backup_root/run-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
bash "$script_dir/backup-aetherhost.sh" "$container" "$run_dir"
for snapshot in "$run_dir"/smartcrawl-*/jobs.sqlite; do
  python3 "$script_dir/verify-backup.py" "$(dirname -- "$snapshot")"
  # Only publish success after both the snapshot and restore checks pass.
  python3 - "$(dirname -- "$snapshot")/manifest.json" "$backup_root/latest-success.json" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
source, destination = map(Path, sys.argv[1:])
manifest = json.loads(source.read_text())
manifest['snapshotDirectory'] = str(source.parent)
descriptor, temporary = tempfile.mkstemp(prefix='.latest-', dir=destination.parent)
with os.fdopen(descriptor, 'w') as stream:
    json.dump(manifest, stream, indent=2)
    stream.write('\n')
os.replace(temporary, destination)
PY
done
printf 'Daily backup complete. No existing backups were removed.\n'
