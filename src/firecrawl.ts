import { enrichMarkdownDocument } from './extract.js';
import type { ResolvedScrapeRequest } from './scrape.js';
import type { ScrapeResult } from './types.js';
import { validateHttpUrl } from './url.js';
import { assertSourceStatus } from './errors.js';

const DEFAULT_FIRECRAWL_API_URL = 'https://api.firecrawl.dev';

export function resolveFirecrawlBaseUrl(env = process.env): string {
  const custom = env.FIRECRAWL_BASE_URL?.trim() || env.FIRECRAWL_API_URL?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return DEFAULT_FIRECRAWL_API_URL;
}

export function isLocalFirecrawlEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: unknown;
    html?: unknown;
    links?: unknown;
    warning?: unknown;
    metadata?: {
      title?: unknown;
      description?: unknown;
      statusCode?: unknown;
      url?: unknown;
      sourceURL?: unknown;
    };
  };
  error?: unknown;
}

/**
 * Adapter for Firecrawl's v2 scrape endpoint, supporting either Firecrawl Cloud
 * (https://api.firecrawl.dev) or Firecrawl Local (e.g. http://127.0.0.1:3002).
 * When targeting a local binary endpoint, an API key is optional.
 */
export class FirecrawlProvider {
  readonly baseUrl: string;
  readonly isLocal: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey?: string,
    baseUrlOrFetch?: string | typeof fetch,
    fetchImpl?: typeof fetch,
  ) {
    if (typeof baseUrlOrFetch === 'function') {
      this.baseUrl = DEFAULT_FIRECRAWL_API_URL;
      this.fetchImpl = baseUrlOrFetch;
    } else {
      this.baseUrl = baseUrlOrFetch ? baseUrlOrFetch.replace(/\/+$/, '') : DEFAULT_FIRECRAWL_API_URL;
      this.fetchImpl = fetchImpl ?? fetch;
    }
    this.isLocal = isLocalFirecrawlEndpoint(this.baseUrl);
  }

  static fromEnv(env = process.env): FirecrawlProvider | undefined {
    const baseUrl = resolveFirecrawlBaseUrl(env);
    const isLocal = isLocalFirecrawlEndpoint(baseUrl);
    const apiKey = env.FIRECRAWL_API_KEY?.trim();

    // For cloud Firecrawl, apiKey is strictly required. For local Firecrawl, it's optional.
    if (!apiKey && !isLocal) {
      return undefined;
    }
    return new FirecrawlProvider(apiKey, baseUrl);
  }

  get scrapeUrl(): string {
    return `${this.baseUrl}/v2/scrape`;
  }

  async scrape(request: ResolvedScrapeRequest): Promise<ScrapeResult> {
    const started = Date.now();
    const formats = request.formats.filter((format) => format !== 'metadata');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(this.scrapeUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(request.timeoutMs),
      body: JSON.stringify({
        url: request.url,
        formats: formats.length ? formats : ['markdown'],
        onlyMainContent: request.onlyMainContent,
      }),
    });
    const payload = await response.json().catch(() => ({})) as FirecrawlResponse;
    if (!response.ok || !payload.success || !payload.data) {
      const detail = typeof payload.error === 'string' ? payload.error : `Firecrawl returned HTTP ${response.status}`;
      throw new Error(detail);
    }

    const data = payload.data;
    const metadata = data.metadata ?? {};
    const finalUrl = firstString(metadata.url, metadata.sourceURL) ?? request.url;
    validateHttpUrl(finalUrl);
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : 200;
    assertSourceStatus(statusCode, finalUrl);
    const warning = typeof data.warning === 'string' ? data.warning : undefined;
    const markdown = typeof data.markdown === 'string' ? data.markdown : undefined;
    const enrichment = markdown ? enrichMarkdownDocument(markdown) : undefined;

    return {
      success: true,
      markdown,
      html: typeof data.html === 'string' ? data.html : undefined,
      links: stringArray(data.links),
      ...(enrichment ? { chunks: enrichment.chunks } : {}),
      metadata: {
        title: typeof metadata.title === 'string' ? metadata.title : undefined,
        description: typeof metadata.description === 'string' ? metadata.description : undefined,
        ...(enrichment?.contentHash ? { contentHash: enrichment.contentHash } : {}),
        ...(enrichment ? { wordCount: enrichment.wordCount, estimatedTokens: enrichment.estimatedTokens } : {}),
        statusCode,
        sourceUrl: request.url,
        finalUrl,
        redirectChain: finalUrl === request.url ? [] : [finalUrl],
        engine: 'firecrawl',
        charset: 'utf-8',
      },
      warnings: warning ? [warning] : [],
      timing: { ttfbMs: 0, totalMs: Date.now() - started },
    };
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}
