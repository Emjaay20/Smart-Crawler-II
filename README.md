# SmartCrawl

URL in. Clean markdown and structured JSON out.

Live: [https://smart-crawler.aetherhost.com.ng](https://smart-crawler.aetherhost.com.ng)  
OpenAPI: [`openapi.yaml`](./openapi.yaml)

Fetch-first: HTTP + Mozilla Readability by default. Playwright only when the page is a JS shell (not installed on AetherHost’s 512MB tenant). Jobs persist in SQLite.

## Use it in code

```ts
import { SmartCrawl } from 'smart-crawler';

const sc = new SmartCrawl({
  baseUrl: 'https://smart-crawler.aetherhost.com.ng',
  apiKey: process.env.SMARTCRAWL_API_KEY, // required once auth is on
});

const doc = await sc.scrape('https://example.com');
console.log(doc.markdown);
```

`sc.map(url)` and `sc.crawl(url, { limit: 5 })` wait for the job the same way. `sc.me()` inspects current key quota and `sc.listJobs()` lists recent jobs.

## Use it in a terminal

```bash
npm run build
npx smartcrawl --base https://smart-crawler.aetherhost.com.ng health
npx smartcrawl me
npx smartcrawl jobs
npx smartcrawl report
npx smartcrawl scrape https://example.com
npx smartcrawl map https://example.com --limit 10
npx smartcrawl crawl https://example.com --limit 3
```

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

`provider`: `"local"` (default) keeps work inside SmartCrawl's HTTP/Playwright pipeline. When an operator has configured `FIRECRAWL_API_KEY` as a private deployment environment variable, a single-page request may use `"firecrawl"`, or `"auto"` may use it only after an eligible local failure. Provider credentials are never accepted from, returned to, or stored by the browser. Map and crawl jobs always stay local so a multi-page request cannot unexpectedly consume managed-provider credits.

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

Errors are typed: `invalid_url`, `robots_blocked`, `timeout`, `dns`, `http_4xx`, `http_5xx`, `js_required`, `provider_unavailable`, `extract_empty`, `unknown`.

## Docker / AetherHost

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
- `SMARTCRAWL_ADMIN_TOKEN` — when set, scrape/map/crawl require a user API key
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

## Auth (multiple users)

Until `SMARTCRAWL_ADMIN_TOKEN` (or `/app/data/admin.token`) is set, the API is open. Set it on the host, then mint keys. The raw key is shown **once**.

```bash
export SMARTCRAWL_ADMIN_TOKEN='a-long-random-secret'

curl -s -X POST https://smart-crawler.aetherhost.com.ng/v1/admin/keys \
  -H "authorization: Bearer $SMARTCRAWL_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"alice","dailyLimit":50}'

curl -s -X POST https://smart-crawler.aetherhost.com.ng/v1/scrape \
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
