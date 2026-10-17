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

`sc.map(url)` and `sc.crawl(url, { limit: 5 })` wait for the job the same way.

## Use it in a terminal

```bash
npm run build
npx smartcrawl --base https://smart-crawler.aetherhost.com.ng health
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
| GET | `/metrics` | Prometheus counters |
| GET | `/v1/stats` | JSON snapshot of the same counters |
| POST | `/v1/scrape` | Enqueue a scrape job |
| POST | `/v1/map` | Discover same-origin URLs |
| POST | `/v1/crawl` | Multi-page scrape (`limit` max 20) |
| GET | `/v1/jobs/:id` | Job status, logs, result |
| POST | `/v1/admin/keys` | Mint a user key (admin token) |
| GET | `/v1/admin/keys` | List key prefixes and quota (admin) |
| POST | `/crawl` | Legacy alias of `/v1/scrape` |
| GET | `/status/:id` | Legacy alias of `/v1/jobs/:id` |

`POST /v1/scrape` body:

```json
{
  "url": "https://example.com/blog/post",
  "formats": ["markdown", "links", "metadata", "html"],
  "onlyMainContent": true,
  "js": "auto",
  "timeoutMs": 15000,
  "userAgent": "SmartCrawl/1.0"
}
```

`js`: `"auto"` (default) uses HTTP then Playwright if the body looks empty; `false` is HTTP only; `true` always uses Chromium.

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

Errors are typed: `invalid_url`, `robots_blocked`, `timeout`, `dns`, `http_4xx`, `http_5xx`, `js_required`, `extract_empty`, `unknown`.

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

## Auth (multiple users)

Until `SMARTCRAWL_ADMIN_TOKEN` is set, the API is open. Set it on the host, then mint keys. The raw key is shown **once**.

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

Each key has a daily job cap (default 50). Over quota returns `429`. Jobs are visible only to the key that created them. Paste the key in the playground under Configuration.

## How extraction works

1. Validate http(s) URL, canonicalize, check `robots.txt`.
2. Fetch HTML. If it looks like a real document, run Readability and convert to markdown.
3. If the body is a JS shell and `js` is `auto`, render with Playwright (images/fonts/CSS blocked), then extract.
4. Deduplicate links by canonical URL. Persist the job and logs in SQLite.

## Tests

```bash
npm test
```

Fixtures cover article chrome-stripping, HN-style link dedup, SPA shells, robots, job durability, and the HTTP API.

Requires Node 22+ (`node:sqlite`).
