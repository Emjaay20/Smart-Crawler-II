# SmartCrawl

URL in. Clean markdown and structured JSON out.

Live: [https://smart-crawler.aetherhost.app](https://smart-crawler.aetherhost.app)
OpenAPI: [`openapi.yaml`](./openapi.yaml)

Fetch-first: HTTP + Mozilla Readability by default. Playwright only when the page is a JS shell (not installed on AetherHost’s 512MB tenant). Jobs persist in SQLite.

## Use it in code

```ts
import { SmartCrawl } from 'smart-crawler';

const sc = new SmartCrawl({
  baseUrl: 'https://smart-crawler.aetherhost.app',
  apiKey: process.env.SMARTCRAWL_API_KEY, // required once auth is on
});

const doc = await sc.scrape('https://example.com');
console.log(doc.markdown);
```

`sc.map(url)` and `sc.crawl(url, { limit: 5 })` wait for the job the same way. `sc.me()` inspects current key quota and `sc.listJobs()` lists recent jobs.

## Use it in a terminal

```bash
npm run build
npx smartcrawl --base https://smart-crawler.aetherhost.app health
npx smartcrawl me
npx smartcrawl jobs
npx smartcrawl report
npx smartcrawl scrape https://example.com --provider auto
npx smartcrawl map https://example.com --limit 10
npx smartcrawl crawl https://example.com --limit 3
npx smartcrawl export <jobId> > dataset.jsonl
npx smartcrawl mcp
```

### AI Agent Integration (Model Context Protocol / MCP)

SmartCrawl provides a built-in stdio Model Context Protocol (MCP) server for AI coding tools (Claude Code, Cursor, Windsurf, Codex):

```bash
npx smartcrawl mcp
```

Configure in your tool's MCP configuration:

```json
{
  "mcpServers": {
    "smartcrawl": {
      "command": "npx",
      "args": ["smartcrawl", "mcp"]
    }
  }
}
```

Provides native agent tools:
- `smartcrawl_scrape({ url, js, provider })`: Scrapes a URL to clean markdown and structured content.
- `smartcrawl_crawl({ url, limit })`: Bounded crawl over same-origin links.
- `smartcrawl_map({ url, limit })`: Fast same-origin link and sitemap discovery.

Env: `SMARTCRAWL_URL`, `SMARTCRAWL_API_KEY`. Flags: `--base`, `--key`.

## Quick start (local)

```bash
npm install
npx playwright install chromium   # optional, local JS pages only
npm --prefix ui install
npm test
npm run start:server
```

```bash
curl -s http://localhost:3000/health
# {"status":"ok"}
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/ready` | SQLite is readable |
| GET | `/metrics` | Prometheus counters (`scrape_jobs_total`, `scrape_errors_total`, `worker_active_jobs`, `worker_queue_depth`, p95 latency) |
| GET | `/v1/stats` | JSON snapshot of the same counters |
| GET | `/v1/providers` | Which optional server-side content providers are enabled (never exposes credentials) |
| GET | `/v1/report` | Operational health digest (`healthy` / `degraded` / `critical`) |
| GET | `/v1/me` | Auth mode and current API key quota (`dailyLimit`, `usedToday`, `remaining`) |
| POST | `/v1/scrape` | Enqueue a scrape job |
| POST | `/v1/map` | Discover same-origin URLs (seed page + `/sitemap.xml`) |
| POST | `/v1/crawl` | Multi-page BFS scrape (`limit` max 20) |
| GET | `/v1/jobs` | List recent jobs (`?limit=20`) |
| GET | `/v1/jobs/:id` | Job status, logs, result |
| GET | `/v1/jobs/:id/export.jsonl` | Export completed scrape/crawl job as NDJSON (`.jsonl`) dataset |
| POST | `/v1/admin/keys` | Mint a user key (admin token) |
| GET | `/v1/admin/keys` | List key prefixes and quota (admin) |
| DELETE | `/v1/admin/keys/:id` | Revoke a user key (admin) |
| POST | `/v1/admin/report` | Generate operational digest and post to Slack (admin) |
| POST | `/crawl` | Legacy alias of `/v1/scrape` |
| GET | `/status/:id` | Legacy alias of `/v1/jobs/:id` |

`POST /v1/scrape` body:

```json
{
  "url": "https://example.com/blog/post",
  "formats": ["markdown", "links", "metadata", "html"],
  "onlyMainContent": true,
  "js": "auto",
  "provider": "local",
  "timeoutMs": 15000,
  "userAgent": "SmartCrawl/1.0"
}
```

`js`: `"auto"` (default) uses HTTP then Playwright if the body looks empty; `false` is HTTP only; `true` always uses Chromium.

`provider`: `"local"` (default) keeps work inside SmartCrawl's HTTP/Playwright pipeline. When an operator has configured `FIRECRAWL_API_KEY` (for Firecrawl Cloud) or `FIRECRAWL_BASE_URL` (such as `http://127.0.0.1:3002` for air-gapped `firecrawl-local`), a single-page request may use `"firecrawl"`, or `"auto"` may use it only after an eligible local failure. Provider credentials are never accepted from, returned to, or stored by the browser. Map and crawl jobs always stay local so a multi-page request cannot unexpectedly consume managed-provider credits.

Successful `data`:

```json
{
  "success": true,
  "markdown": "# Title\n\n...",
  "links": ["https://example.com/next"],
  "metadata": {
    "title": "Title",
    "statusCode": 200,
    "sourceUrl": "https://example.com/blog/post",
    "finalUrl": "https://example.com/blog/post",
    "engine": "http",
    "redirectChain": []
  },
  "warnings": [],
  "timing": { "ttfbMs": 120, "totalMs": 840 }
}
```

Errors are typed: `invalid_url`, `robots_blocked`, `timeout`, `dns`, `http_4xx`, `http_5xx`, `js_required`, `anti_bot_detected`, `circuit_broken`, `provider_unavailable`, `extract_empty`, `unknown`.

## Engineering evidence and release review

- [Phase-by-phase CI results and outstanding release gates](./docs/engineering/CI_PHASE_RESULTS.md)
- [Performance methodology and verification](./docs/engineering/PHASE6_PERFORMANCE_REVIEW.md)
- [Source-backed Firecrawl engineering case study](./docs/portfolio/SMARTCRAWL_FIRECRAWL_CASE_STUDY.md)

**Review state:** security, crawler, recovery, SDK and audit improvements are stacked draft changes. They require independent code/security review and staging validation before a production release.

## Administrative audit and key authentication (Phase 5 draft)

When API keys are configured, SmartCrawl now requires an authorized key or configured guest-demo allowance even if the administrator token is absent. Selected key operations and administrator-approved crawl resumption write credential-free audit records to SQLite. Administrators can query the bounded `GET /v1/admin/audit` endpoint with their bearer token.

This is **not** an immutable compliance-grade audit system. See [Phase 5 security and audit notes](./docs/engineering/PHASE5_AUTH_AUDIT.md).

## SDK request deadlines (Phase 4 draft)

The TypeScript SDK now supports `requestTimeoutMs` (default 15 seconds) and `pollIntervalMs` (default 250ms). `waitForJob(jobId, timeoutMs)` enforces an overall time budget, and HTTP errors preserve structured status and code. SDK requests reject redirects by default.

**Important:** a client-side timeout does not cancel the server's job. Retry POST requests only with appropriate idempotency safeguards. See [Phase 4 SDK engineering notes](./docs/engineering/PHASE4_SDK_DEADLINES.md).

## Durable crawl checkpoints (Phase 3C draft)

Optional `SMARTCRAWL_ENABLE_CRAWL_CHECKPOINTS=true` commits completed breadth-first crawl batches to SQLite. A separate `SMARTCRAWL_ENABLE_CHECKPOINT_RESUME=true` flag allows an administrator with the configured admin token to explicitly resume an interrupted crawl as a **new** job from the last committed checkpoint by calling `POST /v1/admin/jobs/:id/resume` with `{"acknowledgePossibleRefetch":true}`.

This is an **at-least-once** operation: requests in an incomplete batch may be repeated. Checkpoint capture and resume are both off by default. Never enable automatic replay of already running jobs. See [Phase 3C checkpoint/replay design](./docs/engineering/PHASE3_CRAWL_CHECKPOINTS.md) for guarantees, tests and safe rollout requirements.

## Safe pending-crawl recovery (Phase 3 draft)

The optional `SMARTCRAWL_ENABLE_PENDING_RECOVERY=true` setting resumes **explicitly eligible, never-started local crawl jobs** from the SQLite database after restart. A pending job is atomically claimed once and retains its original job ID. Interrupted running crawls are **not** automatically replayed because their requests may already have reached the target website. Replay attempts are limited to three startup opportunities.

The flag is disabled by default and **requires an exclusive single-instance SQLite deployment**. It is not an exactly-once distributed queue and it does not resume partial pages. See the [recovery design and staging checklist](./docs/engineering/PHASE3_PENDING_RECOVERY.md) before enabling it.

## Bounded concurrent crawling (Phase 3 draft)

`/v1/crawl` supports an optional `concurrency` setting (integer 1–4, default 1) and a per-origin start-spacing `crawlDelayMs` (0–60,000ms, default 250ms). The crawler uses deterministic breadth-first batches with a maximum of 20 successful pages. It rejects cross-origin links, including alternate ports on the same hostname.

```json
{
  "url": "https://example.com/docs",
  "limit": 10,
  "concurrency": 2,
  "crawlDelayMs": 250
}
```

For offline, reproducible performance experiments run `npm run bench:crawl`, which compares concurrency levels 1, 2 and 4 against synthetic fixture responses. **Synthetic latency does not represent real website performance.** The scheduler is in-process and cannot yet resume incomplete crawls after a restart. See [Phase 3 scheduler design](./docs/engineering/PHASE3_CRAWL_SCHEDULER.md) for the tests and remaining durability work.

## Outbound request security

Direct HTTP scraping, robots.txt and sitemap requests now use validated, DNS-pinned egress with manually checked redirects. See [HTTP egress security](./docs/engineering/SAFE_EGRESS.md) for limitations and the remaining audit work.

Browser rendering fails closed unless a deployment operator has **enforced outbound network isolation** and sets `SMARTCRAWL_BROWSER_EGRESS_ISOLATED=true`. Third-party proxy requests fail closed unless an operator configures the *exact* gateway URL with `SMARTCRAWL_PROXY_URL`, sets `SMARTCRAWL_TRUSTED_PROXY_EGRESS=true`, and ensures that gateway enforces destination restrictions. Per-request proxy substitution is not supported. Neither flag supplies a firewall on its own; do not enable either without the corresponding external security controls. The low-memory hosted Docker image does not include Chromium.

## Browser reliability (Phase 2 draft)

Browser rendering uses an in-process bounded task scheduler and per-request Playwright contexts. The safe default is a single concurrent render. Set `SMARTCRAWL_BROWSER_CONCURRENCY` (1–4, default 1) and `SMARTCRAWL_BROWSER_MAX_PENDING` (1–128, default 24) to tune resource admission. Saturated queues reject additional requests, and process shutdown drains accepted browser tasks.

**Browser egress must still be enforced by the deployment network.** Setting `SMARTCRAWL_BROWSER_EGRESS_ISOLATED=true` only acknowledges the operator's external firewall/isolation policy; it is not a substitute for one. This in-process queue is not durable across restarts.

See the [Phase 2 browser engineering notes](./docs/engineering/PHASE2_BROWSER_RELIABILITY.md) for test coverage, tradeoffs and real-Chromium staging requirements.

## Web-Scale Crawler & Egress Infrastructure

SmartCrawl incorporates production crawler infrastructure patterned after high-throughput distributed crawling networks:

- **Egress Proxy Routing:** Supports outbound HTTP/HTTPS/SOCKS5 proxies via ambient environment variables (`SMARTCRAWL_PROXY_URL`, `HTTP_PROXY`, `HTTPS_PROXY`) or per-request `proxy` parameters. In Node 22, requests are routed via `undici.ProxyAgent` connection pools; in browser mode, proxies are injected into isolated Playwright browser contexts. Every proxy URL is validated against the SSRF engine to prevent loopback/metadata pivot attacks.
- **WAF & Anti-Bot Challenge Classification:** Inspects response headers and HTML payloads to identify challenge barriers before classifying generic HTTP errors. Accurately flags Cloudflare Turnstile / Under Attack Mode (`cf-ray`, `cf-chl-bypass`, `<title>Just a moment...</title>`), DataDome (`x-datadome`), AWS WAF (`x-amzn-waf-action: block`), and Akamai (`x-akamai-transformed`) as `anti_bot_detected`. When `provider: "auto"` is selected, requests automatically escalate to the server's configured managed provider tier.
- **Domain Circuit Breakers (`DomainCircuitBreaker`):** Prevents burning proxy IP reputations or wasting bandwidth on persistent WAF blocks. Tracks consecutive challenge/failure states per origin; after reaching the failure threshold, the origin enters an open circuit state, immediately rejecting requests with `circuit_broken` during the cooldown window before probing in half-open state.
- **Politeness Limiter & Jitter (`DomainPolitenessLimiter`):** Enforces crawl spacing per target domain, honoring robots.txt `Crawl-delay` directives and adding randomized jitter to smooth traffic spikes and avoid synchronized hammering of upstream origins.

## Docker / AetherHost

Daily verified database backups and the `npm run backup:fetch` off-server copy
command are described in [backup operations](./docs/engineering/BACKUP_OPERATIONS.md).

See the [Aetherhost release configuration](./docs/engineering/AETHERHOST_RELEASE.md)
for persistent storage, low-memory settings, staging checks and rollback steps.

Listens on `PORT` (default 3000). Health check: `GET /health`.

```bash
docker build -t smart-crawler .
docker run --rm -p 3000:3000 -e PORT=3000 smart-crawler
```

Env:

- `PORT` — listen port
- `HOST` — bind address (default `0.0.0.0`)
- `JOBS_DB` — SQLite path (default `/app/data/jobs.sqlite`)
- `PUBLIC_DIR` — playground build (default `/app/ui/dist`)
- `SMARTCRAWL_ADMIN_TOKEN` — protects administrative routes; the configured key store independently enforces user API keys and the guest allowance
- `SMARTCRAWL_ADMIN_TOKEN_FILE` — optional file path for the admin token (defaults to `/app/data/admin.token` if present)
- `SMARTCRAWL_SLACK_WEBHOOK_URL` — optional Slack incoming webhook for automatic failure-spike alerts and operational digests
- `SMARTCRAWL_ALERT_FAILURE_THRESHOLD` — consecutive failures before firing a Slack alert (default `3`)
- `SMARTCRAWL_ALERT_COOLDOWN_MS` — alert cooldown window in ms to prevent Slack notification storms (default `300000`)
- `MAX_CONCURRENT_JOBS` — max concurrent worker jobs (default `4`)
- `SMARTCRAWL_ALLOW_PRIVATE_NETWORKS` — set to `true` only for local test suites scraping `127.0.0.1`
- `SMARTCRAWL_OIDC_ISSUER` — Odudu tenant issuer, for example `https://auth.example.com/tenants/smartcrawl`
- `SMARTCRAWL_OIDC_CLIENT_ID` — SmartCrawl's registered OIDC client ID
- `SMARTCRAWL_OIDC_CLIENT_SECRET` — optional client secret for the server-side web client
- `SMARTCRAWL_OIDC_REDIRECT_URI` — exact callback URL, for example `https://smart-crawler.example.com/auth/callback`
- `SMARTCRAWL_FREE_DAILY_LIMIT` — daily job allowance for a newly created account key (default `25`)
- `SMARTCRAWL_GUEST_DEMO_LIMIT` — free trial scrapes allowed per client IP before requiring account sign-in (default `2`)

## Auth (multiple users)

The server always configures a key store, so API authentication remains enforced even when no admin token is available. The guest allowance defaults to two jobs per client IP; set `SMARTCRAWL_GUEST_DEMO_LIMIT=0` for key-only access. Configure `SMARTCRAWL_ADMIN_TOKEN` (or `/app/data/admin.token`) to manage keys. The raw user key is shown **once**.

```bash
export SMARTCRAWL_ADMIN_TOKEN='a-long-random-secret'

curl -s -X POST https://smart-crawler.aetherhost.app/v1/admin/keys \
  -H "authorization: Bearer $SMARTCRAWL_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"alice","dailyLimit":50}'

curl -s -X POST https://smart-crawler.aetherhost.app/v1/scrape \
  -H "authorization: Bearer sc_live_YOUR_KEY" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

Each key has a daily job cap (default 50) and returns `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers. Over quota returns `429`. Jobs are visible only to the key that created them. Paste the key in the playground under Configuration.

## Account sign-up with Odudu

SmartCrawl uses [Odudu](https://github.com/wizzywit/odudu) as an optional OpenID Connect identity provider for dashboard accounts. Odudu handles sign-up and sign-in; SmartCrawl keeps product data such as plans, jobs, quotas, and API keys.

Run Odudu separately with PostgreSQL and HTTPS, then create a `smartcrawl` tenant and register SmartCrawl as a server-side web client. Its redirect URI must exactly match `SMARTCRAWL_OIDC_REDIRECT_URI`.

```bash
export SMARTCRAWL_OIDC_ISSUER='https://auth.example.com/tenants/smartcrawl'
export SMARTCRAWL_OIDC_CLIENT_ID='smartcrawl-web'
export SMARTCRAWL_OIDC_CLIENT_SECRET='set-this-for-a-confidential-client'
export SMARTCRAWL_OIDC_REDIRECT_URI='https://smart-crawler.example.com/auth/callback'
export SMARTCRAWL_FREE_DAILY_LIMIT=25
```

After configuration, the playground displays **Start free**. The browser uses OIDC authorization code flow with PKCE; after returning to SmartCrawl, the user can create a personal `sc_live_…` API key. The key is for their application or server, while the OIDC session is only for the dashboard.

Account endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login` | Start the Odudu sign-in flow |
| GET | `/auth/callback` | OIDC callback (configured redirect URI) |
| POST | `/auth/logout` | End the SmartCrawl browser session |
| GET | `/auth/me` | Current dashboard session |
| GET | `/v1/account` | Account and its API-key summaries |
| POST | `/v1/account/keys` | Create a personal API key (shown once) |
| DELETE | `/v1/account/keys/:id` | Revoke one of the user's keys |

## How extraction works

1. Validate `http(s)` URL, reject SSRF targets (cloud metadata `169.254.169.254`, loopback, RFC1918, IPv6 private/link-local), canonicalize, and check `robots.txt`.
2. Fetch HTML (rejecting binary MIME types and payloads over 5MB) and re-validate the final post-redirect URL against SSRF rules. If it looks like a real document, run Readability and convert to markdown.
3. If the body is a JS shell and `js` is `auto`, render with Playwright (images/fonts/CSS blocked), then extract.
4. Deduplicate links by canonical URL (and merge `/sitemap.xml` during `map`). Persist the job and live per-page progress logs in SQLite, automatically recovering interrupted jobs on server restart.

## Tests

```bash
npm test
```

Fixtures cover article chrome-stripping, HN-style link dedup, SPA shells, robots, SSRF/redirect guards, sitemap discovery, job durability & stale-job recovery, API key lifecycle, and the HTTP API.

Requires Node 22+ (`node:sqlite`).
