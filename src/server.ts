import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { AccountStore } from './accounts.js';
import { closeBrowser, isBrowserConfigured, renderWithPlaywright } from './browser.js';
import { crawlSite, mapSite } from './crawl.js';
import { KeyStore } from './keys.js';
import { JobStore } from './jobs.js';
import { Metrics } from './metrics.js';
import { OidcClient } from './oidc.js';
import { DomainCircuitBreaker } from './circuit.js';
import { FirecrawlProvider } from './firecrawl.js';
import { scrape } from './scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const dbPath = process.env.JOBS_DB ?? path.join(__dirname, '../data/jobs.sqlite');
const publicDir = process.env.PUBLIC_DIR ?? path.join(__dirname, '../ui/dist');

const store = new JobStore(dbPath);
const enablePendingRecovery = process.env.SMARTCRAWL_ENABLE_PENDING_RECOVERY === 'true';
const enableCrawlCheckpoints = process.env.SMARTCRAWL_ENABLE_CRAWL_CHECKPOINTS === 'true';
const enableCheckpointResume = process.env.SMARTCRAWL_ENABLE_CHECKPOINT_RESUME === 'true';
const recoverySummary = enablePendingRecovery
  ? store.prepareRestartRecovery()
  : { recoverablePending: 0, markedFailed: store.recoverStaleJobs(
      undefined, enableCrawlCheckpoints && enableCheckpointResume ? 'restart_interrupted' : 'unknown',
    ) };

const keys = new KeyStore(store.db);
const accounts = new AccountStore(store.db);
const metrics = new Metrics();
const firecrawl = FirecrawlProvider.fromEnv();
const circuitBreaker = new DomainCircuitBreaker();
const proxyConfigured = Boolean(
  process.env.SMARTCRAWL_PROXY_URL?.trim() &&
  process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS === 'true',
);
const scrapeDeps = {
  renderWithBrowser: renderWithPlaywright,
  circuitBreaker,
  onRetry: () => metrics.recordRetry(),
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
  firecrawlLocal: Boolean(firecrawl?.isLocal),
  proxyConfigured,
  browserConfigured: isBrowserConfigured(),
  enableCrawlCheckpoints,
  enableCheckpointResume,
  guestDemoLimit: Math.max(0, Number(process.env.SMARTCRAWL_GUEST_DEMO_LIMIT ?? 2)),
  scrape: (request) => scrape(request, scrapeDeps),
  map: (request) => mapSite(request, scrapeDeps),
  crawl: (request, hooks) => crawlSite(request, { ...scrapeDeps, ...hooks }),
});

const server = app.listen(PORT, HOST, () => {
  console.log(`SmartCrawl listening on http://${HOST}:${PORT}`);
});
// Only opt-in, exclusively-owned SQLite deployments may resume unclaimed work.
if (enablePendingRecovery) {
  const scheduled = (app.locals.resumePendingCrawls as () => number)();
  console.info('Pending crawl recovery:', {
    markedFailed: recoverySummary.markedFailed,
    recoverablePending: recoverySummary.recoverablePending,
    scheduled,
  });
}

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
