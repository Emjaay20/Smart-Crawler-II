import { describe, expect, it } from 'vitest';
import { isUrlAllowedByRobots } from '../src/robots.js';

const robotsTxt = `
User-agent: *
Disallow: /secret
Allow: /secret/public

User-agent: BadBot
Disallow: /
`;

describe('isUrlAllowedByRobots', () => {
  it('blocks disallowed paths and allows the rest', () => {
    expect(isUrlAllowedByRobots(robotsTxt, '*', 'https://example.com/secret')).toBe(false);
    expect(isUrlAllowedByRobots(robotsTxt, '*', 'https://example.com/blog')).toBe(true);
  });

  it('allows everything when robots.txt is empty', () => {
    expect(isUrlAllowedByRobots('', 'SmartCrawl', 'https://example.com/any')).toBe(true);
  });

  it('honors a matching user-agent group', () => {
    expect(isUrlAllowedByRobots(robotsTxt, 'BadBot', 'https://example.com/blog')).toBe(false);
  });
});
