# Phase 3 — Crash-Safe Pending Crawl Recovery (Tranche 2)

**Date:** 2026-11-14  
**Branch:** \`phase3/durable-pending-recovery-20261114\`  
**Base:** \`phase3/bounded-crawl-20261114\` (PR #6).  
**Status:** Draft implementation, requires CI, staging and review.

## Safe guarantee

Only **never-started pending crawl jobs** with explicit versioned replay metadata can be resumed after an unclean restart. An in-flight job (\`status=crawling\`) is treated as **ambiguous** and is marked failed, because its HTTP requests may already have been performed.

This is **durable pending admission**, not exact-once network execution, durable in-flight continuation or page-checkpoint recovery.

## Feature flag and deployment preconditions

\`\`\`bash
SMARTCRAWL_ENABLE_PENDING_RECOVERY=true
\`\`\`

This flag is **off by default**. When disabled, the original \`recoverStaleJobs()\` behavior is retained: any pending/running jobs found on startup are failed.

When enabled, the application must use an **exclusive, single-writer SQLite database and one active SmartCrawl instance**. Do not enable it against a SQLite file shared by multiple live servers; startup recovery could misidentify another process's in-flight work as stale. This release does not implement a distributed leadership lease or fencing token.

The feature must be trialed against a backed-up, sanitized staging DB before any production approval.

## Replay metadata and eligibility

New \`/v1/crawl\` jobs receive these internal options **only if no per-request proxy is requested**:

\`\`\`json
{
  "kind": "crawl",
  "provider": "local",
  "recoveryVersion": 1,
  "pendingRecoveryAttempts": 0
}
\`\`\`

Ordinary crawl request options, URL and owner identity remain in the same persisted job. The job store excludes proxy credentials from persisted options.

The recovery process:

1. Reads pending and crawling rows at application startup inside one SQLite transaction.
2. Leaves an eligible \`pending\` crawl pending, increments \`pendingRecoveryAttempts\`, and appends a recovery log.
3. Marks \`crawling\`, untagged, incompatible, or attempt-exhausted rows \`failed\` with an explicit reason.
4. Queues eligible pending crawls through the same in-process admission queue as normal jobs.
5. Revalidates the stored URL and replay manifest. Incompatible manifests fail before any network work.
6. Atomically claims each pending job with an update conditional on \`status='pending'\`, preserving the original job ID.
7. Writes completion or failure only from \`status='crawling'\`. Late terminal writes after a terminal transition do not overwrite the result.

After **three** restart-based recovery opportunities, a job that has still not started fails rather than looping forever.

The feature does not retry failed jobs automatically, so errors cannot cause unbounded repeated execution.

## Security and data boundaries

- Only local crawl jobs are eligible. Previously stored proxy URLs are not replayed because credentials must not be retained.
- A pending job retains its original owner metadata and quota consumption; recovery does not mint new API keys or consume a second quota token.
- Cross-user job reads remain governed by the existing API key or guest-session authorization.
- The public job JSON omits internal \`recoveryVersion\` and \`pendingRecoveryAttempts\`.
- Queued work is reconstructed from validated persisted options, not from an arbitrary client-supplied restart command.
- Startup recovery should run only after the database backup has been secured and after deployment/ingress policy has been reviewed.

## Known limitations

- **No checkpointed page resume.** If a crawl had started before crashing, it is marked failed, even if some pages had been fetched. Logs may record partial progress but the batch cannot be restarted automatically without potential duplicate external requests.
- There is no distributed claim lease/heartbeat for multiple live service instances.
- The pending job admission queue is still in-process after startup. A new crash before a recovered job starts leaves it pending again, up to the stated restart limit.
- The recovery query schedules up to 250 eligible pending crawls per startup. Operators should keep the backlog within that bound. A larger backlog is an operational exception requiring explicit handling; do not claim complete fleet-scale backlog recovery.
- Graceful shutdown must drain all application jobs; browser-only draining is not a substitute. A future change should add an app-level drain and stop accepting new work before closing storage.
- The network egress and browser isolation work from Phase 1 remains independently reviewable and not yet staged. This feature does not weaken or replace those controls.
- External HTTP requests, logging, provider costs, webhooks, and other side effects are not exactly-once despite atomic database claiming. The strongest guarantee here is **one successful DB claim** per pending job.

## Verification checklist

- A versioned pending crawl survives process restart and resumes using the same job ID and options.
- Already-running and legacy pending jobs fail visibly, without replay.
- A second process cannot claim the same pending ID.
- Terminal jobs cannot be overwritten by late claimed completion/failure.
- A malformed or unsafe replay manifest fails before any crawler callback executes.
- Repeated recovery attempts are capped at three.
- The feature is disabled by default and the old startup policy remains available.
- CI runs TypeScript, Vitest, build, and Docker smoke.
- Staging must exercise an abrupt process kill at **pending** and **crawling** states against an owned fixture website, with SQLite WAL backup/restore tested.

## Follow-up design for true durable in-flight recovery

Before implementing in-flight continuation, design per-page durable checkpoint records and a worker lease/fencing protocol. Retrying may re-issue GET requests, so define idempotency by URL, stored output hash and intended side effects. Require bounded attempts, stable crawl frontier, per-domain politeness on resume, cancellation, fair global worker admission, and externally isolated network egress.

## Portfolio claim

A defensible statement is: *Added opt-in SQLite-backed recovery of explicitly eligible, unclaimed crawler jobs with atomic claiming, bounded restart attempts and regression tests.* Do not claim production-ready crash recovery or exactly-once scraping until staging and real-failure testing confirm it.
