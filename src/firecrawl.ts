import type { ResolvedScrapeRequest } from './scrape.js';
import type { ScrapeResult } from './types.js';
import { validateHttpUrl } from './url.js';

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';

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
 * Small server-side adapter for Firecrawl's documented v2 scrape endpoint.
 * It deliberately accepts only a server environment key: browser clients never
 * receive or submit provider credentials.
 */
export class FirecrawlProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(env = process.env): FirecrawlProvider | undefined {
    const apiKey = env.FIRECRAWL_API_KEY?.trim();
    return apiKey ? new FirecrawlProvider(apiKey) : undefined;
  }

  async scrape(request: ResolvedScrapeRequest): Promise<ScrapeResult> {
    const started = Date.now();
    const formats = request.formats.filter((format) => format !== 'metadata');
    const response = await this.fetchImpl(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
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
    const warning = typeof data.warning === 'string' ? data.warning : undefined;

    return {
      success: true,
      markdown: typeof data.markdown === 'string' ? data.markdown : undefined,
      html: typeof data.html === 'string' ? data.html : undefined,
      links: stringArray(data.links),
      metadata: {
        title: typeof metadata.title === 'string' ? metadata.title : undefined,
        description: typeof metadata.description === 'string' ? metadata.description : undefined,
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
