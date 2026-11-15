# Opt-in persistent data for GitHub workloads

`persistent-app-data.patch` changes Aetherhost's Go provisioner, not the crawler.
Apply it from the Aetherhost repository root with `git apply --check` followed by
`git apply`. The patch adds two files and changes only the GitHub Compose renderer.
It preserves unrelated server changes.

Set `AETHER_PERSIST_APP_DATA=true` in the application's runtime configuration.
The provisioner then mounts a named volume at `/app/data`. Its name is
`aetherhost-data-` followed by the SHA-256 of the immutable application ID, so
renaming the app does not change its data location and apps do not share volumes.
No host path or tenant-selected mount target is accepted. Other apps remain
unchanged unless they opt in. Missing application IDs do not enable the mount.

Run `go test ./...` in `apps/agent-go` before building/replacing the agent.
The added regression verifies opt-in behavior, fixed target, stable rename behavior
and separate identities. The full Go agent test suite passed on 2026-11-15.

## Live rollout

- The previous agent image was retained as
  `aetherhost-agent:before-smartcrawl-persistence-20261115`.
- The previous provisioner source was retained at
  `/root/smartcrawl-provisioner-before-persistence.go`.
- The patched agent image is
  `sha256:3c063886e4dde5c53a7ac8b7a7bf927c8e27a75610441a63a64d95a55e4b1874`.
- The app was stopped before copying its current database/WAL files. The exact
  stopped-container data is preserved under
  `/root/smartcrawl-backups/pre-volume-migration-20261115/data`.
- Its durable volume is
  `aetherhost-data-0861ebe1c7af3e44bce7542ab3659a46d6d3e4ef89f15d96924f6b35349f6eb8`.
- Files were copied as root then assigned to UID/GID 1000; the data directory is
  mode 0700. The database was not replaced with the older host-directory copy.
- `AETHER_PERSIST_APP_DATA=true` was saved in the control plane with no immediate
  redeploy, then the patched agent performed the application redeployment.
- A second full API-triggered redeploy preserved a private temporary marker in
  `/app/data`. SQLite integrity remained `ok`, and the marker was removed after
  verification. Health/readiness and authenticated/unauthenticated admin checks
  passed over the public HTTPS origin.

The patch was merged through [Aetherhost PR #50](https://github.com/Emjaay20/AetherHost/pull/50)
as commit `3ae5e9eaf0d50b3daac5101137955cf481e3f03c`. All code checks passed.
The initial automatic deployment correctly refused the modified host checkout.
The local patch was archived and reversed, the host fast-forwarded to the merged
source, and the agent was rebuilt/reconciled from that clean checkout. Thus the
running fix now comes from the upstream repository rather than an untracked edit.
The patch file is retained as a historical rollout artifact, not something to
reapply over the merged source. Retain the named volume and backups through any platform rollback.
Do not use `docker compose down -v` or delete the volume as a rollback step.
