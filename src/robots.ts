import robotsParser from 'robots-parser';

const ROBOTS_CACHE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_CACHE_MAX_ENTRIES = 500;

interface CachedRobots {
  txt: string;
  expiresAt: number;
}

const cachesByFetch = new WeakMap<typeof fetch, Map<string, CachedRobots>>();

export function isUrlAllowedByRobots(robotsTxt: string, userAgent: string, url: string): boolean {
  if (!robotsTxt.trim()) return true;
  const origin = new URL(url).origin;
  const parser = robotsParser(`${origin}/robots.txt`, robotsTxt);
  return parser.isAllowed(url, userAgent) !== false;
}

export function getCrawlDelayFromRobots(robotsTxt: string, userAgent: string, url: string): number | undefined {
  if (!robotsTxt.trim()) return undefined;
  const origin = new URL(url).origin;
  const parser = robotsParser(`${origin}/robots.txt`, robotsTxt);
  const delay = parser.getCrawlDelay(userAgent);
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export async function fetchRobotsTxtCached(
  targetUrl: string,
  userAgent: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): Promise<string> {
  const origin = new URL(targetUrl).origin;
  let cache = cachesByFetch.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    cachesByFetch.set(fetchImpl, cache);
  }

  const current = now();
  const cached = cache.get(origin);
  if (cached && cached.expiresAt > current) {
    return cached.txt;
  }

  const robotsUrl = new URL('/robots.txt', origin).href;
  let robotsTxt = '';
  try {
    const res = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(Math.min(5000, timeoutMs)),
    });
    if (res.ok) robotsTxt = await res.text();
  } catch {
    return '';
  }

  if (cache.size >= ROBOTS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(origin, { txt: robotsTxt, expiresAt: current + ROBOTS_CACHE_TTL_MS });
  return robotsTxt;
}
