# Firecrawl OSS Investigation — Issue #5717

**Investigation date:** 2026-11-14  
**Status:** Updated 2026-11-15: one hosted request reproduced the source/output inconsistency. Exact root cause remains unconfirmed. See [current evidence and validation limits](SOURCE_STATUS_INTEGRITY.md).
**Issue:** https://github.com/firecrawl/firecrawl/issues/5717  
**Upstream project:** https://github.com/firecrawl/firecrawl  
**Source revision inspected:** Firecrawl default-branch code as returned by connected GitHub source lookup on 2026-11-14.

## 1. Problem statement from the reported issue

A JSON-format scrape of a GitHub releases/latest endpoint returned HTTP source status 404 yet also supplied a concrete, apparently valid release version and edition explanation. The issue reporter documented **one observation**, not a failure rate or a root cause.

A downstream consumer that trusts JSON-formatted facts while ignoring source HTTP metadata could act on an unsupported version number.

**Desired invariant:** An unsuccessful/unavailable source must not silently yield fabricated-looking, release-dependent facts represented as verified extraction.

## 2. Relevant code path identified

**Potential location to investigate:** `apps/api/src/scraper/scrapeURL/transformers/llmExtract.ts`, `performLLMExtract(meta, document)`.

- The JSON transformer detects whether the `json` format is requested and constructs model completion options using `document.markdown`.
- On completion, the transformer writes `document.json = extractedData ?? null` for API v2.
- In the inspected `performLLMExtract` implementation, there is no obvious guard that rejects extracted data based on `document.metadata.statusCode` before assigning JSON output.

**Code source:** https://github.com/firecrawl/firecrawl/blob/main/apps/api/src/scraper/scrapeURL/transformers/llmExtract.ts

This is an **investigation hypothesis**, not a proven defect: it is not yet established whether the 404 metadata was known at the time, whether the API path used this transformer, or whether an agent/integration wrapper introduced the inconsistency.

Other potential components: upstream fetch/scrape status propagation, retry/fallback handling, AI model extraction, response transformers and output serialization.

## 3. Reproduction plan

Work on a fork/local checkout following Firecrawl's CONTRIBUTING.md.

1. Inspect existing v2 scrape harness and relevant JSON-format test suites.
2. Create a local, owned fixture endpoint that returns HTTP 404 with a small realistic error body and **no release data**.
3. Request `formats: [{ type: "json", schema: ... }]` with a schema containing optional release-dependent fields (version/tag/date).
4. Capture API status, `metadata.statusCode`, warning/error, resulting `json`, and an execution trace that identifies the extraction path.
5. Repeat using markdown-only format as a control, a 200 fixture containing legitimate release data, and a 404 fixture with no extracted fields.
6. Repeat deterministic mocks before using live LLM calls to avoid flaky tests, expense and attribution mistakes.
7. If reproduced, agree on expected contract with maintainers (null JSON, omitted fields, explicit extraction failure, or provenance marker) **before** submitting behavior changes.

## 4. Proposed test matrix

| Source fixture | Expected status metadata | Acceptable extraction behavior |
| --- | --- | --- |
| Successful 200 page with version 2.0.0 | 200 | Version 2.0.0 if supported by content |
| 404 page with only 'Not Found' | 404 | No invented release version; explicit absence/failure |
| 404 page with plausible templated text | 404 | No unsupported validated release facts |
| 429 / 503 temporary error | 429 / 503 | Clear warning/error, no unverified release facts |
| 200 page missing release metadata | 200 | Omit/null unknown fields, not fabricated defaults |
| 200 page with schema default for version | 200 | Document default-source distinctions; do not confuse schema defaults with extracted facts |

## 5. Candidate engineering change (conditional)

If investigation confirms the relevant path, a narrow test and guard at a shared JSON transformation boundary might be appropriate, but only after understanding behavior that deliberately permits extraction of 4xx pages for diagnostics. A blanket ban on all 4xx responses could break existing supported uses.

Add a failure regression test before changing production code. Ensure successful 200 extraction remains unchanged and existing metadata/warnings are preserved.

## 6. Documentation and contribution evidence

Before opening a PR, record:
- Upstream commit SHA and local setup commands.
- Exact minimal reproduction and failing tests.
- Relevant function/call-path evidence.
- Alternatives and compatibility effects.
- Test commands, logs and results.
- Maintainer feedback, PR link and final status.

**Historical state (2026-11-14):** Investigation only; no runtime reproduction had been performed. The later hosted observation and upstream candidate are recorded in the linked update. No claim of a general model failure rate is made.
