# Phase 2 — Browser Reliability and Bounded Concurrency

**Date:** 2026-11-14  
**Implementation branch:** `phase2/browser-bounded-recovery-20261114`  
**Dependency:** `integration/p1-security-combined-20261114` (Phase 1 branch). Draft PR #5 targets `main` only to activate the existing GitHub Actions pull-request CI filter; the reviewable Phase 2-only diff is the comparison against the integration branch. **Do not merge Phase 2 independently of approved Phase 1 controls.**  
**Status:** Draft feature, mock-backed tests; CI and external Playwright validation required.

## Goal

Allow controlled concurrent browser rendering without unlimited Chromium contexts, lost queue work or multiple simultaneous browser-launch attempts. Recover from browser failures and drain in-flight requests on shutdown.

## Design and scope

- `src/browser-scheduler.ts` runs no more than a configured number of browser tasks at once, applies a maximum pending queue, returns a clear capacity error for excess work, and drains accepted requests on shutdown.
- `src/browser.ts` shares one Chromium launch promise among concurrent requests, creates separate Playwright contexts per task and retires browser processes after failures or the existing 20-successful-page recycle threshold.
- Retiring a process doesn't close it while other tasks still hold active contexts. New requests may use a fresh instance while existing tasks finish on the old instance.
- The browser is still protected by the Phase 1 external egress-isolation requirement: `SMARTCRAWL_BROWSER_EGRESS_ISOLATED=true` is only an operator assertion, **not a firewall**. Run untrusted browser navigation only in an actually isolated network.
- Per-domain politeness and crawl job scheduling are Phase 3 work; browser context limits alone do **not** guarantee fair crawl scheduling, durable queue recovery, or safe automation against anti-bot-protected third-party services.

## Configuration

| Environment setting | Default | Allowed effective range | Meaning |
| --- | --- | --- | --- |
| `SMARTCRAWL_BROWSER_CONCURRENCY` | 1 | 1–4 | Maximum simultaneous browser-render tasks within this process |
| `SMARTCRAWL_BROWSER_MAX_PENDING` | 24 | 1–128 | Pending render tasks before admission rejects additional work |
| `SMARTCRAWL_BROWSER_EGRESS_ISOLATED` | Off | Explicit true required | Operator confirms external network egress isolation exists |

Invalid values fall back to defaults. Exceeding the cap clamps to the maximum. Default concurrency **1** preserves the resource usage of the original serialized browser path until an operator selects a larger value.

A capacity rejection is classified as `provider_unavailable` and should be presented transparently to API clients. Any managed retry must be bounded and avoid hammering a saturated worker.

## Verification requirements

- Unit tests: bounded concurrency, task ordering, queue capacity, recovery after a rejected task, shutdown draining, and configuration ranges.
- Playwright mock-based tests: one browser launch for concurrent contexts, isolated contexts, restart after simulated crash, backpressure, and shutdown with a task active.
- CI: full Vitest, TypeScript compilation, UI build and Docker smoke.
- **Outstanding staging work**: real Playwright/Chromium crash injection, memory/CPU measurements, browser-process count, timeouts, network isolation and load/soak tests. CI mocks alone cannot establish browser stability or production throughput.
- Evaluate latency and peak memory at concurrency 1, 2 and 4 using authorized fixture sites. Record raw measurements and machine/container limits.

## Known tradeoffs and limitations

- This queue is in-process and **not persistent**; process restart still cancels pending browser work. Durable job recovery belongs to Phase 3.
- Multi-process deployments independently enforce these limits, so total concurrency across replicas must be controlled by infrastructure quotas.
- Long-running pages may occupy slots until navigation/evaluation timeouts are reached; cancellation and per-task total deadlines are follow-up work.
- A fatal browser failure may affect other contexts using the same instance. Those failures should be observed and re-queued only when the higher-level job retry policy deems it safe.
- Existing cookies and session storage are not shared across browser contexts; each render is independent.
- Error handling still requires defense-in-depth redaction for secrets originating in browser automation exceptions.

## Application evidence

This work demonstrates a **testable bounded browser scheduler and lifecycle management**. It does not yet demonstrate high-volume throughput, real Chromium resilience under load, advanced fingerprinting, CDP expertise, or production-scale browser fleet management. Publish a benchmark case study only after real measurements.
