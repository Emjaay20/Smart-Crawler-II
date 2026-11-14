import { describe, expect, it } from 'vitest';
import { crawlSite } from '../src/crawl.js';

const origin = 'https://docs.example';
function htmlPage(title: string, links: string[] = []): string {
  const anchors = links.map((url) => '<a href="' + url + '">Next</a>').join('');
  return '<!doctype html><html><head><title>' + title +
    '</title></head><body><article><h1>' + title +
    '</h1><p>Long enough content to extract successfully as markdown for a controlled test.</p>' +
    anchors + '</article></body></html>';
}

function asHtml(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

describe('bounded breadth-first crawl scheduling', () => {
  it('overlaps at most two child pages and preserves BFS output order despite different completion times', async () => {
    const childrenStarted = deferred();
    const releaseChildren = deferred();
    const requested: string[] = [];
    let active = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      requested.push(url);
      if (url === origin + '/') {
        return asHtml(htmlPage('Home', [origin + '/a', origin + '/b', origin + '/c']));
      }
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) childrenStarted.resolve();
      await releaseChildren.promise;
      active -= 1;
      return asHtml(htmlPage(url.split('/').pop() ?? 'Child'));
    }) as typeof fetch;

    const progress: string[] = [];
    const crawling = crawlSite(
      { url: origin + '/', limit: 3, concurrency: 2, crawlDelayMs: 0 },
      { fetch: fetchImpl, onPage: (page) => progress.push(page.url) },
    );
    await childrenStarted.promise;
    expect(peak).toBe(2);
    releaseChildren.resolve();
    const result = await crawling;
    expect(result.pages.map((page) => page.url)).toEqual([origin + '/', origin + '/a', origin + '/b']);
    expect(progress).toEqual([origin + '/', origin + '/a', origin + '/b']);
    expect(requested).not.toContain(origin + '/c');
  });

  it('continues after a failed non-seed page until the successful-page limit is reached', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      requested.push(url);
      if (url === origin + '/') return asHtml(htmlPage('Home', [origin + '/missing', origin + '/good', origin + '/last']));
      if (url.endsWith('/missing')) return new Response('Not Found', { status: 404 });
      return asHtml(htmlPage('Working Page'));
    }) as typeof fetch;
    const result = await crawlSite(
      { url: origin + '/', concurrency: 2, limit: 3, crawlDelayMs: 0 },
      { fetch: fetchImpl },
    );
    expect(result.pages.map((page) => page.url)).toEqual([origin + '/', origin + '/good', origin + '/last']);
    expect(requested).toContain(origin + '/missing');
  });

  it('never follows same-host links on a different origin port', async () => {
    const seed = origin + ':8443/';
    const foreignPort = origin + ':9443/private';
    const samePort = origin + ':8443/allowed';
    const visited: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      visited.push(url);
      return asHtml(htmlPage('Port isolated', url === seed ? [foreignPort, samePort] : []));
    }) as typeof fetch;
    const result = await crawlSite(
      { url: seed, concurrency: 2, limit: 4, crawlDelayMs: 0 },
      { fetch: fetchImpl },
    );
    expect(result.pages.map((page) => page.url)).toEqual([seed, samePort]);
    expect(visited).not.toContain(foreignPort);
  });

  it('spaces same-origin request starts even when multiple workers are available', async () => {
    const startedAt: number[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      startedAt.push(Date.now());
      return asHtml(htmlPage('Polite', url === origin + '/' ? [origin + '/a', origin + '/b'] : []));
    }) as typeof fetch;
    const result = await crawlSite(
      { url: origin + '/', concurrency: 3, limit: 3, crawlDelayMs: 45 },
      { fetch: fetchImpl },
    );
    expect(result.pages).toHaveLength(3);
    expect(startedAt).toHaveLength(3);
    for (let i = 1; i < startedAt.length; i++) {
      expect(startedAt[i]! - startedAt[i - 1]!).toBeGreaterThanOrEqual(30);
    }
  });

  it('propagates seed failures instead of returning a misleading successful empty crawl', async () => {
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    await expect(crawlSite(
      { url: origin + '/', concurrency: 4, limit: 3, crawlDelayMs: 0 },
      { fetch: fetchImpl },
    )).rejects.toBeDefined();
  });
});
