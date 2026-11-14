# HTTP Egress Security — First Implementation Tranche

**Baseline revision:** fa157b3e37de24f7e0df5c989571c632a0a7f955  
**Change branch:** security/p1-safe-http-egress-20261114  
**Status:** Draft implementation; CI and real-world validation must be confirmed.

## Goal

Require public-network destinations for HTTP-first scraping, robots.txt and sitemap fetches. Validate each redirect *before following it*. Prevent DNS time-of-check/time-of-use for direct requests by pinning Undici sockets to validated DNS answers.

## Changes

- src/egress.ts implements public-address classification, DNS resolution, per-request socket lookup pinning, manual redirect limits, bounded response bodies and a fail-closed proxy policy.
- src/scrape.ts sends robots.txt requests and HTTP extraction through the shared safe fetch wrapper.
- src/crawl.ts routes sitemap discovery through the same fetch policy.
- src/browser.ts refuses browser navigation unless the operator has enforced network-level egress isolation and explicitly sets SMARTCRAWL_BROWSER_EGRESS_ISOLATED=true.
- Third-party proxies are denied by default. SMARTCRAWL_TRUSTED_PROXY_EGRESS=true requires a *trusted, operator-controlled* gateway that independently blocks unsafe destinations after its own DNS resolution; direct socket pinning cannot enforce destination policy through arbitrary third-party proxies.

## Security expectations

1. HTTP(S) only; reject embedded URL credentials on production native fetches.
2. Inspect all DNS answers, rejecting mixed safe/unsafe results.
3. For direct hostnames, use the validated address for the socket connection, not a second unvalidated DNS lookup.
4. Handle redirects manually up to five hops, validating destinations before a new request.
5. Limit response body sizes.
6. Do not enable browser or proxy modes without enforced network isolation.
7. Preserve existing positive scrape, crawl and SDK behavior where these requirements allow.

## Remaining work

**This first PR does not establish complete SSRF protection across all modes and integrations.**

- Verify actual browser/network-isolation and proxy gateway behavior at deployment.
- Eliminate storage/return of proxy credentials in job metadata.
- Verify pinning and DNS-race behavior in controlled socket-level integration tests.
- Review other dynamic outbound integrations and their credentials.
- Fix trusted-proxy IP handling and guest job authorization.
- Benchmark additional DNS lookups and agent lifecycle overhead.

## Verification status

Source was inspected through connected GitHub. No new npm tests were run locally in this runtime because a checkout could not be obtained. New test outcomes must be verified through the GitHub Actions run for this PR. Do not claim full SSRF remediation or benchmark results until those checks are complete.

## Evidence standard

Problem → reproduction → root cause → code/test changes → CI result → runtime check → remaining limitations.
