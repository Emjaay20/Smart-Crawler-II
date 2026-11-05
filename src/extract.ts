import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { ContentChunk, ExtractOptions, ExtractResult } from './types.js';
import { canonicalizeUrl } from './url.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const EMPTY_TEXT_LIMIT = 80;
const DEFAULT_MAX_CHUNK_CHARS = 1200;

export interface DocumentEnrichment {
  contentHash?: string;
  wordCount: number;
  estimatedTokens: number;
  chunks: ContentChunk[];
}

export function enrichMarkdownDocument(markdown: string, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS): DocumentEnrichment {
  const normalized = markdown.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { wordCount: 0, estimatedTokens: 0, chunks: [] };
  }
  const words = normalized.split(' ').filter(Boolean);
  const wordCount = words.length;
  const estimatedTokens = Math.max(1, Math.ceil(normalized.length / 4));
  const contentHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const chunks = segmentMarkdownIntoChunks(markdown, maxChunkChars);
  return { contentHash, wordCount, estimatedTokens, chunks };
}

export function segmentMarkdownIntoChunks(markdown: string, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS): ContentChunk[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/);
  const sections: Array<{ heading?: string; blocks: string[] }> = [];
  let current: { heading?: string; blocks: string[] } = { blocks: [] };
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const text = paragraph.join('\n').trim();
      if (text) current.blocks.push(text);
      paragraph = [];
    }
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      if (current.heading || current.blocks.length > 0) {
        sections.push(current);
      }
      current = { heading: headingMatch[2]!.trim(), blocks: [] };
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  if (current.heading || current.blocks.length > 0) {
    sections.push(current);
  }

  const chunks: ContentChunk[] = [];
  const pushChunk = (heading: string | undefined, text: string) => {
    const clean = text.trim();
    if (!clean) return;
    chunks.push({
      index: chunks.length,
      ...(heading ? { heading } : {}),
      text: clean,
      charCount: clean.length,
      estimatedTokens: Math.max(1, Math.ceil(clean.length / 4)),
    });
  };

  for (const section of sections) {
    if (section.blocks.length === 0 && section.heading) {
      pushChunk(section.heading, section.heading);
      continue;
    }
    let buffer = '';
    for (const block of section.blocks) {
      const candidate = buffer ? `${buffer}\n\n${block}` : block;
      if (candidate.length > maxChunkChars && buffer) {
        pushChunk(section.heading, buffer);
        buffer = block;
      } else {
        buffer = candidate;
      }
    }
    if (buffer) {
      pushChunk(section.heading, buffer);
    }
  }

  return chunks;
}

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
    const clonedDoc = document.cloneNode(true) as Document;
    const article = new Readability(clonedDoc).parse();
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

  const enrichment = enrichMarkdownDocument(markdown);

  const result: ExtractResult = {
    metadata: {
      title: contentTitle,
      description,
      ...(enrichment.contentHash ? { contentHash: enrichment.contentHash } : {}),
      wordCount: enrichment.wordCount,
      estimatedTokens: enrichment.estimatedTokens,
    },
    warnings,
    looksLikeSpa,
  };

  if (options.formats.includes('markdown')) {
    result.markdown = markdown;
    result.chunks = enrichment.chunks;
  }
  if (options.formats.includes('html')) {
    result.html = contentHtml;
  }
  if (options.formats.includes('links')) {
    result.links = options.onlyMainContent
      ? collectLinksFromHtml(contentHtml, baseUrl)
      : collectLinksFromRoot(document, baseUrl);
  }

  return result;
}

function collectLinksFromHtml(html: string, baseUrl: string): string[] {
  const dom = new JSDOM(html, { url: baseUrl });
  return collectLinksFromRoot(dom.window.document, baseUrl);
}

function collectLinksFromRoot(root: ParentNode, baseUrl: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      const canonical = canonicalizeUrl(href, baseUrl);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      links.push(canonical);
    } catch {
      // skip javascript:, mailto:, private/blocked hosts, and other non-http hrefs
    }
  }

  return links;
}
