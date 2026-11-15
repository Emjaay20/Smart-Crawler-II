#!/usr/bin/env bash
# Run as root on the Docker host, from a checked-out SmartCrawl repository.
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  printf 'Run this installer as root on the Docker host.\n' >&2
  exit 1
fi
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install -d -m 0755 /usr/local/libexec/smartcrawl-backup
install -d -m 0700 /var/backups/smartcrawl
for script in daily-backup.sh backup-aetherhost.sh verify-backup.py; do
  install -m 0755 "$project_root/scripts/$script" "/usr/local/libexec/smartcrawl-backup/$script"
done
install -m 0644 "$project_root/ops/systemd/smartcrawl-daily-backup.service" /etc/systemd/system/
install -m 0644 "$project_root/ops/systemd/smartcrawl-daily-backup.timer" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/smartcrawl-daily-backup.service /etc/systemd/system/smartcrawl-daily-backup.timer
systemctl daemon-reload
systemctl start smartcrawl-daily-backup.service
systemctl enable --now smartcrawl-daily-backup.timer
systemctl list-timers smartcrawl-daily-backup.timer --no-pager
