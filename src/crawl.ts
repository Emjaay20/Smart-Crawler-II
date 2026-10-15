import { scrape, type ScrapeDeps } from './scrape.js';
import { isAllowedPath } from './paths.js';
import { canonicalizeUrl } from './url.js';

export const DEFAULT_MAP_LIMIT = 50;
export const MAX_MAP_LIMIT = 200;
export const DEFAULT_CRAWL_LIMIT = 5;
export const MAX_CRAWL_LIMIT = 20;

export interface DiscoverRequest {
  url: string;
  limit?: number;
  includePaths?: string[];
  excludePaths?: string[];
  timeoutMs?: number;
  userAgent?: string;
  js?: boolean | 'auto';
}

export interface MapResult {
  success: true;
  sourceUrl: string;
  links: string[];
}

export interface CrawledPage {
  url: string;
  title?: string;
  markdown?: string;
  statusCode: number;
}

export interface CrawlResult {
  success: true;
  pages: CrawledPage[];
}

export async function mapSite(request: DiscoverRequest, deps: ScrapeDeps = {}): Promise<MapResult> {
  const sourceUrl = canonicalizeUrl(request.url);
  const scraped = await scrape({
    url: sourceUrl,
    formats: ['links'],
    onlyMainContent: false,
    js: false,
    timeoutMs: request.timeoutMs,
    userAgent: request.userAgent,
  }, deps);

  const limit = clamp(request.limit ?? DEFAULT_MAP_LIMIT, 1, MAX_MAP_LIMIT);
  const links = (scraped.links ?? [])
    .filter((href) => sameOrigin(sourceUrl, href))
    .filter((href) => isAllowedPath(new URL(href).pathname, request.includePaths, request.excludePaths))
    .slice(0, limit);

  return { success: true, sourceUrl, links };
}

export async function crawlSite(request: DiscoverRequest, deps: ScrapeDeps = {}): Promise<CrawlResult> {
  const seed = canonicalizeUrl(request.url);
  const limit = clamp(request.limit ?? DEFAULT_CRAWL_LIMIT, 1, MAX_CRAWL_LIMIT);
  const queue: string[] = [seed];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];

  while (queue.length && pages.length < limit) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    if (!isAllowedPath(new URL(url).pathname, request.includePaths, request.excludePaths) && url !== seed) {
      continue;
    }
    seen.add(url);

    try {
      const scraped = await scrape({
        url,
        formats: ['markdown', 'links', 'metadata'],
        onlyMainContent: true,
        js: request.js ?? false,
        timeoutMs: request.timeoutMs,
        userAgent: request.userAgent,
      }, deps);
      pages.push({
        url: scraped.metadata.finalUrl || url,
        title: scraped.metadata.title,
        markdown: scraped.markdown,
        statusCode: scraped.metadata.statusCode,
      });
      for (const href of scraped.links ?? []) {
        if (!sameOrigin(seed, href)) continue;
        if (!isAllowedPath(new URL(href).pathname, request.includePaths, request.excludePaths)) continue;
        if (seen.has(href) || queue.includes(href)) continue;
        queue.push(href);
      }
    } catch (err) {
      if (url === seed) throw err;
    }
  }

  return { success: true, pages };
}

function sameOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === b.protocol && a.hostname === b.hostname;
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
