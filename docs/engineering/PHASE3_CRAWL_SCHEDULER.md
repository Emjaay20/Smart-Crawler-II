# Phase 3 — Bounded Crawl Scheduling (Tranche 1)

**Date:** 2026-11-14  
**Feature branch:** `phase3/bounded-crawl-20261114`  
**Base:** Phase 2 draft commit `10284a464e18a11607f154597cb9447145e7db9f`  
**Status:** Draft implementation. The Phase 1 and 2 parents are not merged or deployed.

## What was wrong

`crawlSite()` fetched candidate pages one at a time, even where per-site request delays could be respected alongside bounded concurrency. The existing `DomainPolitenessLimiter.acquire()` has a mutable last-access timestamp and should **not** be awaited concurrently for the same origin without a serialization mechanism. `sameOrigin()` also compared protocol and hostname but not origin port.

## Design

1. The crawler starts with the seed URL. Successful extraction discovers child URLs.
2. Child pages run in breadth-first **batches** of at most `concurrency` tasks and at most the remaining number of successful page slots. The default is 1 and the hard maximum is 4.
3. Each batch fully settles before appending new discovered links. This preserves deterministic BFS output order even if requests finish in a different order.
4. A per-crawl `PerOriginStartGate` serializes the *start reservations* for requests to the same origin, but the network work itself can overlap. The default minimum request-start spacing is 250ms; callers may set `crawlDelayMs` to 0–60,000ms.
5. URLs are canonicalized before deduplication, paths are filtered, and exact origins (including port) must match.
6. Failure of the seed request rejects the crawl. An unsuccessful non-seed page does not consume a successful-page slot; the crawler continues to other candidates.
7. On-page callbacks run in deterministic result order after the batch joins.

**API:** `POST /v1/crawl` and `POST /v1/map` accept `concurrency` as a validated integer in 1–4. The application default is 1 unless `SMARTCRAWL_CRAWL_CONCURRENCY` is configured. `limit` remains capped at 20 crawl pages.

## What this does *not* solve

- The queue lives in memory and is not durable across process restarts. The SQLite job store still marks stale pending/running jobs as failed. **Do not claim restart-safe crawling.**
- Requests to robots.txt may happen outside the per-page request-start reservation and robots caches are not guaranteed to coalesce every simultaneous cache miss. This must be checked before making strict global politeness claims.
- The limiter is serialized per `crawlSite()` call; separate parallel crawl jobs and separate server replicas can still request the same origin simultaneously. Global fairness, per-domain quotas across processes and distributed rate limiting are future work.
- Limited batches can leave some concurrency idle while waiting for slow pages; the tradeoff is simpler, deterministic discovery and strict success-page limits.
- Each global API worker can execute an independent crawl. The total number of simultaneously fetched pages can exceed an individual crawl's `concurrency` setting. Enforce global resource budgets at the deployment level.
- This implementation does not alter the Phase 1 network egress requirements or automatically make Playwright rendering safe.

## Verification plan

- Unit tests demonstrate maximum two active child pages with a third link not scheduled past the limit.
- Tests demonstrate BFS order independent of completion timing and continued crawling after a failed child page.
- Exact origin tests reject same-host alternate-port URLs.
- Politeness tests validate minimum request-start spacing for the controlled single-crawl fixture.
- API tests validate allowed concurrency settings and reject invalid values before creating jobs.
- Existing map/crawl tests and all other suites must pass.
- Stage and benchmark with **owned fixture sites**, recording concurrency, number of pages, total time, peak work, CPU, memory, p50/p95 and extraction failures. Unit tests do not substitute for real network/load measurements.

## Upcoming tranche — Durable restart recovery

Before resuming jobs, define a trusted replay manifest with persistable options, attempt limits and an idempotent completion protocol. Ensure the scheduler can reconstruct jobs from safe metadata (never persisted proxy secrets), distinguish pending from partially completed work, handle interrupted in-flight pages without corrupting results, and provide explicit cancellation/dead-letter semantics.

**Do not simply reset `status='crawling'` to `pending` at startup.** The current synchronous SQLite store does not by itself establish exclusive worker leases, deduplicated page effects, or replay-safe side effects.

## Evidence for Firecrawl application

This PR, regression tests, deterministic scheduler design, documented resource limits and a subsequent controlled benchmark will support a Product Engineer – Scrape and Backend Infrastructure engineering case study. Avoid claims of production-scale concurrency or crash recovery until independently tested.
