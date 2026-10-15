import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { ExtractOptions, ExtractResult } from './types.js';
import { canonicalizeUrl } from './url.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const EMPTY_TEXT_LIMIT = 80;

export function extractFromHtml(html: string, baseUrl: string, options: ExtractOptions): ExtractResult {
  const dom = new JSDOM(html, { url: baseUrl });
  const { document } = dom.window;

  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.title
    || undefined;
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
    || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || undefined;

  const bodyText = document.body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const scriptCount = document.querySelectorAll('script[src], script:not([src])').length;
  const looksLikeSpa = bodyText.length < EMPTY_TEXT_LIMIT && scriptCount > 0;

  let contentHtml = document.body?.innerHTML ?? '';
  let contentTitle = title;

  if (options.onlyMainContent) {
    const cloned = new JSDOM(html, { url: baseUrl });
    const article = new Readability(cloned.window.document).parse();
    if (article?.content) {
      contentHtml = article.content;
      contentTitle = article.title || contentTitle;
    }
  }

  const markdown = turndown.turndown(contentHtml).trim();
  const warnings: string[] = [];
  if (markdown.length < EMPTY_TEXT_LIMIT) {
    warnings.push('extract_empty');
  }

  const result: ExtractResult = {
    metadata: { title: contentTitle, description },
    warnings,
    looksLikeSpa,
  };

  if (options.formats.includes('markdown')) {
    result.markdown = markdown;
  }
  if (options.formats.includes('html')) {
    result.html = contentHtml;
  }
  if (options.formats.includes('links')) {
    result.links = collectLinks(contentHtml, baseUrl);
  }

  return result;
}

function collectLinks(html: string, baseUrl: string): string[] {
  const dom = new JSDOM(html, { url: baseUrl });
  const seen = new Set<string>();
  const links: string[] = [];

  for (const anchor of dom.window.document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      const canonical = canonicalizeUrl(href, baseUrl);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      links.push(canonical);
    } catch {
      // skip javascript: and other non-http hrefs
    }
  }

  return links;
}
