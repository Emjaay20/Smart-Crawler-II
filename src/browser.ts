import { chromium, type Browser, type Page } from 'playwright';
import { ScrapeError } from './errors.js';
import type { BrowserRender, ResolvedScrapeRequest } from './scrape.js';

const MAX_PAGES = 20;

export function shouldRecycleBrowser(opts: {
  pagesSinceLaunch: number;
  failed: boolean;
  maxPages?: number;
}): boolean {
  return opts.failed || opts.pagesSinceLaunch >= (opts.maxPages ?? MAX_PAGES);
}

let queue: Promise<unknown> = Promise.resolve();
let browser: Browser | null = null;
let pagesSinceLaunch = 0;

export function renderWithPlaywright(url: string, request: ResolvedScrapeRequest): Promise<BrowserRender> {
  const run = queue.then(() => render(url, request));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  const current = browser;
  browser = null;
  pagesSinceLaunch = 0;
  await current.close().catch(() => undefined);
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  pagesSinceLaunch = 0;
  return browser;
}

async function render(url: string, request: ResolvedScrapeRequest): Promise<BrowserRender> {
  const instance = await getBrowser();
  const started = Date.now();
  let failed = false;
  try {
    const context = await instance.newContext({ userAgent: request.userAgent });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: request.timeoutMs });
      const ttfbMs = Date.now() - started;
      if (!response) {
        throw new ScrapeError('unknown', `No response from ${url}`);
      }

      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(5000, request.timeoutMs) });
      } catch {
        // proceed with whatever the DOM currently has
      }

      await autoScroll(page);
      const html = await page.content();
      const finalUrl = page.url();
      pagesSinceLaunch += 1;
      return {
        html,
        finalUrl,
        statusCode: response.status(),
        redirectChain: finalUrl === url ? [] : [finalUrl],
        ttfbMs,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (shouldRecycleBrowser({ pagesSinceLaunch, failed, maxPages: MAX_PAGES })) {
      await closeBrowser();
    }
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 8000) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}
