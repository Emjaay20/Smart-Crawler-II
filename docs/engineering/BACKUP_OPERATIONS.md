# Backup operations and off-server recovery

Verified 2026-11-16. Daily server snapshots are installed and active. The scheduled
run completed at 02:06 Lagos time today, with SQLite integrity and clean-directory
restore checks passing. The timer runs at approximately 02:00–02:10 Africa/Lagos,
including missed runs after downtime. Snapshots and success manifests are private;
no existing backups are automatically deleted.

## Keep an independently verified copy on your computer

From the project directory, run:

```sh
npm run backup:fetch
```

The command uses your existing SSH authentication; it never stores a password.
It copies the latest verified database into a new private directory under
`~/.codex/backups/smartcrawl`, outside this repository. It verifies the exact file
size and SHA-256 from the server manifest, then independently checks SQLite and a
clean-directory restore on your computer. The database file is mode 0600 and its
directory is mode 0700. It never overwrites an earlier backup or prints row data.

The command refuses unexpected server paths and backups older than 36 hours.
For recovery when an older snapshot is the best available copy, explicitly use:

```sh
npm run backup:fetch -- --allow-stale
```

You can choose another SSH host or local directory:

```sh
npm run backup:fetch -- --host user@your-server --destination /private/backup-directory
```

SSH must already trust the server's host key and have usable authentication.
Snapshot destinations inside the repository are refused to avoid accidental
commits of private account/key data. A transfer that fails verification is never
marked successful. Keep any unverified download separate from valid snapshots.

## Inspect the scheduled job

On the Docker host:

```sh
systemctl status smartcrawl-daily-backup.timer --no-pager
systemctl status smartcrawl-daily-backup.service --no-pager
cat /var/backups/smartcrawl/latest-success.json
journalctl -u smartcrawl-daily-backup.service -n 30 --no-pager
```

`inactive (dead)` is normal for a successful oneshot service between runs; inspect
its last exit status and the timer's next trigger. The success manifest is updated
only after snapshot and restore checks pass. The job refuses to run if less than
1 GiB of free server disk remains. Check disk usage periodically because automatic
deletion is deliberately disabled.

## Recovery boundaries

Daily server backups protect against accidental deletion and container problems;
they do not protect against losing the entire VPS. The fetch command creates an
off-server copy when you run it; it is **not** an automatic off-server schedule.
Choose a separate, durable storage destination before adding that schedule.

For an actual rollback, stop writers, retain the current database/WAL files as a
separate recovery set, and restore the verified snapshot into a fresh directory.
Use the compatible application image and recheck ownership, authentication,
health and readiness. Do not overwrite a live SQLite database or overlay a
snapshot on stale WAL files. See [the release record](AETHERHOST_RELEASE.md).

## Validation

Six Python regressions cover snapshot restore, private manifests, corrupt files,
checksum mismatches, path traversal and stale-backup opt-in. CI runs these together
with the application suite. A real off-server transfer was also verified on the
operator's computer; credentials and database rows were not included in Git.
