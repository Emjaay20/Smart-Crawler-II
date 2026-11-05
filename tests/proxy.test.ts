import { describe, expect, it } from 'vitest';
import { validateHttpUrl, InvalidUrlError } from '../src/url.js';
import { scrape } from '../src/scrape.js';

describe('Proxy security & SSRF prevention', () => {
  it('rejects loopback and metadata addresses in proxy URLs', () => {
    expect(() => validateHttpUrl('http://127.0.0.1:8080')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://localhost:3128')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://169.254.169.254:80')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://10.0.0.1:8080')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('ftp://proxy.com:21')).toThrow(InvalidUrlError);
  });

  it('permits public proxy URLs with valid schemes', () => {
    const validHttp = validateHttpUrl('http://proxy.wyndlabs.com:8080');
    expect(validHttp.hostname).toBe('proxy.wyndlabs.com');

    const validHttps = validateHttpUrl('https://residential.proxy-network.io:8443');
    expect(validHttps.hostname).toBe('residential.proxy-network.io');
  });

  it('passes proxy through scrape resolution and injects it into metadata', async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response('<html><head><title>Routed via Proxy</title></head><body>Proxy Content</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const proxyUrl = 'http://egress-node.grass.io:8080';
    const result = await scrape(
      {
        url: 'https://news.ycombinator.com',
        proxy: proxyUrl,
      },
      { fetch: fakeFetch },
    );

    expect(result.success).toBe(true);
    expect(result.metadata.proxy).toBe(true);
  });
});
