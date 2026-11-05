import { describe, expect, it, vi } from 'vitest';
import { detectAntiBotChallenge } from '../src/antibot.js';
import { scrape } from '../src/scrape.js';
import { ScrapeError } from '../src/errors.js';
import { DomainCircuitBreaker } from '../src/circuit.js';

describe('detectAntiBotChallenge', () => {
  it('detects Cloudflare Turnstile / IUAM interstitial', () => {
    const res = new Response('<html><title>Just a moment...</title><body>Checking your browser</body></html>', {
      status: 403,
      headers: {
        'cf-ray': '8ec6e19198642a8b-AMS',
        'server': 'cloudflare',
      },
    });
    const result = detectAntiBotChallenge(res, '<title>Just a moment...</title>');
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('cloudflare');
  });

  it('detects DataDome challenge headers and scripts', () => {
    const res = new Response('blocked', {
      status: 403,
      headers: {
        'x-datadome': 'protected',
      },
    });
    const result = detectAntiBotChallenge(res, '');
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('datadome');

    const resHtml = new Response('<html><script src="https://static.datadome.js"></script></html>', {
      status: 200,
    });
    const resultHtml = detectAntiBotChallenge(resHtml, '<script src="https://static.datadome.js"></script>');
    expect(resultHtml.detected).toBe(true);
    expect(resultHtml.provider).toBe('datadome');
  });

  it('detects AWS WAF action block', () => {
    const res = new Response('Forbidden', {
      status: 403,
      headers: {
        'x-amzn-waf-action': 'block',
      },
    });
    const result = detectAntiBotChallenge(res, '');
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('aws_waf');
  });

  it('detects Akamai interstitial', () => {
    const res = new Response('Denied', {
      status: 403,
      headers: {
        'x-akamai-transformed': '9 - 0 pmb=mRUM,1',
      },
    });
    const result = detectAntiBotChallenge(res, '');
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('akamai');
  });

  it('returns detected: false for normal responses', () => {
    const res = new Response('<h1>Hello world</h1>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const result = detectAntiBotChallenge(res, '<h1>Hello world</h1>');
    expect(result.detected).toBe(false);
  });
});

describe('scrape anti-bot handling and escalation', () => {
  it('throws anti_bot_detected ScrapeError when challenged in local mode', async () => {
    const cfHtml = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare Ray ID: 12345</body></html>';
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response(cfHtml, {
        status: 403,
        headers: {
          'server': 'cloudflare',
          'cf-ray': 'abcd1234efgh',
          'content-type': 'text/html',
        },
      });
    }) as typeof fetch;

    await expect(
      scrape(
        { url: 'https://protected.example/data', provider: 'local' },
        { fetch: fakeFetch },
      ),
    ).rejects.toMatchObject({
      code: 'anti_bot_detected',
      challengeProvider: 'cloudflare',
    });
  });

  it('escalates anti_bot_detected to Firecrawl when provider: "auto" has a client', async () => {
    const cfHtml = '<html><title>Just a moment...</title><body>Cloudflare Ray ID: 123</body></html>';
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response(cfHtml, {
        status: 403,
        headers: {
          'server': 'cloudflare',
          'cf-ray': 'test-ray',
          'content-type': 'text/html',
        },
      });
    }) as typeof fetch;

    const scrapeWithFirecrawl = vi.fn().mockResolvedValue({
      success: true,
      markdown: '# Bypassed Cloudflare via Managed Tier\n\nData extracted successfully.',
      metadata: {
        title: 'Bypassed Content',
        description: '',
        sourceUrl: 'https://protected.example/data',
        canonicalUrl: 'https://protected.example/data',
        statusCode: 200,
        contentLength: 60,
        byline: null,
        language: 'en',
        fetchedAt: new Date().toISOString(),
        engine: 'firecrawl',
        proxy: false,
        links: [],
      },
    });

    const result = await scrape(
      { url: 'https://protected.example/data', provider: 'auto' },
      {
        fetch: fakeFetch,
        firecrawlClient: {} as any,
        scrapeWithFirecrawl,
      },
    );

    expect(result.success).toBe(true);
    expect(result.metadata.engine).toBe('firecrawl');
    expect(result.markdown).toContain('Bypassed Cloudflare');
    expect(scrapeWithFirecrawl).toHaveBeenCalled();
  });

  it('trips domain circuit breaker on repeated anti-bot blocks', async () => {
    const breaker = new DomainCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    const cfHtml = '<html><title>Just a moment...</title></html>';
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response(cfHtml, {
        status: 403,
        headers: { 'server': 'cloudflare', 'cf-ray': 'test-ray' },
      });
    }) as typeof fetch;

    // First attempt -> fails with anti_bot_detected
    await expect(
      scrape({ url: 'https://strict.example/page1', provider: 'local' }, { fetch: fakeFetch, circuitBreaker: breaker }),
    ).rejects.toMatchObject({ code: 'anti_bot_detected' });

    // Second attempt -> fails with anti_bot_detected and trips breaker
    await expect(
      scrape({ url: 'https://strict.example/page2', provider: 'local' }, { fetch: fakeFetch, circuitBreaker: breaker }),
    ).rejects.toMatchObject({ code: 'anti_bot_detected' });

    expect(breaker.isBroken('https://strict.example/page3')).toBe(true);

    // Third attempt -> immediately rejected by circuit breaker to save IP reputation!
    await expect(
      scrape({ url: 'https://strict.example/page3', provider: 'local' }, { fetch: fakeFetch, circuitBreaker: breaker }),
    ).rejects.toMatchObject({ code: 'circuit_broken' });
  });
});
