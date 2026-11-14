# Phase 6 — Performance Evidence and Release Verification

**Date:** 2026-11-14  
**Scope:** Smart-Crawler-II stacked feature candidate; no production release authorized.

## Instrumentation verified in source

The existing `src/metrics.ts` provides scrape counts, error rate/breakdown, engine counts, duration mean and p50/p95/p99, crawl-page count, retry count, extracted-token total, worker activity and queue depth. This is *application-level telemetry*. It does not yet establish complete event-loop delay, GC, browser-process RSS, network-level egress or multi-replica observability.

## Reproducible controlled benchmark

The `npm run bench:crawl` script emits raw synthetic measurement JSON from a 16-page in-memory HTTP fixture with a programmed 45ms page-response delay and three trials at each concurrency. Source data: [PHASE3_SYNTHETIC_RESULTS.md](../benchmarks/PHASE3_SYNTHETIC_RESULTS.md); [GitHub Actions #43595369462](https://github.com/Emjaay20/Smart-Crawler-II/actions/runs/43595369462).

| Configured per-crawl concurrency | Mean completion (ms) | Peak observed concurrent fixture requests |
| ---: | ---: | ---: |
| 1 | 1120.65 | 1 |
| 2 | 688.76 | 2 |
| 4 | 533.96 | 4 |

At concurrency 4, the synthetic fixture mean was ~52.3% lower than at 1 (roughly 2.10× throughput on this *single fixture*). These are not live website performance, production service-level objectives, browser resilience results, or statements about Firecrawl.

## Test and architecture provenance

- Phase 1: DNS-pinned outbound requests, manually validated redirects, guest-session isolation, redacted proxy errors, trusted gateway restriction.
- Phase 2: bounded browser task queue, shared browser launch, simulated crash recovery and lifecycle tests.
- Phase 3A: bounded BFS concurrency and start-time spacing, plus fixture performance tests.
- Phase 3B: SQLite persisted pending recovery with bounded attempts and atomic claims.
- Phase 3C: versioned batch checkpoints, explicit admin-only at-least-once replay and real child-process SIGKILL regression.
- Phase 4: SDK network time budgets, bounded polling and typed timeout errors.
- Phase 5: fail-closed key store authentication and minimal credential-free administrative audit.

## Release evidence still missing

- Review the individual security PRs and the combined diff, including authentication compatibility and credential handling.
- Real DNS-rebinding/socket-level egress tests, firewall enforcement and browser/proxy isolation on staging.
- Real Chromium crash and memory/CPU experiments at 1, 2 and 4 contexts.
- Staging database backup, WAL restore, process-kill in container, recovery and rollback.
- At least 50+ independent experiments using approved fixture sites with realistic content and rate limits.
- A true production representative load test, long-running soak test, multi-process fairness and rate admission review.
- Observability and retention design for audit events and checkpoint content.
- Approval to merge and deploy, followed by real post-deployment monitoring.

## Evidence discipline

CI passing means the checked-in code compiled and passed automated scenarios. It is **not** proof of universal security, production correctness, regulatory compliance, high availability or real site throughput. Record a source SHA and run URL for every benchmark or deployment claim.
