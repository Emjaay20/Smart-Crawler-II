# Aetherhost release configuration

Target confirmed by the owner on 2026-11-15. API authentication is now verified.
The previously documented `https://smart-crawler.aetherhost.com.ng/health` returned
HTTP 404 during this check; that response alone does not identify the root cause.
Authenticated deployment logs confirm the actual public origin is
`https://smart-crawler.aetherhost.app`. Its `/health` and `/ready` both returned 200.
Project examples, CLI default, OpenAPI and monitoring workflow now use that origin.

Platform reference: [Aetherhost documentation](https://aetherhost.com.ng/docs).
The current documentation describes Docker workloads behind Traefik, agent health
checks at `/health`, and both `.aetherhost.app` and legacy `.aetherhost.com.ng`
hostnames. Confirm the actual assigned domain in the console.

## Application settings

Use this repository's Dockerfile, listen on port 3000, and deploy one instance.
Use a separate staging application and database before replacing the existing app.
Confirm plan capacity first; do not purchase or upgrade a plan implicitly.

| Setting | Value / source |
| --- | --- |
| Runtime | Docker image built from the reviewed source commit |
| Health check | HTTP `GET /health` on port 3000 |
| Readiness check | `GET /ready` |
| Persistent mount | Writable `/app/data`, owned by container UID 1000 |
| `NODE_ENV` | `production` |
| `HOST` / `PORT` | `0.0.0.0` / `3000` |
| `JOBS_DB` | `/app/data/jobs.sqlite` |
| `PUBLIC_DIR` | `/app/ui/dist` |
| `MAX_CONCURRENT_JOBS` | `1` initially for the low-memory tenant |
| `NODE_OPTIONS` | `--max-old-space-size=192` initially; measure RSS before raising |
| `SMARTCRAWL_ADMIN_TOKEN` | Private runtime secret supplied in the host, never committed |
| `SMARTCRAWL_GUEST_DEMO_LIMIT` | `0` during private staging; owner chooses public demo policy |
| `SMARTCRAWL_BROWSER_EGRESS_ISOLATED` | `false`; bundled image excludes Chromium |
| `SMARTCRAWL_TRUSTED_PROXY_EGRESS` | `false`; leave gateway URL unset |
| `SMARTCRAWL_ENABLE_PENDING_RECOVERY` | `false` until single-instance recovery exercise passes |
| `SMARTCRAWL_ENABLE_CRAWL_CHECKPOINTS` | `false` until storage/backup validation passes |
| `SMARTCRAWL_ENABLE_CHECKPOINT_RESUME` | `false` until explicit resume validation passes |

Leave `SMARTCRAWL_ALLOW_PRIVATE_NETWORKS` unset. Set
`SMARTCRAWL_TRUSTED_PROXIES` only after obtaining the actual last-hop proxy
addresses/CIDRs from the platform. Do not assume all private networks are trusted.
Leave Slack and managed-provider settings unset for controlled staging to avoid
sending notifications or consuming provider credits. Set up OIDC only with the
actual public origin and registered callback URL.

The heap setting is an initial application budget, not a total process-memory cap.
Measure native allocations and concurrency under the platform's actual limits.
Do not enable restart recovery with multiple instances sharing one SQLite file.

## Release procedure

1. Locate the existing SmartCrawl app and inspect its source, build/start logs,
   assigned hostname, routing port, persistent storage and current image revision.
   Inspect secret names without copying their values into logs or documents.
2. Record the current image/revision and make an integrity-checked backup using
   `npm run db:backup -- SOURCE.sqlite NEW_BACKUP.sqlite`. Store it outside the
   disposable container filesystem. Follow the rollback procedure in
   [local validation](LOCAL_RELEASE_VALIDATION.md).
3. Deploy the reviewed commit to an isolated staging app with fresh data and the
   settings above. Verify the volume survives an ordinary container restart.
4. Verify HTTPS, health/readiness, protected admin routes, API-key ownership,
   guest policy, SDK polling/exports, memory and direct public HTTP scraping against
   owned fixtures. Record commit, image digest, domain and results. Local browser
   tests remain separate because this image does not contain Chromium.
5. Exercise snapshot restore and application rollback before routing production
   traffic. Test checkpoint flags separately with a disposable staging database.
6. Once staging passes, deploy the same image/revision to the existing app, retain
   its volume and verify the assigned public hostname. Do not replace the database
   with the fresh staging database. Monitor failures and memory after release.

## Verified hosting inspection, staging rehearsal, and production release

The owner provided both an Aetherhost API token and SSH access (`root@194.163.172.101`,
host `vmi3660877`). Credentials were used in memory only and never written to project
files.

- App: `app_smart-crawler_e094b774`, runtime `github`, port 3000, health `/health`.
- Source: `https://github.com/Emjaay20/Smart-Crawler-II`.
- Previous live image: `sha256:6765207013fb82a1ee17fad107e4914286e67241e4011339fd5c7d23582a3ffb`
  (tagged on host as `aetherhost-smart-crawler-app:rollback-20261115` from commit `fa157b3`).
- Verified live pre-release backup: `bash scripts/backup-aetherhost.sh` executed on the
  Docker host saved `/root/smartcrawl-backups/smartcrawl-TGC4Oipf/jobs.sqlite` (`0600`,
  `PRAGMA integrity_check = ok`, 61,440 bytes) along with `image-id.txt` and `mounts.json`,
  and an off-host copy was archived prior to release.
- Last-hop reverse proxy inspection: `aetherhost-traefik` on `aetherhost-net`
  (`172.18.0.0/16`) has address `172.18.0.4`. Setting
  `SMARTCRAWL_TRUSTED_PROXIES=172.18.0.4/32` trusts only the Traefik ingress container
  rather than the shared tenant subnet.
- Isolated HTTPS staging rehearsal (`https://smart-crawler-staging.aetherhost.app`,
  image `sha256:95c086adbf9bdf9a0c9701579298e975a7b8a68abaf999431da61d1522cfdf6d`):
  - `GET /health` and `GET /ready` returned HTTP/2 200 over Let's Encrypt TLS.
  - `GET /v1/me` issued `smartcrawl_guest` with `HttpOnly; Secure; SameSite=Lax`.
  - Unauthenticated `GET /v1/admin/keys` returned `401`; authenticated `POST /v1/admin/keys`
    minted a key and recorded `admin.key.created` in `/v1/admin/audit`.
  - Authenticated `POST /v1/scrape` completed (`efd003c3-faec-4652-be7b-d04e6127fbb6`),
    exported 1 JSONL record at `/v1/jobs/:id/export.jsonl`, rejected cross-tenant guest reads
    with `404`, and persisted across `docker restart` (`200`).
  - Measured container RSS after scrape and restart: `111.2 MiB` (`0.03%` CPU).
  - Snapshot backup (`smartcrawl-5JT045Es`) and clean-directory restore preserved all 4
    staging keys and verified startup with `SMARTCRAWL_ENABLE_PENDING_RECOVERY=true`,
    `SMARTCRAWL_ENABLE_CRAWL_CHECKPOINTS=true`, and `SMARTCRAWL_ENABLE_CHECKPOINT_RESUME=true`.
- Persistent host storage attached for production at `/srv/aetherhost/data/smart-crawler:/app/data`
  (UID `1000:1000`, mode `0700`) in `/srv/aetherhost/projects/smart-crawler/docker-compose.yml`.
  Note that if `aetherhost-agent` regenerates `docker-compose.yml` during an automated
  control-plane reprovision, the volume mount should be re-verified on the host.

## Follow-up: persistent storage repaired after automated redeploy

On 2026-11-15, a fresh server inspection found the running `24df972` app had
**no mounts**. The platform had regenerated Compose without the manually added
host bind mount. The prior paragraph records the earlier release, not the current
storage configuration.

The current live database was backed up and integrity-checked at
`/root/smartcrawl-backups/smartcrawl-l7vWGCQ6/jobs.sqlite`, with a private off-server
copy under `~/.codex/backups/smartcrawl/2026-11-15/`. Before migration it contained
no jobs, keys or users. The older host database was preserved separately; its one
guest session was not substituted for the current database.

An opt-in named-volume feature was added to the Aetherhost GitHub-workload
renderer. It is enabled for this application through `AETHER_PERSIST_APP_DATA=true`.
The full Go agent suite passed before building and installing the patched agent.
Other applications remain opted out. See the [patch and rollout record](../../ops/aetherhost/README.md).

After gracefully stopping the app, all its database/WAL files were preserved at
`/root/smartcrawl-backups/pre-volume-migration-20261115/data` and copied into
`aetherhost-data-0861ebe1c7af3e44bce7542ab3659a46d6d3e4ef89f15d96924f6b35349f6eb8`.
The provisioner now regenerates this same named mount at `/app/data` rather than
discarding it. The first redeployment verified a writable mount, UID 1000,
directory mode 0700, database integrity `ok`, HTTPS health/readiness 200 and
unauthenticated admin access rejected with 401.

A second full control-plane redeploy recreated the container at
`2026-11-15T13:07:24Z`. A temporary private marker in `/app/data` survived that
recreation, then was removed. SQLite integrity remained `ok`. Final HTTPS checks
returned 200 for health/readiness, 401 for unauthenticated admin access and 200 for
authenticated admin access. Observed container memory was 83.57 MiB after this
check; this is an idle observation, not a load-test result. The final app image was
`sha256:3fdfb08ff28750ca6a1a0345af545188b45304a3a23686e02750afa6fd2bb660`.

The patch is now merged upstream through
[Aetherhost PR #50](https://github.com/Emjaay20/AetherHost/pull/50), commit
`3ae5e9eaf0d50b3daac5101137955cf481e3f03c`. Code checks passed. The initial automatic
deployment refused the modified host checkout; those local edits were archived
and removed, the source fast-forwarded, and the agent reconciled from clean merged
source without replacing unrelated platform services. The application was still
on released commit `24df972` at that verification point.
