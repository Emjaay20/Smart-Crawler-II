import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, InvalidUrlError, isBlockedHost, validateHttpUrl } from '../src/url.js';

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

  it('blocks cloud metadata endpoints unconditionally (SSRF protection)', () => {
    expect(() => validateHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://metadata.google.internal/computeMetadata/v1/')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://100.100.100.200/latest/meta-data/')).toThrow(InvalidUrlError);
    expect(
      isBlockedHost('169.254.169.254', { allowPrivateNetworks: true }).blocked,
    ).toBe(true);
  });

  it('blocks loopback and RFC1918 private network addresses by default', () => {
    expect(() => validateHttpUrl('http://localhost:3000/v1/admin/keys')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://127.0.0.1:8080/')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://[::1]:3000/')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://10.0.0.42/internal')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://172.16.4.9/admin')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://192.168.1.1/router')).toThrow(InvalidUrlError);
    expect(() => validateHttpUrl('http://internal.corp.local/')).toThrow(InvalidUrlError);
  });

  it('allows private networks only when allowPrivateNetworks option is set', () => {
    expect(
      validateHttpUrl('http://127.0.0.1:8080/test', undefined, { allowPrivateNetworks: true }).href,
    ).toBe('http://127.0.0.1:8080/test');
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
