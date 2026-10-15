import { describe, expect, it } from 'vitest';
import { matchesPathPattern } from '../src/paths.js';

describe('matchesPathPattern', () => {
  it('treats a prefix as that path and its children', () => {
    expect(matchesPathPattern('/docs', '/docs')).toBe(true);
    expect(matchesPathPattern('/docs/api', '/docs')).toBe(true);
    expect(matchesPathPattern('/blog', '/docs')).toBe(false);
  });

  it('honors a trailing glob', () => {
    expect(matchesPathPattern('/docs/api', '/docs/*')).toBe(true);
    expect(matchesPathPattern('/docs', '/docs/*')).toBe(true);
    expect(matchesPathPattern('/other', '/docs/*')).toBe(false);
  });
});
