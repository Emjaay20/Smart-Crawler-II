import { extractFromHtml } from './extract.js';
import { classifyError, ScrapeError } from './errors.js';
import { isUrlAllowedByRobots } from './robots.js';
import {
  DEFAULT_FORMATS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  type Format,
  type ScrapeRequest,
  type ScrapeResult,
} from './types.js';
import { canonicalizeUrl, validateHttpUrl } from './url.js';

export interface BrowserRender {
  html: string;
  finalUrl: string;
  statusCode: number;
  redirectChain: string[];
  ttfbMs: number;
}

export interface ScrapeDeps {
  fetch?: typeof fetch;
  renderWithBrowser?: (url: string, request: ResolvedScrapeRequest) => Promise<BrowserRender>;
  now?: () => number;
}

export interface ResolvedScrapeRequest {
  url: string;
  formats: Format[];
  onlyMainContent: boolean;
  js: boolean | 'auto';
  timeoutMs: number;
  userAgent: string;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BLOCKED_CONTENT_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
];

export async function scrape(request: ScrapeRequest, deps: ScrapeDeps = {}): Promise<ScrapeResult> {
  const started = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetch ?? fetch;
  const resolved = resolveRequest(request);

  try {
    await assertRobotsAllowed(resolved, fetchImpl);

    if (resolved.js === true) {
      return finalize(await scrapeWithBrowser(resolved, deps), resolved, started, deps);
    }

    const httpResult = await scrapeWithHttp(resolved, fetchImpl, deps.now);
    const shouldEscalate = resolved.js !== false && httpResult.looksLikeSpa;

    if (!shouldEscalate) {
      if (httpResult.looksLikeSpa && resolved.js === false) {
        throw new ScrapeError('js_required', 'Page looks like a JavaScript shell and js rendering is disabled');
      }
      return finalize(httpResult, resolved, started, deps);
    }

    return finalize(await scrapeWithBrowser(resolved, deps), resolved, started, deps);
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    const classified = classifyError(err);
    throw new ScrapeError(classified.code, classified.message, { cause: err });
  }
}

function resolveRequest(request: ScrapeRequest): ResolvedScrapeRequest {
  const url = canonicalizeUrl(request.url);
  validateHttpUrl(url);
  return {
    url,
    formats: request.formats?.length ? request.formats : DEFAULT_FORMATS,
    onlyMainContent: request.onlyMainContent ?? true,
    js: request.js ?? 'auto',
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: request.userAgent ?? DEFAULT_USER_AGENT,
  };
}

async function assertRobotsAllowed(request: ResolvedScrapeRequest, fetchImpl: typeof fetch): Promise<void> {
  const robotsUrl = new URL('/robots.txt', request.url).href;
  let robotsTxt = '';
  try {
    const res = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': request.userAgent },
      signal: AbortSignal.timeout(Math.min(5000, request.timeoutMs)),
    });
    if (res.ok) robotsTxt = await res.text();
  } catch {
    return;
  }
  if (!isUrlAllowedByRobots(robotsTxt, request.userAgent, request.url)) {
    throw new ScrapeError('robots_blocked', `robots.txt disallows ${request.url}`);
  }
}

async function scrapeWithHttp(
  request: ResolvedScrapeRequest,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): Promise<HttpPage> {
  const t0 = now();
  const res = await fetchImpl(request.url, {
    headers: { 'user-agent': request.userAgent, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'follow',
  });
  const ttfbMs = now() - t0;

  const finalUrl = res.url || request.url;
  if (finalUrl !== request.url) {
    validateHttpUrl(finalUrl);
  }

  if (res.status >= 400 && res.status < 500) {
    throw new ScrapeError('http_4xx', `HTTP ${res.status} fetching ${request.url}`);
  }
  if (res.status >= 500) {
    throw new ScrapeError('http_5xx', `HTTP ${res.status} fetching ${request.url}`);
  }

  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (BLOCKED_CONTENT_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
    throw new ScrapeError('invalid_url', `Unsupported content-type for HTML extraction: ${contentType}`);
  }

  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    throw new ScrapeError('invalid_url', 'Response body exceeds 5MB limit');
  }

  const html = await res.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new ScrapeError('invalid_url', 'Response body exceeds 5MB limit');
  }

  const extracted = extractFromHtml(html, finalUrl, {
    onlyMainContent: request.onlyMainContent,
    formats: request.formats,
  });

  return {
    engine: 'http',
    html,
    extracted,
    looksLikeSpa: extracted.looksLikeSpa,
    statusCode: res.status,
    finalUrl,
    redirectChain: finalUrl === request.url ? [] : [finalUrl],
    ttfbMs,
    charset: charsetFromContentType(res.headers.get('content-type')),
  };
}

async function scrapeWithBrowser(request: ResolvedScrapeRequest, deps: ScrapeDeps): Promise<HttpPage> {
  if (!deps.renderWithBrowser) {
    throw new ScrapeError('js_required', 'JavaScript rendering required but no browser engine is configured');
  }
  const rendered = await deps.renderWithBrowser(request.url, request);
  const finalUrl = rendered.finalUrl || request.url;
  if (finalUrl !== request.url) {
    validateHttpUrl(finalUrl);
  }
  const extracted = extractFromHtml(rendered.html, finalUrl, {
    onlyMainContent: request.onlyMainContent,
    formats: request.formats,
  });
  return {
    engine: 'playwright',
    html: rendered.html,
    extracted,
    looksLikeSpa: extracted.looksLikeSpa,
    statusCode: rendered.statusCode,
    finalUrl,
    redirectChain: rendered.redirectChain,
    ttfbMs: rendered.ttfbMs,
    charset: 'utf-8',
  };
}

interface HttpPage {
  engine: 'http' | 'playwright';
  html: string;
  extracted: ReturnType<typeof extractFromHtml>;
  looksLikeSpa: boolean;
  statusCode: number;
  finalUrl: string;
  redirectChain: string[];
  ttfbMs: number;
  charset?: string;
}

function finalize(page: HttpPage, request: ResolvedScrapeRequest, started: number, deps: ScrapeDeps): ScrapeResult {
  const now = deps.now ?? Date.now;
  const { extracted } = page;
  return {
    success: true,
    markdown: extracted.markdown,
    html: extracted.html,
    links: extracted.links,
    metadata: {
      title: extracted.metadata.title,
      description: extracted.metadata.description,
      statusCode: page.statusCode,
      sourceUrl: request.url,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
      engine: page.engine,
      charset: page.charset,
    },
    warnings: extracted.warnings,
    timing: { ttfbMs: page.ttfbMs, totalMs: now() - started },
  };
}

function charsetFromContentType(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /charset=([^;]+)/i.exec(value);
  return match?.[1]?.trim();
}
