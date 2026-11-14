import { createHash } from 'node:crypto';
import { scrape, type ScrapeDeps } from './scrape.js';
import { createSafeFetch } from './egress.js';
import { DomainPolitenessLimiter } from './circuit.js';
import { isAllowedPath } from './paths.js';
import type { ContentChunk } from './types.js';
import { canonicalizeUrl } from './url.js';

export const DEFAULT_MAP_LIMIT = 50;
export const MAX_MAP_LIMIT = 200;
export const DEFAULT_CRAWL_LIMIT = 5;
export const MAX_CRAWL_LIMIT = 20;
/** Bound the discovered URL frontier independently of the successful-page limit. */
export const MAX_CRAWL_FRONTIER = 500;

export interface DiscoverRequest {
  url: string;
  limit?: number;
  includePaths?: string[];
  excludePaths?: string[];
  timeoutMs?: number;
  userAgent?: string;
  js?: boolean | 'auto';
  crawlDelayMs?: number;
  /** Maximum simultaneous page requests per crawl (1–4, default 1). */
  concurrency?: number;
  proxy?: string;
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
  engine?: 'http' | 'playwright' | 'firecrawl';
  contentHash?: string;
  wordCount?: number;
  estimatedTokens?: number;
  chunks?: ContentChunk[];
}

export interface CrawlResult {
  success: true;
  pages: CrawledPage[];
}

export interface CrawlCheckpointV1 {
  version: 1;
  seed: string;
  requestKey: string;
  pages: CrawledPage[];
  queue: string[];
  seen: string[];
}

