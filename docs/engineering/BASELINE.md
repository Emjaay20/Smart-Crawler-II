# SmartCrawl Engineering Baseline

**Date:** 2026-11-14  
**Source baseline:** [`fa157b3e37de24f7e0df5c989571c632a0a7f955`](https://github.com/Emjaay20/Smart-Crawler-II/commit/fa157b3e37de24f7e0df5c989571c632a0a7f955)  
**Purpose:** Document the current engineering foundation and establish measurable, reviewable enhancement work for the scraping product, browser automation, and platform reliability.

## Verification and scope

This is a GitHub source inspection and CI-evidence review, not a penetration test or local performance benchmark.

- The repository contains **21 Vitest test files** covering extraction, scraping, URL validation, accounts, API keys, guest access, browser recycling, jobs, proxies, API routes, clients, and other subsystems.
- [CI & Container Smoke run](https://github.com/Emjaay20/Smart-Crawler-II/actions/runs/42186449256) passed on the baseline commit (2026-11-06). Vitest, TypeScript/UI build, Docker build and container smoke steps succeeded.
- [Production Smoke & Slack Digest run](https://github.com/Emjaay20/Smart-Crawler-II/actions/runs/43557844262) succeeded on the baseline commit (2026-11-14). The workflow checks health/readiness/providers; an actual scrape is conditional on a configured API key, so a successful run alone **does not verify scrape execution**.
- Local test execution was **not performed** during this assessment because this runtime could not clone the repository. CI evidence above is not represented as a fresh local test run.

## Existing product and implementation

| Subsystem | Verified source | Present behavior |
| --- | --- | --- |
| Web extraction | `src/scrape.ts`, `src/extract.ts` | HTTP-first extraction, content classification, retry logic and optional browser/provider fallback |
| Browser rendering | `src/browser.ts` | Playwright context isolation and browser recycling; rendering is serialized within this process |
| Crawl and map | `src/crawl.ts` | Same-origin discovery, bounded depth/page counts, sequential per-site crawling, path filters |
| Job persistence | `src/jobs.ts` | SQLite WAL job persistence and explicit failure of stale jobs following restart |
| API and auth | `src/app.ts`, `src/keys.ts`, `src/accounts.ts`, `src/oidc.ts` | API keys, quotas, guest access, account login, scoped job reads and administrative endpoints |
| Developer experience | `src/client.ts`, `src/cli.ts`, `openapi.yaml` | SDK, CLI, typed API errors and reference schema |
| Observability | `src/metrics.ts`, `src/alerts.ts` | Error categories, latency percentiles, queue gauges and operational alert reports |
| Verification | `tests/`, `.github/workflows/` | Test suites, CI/container smoke, deployment image and periodic operational checks |

## Work priorities

### Priority 0 — Transport security and safe network boundaries

Review all user-driven outbound network paths against a consistent destination policy: direct HTTP, redirects, robots/sitemaps, proxies and browser navigation. Add local, controlled regression tests and repair any gaps before expanding concurrency.

**Done when:** unsafe destinations and redirect chains are denied *before connecting*, connection-level policy is verified in tests, and ordinary public scraping remains functional.

### Priority 1 — API identity, secret handling and multi-tenant contracts

Review trusted proxy handling, guest authorization, sensitive configuration retention, scoped job access, API-key lifecycle and quota concurrency. Keep specific unpatched observations in a private review until fixes are complete.

**Done when:** request identity is trustworthy, secrets are not leaked in persisted/public job data, unauthorized access is denied, and quota tests show the intended semantics.

### Priority 2 — Reliable concurrency and restart behavior

Move toward bounded per-crawl/per-browser concurrency with politeness and clear job cancellation/recovery guarantees. Preserve the low-memory HTTP-first hosting mode.

**Done when:** load and process-failure tests establish that capacity limits are respected and job states are deterministic.

### Priority 3 — Developer experience and runtime observability

Improve SDK polling/deadlines, browser lifecycle tests, explainable errors, runtime metrics, and clean-install onboarding.

**Done when:** SDK and API tests pass, a first-time-user walkthrough works, and core runtime/quality metrics are reproducible.

### Priority 4 — Benchmarks and case studies

Produce fixed-fixture extraction-quality tests and load benchmarks (throughput, success rate, p50/p95/p99, memory, error categories) with recorded test setup, baseline results and changes.

**Done when:** results are independently reproducible and linked to the exact source revision.

## Engineering evidence standard

Each implementation change should include: **problem → minimal reproduction → root-cause evidence → alternatives → code → regression tests → measured result → limitations**.

Document CI commands and outcomes without inventing test counts, uptime, customers, speedups or production-scale metrics.

## Suggested first implementation branch

Start with a focused **safe-outbound-transport** design and tests. Audit all relevant network paths before selecting an implementation approach; prefer preserving existing API behavior over adding features. Maintain security-sensitive investigation notes privately until issues are mitigated.

No product code, infrastructure configuration, or deployment behavior was changed in this baseline documentation update.
