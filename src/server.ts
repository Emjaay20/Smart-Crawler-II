import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { AccountStore } from './accounts.js';
import { closeBrowser, renderWithPlaywright } from './browser.js';
import { crawlSite, mapSite } from './crawl.js';
import { KeyStore } from './keys.js';
import { JobStore } from './jobs.js';
import { Metrics } from './metrics.js';
import { OidcClient } from './oidc.js';
import { FirecrawlProvider } from './firecrawl.js';
import { scrape } from './scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const dbPath = process.env.JOBS_DB ?? path.join(__dirname, '../data/jobs.sqlite');
const publicDir = process.env.PUBLIC_DIR ?? path.join(__dirname, '../ui/dist');

const store = new JobStore(dbPath);
store.recoverStaleJobs();

const keys = new KeyStore(store.db);
const accounts = new AccountStore(store.db);
const metrics = new Metrics();
const firecrawl = FirecrawlProvider.fromEnv();
const scrapeDeps = {
  renderWithBrowser: renderWithPlaywright,
  ...(firecrawl ? { scrapeWithFirecrawl: firecrawl.scrape.bind(firecrawl) } : {}),
};
const adminToken = resolveAdminToken(dbPath);

const app = createApp({
  store,
  keys,
  accounts,
  oidc: OidcClient.fromEnv(),
  adminToken,
  publicDir,
  metrics,
  firecrawlConfigured: Boolean(firecrawl),
  scrape: (request) => scrape(request, scrapeDeps),
  map: (request) => mapSite(request, scrapeDeps),
  crawl: (request, hooks) => crawlSite(request, { ...scrapeDeps, ...hooks }),
});

const server = app.listen(PORT, HOST, () => {
  console.log(`SmartCrawl listening on http://${HOST}:${PORT}`);
});

function resolveAdminToken(sqlitePath: string): string | undefined {
  const fromEnv = process.env.SMARTCRAWL_ADMIN_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenFile = process.env.SMARTCRAWL_ADMIN_TOKEN_FILE ?? path.join(path.dirname(sqlitePath), 'admin.token');
  try {
    if (fs.existsSync(tokenFile)) {
      const value = fs.readFileSync(tokenFile, 'utf8').trim();
      if (value) return value;
    }
  } catch {
    // ignore unreadable token file
  }
  return undefined;
}

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeBrowser();
  store.close();
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
