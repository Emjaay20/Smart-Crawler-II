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

export interface CrawlDeps extends ScrapeDeps {
  onPage?: (page: CrawledPage, index: number, limit: number) => void;
}

export async function mapSite(request: DiscoverRequest, deps: ScrapeDeps = {}): Promise<MapResult> {
  const sourceUrl = canonicalizeUrl(request.url);
  const fetchImpl = deps.fetch ?? fetch;
  const [scraped, sitemapLinks] = await Promise.all([
    scrape({
      url: sourceUrl,
      formats: ['links'],
      onlyMainContent: false,
      js: request.js ?? false,
      timeoutMs: request.timeoutMs,
      userAgent: request.userAgent,
    }, deps),
    fetchSitemapLinks(sourceUrl, fetchImpl, request.userAgent, request.timeoutMs),
  ]);

  const limit = clamp(request.limit ?? DEFAULT_MAP_LIMIT, 1, MAX_MAP_LIMIT);
  const merged = new Set<string>();
  for (const href of [...(scraped.links ?? []), ...sitemapLinks]) {
    if (!sameOrigin(sourceUrl, href)) continue;
    try {
      if (!isAllowedPath(new URL(href).pathname, request.includePaths, request.excludePaths)) continue;
      merged.add(href);
    } catch {
      continue;
    }
    if (merged.size >= limit) break;
  }

  return { success: true, sourceUrl, links: Array.from(merged) };
}

export async function crawlSite(request: DiscoverRequest, deps: CrawlDeps = {}): Promise<CrawlResult> {
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
      const page: CrawledPage = {
        url: scraped.metadata.finalUrl || url,
        title: scraped.metadata.title,
        markdown: scraped.markdown,
        statusCode: scraped.metadata.statusCode,
      };
      pages.push(page);
      deps.onPage?.(page, pages.length, limit);

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

async function fetchSitemapLinks(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  userAgent?: string,
  timeoutMs = 5000,
): Promise<string[]> {
  try {
    const sitemapUrl = new URL('/sitemap.xml', sourceUrl).href;
    const res = await fetchImpl(sitemapUrl, {
      headers: userAgent ? { 'user-agent': userAgent } : undefined,
      signal: AbortSignal.timeout(Math.min(3000, timeoutMs)),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
    const urls: string[] = [];
    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      try {
        urls.push(canonicalizeUrl(raw, sourceUrl));
      } catch {
        // ignore invalid or non-http sitemap entries
      }
    }
    return urls;
  } catch {
    return [];
  }
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
