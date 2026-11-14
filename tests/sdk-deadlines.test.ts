import { describe, expect, it, vi } from 'vitest';
import { SmartCrawl, SmartCrawlError } from '../src/client.js';

describe('SDK timeout and developer-experience contract', () => {
  it('fails a stalled network request with a typed timeout error', async () => {
    const stalled: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      expect(signal).toBeDefined();
      signal?.addEventListener('abort', () =>
        reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    });
    const client = new SmartCrawl({
      baseUrl: 'https://api.example',
      apiKey: 'test-key',
      requestTimeoutMs: 50,
      fetch: stalled,
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 408, code: 'timeout',
    } satisfies Partial<SmartCrawlError>);
  });

  it('honors the overall job-poll deadline instead of polling indefinitely', async () => {
    let polls = 0;
    const stub: typeof fetch = (async (_url, init) => {
      expect(init?.redirect).toBe('error');
      polls += 1;
      return new Response(JSON.stringify({ id: 'job-1', status: 'pending' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = new SmartCrawl({
      baseUrl: 'https://api.example', apiKey: 'test-key',
      pollIntervalMs: 50, requestTimeoutMs: 1000, fetch: stub,
    });
    await expect(client.waitForJob('job-1', 170)).rejects.toMatchObject({
      status: 408, code: 'timeout',
    } satisfies Partial<SmartCrawlError>);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(5);
  });

  it('preserves structured HTTP failures and blocks cross-origin redirects', async () => {
    const stub = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify({ code: 'quota_exceeded', error: 'Daily quota exceeded' }), {
        status: 429, headers: { 'content-type': 'application/json' },
      });
    });
    const client = new SmartCrawl({
      baseUrl: 'https://api.example', apiKey: 'test-key',
      fetch: stub as unknown as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({
      status: 429, code: 'quota_exceeded', message: 'Daily quota exceeded',
    } satisfies Partial<SmartCrawlError>);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('validates network timeouts and polling intervals', () => {
    expect(() => new SmartCrawl({ baseUrl: 'https://api.example', requestTimeoutMs: Number.NaN }))
      .toThrow(RangeError);
    expect(() => new SmartCrawl({ baseUrl: 'https://api.example', requestTimeoutMs: -1 }))
      .toThrow(RangeError);
    expect(() => new SmartCrawl({ baseUrl: 'https://api.example', pollIntervalMs: 0 }))
      .toThrow(RangeError);
  });
});
