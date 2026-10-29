import { describe, expect, it, vi } from 'vitest';
import { FirecrawlProvider } from '../src/firecrawl.js';

describe('FirecrawlProvider', () => {
  it('keeps its credential server-side and adapts a documented scrape response', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('https://api.firecrawl.dev/v2/scrape');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-private-key' });
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://example.com/article',
        formats: ['markdown', 'links'],
        onlyMainContent: true,
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: '# Article',
          links: ['https://example.com/next'],
          metadata: { title: 'Article', statusCode: 200, url: 'https://example.com/article' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const provider = new FirecrawlProvider('test-private-key', fetchImpl);

    const result = await provider.scrape({
      url: 'https://example.com/article',
      formats: ['markdown', 'links'],
      onlyMainContent: true,
      js: 'auto',
      provider: 'firecrawl',
      timeoutMs: 1000,
      userAgent: 'SmartCrawl/1.0',
    });

    expect(result.metadata.engine).toBe('firecrawl');
    expect(result.markdown).toBe('# Article');
    expect(result.links).toEqual(['https://example.com/next']);
  });

  it('is absent until the deployment has a private environment key', () => {
    expect(FirecrawlProvider.fromEnv({})).toBeUndefined();
    expect(FirecrawlProvider.fromEnv({ FIRECRAWL_API_KEY: ' configured-key ' })).toBeInstanceOf(FirecrawlProvider);
  });
});
