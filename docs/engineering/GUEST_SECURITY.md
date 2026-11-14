# Guest session identity and confidential job options

**Scope:** Phase 1, second security PR  
**Base:** main at fa157b3e37de24f7e0df5c989571c632a0a7f955  
**Status:** Draft pending automated checks and deployment review

## Why this change

Guest quota consumption and guest job ownership have different security needs. A client network address can provide a coarse abuse-control signal (provided any reverse-proxy metadata is trusted), but it must not grant access to someone else's job results. Proxy URLs may contain credentials and must not be persisted in job option metadata.

## Guest session flow

1. When the guest demo is enabled and the caller supplies no API key, the API issues a cryptographically random guest token as an HttpOnly, SameSite=Lax cookie named `smartcrawl_guest`.
2. Only the SHA-256 token identifier and expiry are persisted in SQLite. The bearer token is not stored in job metadata.
3. Guest-created jobs carry their session identifier in internal metadata. Job status, job lists, legacy status aliases and result exports require the same valid guest session.
4. Demo quota is still consumed per verified client network address and UTC day, using an atomic SQLite upsert. Rotating cookies does not reset the daily allowance from the same address.
5. Reaching the daily limit prevents additional jobs, but must not remove access to already-created jobs. Legacy jobs identified only by IP intentionally cannot be claimed through a new guest cookie.

## Reverse proxy and cookie deployment

- Default: **never trust X-Forwarded-For**. Use the actual socket address for the demo allowance.
- For deployments with a trusted reverse proxy, configure `SMARTCRAWL_TRUSTED_PROXIES` with exact proxy IP addresses or narrowly scoped non-zero CIDRs, separated by commas (e.g., `127.0.0.1,::1` when and only when these are the actual trusted hops).
- The application uses Express trusted-proxy processing to select the first untrusted hop. `*`, `true`, malformed ranges and `/0` are not allowed.
- A proxy trust list that is broader than the real proxy network reintroduces spoofing risk. Use gateway-level identity/rate limiting for robust public deployment and avoid sharing one source-IP allowance among all users behind an unconfigured proxy.
- Cookie uses Secure when the app detects an HTTPS request, `SMARTCRAWL_COOKIE_SECURE=true` is configured, or `NODE_ENV=production`. Production browsers must access the app through HTTPS.
- Cookies are bearer credentials; treat them as such. Guest access is not equivalent to a signed-in customer account. Network sharing, cookie theft and browser cookie deletion have the usual implications for unauthenticated demos.

## Job configuration confidentiality

- The job store removes the `proxy` field before writing new job option records.
- On database opening, a targeted SQLite migration removes legacy top-level `proxy` options. Back up the database before rollout if your retention process requires a recoverable audit trail.
- Job-status responses also hide internal ownership fields (`keyId`, `userId`, `guestSessionId`, legacy `guestIp`, `isGuest`).
- The original in-memory request retains the proxy URL long enough to execute the job. The migration does not alter scrape outputs, logs, external systems or previously exported data. Review and rotate credentials that were already exposed before this patch.

## Behavioral and compatibility changes

- Guest clients need to preserve the `smartcrawl_guest` cookie across requests to read their own job results. Non-browser SDK clients must manage the cookie explicitly or authenticate using an API key.
- IP-only legacy guest jobs are not accessible through the guest endpoint after the change.
- The default reverse-proxy trust behavior is stricter than before; hosted deployments must review the proxy allowlist and rate-limiting policy before release.

## Verification checklist

- Forged X-Forwarded-For headers do not reset daily quota by default.
- Separate guest cookies on one address cannot read or list each other's jobs.
- A guest who has exhausted quota can still poll/export their own completed jobs.
- Raw guest tokens are not persisted in SQLite or visible in job JSON.
- New and legacy stored job options do not include proxy credentials.
- Runtime scraping receives the proxy value when requested, while the job status response does not.
- Invalid trusted-proxy CIDRs and URLs with embedded destination credentials fail validation.
- CI tests and Docker smoke steps pass before merge.

**This patch is not a complete application-security audit.** Network-level abuse prevention, authenticated-user RBAC, remaining sensitive logs, and the independently drafted HTTP egress hardening are additional work.
