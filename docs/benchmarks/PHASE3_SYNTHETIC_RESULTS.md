# Phase 3 — Synthetic Concurrent Crawling Benchmark

**Captured:** 2026-11-14  
**CI run:** [GitHub Actions #43595369462](https://github.com/Emjaay20/Smart-Crawler-II/actions/runs/43595369462)  
**Source commit measured:** `057be96b95da09905096ba642068dd7f79d0aaa3`  
**Command:** `npm run bench:crawl` (from `scripts/benchmark-crawl.ts`)  
**Environment:** GitHub Actions Ubuntu runner, Node.js `v22.23.4`

## Test methodology

- A **synthetic in-memory HTTP fixture** returns controlled, extractable HTML. No real websites or outbound internet requests were measured.
- Each trial crawls a seed page and 15 discovered pages (16 pages total). Every fixture HTML response has a programmed 45ms delay.
- Compare per-crawl concurrency settings 1, 2 and 4, with `crawlDelayMs: 0` to isolate scheduler behavior.
- Run three trials per concurrency setting; record individual end-to-end durations, calculated mean, sample p50/p95 and observed peak concurrent fixture fetches.
- Every trial asserted exactly 16 successfully crawled pages and a peak number of in-flight fixture requests no greater than the configured setting.

## Measured results

| Concurrency | Mean (ms) | Sample p50 (ms) | Sample p95 (ms) | Peak simultaneous fixture requests |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1120.65 | 1046.25 | 1271.18 | 1 |
| 2 | 688.76 | 692.49 | 702.72 | 2 |
| 4 | 533.96 | 522.19 | 567.86 | 4 |

**Raw trial durations (ms)**

- Concurrency 1: `1271.18`, `1044.51`, `1046.25`
- Concurrency 2: `702.72`, `671.08`, `692.49`
- Concurrency 4: `511.82`, `567.86`, `522.19`

Relative to the concurrency-1 fixture, observed mean wall-clock time was approximately **38.5% lower** at concurrency 2 and **52.3% lower** at concurrency 4. Equivalently, the synthetic fixture completed roughly **1.63×** and **2.10×** as fast, respectively.

## Interpretation and limits

These are **three-run, environment-specific synthetic measurements** of one known fixture shape. Sample p95 with three observations is unstable and must not be presented as a production SLO or population percentile.

The benchmark intentionally disables request-start spacing and contains no real network latency, DNS/rebinding, remote robots.txt timing, browser-rendering workload, anti-bot handling, cross-process contention, durable job recovery or realistic large HTML parsing. Real-world throughput may be much slower and sites may require significantly larger crawl delays.

This is evidence that bounded parallelism improves throughput on a controlled fixture without violating the configured page-task limits. It is **not** evidence of Firecrawl-comparable scale, real-user load or a production deployment.

## Reproduce

```bash
npm ci
npm run bench:crawl
```

Review `scripts/benchmark-crawl.ts` and the GitHub Actions logs for actual fixture construction and output. Record future benchmark comparisons with their commit SHA, runtime versions, hardware and resource limits rather than comparing unstated environments.

## Next measurements

In an approved, network-isolated staging environment with owned test sites, add 50+ repetitions across a content-size matrix, realistic request delays, robots rules, redirect chains and controlled errors. Collect total wall time, p50/p95/p99 by page, memory/CPU use, successes, failure categories and global request-rate policy compliance. No staging results exist yet.
