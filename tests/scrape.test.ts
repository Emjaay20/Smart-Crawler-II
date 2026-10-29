import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { scrape } from '../src/scrape.js';
import { ScrapeError } from '../src/errors.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const articleHtml = readFileSync(join(fixtures, 'article.html'), 'utf8');
const spaHtml = readFileSync(join(fixtures, 'spa-shell.html'), 'utf8');

function htmlFetch(map: Record<string, { status?: number; body: string; contentType?: string; headers?: Record<string, string> }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const hit = map[url];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body, {
      status: hit.status ?? 200,
      headers: {
        'content-type': hit.contentType ?? 'text/html; charset=utf-8',
        ...(hit.headers ?? {}),
      },
    });
  }) as typeof fetch;
}

describe('scrape', () => {
  it('uses HTTP extraction and does not launch a browser for a real article', async () => {
    const renderWithBrowser = vi.fn();
    const result = await scrape(
      { url: 'https://food.example/blog/yams' },
      {
        fetch: htmlFetch({ 'https://food.example/blog/yams': { body: articleHtml } }),
        renderWithBrowser,
      },
    );

    expect(result.success).toBe(true);
    expect(result.metadata.engine).toBe('http');
    expect(result.markdown).toMatch(/Peel the yams/);
    expect(result.metadata.statusCode).toBe(200);
    expect(result.metadata.sourceUrl).toBe('https://food.example/blog/yams');
    expect(renderWithBrowser).not.toHaveBeenCalled();
  });

  it('falls back to Playwright when the HTTP body is a JS shell', async () => {
    const result = await scrape(
      { url: 'https://app.example/', js: 'auto' },
      {
        fetch: htmlFetch({ 'https://app.example/': { body: spaHtml } }),
        renderWithBrowser: async () => ({
          html: articleHtml,
          finalUrl: 'https://app.example/',
          statusCode: 200,
          redirectChain: [],
          ttfbMs: 12,
        }),
      },
    );

    expect(result.metadata.engine).toBe('playwright');
    expect(result.markdown).toMatch(/Peel the yams/);
  });

  it('throws js_required when a shell is fetched and js is disabled', async () => {
    await expect(
      scrape(
        { url: 'https://app.example/', js: false },
        { fetch: htmlFetch({ 'https://app.example/': { body: spaHtml } }) },
      ),
    ).rejects.toMatchObject({ code: 'js_required' } satisfies Partial<ScrapeError>);
  });

  it('uses the explicitly selected managed provider only after robots validation', async () => {
    const scrapeWithFirecrawl = vi.fn(async () => ({
      success: true as const,
      markdown: '# Managed result',
      links: [],
      metadata: {
        statusCode: 200,
        sourceUrl: 'https://food.example/managed',
        finalUrl: 'https://food.example/managed',
        redirectChain: [],
        engine: 'firecrawl' as const,
      },
      warnings: [],
      timing: { ttfbMs: 0, totalMs: 10 },
    }));
    const result = await scrape(
      { url: 'https://food.example/managed', provider: 'firecrawl' },
      { fetch: htmlFetch({}), scrapeWithFirecrawl },
    );

    expect(result.metadata.engine).toBe('firecrawl');
    expect(scrapeWithFirecrawl).toHaveBeenCalledOnce();
  });

  it('falls back to the managed provider only in auto mode after an eligible local failure', async () => {
    const scrapeWithFirecrawl = vi.fn(async () => ({
      success: true as const,
      markdown: '# Recovered result',
      links: [],
      metadata: {
        statusCode: 200,
        sourceUrl: 'https://food.example/missing',
        finalUrl: 'https://food.example/missing',
        redirectChain: [],
        engine: 'firecrawl' as const,
      },
      warnings: [],
      timing: { ttfbMs: 0, totalMs: 10 },
    }));
    const result = await scrape(
      { url: 'https://food.example/missing', provider: 'auto' },
      { fetch: htmlFetch({}), scrapeWithFirecrawl },
    );

    expect(result.metadata.engine).toBe('firecrawl');
    expect(scrapeWithFirecrawl).toHaveBeenCalledOnce();
  });

  it('throws robots_blocked when robots.txt disallows the path', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private\n', { status: 200 });
      }
      return new Response(articleHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    await expect(
      scrape({ url: 'https://food.example/private' }, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'robots_blocked' });
  });

  it('throws http_4xx on a 404', async () => {
    await expect(
      scrape(
        { url: 'https://food.example/missing' },
        { fetch: htmlFetch({}) },
      ),
    ).rejects.toMatchObject({ code: 'http_4xx' });
  });

  it('rejects binary content-types and responses exceeding 5MB', async () => {
    await expect(
      scrape(
        { url: 'https://food.example/file.pdf' },
        { fetch: htmlFetch({ 'https://food.example/file.pdf': { body: '%PDF-1.5', contentType: 'application/pdf' } }) },
      ),
    ).rejects.toMatchObject({ code: 'invalid_url' });

    await expect(
      scrape(
        { url: 'https://food.example/huge' },
        {
          fetch: htmlFetch({
            'https://food.example/huge': {
              body: '<p>hi</p>',
              headers: { 'content-length': String(10 * 1024 * 1024) },
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('blocks SSRF redirects to metadata or loopback hosts', async () => {
    const redirectingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      const res = new Response('<p>secret</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: 'http://169.254.169.254/latest/meta-data/' });
      return res;
    }) as typeof fetch;

    await expect(
      scrape({ url: 'https://food.example/redirect' }, { fetch: redirectingFetch }),
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });
});
