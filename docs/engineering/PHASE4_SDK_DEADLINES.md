# Phase 4 — SDK request deadlines and developer experience

**Parent:** Phase 3C draft PR #8  
**Status:** Draft, CI verification required.

The SmartCrawl TypeScript SDK previously waited indefinitely for a blocked HTTP request, even when a job polling timeout had been configured. Phase 4 introduces a bounded network deadline, an adjustable polling interval, typed timeouts and explicit redirect rejection.

## Public client settings

```ts
const client = new SmartCrawl({
  baseUrl: 'https://YOUR-APP-ORIGIN',
  apiKey: process.env.SMARTCRAWL_KEY,
  requestTimeoutMs: 15_000, // default, allowed 50–120,000
  pollIntervalMs: 250, // default, allowed 50–5,000
});
```

- Every SDK HTTP call uses `AbortSignal.timeout()`; a stalled request produces a `SmartCrawlError` with status 408 and code `timeout`.
- `waitForJob(id, timeoutMs)` bounds its total polling budget (default 60 seconds) and caps each individual network request to the remaining budget.
- Errors from HTTP responses retain the server's status and structured error code.
- SDK requests disallow HTTP redirects, preventing accidentally carrying a bearer token or guest session to another origin.
- Node.js guest-session bootstrapping remains compatible, but bootstrap calls now also have a network timeout.
- Browser and Node clients can choose appropriate wait durations for their workload.

## Limitations

An SDK timeout does not automatically cancel a server-side job. Call `job(jobId)` later if the request successfully created a job. A local abort may occur while the server continues processing. Do not automatically retry POST requests without a server-side idempotency key.

SDK clients do not yet have general request cancellation options, exponential polling backoff, or a durable job cancel API. These require separately reviewed changes.

## Verification

- Mocked stalled fetch enforces a typed timeout.
- Polling a permanently pending job reaches the requested deadline.
- Structured HTTP quota errors remain accessible.
- Options reject invalid/unsafe timeout ranges.
- Existing SDK API-key and anonymous guest-cookie tests continue to pass.
- CI type-check, Vitest, UI build, Docker smoke and benchmark must all pass.

These are functional tests rather than production measurements. The SDK's actual external-network latency and server-side workload behavior still require staging measurements.
