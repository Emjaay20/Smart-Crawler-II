import { chromium, type Browser, type Page } from 'playwright';
import { BoundedTaskScheduler, browserSchedulerLimits } from './browser-scheduler.js';
import { ScrapeError } from './errors.js';
import type { BrowserRender, ResolvedScrapeRequest } from './scrape.js';

const MAX_PAGES = 20;
const scheduler = new BoundedTaskScheduler(
  browserSchedulerLimits().concurrency,
  browserSchedulerLimits().maxPending,
);

interface BrowserState {
  active: number;
  pages: number;
  retired: boolean;
}

let currentBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;
const instances = new Map<Browser, BrowserState>();

export function shouldRecycleBrowser(opts: {
  pagesSinceLaunch: number;
  failed: boolean;
  maxPages?: number;
}): boolean {
  return opts.failed || opts.pagesSinceLaunch >= (opts.maxPages ?? MAX_PAGES);
}

export function browserPoolSnapshot() {
  return {
    ...scheduler.snapshot(),
    liveInstances: instances.size,
  };
}

export function renderWithPlaywright(url: string, request: ResolvedScrapeRequest): Promise<BrowserRender> {
  if (process.env.SMARTCRAWL_BROWSER_EGRESS_ISOLATED !== 'true') {
    return Promise.reject(new ScrapeError(
      'provider_unavailable',
      'Browser rendering requires an isolated network with enforced outbound destination filtering',
    ));
  }
  return scheduler.run(() => render(url, request)).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Browser scheduling capacity exceeded') {
      throw new ScrapeError('provider_unavailable', 'Browser queue is at capacity', { cause: error });
    }
    throw error;
  });
}

/** Stop accepting new browser tasks, drain in-flight contexts, and close all browser processes. */
export async function closeBrowser(): Promise<void> {
  await scheduler.drain();
  if (launching) await launching.catch(() => undefined);
  await Promise.all([...instances.keys()].map((instance) => retireBrowser(instance)));
}

async function retireBrowser(instance: Browser): Promise<void> {
  const state = instances.get(instance);
  if (!state) return;
  state.retired = true;
  if (currentBrowser === instance) currentBrowser = null;
  if (state.active !== 0) return;
  instances.delete(instance);
  await instance.close().catch(() => undefined);
}

async function getBrowser(): Promise<Browser> {
  if (currentBrowser && currentBrowser.isConnected()) return currentBrowser;
  if (currentBrowser && !currentBrowser.isConnected()) await retireBrowser(currentBrowser);
  if (!launching) {
    launching = chromium.launch({ headless: true }).then((instance) => {
      instances.set(instance, { active: 0, pages: 0, retired: false });
      currentBrowser = instance;
      return instance;
    }).finally(() => {
      launching = null;
    });
  }
  return launching;
}

async function acquireBrowser(): Promise<Browser> {
  // A browser may disconnect while another invocation awaits its launch.
  // Retry a stale reference once; never create duplicate launches.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const instance = await getBrowser();
    const state = instances.get(instance);
    if (state && !state.retired && instance.isConnected()) {
      state.active += 1;
      return instance;
    }
    await retireBrowser(instance);
  }
  throw new ScrapeError('provider_unavailable', 'Browser disconnected during startup');
}

async function releaseBrowser(instance: Browser, failed: boolean): Promise<void> {
  const state = instances.get(instance);
  if (!state) return;
  if (!failed) state.pages += 1;
  state.active = Math.max(0, state.active - 1);
  if (!instance.isConnected() || shouldRecycleBrowser({
    pagesSinceLaunch: state.pages,
    failed,
    maxPages: MAX_PAGES,
  })) {
    state.retired = true;
    if (currentBrowser === instance) currentBrowser = null;
  }
  if (state.retired && state.active === 0) await retireBrowser(instance);
}

async function render(url: string, request: ResolvedScrapeRequest): Promise<BrowserRender> {
  const instance = await acquireBrowser();
  const started = Date.now();
  let failed = true;
  try {
    const context = await instance.newContext({
      userAgent: request.userAgent,
      ...(request.proxy ? { proxy: { server: request.proxy } } : {}),
    });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) return route.abort();
        return route.continue();
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: request.timeoutMs });
      const ttfbMs = Date.now() - started;
      if (!response) throw new ScrapeError('unknown', 'No browser response from target URL');

      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(5000, request.timeoutMs) });
      } catch {
        // Return the rendered document even when idle is not reached.
      }

      await autoScroll(page);
      const html = await page.content();
      const finalUrl = page.url();
      failed = false;
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
  } finally {
    await releaseBrowser(instance, failed);
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
