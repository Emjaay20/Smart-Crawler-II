# Firecrawl Open-Source Contribution Tracker

**Started:** 2026-11-14  
**Contributor:** [Emjaay20](https://github.com/Emjaay20)  
**Status:** Research and candidate selection only; no upstream contribution claimed.

## Working rules

1. Follow [Firecrawl's contribution instructions](https://github.com/firecrawl/firecrawl/blob/main/CONTRIBUTING.md).
2. Re-check issue and pull request status before starting any work.
3. Reproduce the behavior and identify the smallest maintainer-appropriate scope.
4. Avoid duplicate fixes, especially where another contributor has an open PR.
5. Document actual tests, review feedback and merge status; do not imply a PR is merged before confirmation.
6. Keep confidential reports and unpatched security findings out of this public tracker.

## Candidate issues

| Candidate | Issue | Assessment / next action |
| --- | --- | --- |
| Structured extraction reliability | [#5717](https://github.com/firecrawl/firecrawl/issues/5717) | Investigate a reported JSON-extraction inconsistency on failed sources. **Open at baseline.** First check whether it can be reproduced using public/local code and a harmless mocked 404. |
| Self-hosted search diagnostics | [#5472](https://github.com/firecrawl/firecrawl/issues/5472) | Improve understanding of 429/upstream failure vs empty results. **Open at baseline.** Establish a controllable repro before proposing a fix. |
| Manual terminal webhook redelivery | [#4774](https://github.com/firecrawl/firecrawl/issues/4774) | Relevant to event delivery/idempotency work, but a larger feature. **Open at baseline.** Seek maintainer guidance on a small first scope. |

## Investigation in progress

- [Issue #5717 source inspection and controlled reproduction plan](./FIRECRAWL_5717_INVESTIGATION.md): inspected the JSON extraction transformer and identified a candidate missing source-status guard. **No local reproduction or confirmed root cause yet. No upstream PR has been submitted.**

## Existing pull requests to study, test or review

- [#5167 — Playwright browser recovery](https://github.com/firecrawl/firecrawl/pull/5167): open at baseline; do not submit a duplicate fix.
- [#5667 — Python batch wait deadlines](https://github.com/firecrawl/firecrawl/pull/5667): open at baseline; useful for SDK timeout/cancellation testing.

## First contribution evidence template

- **Issue / PR:**
- **Upstream revision inspected:**
- **Expected behavior:**
- **Observed behavior (with reproduction):**
- **Affected component:**
- **Root cause (confirmed vs hypothesis):**
- **Tests added / exact commands and outcomes:**
- **Compatibility, security or deployment implications:**
- **Maintainer discussion and review feedback:**
- **Final status (proposed / submitted / reviewed / merged / closed):**
- **Public case-study link:**

No GitHub issue comments, external pull requests or upstream file modifications were made as part of this tracker creation.
