# Consolidated local release validation

Date: 2026-11-15. Working branch: `codex/complete-release-validation`.
Base: `origin/release/combined-review-20261114` (the cumulative candidate from PR #11).

The previous checkout was `main`. The working branch now contains the combined
security, guest sessions, browser scheduling, concurrent crawl, pending recovery,
checkpoint/resume, SDK deadline, audit and portfolio work described in the shared
chat. Existing draft PRs have not been merged or closed; production is unchanged.
Use the combined candidate as the review unit rather than merging all eleven
overlapping PRs independently.

## Additional implementation

- Updated server and UI lockfiles with compatible security fixes, including a
  `minimatch` override (`^11.0.8`) in `ui/package.json`. Server audit: zero
  findings. UI audit: zero findings. CI now rejects high/critical findings.
- Added `npm run db:backup -- SOURCE.sqlite NEW_BACKUP.sqlite`. SQLite `VACUUM INTO`
  captures a consistent standalone snapshot, including committed WAL data. The
  destination is exclusively created with mode 0600 and integrity-checked. Existing
  files are never overwritten. Snapshot only; no automatic production restore.
- Added a restore regression against a live WAL database, including backup
  immutability and file permissions.
- Added an opt-in real Chromium test: concurrent contexts do not share local
  storage, an in-flight browser process is crashed through Chromium's debug
  protocol, and the next render launches a fresh browser successfully.
- Added certificate-verified local HTTPS coverage of production guest cookie
  flags, using a dedicated temporary certificate without disabling TLS checks.
- Added a real listening socket fixture proving that a private DNS result is
  rejected without connecting to the fixture. This does not establish deployed
  firewall enforcement or a complete DNS-rebinding attack test.
- CI installs Chromium and runs the real browser regression separately from the
  ordinary suite.

## Verification commands

```sh
npm ci
npm --prefix ui ci
npm test
npx playwright install chromium
npm run test:browser
npm run build
npm audit --audit-level=high
npm --prefix ui audit --audit-level=high
npm run bench:crawl
docker build -t smart-crawler:local-validation .
```

Local Node runtime: v22.20.0, macOS arm64. The standard suite intentionally skips
the opt-in browser test; `npm run test:browser` runs it with real Chromium.
The local HTTPS test requires OpenSSL, also available on the Linux CI runner.

Final standard-suite result: **146 passed**, 37 passing files; one real-browser
test skipped by design. Separate real-browser result: **1 passed**. Backend and
UI builds both passed. The existing process-kill checkpoint regression is included
in the passing standard suite. `git diff --check` passed.

The synthetic 16-page benchmark's latest measured means were 974.93ms at
concurrency 1, 602.26ms at 2 and 397.98ms at 4 (three trials each). These are local
fixtures and vary with host load; they are not production throughput claims.

The Docker image built successfully. A private container (no published ports)
returned healthy `/health`, ready `/ready`, rejected unauthenticated admin access
with 401 and returned a healthy authenticated administrative report.

## Backup and rollback exercise

1. Put the backup in a private directory on durable storage. Run the backup command
   while the source database is open; never copy only the main SQLite file while
   WAL writes are active.
2. Preserve the previous application image and its configuration separately. A
   database snapshot contains private job, account and key records; protect it.
3. For an actual rollback, stop the service and all database writers. Keep the
   current database and its WAL/SHM files together as a separate recovery set.
4. Restore the verified standalone snapshot into a fresh directory, configure a
   single service instance with `JOBS_DB` pointing there, and start the pinned
   compatible application image. Do not overlay a snapshot onto live WAL files.
5. Check health/readiness, authentication, job ownership and checkpoints before
   restoring traffic. Repeat in the intended staging environment before production.

## Hosting validation and remaining boundaries

- Aetherhost SSH backup (`/root/smartcrawl-backups/smartcrawl-TGC4Oipf`), isolated
  Let's Encrypt HTTPS staging (`https://smart-crawler-staging.aetherhost.app`),
  container restart persistence, snapshot restore rehearsal, and production persistent
  mount (`/srv/aetherhost/data/smart-crawler:/app/data`) are documented in
  [Aetherhost release configuration](AETHERHOST_RELEASE.md).
- A later automated redeploy removed that manual host bind mount. The follow-up
  repair now gives this app an opt-in, application-specific named volume through
  the patched provisioner; see the same release record and
  [platform patch](../../ops/aetherhost/README.md). The older host data and current
  container data were backed up separately before migration.
- Outbound browser/proxy firewall policy on the host remains disabled by default
  (`SMARTCRAWL_BROWSER_EGRESS_ISOLATED=false`, `SMARTCRAWL_TRUSTED_PROXY_EGRESS=false`)
  because the production image excludes Chromium and no external proxy gateway is configured.
- Firecrawl #5717 was reproduced in one hosted request. [Draft PR #5756](https://github.com/firecrawl/firecrawl/pull/5756)
  proposes a guard and regressions; local upstream tests are blocked by missing
  FoundationDB client headers. It has no maintainer feedback yet and is not an
  accepted upstream fix. See [the evidence and validation limits](SOURCE_STATUS_INTEGRITY.md).
- Daily backups passed a scheduled run on 2026-11-16. The off-server fetch command
  adds independent checksum, integrity and restore verification; see
  [backup operations](BACKUP_OPERATIONS.md).
- [Role-specific application materials](../portfolio/FIRECRAWL_APPLICATION_NOTES.md)
  have been tailored with Yusuf Abubakar Saka's CV details and both Ashby job descriptions.
