# SmartCrawl — Web Extraction Platform Reliability Case Study

**Portfolio engineering write-up**  
**Repository:** [Emjaay20/Smart-Crawler-II](https://github.com/Emjaay20/Smart-Crawler-II)  
**Status:** Tested draft engineering work; not an approved production release.

## Problem

The original SmartCrawl project already offered HTTP-first extraction, Readability-based content cleanup, optional Playwright rendering, a TypeScript SDK, API keys, SQLite jobs and HTTP endpoints. Engineering review identified weaknesses in outbound network trust, guest job ownership, browser scheduling, sequential crawling, stalled SDK calls and restart ambiguity.

The goal was to improve correctness, resource predictability, operational transparency and developer experience without overstating the implications of passing unit tests.

## Engineering changes with review evidence

**1. Outbound security and tenant access** — [PR #2](https://github.com/Emjaay20/Smart-Crawler-II/pull/2) and [PR #3](https://github.com/Emjaay20/Smart-Crawler-II/pull/3). Moved from hostname-string validation toward DNS-aware public-destination checks and pinned direct HTTP sockets. Added per-redirect validation, proxy gateway restrictions, opaque guest session ownership, quota-race protection and secret redaction. [PR #4](https://github.com/Emjaay20/Smart-Crawler-II/pull/4) exercised the combined security behaviors in CI.

**2. Browser lifecycle and resource bounds** — [PR #5](https://github.com/Emjaay20/Smart-Crawler-II/pull/5). Added configurable task admission (default one concurrent browser task), a bounded queue, isolated Playwright contexts, shared browser launch, explicit saturation errors, launch-failure retry and tests for avoiding premature shutdown of in-flight contexts.

**3. Concurrent crawling with deterministic order** — [PR #6](https://github.com/Emjaay20/Smart-Crawler-II/pull/6). Introduced bounded breadth-first batches (concurrency 1–4), request-start pacing, strict origin checks including ports, failure resilience and a 500-URL discovery frontier cap. Synthetic 16-page benchmark means at concurrency 1, 2 and 4 were 1120.65, 688.76 and 533.96ms respectively; that is a **fixture-only** observation, not production performance.

**4. Durable job behavior** — [PR #7](https://github.com/Emjaay20/Smart-Crawler-II/pull/7) and [PR #8](https://github.com/Emjaay20/Smart-Crawler-II/pull/8). Added bounded restart eligibility for unclaimed jobs with atomic SQL claims. Introduced versioned SQLite crawl checkpoints and an administrator-approved, idempotent resume action from the last committed batch. A CI test actually SIGKILLed a separate worker process and verified checkpoint persistence and resumption. The design never claims exactly-once external requests.

**5. Developer experience** — [PR #9](https://github.com/Emjaay20/Smart-Crawler-II/pull/9). Added SDK network deadlines, polling budgets, typed errors and explicit redirect refusal.

**6. Enterprise security foundation** — [PR #10](https://github.com/Emjaay20/Smart-Crawler-II/pull/10). Ensured key-store configuration remains authentication-enforcing even without an admin token. Introduced a limited SQLite event trail for selected sensitive key/admin mutations. It is not a compliance-grade audit trail.

## Method

Each change was developed in a dedicated review branch and validated with TypeScript, automated regression tests, a UI build and Docker smoke tests through GitHub Actions. The latest stacked branch is intended for **combined compatibility review** before any selective merge or release.

## What the evidence does *not* establish

- No production deployment of these branches.
- No real-browser crash or high-volume network benchmark, and no independent penetration test.
- No guarantee of distributed worker exactly-once semantics.
- No enterprise SAML/SCIM, immutable compliance audit, or formal certification.
- No accepted Firecrawl OSS contribution. The investigation of [Firecrawl Issue #5717](https://github.com/firecrawl/firecrawl/issues/5717) is documented, but the reported JSON extraction anomaly has not been locally reproduced.

## Mapping to potential Firecrawl roles

**Product Engineer — Scrape:** Strongest direct match through extraction quality concerns, API reliability, safe output handling, SDK ergonomics, reproducible tests and developer documentation. Show a controlled demo and specific PR review history.

**Web Automation Engineer:** Demonstrates a starting point in Playwright lifecycle management, bounded browser contexts and recoverability. A real Chromium staging benchmark, CDP-level diagnostics and networking investigations are still needed before claiming advanced browser fleet experience.

**Enterprise Solutions Engineer:** Supports discussions of tenancy, API keys, operational reliability, deployment and incident readiness. Do not position the current audit as enterprise compliance or established IAM integration.

## Reproduction links

- [Synthetic performance measurements](../benchmarks/PHASE3_SYNTHETIC_RESULTS.md)
- [Security staging review](../engineering/PHASE1_STAGING_REVIEW.md)
- [Browser lifecycle design](../engineering/PHASE2_BROWSER_RELIABILITY.md)
- [Crawl scheduler](../engineering/PHASE3_CRAWL_SCHEDULER.md)
- [Checkpoint architecture](../engineering/PHASE3_CRAWL_CHECKPOINTS.md)
- [SDK timeouts](../engineering/PHASE4_SDK_DEADLINES.md)
- [Audit boundaries](../engineering/PHASE5_AUTH_AUDIT.md)
- [Firecrawl upstream investigation](../engineering/FIRECRAWL_5717_INVESTIGATION.md)

## Next milestone

Obtain code review, stage behind a reversible deployment, run controlled live socket/browser tests, then merge approved PRs in dependency order. Separately reproduce Firecrawl Issue #5717 in its upstream harness and submit a narrow contribution only if a real failure and suitable correction are established.
