import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { closeBrowser, renderWithPlaywright } from './browser.js';
import { crawlSite, mapSite } from './crawl.js';
import { JobStore } from './jobs.js';
import { Metrics } from './metrics.js';
import { scrape } from './scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const dbPath = process.env.JOBS_DB ?? path.join(__dirname, '../data/jobs.sqlite');
const publicDir = process.env.PUBLIC_DIR ?? path.join(__dirname, '../ui/dist');

const store = new JobStore(dbPath);
const metrics = new Metrics();
const scrapeDeps = { renderWithBrowser: renderWithPlaywright };

const app = createApp({
  store,
  publicDir,
  metrics,
  scrape: (request) => scrape(request, scrapeDeps),
  map: (request) => mapSite(request, scrapeDeps),
  crawl: (request) => crawlSite(request, scrapeDeps),
});

const server = app.listen(PORT, () => {
  console.log(`SmartCrawl listening on http://localhost:${PORT}`);
});

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
