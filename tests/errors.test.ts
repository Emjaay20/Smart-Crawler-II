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

  it('falls back to unknown', () => {
    expect(classifyError(new Error('boom')).code).toBe('unknown');
    expect(classifyError('string').code).toBe('unknown');
  });
});
