import { ProxyAgent } from 'undici';
import { detectAntiBotChallenge } from './antibot.js';
import type { DomainCircuitBreaker } from './circuit.js';
import { extractFromHtml } from './extract.js';
import { classifyError, ScrapeError } from './errors.js';
import { fetchRobotsTxtCached, isUrlAllowedByRobots } from './robots.js';
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
  scrapeWithFirecrawl?: (request: ResolvedScrapeRequest) => Promise<ScrapeResult>;
  circuitBreaker?: DomainCircuitBreaker;
  onRetry?: (attempt: number, statusCode: number) => void;
  now?: () => number;
}

export interface ResolvedScrapeRequest {
  url: string;
  formats: Format[];
  onlyMainContent: boolean;
  js: boolean | 'auto';
  provider: 'local' | 'auto' | 'firecrawl';
  timeoutMs: number;
  userAgent: string;
  maxRetries: number;
  proxy?: string;
}

const proxyAgents = new Map<string, ProxyAgent>();

export function getProxyAgent(proxyUrl?: string): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

function resolveProxyUrl(requestProxy?: string): string | undefined {
  const candidate =
    requestProxy?.trim() ||
    process.env.SMARTCRAWL_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  if (!candidate) return undefined;
  validateHttpUrl(candidate);
  return candidate;
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
  const origin = new URL(resolved.url).origin;

  try {
    await assertRobotsAllowed(resolved, fetchImpl, deps.now);

    if (resolved.provider === 'firecrawl') return scrapeWithConfiguredFirecrawl(resolved, deps);

    const circuit = deps.circuitBreaker?.isOpen(origin);
    if (circuit?.open) {
      const err = new ScrapeError(
        'circuit_broken',
        `Domain circuit breaker open for ${origin} (${Math.ceil(circuit.remainingMs / 1000)}s cooldown remaining)`,
      );
      if (resolved.provider === 'auto' && deps.scrapeWithFirecrawl) {
        return deps.scrapeWithFirecrawl(resolved);
      }
      throw err;
    }

    try {
      const result = await scrapeLocally(resolved, fetchImpl, started, deps);
      deps.circuitBreaker?.recordSuccess(origin);
      return result;
    } catch (err) {
      if (err instanceof ScrapeError && (err.code === 'anti_bot_detected' || err.code === 'http_4xx')) {
        deps.circuitBreaker?.recordFailure(origin, err.code);
      }
      if (resolved.provider === 'auto' && canEscalateToFirecrawl(err) && deps.scrapeWithFirecrawl) {
        return deps.scrapeWithFirecrawl(resolved);
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    const classified = classifyError(err);
    throw new ScrapeError(classified.code, classified.message, { cause: err });
  }
}

function resolveRequest(request: ScrapeRequest): ResolvedScrapeRequest {
  const url = canonicalizeUrl(request.url);
  validateHttpUrl(url);
  const proxy = resolveProxyUrl(request.proxy);
  return {
    url,
    formats: request.formats?.length ? request.formats : DEFAULT_FORMATS,
    onlyMainContent: request.onlyMainContent ?? true,
    js: request.js ?? 'auto',
    provider: request.provider ?? 'local',
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: request.userAgent ?? DEFAULT_USER_AGENT,
    maxRetries: Math.min(3, Math.max(0, Math.floor(request.maxRetries ?? 1))),
    ...(proxy ? { proxy } : {}),
  };
}

async function scrapeLocally(
  resolved: ResolvedScrapeRequest,
  fetchImpl: typeof fetch,
  started: number,
  deps: ScrapeDeps,
): Promise<ScrapeResult> {
  if (resolved.js === true) {
    return finalize(await scrapeWithBrowser(resolved, deps), resolved, started, deps);
  }

  const httpResult = await scrapeWithHttp(resolved, fetchImpl, deps.now, deps.onRetry);
  const shouldEscalate = resolved.js !== false && httpResult.looksLikeSpa;

  if (!shouldEscalate) {
    if (httpResult.looksLikeSpa && resolved.js === false) {
      throw new ScrapeError('js_required', 'Page looks like a JavaScript shell and js rendering is disabled');
    }
    return finalize(httpResult, resolved, started, deps);
  }

  return finalize(await scrapeWithBrowser(resolved, deps), resolved, started, deps);
}

function scrapeWithConfiguredFirecrawl(request: ResolvedScrapeRequest, deps: ScrapeDeps): Promise<ScrapeResult> {
  if (!deps.scrapeWithFirecrawl) {
    throw new ScrapeError('provider_unavailable', 'Firecrawl is not configured for this SmartCrawl deployment');
  }
  return deps.scrapeWithFirecrawl(request);
}

function canEscalateToFirecrawl(err: unknown): boolean {
  if (!(err instanceof ScrapeError)) return false;
  return ['http_4xx', 'http_5xx', 'timeout', 'js_required', 'anti_bot_detected', 'circuit_broken'].includes(err.code);
}

async function assertRobotsAllowed(
  request: ResolvedScrapeRequest,
  fetchImpl: typeof fetch,
  now?: () => number,
): Promise<void> {
  const robotsTxt = await fetchRobotsTxtCached(request.url, request.userAgent, request.timeoutMs, fetchImpl, now);
  if (!isUrlAllowedByRobots(robotsTxt, request.userAgent, request.url)) {
    throw new ScrapeError('robots_blocked', `robots.txt disallows ${request.url}`);
  }
}

const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

async function scrapeWithHttp(
  request: ResolvedScrapeRequest,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
  onRetry?: (attempt: number, statusCode: number) => void,
): Promise<HttpPage> {
  const t0 = now();
  const proxyAgent = getProxyAgent(request.proxy);
  const init: RequestInit & { dispatcher?: ProxyAgent } = {
    headers: { 'user-agent': request.userAgent, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'follow',
    ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
  };

  let res: Response | undefined;
  for (let attempt = 0; attempt <= request.maxRetries; attempt += 1) {
    res = await fetchImpl(request.url, init);
    if (!TRANSIENT_STATUS_CODES.has(res.status) || attempt === request.maxRetries) {
      break;
    }
    onRetry?.(attempt + 1, res.status);
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(2000, retryAfterSec * 1000)
      : Math.min(500, 60 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const response = res!;
  const ttfbMs = now() - t0;

  const finalUrl = response.url || request.url;
  if (finalUrl !== request.url) {
    validateHttpUrl(finalUrl);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (BLOCKED_CONTENT_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
    throw new ScrapeError('invalid_url', `Unsupported content-type for HTML extraction: ${contentType}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    throw new ScrapeError('invalid_url', 'Response body exceeds 5MB limit');
  }

  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new ScrapeError('invalid_url', 'Response body exceeds 5MB limit');
  }

  const antiBot = detectAntiBotChallenge(response, html);
  if (antiBot.detected) {
    throw new ScrapeError(
      'anti_bot_detected',
      antiBot.reason || `Anti-bot or WAF challenge detected (${antiBot.provider ?? 'unknown'})`,
      { challengeProvider: antiBot.provider },
    );
  }

  if (response.status >= 400 && response.status < 500) {
    throw new ScrapeError('http_4xx', `HTTP ${response.status} fetching ${request.url}`);
  }
  if (response.status >= 500) {
    throw new ScrapeError('http_5xx', `HTTP ${response.status} fetching ${request.url}`);
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
    statusCode: response.status,
    finalUrl,
    redirectChain: finalUrl === request.url ? [] : [finalUrl],
    ttfbMs,
    charset: charsetFromContentType(response.headers.get('content-type')),
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
    ...(extracted.chunks ? { chunks: extracted.chunks } : {}),
    metadata: {
      title: extracted.metadata.title,
      description: extracted.metadata.description,
      ...(extracted.metadata.contentHash ? { contentHash: extracted.metadata.contentHash } : {}),
      ...(extracted.metadata.wordCount !== undefined ? { wordCount: extracted.metadata.wordCount } : {}),
      ...(extracted.metadata.estimatedTokens !== undefined ? { estimatedTokens: extracted.metadata.estimatedTokens } : {}),
      statusCode: page.statusCode,
      sourceUrl: request.url,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
      engine: page.engine,
      charset: page.charset,
      ...(request.proxy ? { proxy: true } : {}),
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