/** The fingerprint covers every option that changes crawl results or ordering. */
export function crawlRequestKey(request: DiscoverRequest): string {
  const normalized = {
    seed: canonicalizeUrl(request.url),
    limit: clamp(request.limit ?? DEFAULT_CRAWL_LIMIT, 1, MAX_CRAWL_LIMIT),
    concurrency: clamp(request.concurrency ?? (Number(process.env.SMARTCRAWL_CRAWL_CONCURRENCY) || 1), 1, 4),
    crawlDelayMs: typeof request.crawlDelayMs === 'number' && Number.isFinite(request.crawlDelayMs) && request.crawlDelayMs >= 0
      ? Math.min(request.crawlDelayMs, 60_000) : 250,
    includePaths: request.includePaths ?? [],
    excludePaths: request.excludePaths ?? [],
    timeoutMs: request.timeoutMs ?? null,
    userAgent: request.userAgent ?? null,
    js: request.js ?? false,
    proxy: request.proxy ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Fail closed if a persisted frontier is corrupt or belongs to another request. */
export function validateCrawlCheckpoint(request: DiscoverRequest, data: unknown): CrawlCheckpointV1 {
  const value = data as Partial<CrawlCheckpointV1> | null;
  const seed = canonicalizeUrl(request.url);
  const limit = clamp(request.limit ?? DEFAULT_CRAWL_LIMIT, 1, MAX_CRAWL_LIMIT);
  if (!value || value.version !== 1 || value.seed !== seed ||
      value.requestKey !== crawlRequestKey(request) ||
      !Array.isArray(value.pages) || !Array.isArray(value.queue) || !Array.isArray(value.seen) ||
      value.pages.length > limit || value.queue.length > MAX_CRAWL_FRONTIER ||
      value.seen.length > 1000) {
    throw new Error('Invalid or incompatible persisted crawl checkpoint');
  }
  const checkUrls = (values: unknown[]) => values.every((url) => {
    if (typeof url !== 'string') return false;
    try { return canonicalizeUrl(url) === url && sameOrigin(seed, url); }
    catch { return false; }
  });
  if (!checkUrls(value.queue) || !checkUrls(value.seen) ||
      new Set(value.queue).size !== value.queue.length ||
      new Set(value.seen).size !== value.seen.length ||
      value.queue.some((url) => value.seen!.includes(url)) ||
      value.pages.some((page) => !page || typeof page.url !== 'string' ||
        typeof page.statusCode !== 'number' || !Number.isInteger(page.statusCode))) {
    throw new Error('Corrupt crawl checkpoint frontier or page records');
  }
  return value as CrawlCheckpointV1;
}

export interface CrawlDeps extends ScrapeDeps {
  /** Only supplied by an application after authenticated, explicit resumption. */
  checkpoint?: CrawlCheckpointV1;
  /** Called once per settled BFS batch; must persist atomically or reject. */
  onCheckpoint?: (checkpoint: CrawlCheckpointV1) => void | Promise<void>;
  onPage?: (page: CrawledPage, index: number, limit: number) => void;
  politenessLimiter?: DomainPolitenessLimiter;
}

export async function mapSite(request: DiscoverRequest, deps: ScrapeDeps = {}): Promise<MapResult> {
  const sourceUrl = canonicalizeUrl(request.url);
  const fetchImpl = createSafeFetch(deps.fetch ?? fetch);
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

/**
 * Crawl deterministically in bounded breadth-first batches.
 *
 * A batch is joined before its links are appended to the frontier, so network
 * timing never changes discovery order. Only the seed failure aborts the crawl.
 * Accepted work never exceeds remaining page capacity.
 */
export async function crawlSite(request: DiscoverRequest, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const seed = canonicalizeUrl(request.url);
  const limit = clamp(request.limit ?? DEFAULT_CRAWL_LIMIT, 1, MAX_CRAWL_LIMIT);
  const configuredConcurrency = Number(process.env.SMARTCRAWL_CRAWL_CONCURRENCY);
  const defaultConcurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency : 1;
  const concurrency = clamp(request.concurrency ?? defaultConcurrency, 1, 4);
  const limiter = deps.politenessLimiter ?? new DomainPolitenessLimiter();
  const crawlDelayMs =
    typeof request.crawlDelayMs === 'number' && Number.isFinite(request.crawlDelayMs) && request.crawlDelayMs >= 0
      ? Math.min(request.crawlDelayMs, 60_000) : 250;
  const gate = new PerOriginStartGate(limiter, crawlDelayMs);
  const prior = deps.checkpoint ? validateCrawlCheckpoint(request, deps.checkpoint) : undefined;
  const queue: string[] = prior ? [...prior.queue] : [seed];
  const queued = new Set<string>(queue);
  const seen = new Set<string>(prior?.seen ?? []);
  const pages: CrawledPage[] = prior ? [...prior.pages] : [];

  while (queue.length && pages.length < limit) {
    const batch: string[] = [];
    const availableSlots = Math.min(concurrency, limit - pages.length);
    while (queue.length && batch.length < availableSlots) {
      const url = queue.shift()!;
      queued.delete(url);
      if (seen.has(url)) continue;
      if (!isAllowedPath(new URL(url).pathname, request.includePaths, request.excludePaths) && url !== seed) {
        continue;
      }
      seen.add(url);
      batch.push(url);
    }
    if (!batch.length) continue;

    const results = await Promise.all(batch.map(async (url) => {
      try {
        await gate.acquire(url);
        const scraped = await scrape({
          url,
          formats: ['markdown', 'links', 'metadata'],
          onlyMainContent: true,
          js: request.js ?? false,
          timeoutMs: request.timeoutMs,
          userAgent: request.userAgent,
          proxy: request.proxy,
        }, deps);

        const page: CrawledPage = {
          url: scraped.metadata.finalUrl || url,
          title: scraped.metadata.title,
          markdown: scraped.markdown,
          statusCode: scraped.metadata.statusCode,
          engine: scraped.metadata.engine,
          ...(scraped.metadata.contentHash ? { contentHash: scraped.metadata.contentHash } : {}),
          ...(scraped.metadata.wordCount !== undefined ? { wordCount: scraped.metadata.wordCount } : {}),
          ...(scraped.metadata.estimatedTokens !== undefined ? { estimatedTokens: scraped.metadata.estimatedTokens } : {}),
          ...(scraped.chunks ? { chunks: scraped.chunks } : {}),
        };
        return { url, page, links: scraped.links ?? [], error: undefined as unknown };
      } catch (error) {
        return { url, page: undefined, links: [] as string[], error };
      }
    }));

    for (const result of results) {
      if (result.error) {
        if (result.url === seed) throw result.error;
        continue;
      }
      if (!result.page) continue;
      pages.push(result.page);
      deps.onPage?.(result.page, pages.length, limit);

      // Preserve stable BFS order regardless of which request finishes first.
      for (const href of result.links) {
        let normalized: string;
        try {
          normalized = canonicalizeUrl(href, result.url);
          if (!sameOrigin(seed, normalized)) continue;
          if (!isAllowedPath(new URL(normalized).pathname, request.includePaths, request.excludePaths)) continue;
        } catch {
          continue;
        }
        if (seen.has(normalized) || queued.has(normalized)) continue;
        if (queue.length >= MAX_CRAWL_FRONTIER) break;
        queued.add(normalized);
        queue.push(normalized);
      }
    }
    if (deps.onCheckpoint) {
      await deps.onCheckpoint({
        version: 1,
        seed,
        requestKey: crawlRequestKey(request),
        pages: [...pages],
        queue: [...queue],
        seen: [...seen],
      });
    }
  }

  return { success: true, pages };
}

/**
 * Serialize per-origin start-time reservations while allowing the HTTP fetches
 * themselves to overlap. The underlying limiter is safe even when several
 * same-origin page requests enter the gate at the same time.
 */
class PerOriginStartGate {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly limiter: DomainPolitenessLimiter,
    private readonly delayMs: number,
  ) {}

  async acquire(url: string): Promise<void> {
    const origin = new URL(url).origin;
    const prior = this.tails.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(origin, slot);

    await prior;
    try {
      await this.limiter.acquire(url, this.delayMs, 0);
    } finally {
      release();
      if (this.tails.get(origin) === slot) this.tails.delete(origin);
    }
  }
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
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
