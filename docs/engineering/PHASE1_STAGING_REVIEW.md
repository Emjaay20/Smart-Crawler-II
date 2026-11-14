# Phase 1 — Security Integration: Staging and Release Readiness

**Review date:** 2026-11-14  
**Branch:** `integration/p1-security-combined-20261114`  
**Change scope:** combine HTTP egress hardening (PR #2) with guest/session and credential protections (PR #3).  
**Status:** CI-validated branch; **not approved for production**. No live staging deployment was performed by this review.

## Evidence and changes

- [PR #2](https://github.com/Emjaay20/Smart-Crawler-II/pull/2): DNS-aware public-destination checks, direct Undici socket DNS pinning, manual redirect validation, bounded responses and operator-controlled egress gateway requirements.
- [PR #3](https://github.com/Emjaay20/Smart-Crawler-II/pull/3): opaque hashed guest-session ownership, atomic guest quotas, untrusted forwarded-header defenses, proxy credential redaction and Node.js SDK session compatibility.
- [PR #4](https://github.com/Emjaay20/Smart-Crawler-II/pull/4): controlled integration tests run against both changes together.
- Error strings are redacted for basic-auth URL userinfo and known bearer token formats before persistence in job logs, API errors and operations alerts. This is defense in depth, not a guarantee against arbitrary secrets in custom text.
- Proxy requests may use **only** the exact operator-configured `SMARTCRAWL_PROXY_URL` when `SMARTCRAWL_TRUSTED_PROXY_EGRESS=true`. Arbitrary request-selected gateways and implicit `HTTP_PROXY`/`HTTPS_PROXY` fallbacks are not supported.

## Manual pre-release review gates

| Gate | Required proof | Current state |
| --- | --- | --- |
| CI and Docker smoke | Latest branch SHA, all test counts and logs | CI runs on PR #4; see live status |
| Reverse-proxy identity | Ingress topology and exact trusted IP/CIDRs, negative spoofed-header test | Not verified in a deployed staging environment |
| Guest cookies | HTTPS, HttpOnly/SameSite/Secure behavior, persistent browser and Node SDK sessions | Unit/integration tests; real HTTPS staging check outstanding |
| Public HTTP egress | Controlled DNS-rebinding/socket integration and redirect-chain tests | Static and mocked tests; socket-level staging check outstanding |
| Browser mode | External enforced network isolation and approved destinations | **Do not enable** without deployment evidence |
| Proxy mode | Operator-controlled gateway with independent DNS/IP filters, no client-selected proxy | Config/code tests; staging gateway check outstanding |
| Secret hygiene | API status, logs, DB rows, alerts and old export locations contain no secrets | Regression tests added; operational data review outstanding |
| Existing jobs | SQLite backup, old guest-session access expectations, migration rollback plan | Not verified against a staging copy of production data |
| Throughput | Baseline and changed p50/p95, memory, timeouts and error rate | Not yet benchmarked |

## Staging-only checklist

1. Provision a **non-production** environment isolated from internal services and cloud metadata endpoints. Do not point the staging crawler at private networks. Use explicit test websites and domains under your control.
2. Make a consistent SQLite backup **before** migrating any job database. Ensure the backup captures WAL state and is restorable. If staging uses production-shaped data, use redacted or synthesized records; never move unmasked secrets into logs or case studies.
3. Deploy only the reviewed commit from PR #4 and record its SHA and image digest.
4. Verify `/health` and `/ready` and review the expected authentication behavior.
5. Configure the exact upstream reverse-proxy IPs/CIDRs via `SMARTCRAWL_TRUSTED_PROXIES` **only if** that proxy is really present. Test a spoofed external `X-Forwarded-For` header from an untrusted hop.
6. Use an HTTPS staging origin for browser cookie tests. Confirm guest cookie expiry, Secure, HttpOnly and SameSite; verify two browsers cannot read one another's jobs while expired/exhausted guests can still read their own existing jobs.
7. Test Node.js SDK anonymous scraping, concurrent starts, polling and exports; inspect that one client instance preserves one session. Test an API key separately.
8. Test controlled 301/302 chains and DNS resolution changes. Ensure **no outbound socket** is opened to a loopback, metadata, private or otherwise prohibited destination.
9. Do not enable `SMARTCRAWL_BROWSER_EGRESS_ISOLATED` without an enforced external firewall/network policy. Do not enable `SMARTCRAWL_TRUSTED_PROXY_EGRESS` without an audited operator gateway.
10. Inject simulated proxy connection failures and inspect job status, logs, SQLite rows, error reports and Slack alerts for accidental credential disclosure. Rotate any previously exposed credentials.
11. Compare a fixed, authorized extraction fixture set against the baseline. Record raw test commands, revision, environment, concurrency, p50/p95/p99, success/failure rate, and memory usage.
12. Document evidence and approvals. **No merge/deployment until security review and staging tests are complete.**

## Compatibility notes

- Guest-created jobs now require the session cookie. IP-based legacy guest jobs cannot be re-claimed by presenting a matching IP. Communicate this explicitly; preserve compatibility for API-key users.
- Guest cookies default to Secure in production. HTTPS termination and the actual proxy trust chain must be correct.
- The bundled Node.js SDK bootstraps and retains the guest cookie; a generic script using `fetch` must manage cookies itself.
- If `SMARTCRAWL_PROXY_URL` is set, `SMARTCRAWL_TRUSTED_PROXY_EGRESS=true` and an audited egress gateway are mandatory. `HTTP_PROXY`/`HTTPS_PROXY` no longer implicitly select proxy scraping.
- This change does not retroactively scrub previously exported files, log aggregators, backups or notifications. Review and rotate historical credentials as needed.

## Merge/rollback strategy

1. Have a reviewer evaluate PR #2 and PR #3 separately and PR #4 as the combined verification branch.
2. When approved, merge PR #2, then rebase/update PR #3 onto the new base and rerun the full integration CI. This preserves small, reviewable histories.
3. Treat PR #4 as a **testing reference**, not a second code merge. Once the approved changes are present in `main`, close redundant PR #4 without merging.
4. Deploy to staging first, record service and database health, and compare result fidelity and error rates.
5. Only after positive sign-off, plan an independently approved production deployment with backup, credential rotation and rollback.
6. Rollback must account for database migration and session-cookie compatibility: application rollback alone may not restore legacy proxy fields or old guest-job ownership.

## Career portfolio evidence

Case-study claims should state what CI actually proved and explicitly distinguish simulated fixture behavior from production networking. Preserve links to reviewed PRs, failing tests, fixes, CI runs, deployment checks and measurable before/after outcomes. Never invent throughput, adoption or production security claims.
