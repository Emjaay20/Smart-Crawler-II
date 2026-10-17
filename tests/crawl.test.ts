import { describe, expect, it } from 'vitest';
import { crawlSite, mapSite } from '../src/crawl.js';

function pages(
  map: Record<string, { links?: string[]; title?: string; status?: number }>,
  sitemapUrls: string[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    }
    if (url.endsWith('/sitemap.xml')) {
      if (!sitemapUrls.length) return new Response('missing', { status: 404 });
      const locs = sitemapUrls.map((u) => `<url><loc>${u}</loc></url>`).join('');
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset>${locs}</urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    const parsed = new URL(url);
    const key = parsed.pathname === '/' ? parsed.origin + '/' : parsed.origin + parsed.pathname.replace(/\/$/, '');
    const page = map[key] ?? map[url];
    if (!page) return new Response('missing', { status: 404 });
    if (page.status && page.status >= 400) {
      return new Response('err', { status: page.status });
    }
    const anchors = (page.links ?? []).map((href) => `<a href="${href}">${href}</a>`).join('\n');
    const html = `<!doctype html><html><head><title>${page.title ?? parsed.pathname}</title></head><body><article><h1>${page.title ?? 'Page'}</h1><p>Content for ${parsed.pathname}.</p>${anchors}</article></body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
}

const site = pages({
  'https://docs.example/': { title: 'Home', links: ['https://docs.example/guides', 'https://docs.example/api', 'https://docs.example/secret', 'https://other.example/out'] },
  'https://docs.example/guides': { title: 'Guides', links: ['https://docs.example/guides/install'] },
  'https://docs.example/guides/install': { title: 'Install', links: [] },
  'https://docs.example/api': { title: 'API', links: [] },
  'https://docs.example/secret': { title: 'Secret', links: [] },
});

describe('mapSite', () => {
  it('returns same-origin links up to the limit and drops excluded paths', async () => {
    const result = await mapSite(
      { url: 'https://docs.example/', limit: 10, excludePaths: ['/secret'] },
      { fetch: site },
    );
    expect(result.links).toEqual(expect.arrayContaining([
      'https://docs.example/guides',
      'https://docs.example/api',
    ]));
    expect(result.links).not.toContain('https://docs.example/secret');
    expect(result.links).not.toContain('https://other.example/out');
  });

  it('caps discovered links at limit', async () => {
    const result = await mapSite(
      { url: 'https://docs.example/', limit: 1 },
      { fetch: site },
    );
    expect(result.links).toHaveLength(1);
  });

  it('merges same-origin URLs discovered from /sitemap.xml', async () => {
    const withSitemap = pages(
      { 'https://docs.example/': { title: 'Home', links: ['https://docs.example/guides'] } },
      ['https://docs.example/changelog', 'https://docs.example/secret', 'https://other.example/ignore'],
    );
    const result = await mapSite(
      { url: 'https://docs.example/', limit: 10, excludePaths: ['/secret'] },
      { fetch: withSitemap },
    );
    expect(result.links).toEqual([
      'https://docs.example/guides',
      'https://docs.example/changelog',
    ]);
  });
});

describe('crawlSite', () => {
  it('walks same-origin pages, respects exclude and limit, and fires onPage hooks', async () => {
    const progress: string[] = [];
    const result = await crawlSite(
      { url: 'https://docs.example/', limit: 3, excludePaths: ['/secret'] },
      {
        fetch: site,
        onPage: (page, idx, max) => progress.push(`${idx}/${max}:${page.url}`),
      },
    );
    const urls = result.pages.map((page) => page.url);
    expect(urls).toContain('https://docs.example/');
    expect(urls).toHaveLength(3);
    expect(urls).not.toContain('https://docs.example/secret');
    expect(result.pages.every((page) => page.markdown && page.markdown.length > 0)).toBe(true);
    expect(progress).toHaveLength(3);
  });

  it('only follows includePaths when set', async () => {
    const result = await crawlSite(
      { url: 'https://docs.example/guides', limit: 10, includePaths: ['/guides'] },
      { fetch: site },
    );
    const urls = result.pages.map((page) => page.url);
    expect(urls).toEqual(expect.arrayContaining([
      'https://docs.example/guides',
      'https://docs.example/guides/install',
    ]));
    expect(urls).not.toContain('https://docs.example/api');
  });
});
