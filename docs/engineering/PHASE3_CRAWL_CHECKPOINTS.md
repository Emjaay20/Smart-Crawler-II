# Phase 3C — Durable Crawl Checkpoints and Explicit Replay

**Date:** 2026-11-14  
**Branch:** `phase3/crawl-checkpoints-manual-resume-20261114`  
**Parent:** Phase 3B, draft PR #7  
**Status:** Draft implementation; CI and staging review required.

## Purpose and safety guarantee

The scheduler commits a versioned, authenticated-worker-only checkpoint after each fully settled breadth-first crawl batch, recording the completed page snapshots, ordered frontier, and visited URLs. It writes checkpoint data into the existing SQLite database with a transaction and retains the original crawl job record.

**An interrupted running job is never automatically replayed.** The normal restart handler marks it failed using an explicit `restart_interrupted` code when checkpoint capture and manual replay are both enabled. Automatic pending-job recovery remains separately disabled unless its own flag is set. An operator may later request a *new* job from its last committed checkpoint, explicitly acknowledging that HTTP requests in the interrupted, uncommitted batch may have reached the target and could be repeated. The replacement has a new job ID; the original failed job remains unchanged. This is **at-least-once request behavior**, not exactly-once execution.

## Opt-in flags

Both are **off by default**:

- `SMARTCRAWL_ENABLE_CRAWL_CHECKPOINTS=true`: save a checkpoint after completed BFS batches for local, proxy-free crawl jobs.
- `SMARTCRAWL_ENABLE_CHECKPOINT_RESUME=true`: allow explicit administrative replay from checkpoint. Requires the first flag and an operator-configured `SMARTCRAWL_ADMIN_TOKEN`.

Keep the Phase 3B `SMARTCRAWL_ENABLE_PENDING_RECOVERY` policy separate. It is **not required** for explicit checkpoint replay. With checkpoint capture/resume enabled and pending recovery off, startup fails stale jobs with an explicit interruption code but does not auto-replay them. Its automatic resume path only applies to never-started `pending` jobs.

Only enable this design on an exclusive single-instance SQLite deployment. Multiple live workers sharing one file need a proper worker lease, heartbeat and fencing protocol before enabling restart behavior.

## Administrator endpoint

`POST /v1/admin/jobs/:id/resume`

Requires `Authorization: Bearer <ADMIN_TOKEN>` and JSON:

```json
{ "acknowledgePossibleRefetch": true }
```

- `201`: new child job created and dispatched from last saved checkpoint.
- `200`: idempotent replay request; previously created child job ID returned, without launching a duplicate.
- `400`: the required explicit acknowledgment is absent.
- `401`: incorrect admin token.
- `403`: checkpoints/manual resume disabled.
- `409`: original job is not an interrupted, eligible local crawl with a valid checkpoint.

The endpoint does not accept client-supplied page/frontier content and does not expose the raw checkpoint. Resume source ID is stored in internal metadata and hidden from public job JSON.

This operator-only endpoint is **not** an end-user or guest self-service feature.

## Persistence and validation

- `crawl_checkpoints` is keyed by job ID. Each write is transactionally conditioned on a running (`crawling`) job.
- The checkpoint is versioned (v1) and includes the ordered frontier (`queue`), attempted URLs (`seen`), result pages and a SHA-256 fingerprint of the normalized request parameters.
- On replay, the request fingerprint must match. All queued/visited URLs must be canonical and on the original origin, and array sizes are bounded.
- Checkpoint JSON is capped at **8 MiB**, and the frontier remains capped at **500 URLs**.
- `crawl_resume_links` enforces one derived child ID per interrupted parent, making repeated admin requests idempotent.
- The parent must have `restart_interrupted` error status, versioned `local` crawl metadata, and must be proxy-free.
- Checkpoints include scraped content and URLs: back up and protect SQLite using the same data-retention, access-control and secret-rotation policies as job results.

## Exact crash boundaries

1. **Before a batch checkpoint commits:** the prior checkpoint remains. Some new requests may have run, but their outputs are not committed, so manual replay may refetch them.
2. **After a batch checkpoint commits:** the new frontier and completed page set are durable. Replay skips the pages in that checkpoint.
3. **After the final checkpoint but before job completion:** manual replay can complete from the checkpoint without re-requesting any page.
4. **While a job is pending and not yet claimed:** Phase 3B's separately opt-in recovery policy may safely claim it, subject to its attempt cap.

No transaction spans a network request. Exactly-once request delivery and exactly-once external side effects are not promised.

## Test evidence required

- Resume from a committed batch without refetching completed pages.
- Reject incompatible fingerprints, corrupt, duplicate, or cross-origin queue data.
- Admin-only, explicit replay acknowledgement, and idempotent repeated requests.
- A real child process uses a synthetic HTTP fixture, commits one SQLite WAL checkpoint, and hangs during the next batch. The parent sends **SIGKILL**, opens the database, classifies the running job as interrupted, explicitly creates a new job and resumes from the saved frontier.
- Full TypeScript, Vitest, synthetic crawl benchmark, UI build and Docker smoke.
- **Still required before production:** process-crash test in an isolated container; SQLite WAL backup/restore, realistic content sizes, browser egress isolation and transport defenses; resource/retention impact; global worker admission and graceful shutdown.

## Portfolio claims

Safe claim after CI: *Implemented versioned, transactional BFS checkpoints and explicit idempotent resume for interrupted crawls, with a real child-process SIGKILL regression test.*

Do not claim exactly-once crawling, replay without duplicate network requests, production high availability, or distributed workers.
