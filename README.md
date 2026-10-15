# SmartCrawl

URL in. Clean markdown and structured JSON out.

Fetch-first scraper: HTTP + Mozilla Readability by default, Playwright only when the page is a JS shell. Jobs persist in SQLite. One Docker image serves the API and the playground.

## Quick start

```bash
npm install
npx playwright install chromium
npm --prefix ui install
npm test
npm run start:server
```

In another terminal:

```bash
npm --prefix ui run dev
```

Open http://localhost:5173. The Vite dev server proxies `/v1`, `/health`, and `/ready` to the API on port 3000.

```bash
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/v1/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

Poll `GET /v1/jobs/:jobId` until `status` is `completed` or `failed`.

CLI:

```bash
npx tsx src/crawler.ts --url "https://example.com" --output results.json
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
- `JOBS_DB` — SQLite path (default `/app/data/jobs.sqlite`)
- `PUBLIC_DIR` — playground build (default `/app/ui/dist`)

Chromium is capped to one concurrent browser. Prefer HTTP pages; JS sites are slower and heavier.

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
