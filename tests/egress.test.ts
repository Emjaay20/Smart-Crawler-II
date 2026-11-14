import { describe, expect, it, vi } from 'vitest';
import { safeFetch, isPublicAddress, resolvePublicAddresses, type HostResolver } from '../src/egress.js';
import { InvalidUrlError } from '../src/url.js';

const fakePublicDns: HostResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('safe HTTP egress policy', () => {
  it('rejects private and special-use IPv4 and IPv6 addresses', () => {
    for (const ip of [
      '127.0.0.1', '10.10.2.1', '172.16.0.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '192.0.2.1',
      '198.51.100.9', '203.0.113.77', '224.0.0.1', '0.0.0.0',
      '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects hostnames with private or mixed public/private DNS results', async () => {
    const privateResolver: HostResolver = async () => [{ address: '10.1.1.1', family: 4 }];
    const mixedResolver: HostResolver = async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ];
    await expect(resolvePublicAddresses(new URL('https://example.com'), privateResolver))
      .rejects.toThrow(InvalidUrlError);
    await expect(resolvePublicAddresses(new URL('https://example.com'), mixedResolver))
      .rejects.toThrow(InvalidUrlError);
    await expect(resolvePublicAddresses(new URL('https://example.com'), fakePublicDns))
      .resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('blocks redirect targets before issuing any request to them', async () => {
    const requests: string[] = [];
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
    }) as typeof fetch;
    await expect(safeFetch('https://example.com', {}, { fetchImpl: mockFetch, resolveHost: fakePublicDns }))
      .rejects.toThrow(InvalidUrlError);
    expect(requests).toEqual(['https://example.com/']);
  });

  it('follows allowed relative redirects manually with a bounded hop count', async () => {
    const requested: string[] = [];
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      expect(init?.redirect).toBe('manual');
      if (String(input).endsWith('/start')) {
        return new Response(null, { status: 301, headers: { location: '/complete' } });
      }
      return new Response('<h1>Done</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const response = await safeFetch('https://example.com/start', {}, { fetchImpl: mockFetch, resolveHost: fakePublicDns });
    expect(await response.text()).toBe('<h1>Done</h1>');
    expect(response.url).toBe('https://example.com/complete');
    expect(requested).toEqual(['https://example.com/start', 'https://example.com/complete']);
  });

  it('stops redirect loops and never issues requests beyond the limit', async () => {
    const mockFetch = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: '/again' },
    }));
    await expect(safeFetch('https://example.com/again', {}, {
      fetchImpl: mockFetch as typeof fetch, resolveHost: fakePublicDns, maxRedirects: 2,
    })).rejects.toThrow('Redirect limit exceeded');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects credentials and oversized responses', async () => {
    await expect(safeFetch('https://user:secret@example.com/', {}, {
      fetchImpl: vi.fn() as unknown as typeof fetch, resolveHost: fakePublicDns,
    })).rejects.toThrow(InvalidUrlError);

    const mockFetch: typeof fetch = (async () =>
      new Response('a'.repeat(100), { status: 200 })) as typeof fetch;
    await expect(safeFetch('https://example.com', {}, {
      fetchImpl: mockFetch, resolveHost: fakePublicDns, maxBytes: 30,
    })).rejects.toThrow('Response body exceeds safe size limit');
  });

  it('disallows proxy dispatchers unless an operator explicitly enables a trusted gateway', async () => {
    const original = process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS;
    delete process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS;
    try {
      const mockFetch = vi.fn(async () => new Response('OK'));
      await expect(safeFetch('https://example.com', {
        dispatcher: {} as never,
      }, { fetchImpl: mockFetch as typeof fetch })).rejects.toThrow(InvalidUrlError);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS;
      else process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS = original;
    }
  });
});
