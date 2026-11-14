import { describe, expect, it } from 'vitest';
import { InvalidUrlError } from '../src/url.js';
import { classifyError, ScrapeError } from '../src/errors.js';

describe('classifyError', () => {
  it('maps abort/timeout errors to timeout', () => {
    const abort = new DOMException('Aborted', 'AbortError');
    expect(classifyError(abort).code).toBe('timeout');

    const timeout = new Error('The operation timed out');
    timeout.name = 'TimeoutError';
    expect(classifyError(timeout).code).toBe('timeout');
  });

  it('maps DNS failures to dns', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), {
      code: 'ENOTFOUND',
    });
    expect(classifyError(err).code).toBe('dns');
  });

  it('keeps scrape and invalid URL codes', () => {
    expect(classifyError(new InvalidUrlError()).code).toBe('invalid_url');
    expect(classifyError(new ScrapeError('robots_blocked', 'nope')).code).toBe('robots_blocked');
    expect(classifyError(new ScrapeError('http_4xx', '404')).code).toBe('http_4xx');
  });

  it('redacts proxy basic-auth URLs and bearer tokens in all error classes', () => {
    const proxyUrl = 'http://crawler-user:example-secret@proxy.example:8080';
    const message = 'fetch failed through ' + proxyUrl +
      ' Authorization: Bearer sc_live_ExampleToken123';
    for (const error of [
      new Error(message),
      new ScrapeError('provider_unavailable', message),
      new InvalidUrlError(message),
      Object.assign(new Error(message), { code: 'ENOTFOUND' }),
    ]) {
      const classified = classifyError(error);
      expect(classified.message).toContain('http://[redacted]@proxy.example:8080');
      expect(classified.message).toContain('Bearer [redacted]');
      expect(classified.message).not.toContain('example-secret');
      expect(classified.message).not.toContain('sc_live_ExampleToken123');
    }
  });

  it('falls back to unknown', () => {
    expect(classifyError(new Error('boom')).code).toBe('unknown');
    expect(classifyError('string').code).toBe('unknown');
  });
});
