import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, InvalidUrlError, validateHttpUrl } from '../src/url.js';

describe('validateHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(validateHttpUrl('https://example.com/path').href).toBe('https://example.com/path');
    expect(validateHttpUrl('http://example.com').protocol).toBe('http:');
  });

  it('rejects missing, non-http, and malformed URLs', () => {
    expect(() => validateHttpUrl('')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('not a url')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('ftp://example.com')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
  });
});

describe('canonicalizeUrl', () => {
  it('strips hash fragments and default ports', () => {
    expect(canonicalizeUrl('https://Example.COM:443/a/b#section')).toBe('https://example.com/a/b');
    expect(canonicalizeUrl('http://example.com:80/x')).toBe('http://example.com/x');
  });

  it('drops trailing slash on non-root paths so duplicates collapse', () => {
    expect(canonicalizeUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('resolves relative links against a base URL', () => {
    expect(canonicalizeUrl('/jobs/42', 'https://example.com/careers')).toBe('https://example.com/jobs/42');
  });
});
