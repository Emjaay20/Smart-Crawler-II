import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFromHtml } from '../src/extract.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const articleHtml = readFileSync(join(fixtures, 'article.html'), 'utf8');
const hnHtml = readFileSync(join(fixtures, 'hn-like.html'), 'utf8');
const spaHtml = readFileSync(join(fixtures, 'spa-shell.html'), 'utf8');

describe('extractFromHtml', () => {
  it('keeps the article and drops nav chrome when onlyMainContent is true', () => {
    const result = extractFromHtml(articleHtml, 'https://food.example/blog/yams', {
      onlyMainContent: true,
      formats: ['markdown', 'links', 'metadata', 'html'],
    });

    expect(result.metadata.title).toBe('How to roast yams');
    expect(result.metadata.description).toBe('A short guide to roasting yams.');
    expect(result.markdown).toMatch(/Peel the yams/);
    expect(result.markdown).not.toMatch(/Copyright 2026/);
    expect(result.html).toMatch(/<p>/);
    expect(result.links).toContain('https://food.example/recipes/lime-sauce');
    expect(result.links).not.toContain('https://food.example/');
  });

  it('includes nav links when onlyMainContent is false', () => {
    const result = extractFromHtml(articleHtml, 'https://food.example/blog/yams', {
      onlyMainContent: false,
      formats: ['links', 'markdown'],
    });

    expect(result.links).toEqual(
      expect.arrayContaining([
        'https://food.example/',
        'https://food.example/blog',
        'https://food.example/recipes/lime-sauce',
      ]),
    );
    expect(result.markdown).toMatch(/How to roast yams/);
  });

  it('deduplicates links by canonical URL', () => {
    const result = extractFromHtml(hnHtml, 'https://news.ycombinator.com/', {
      onlyMainContent: false,
      formats: ['links', 'metadata'],
    });

    const hnHome = result.links.filter((href) => href === 'https://news.ycombinator.com/');
    expect(hnHome).toHaveLength(1);
    expect(result.links).toEqual(
      expect.arrayContaining([
        'https://mixpanel.com/breach',
        'https://github.com/penpot/penpot',
      ]),
    );
    expect(result.metadata.title).toBe('Hacker News');
  });

  it('flags empty JS shells as extract_empty', () => {
    const result = extractFromHtml(spaHtml, 'https://app.example/', {
      onlyMainContent: true,
      formats: ['markdown', 'metadata'],
    });

    expect(result.markdown.trim().length).toBeLessThan(80);
    expect(result.warnings).toContain('extract_empty');
    expect(result.looksLikeSpa).toBe(true);
  });

  it('omits formats that were not requested', () => {
    const result = extractFromHtml(articleHtml, 'https://food.example/blog/yams', {
      onlyMainContent: true,
      formats: ['metadata'],
    });

    expect(result.markdown).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(result.links).toBeUndefined();
    expect(result.metadata.title).toBe('How to roast yams');
  });
});
