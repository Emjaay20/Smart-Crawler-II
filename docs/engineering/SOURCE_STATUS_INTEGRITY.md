# Source status and extraction integrity

2026-11-15. SmartCrawl now applies its existing direct-HTTP error policy to
Playwright and managed Firecrawl results too. Provider transport HTTP 200 is not
proof that the target page succeeded: the source status is checked before
extracting or returning content. Source 4xx/5xx results become typed `http_4xx` or
`http_5xx` failures, without returning the failed document as a successful scrape.
Successful 200 extraction remains unchanged.

Five regressions demonstrated the bug before the fix: browser 404/503 and
Firecrawl source 404/429/503 all resolved with `success:true`. Those tests now pass.
The full local suite passed 151 tests, with the opt-in real Chromium test passing
separately. Backend/UI builds also passed.

The workbench now displays source HTTP status alongside the engine and content
statistics. Extraction warnings have their own visible notes banner, including
when users inspect raw JSON or chunks. Log auto-scrolling stays inside the log
pane rather than moving the whole page away from results. The notes and metadata
were visually inspected with a controlled local preview, not presented as a
production extraction.

## Firecrawl issue #5717: current hosted observation

One controlled request to the configured Firecrawl v2 endpoint returned:

- Provider transport: HTTP 200, `success:true`.
- Source metadata: HTTP 404, `error:"Not Found"`.
- JSON: `version:"1.0"`, empty release fields and a note that the release does not
  exist. No top-level `data.warning` was returned.

The original request asked for release metadata at the public GitHub releases
endpoint from the issue, with `maxAge:0` and no version default in its schema.
The [sanitized response record](evidence/firecrawl-5717-hosted-20261115.json)
contains no credentials. This is one observation, not a measured failure rate.
It reproduces the reported source/output inconsistency, but does not identify
the exact hosted backend revision or prove where a model/integration introduced
the unsupported field.

The upstream checkout was `71f430a2dabffaf718cef7091c340b7384b91178`.
The required harness command was attempted:

```sh
pnpm harness pnpm exec vitest run src/scraper/scrapeURL/transformers/llmExtract.test.ts
```

It failed during dependency installation, before any tests ran, because the local
FoundationDB native package could not find `foundationdb/fdb_c.h` on macOS arm64.
No test was bypassed or represented as passing. An upstream candidate includes
transformer regressions and gated API snippet success/failure coverage, but needs
validation in an environment with the required native client and services.

The proposed upstream change is [Firecrawl draft PR #5756](https://github.com/firecrawl/firecrawl/pull/5756).
It remains a draft with the local validation blocker disclosed; it is not an
accepted or upstream-verified fix.
