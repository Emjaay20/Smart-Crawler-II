export type Format = 'markdown' | 'links' | 'metadata' | 'html';

export interface ContentChunk {
  index: number;
  heading?: string;
  text: string;
  charCount: number;
  estimatedTokens: number;
}

export interface ExtractOptions {
  onlyMainContent: boolean;
  formats: Format[];
}

export interface ExtractMetadata {
  title?: string;
  description?: string;
  contentHash?: string;
  wordCount?: number;
  estimatedTokens?: number;
}

export interface ExtractResult {
  markdown?: string;
  html?: string;
  links?: string[];
  chunks?: ContentChunk[];
  metadata: ExtractMetadata;
  warnings: string[];
  looksLikeSpa: boolean;
}

export interface ScrapeRequest {
  url: string;
  formats?: Format[];
  onlyMainContent?: boolean;
  js?: boolean | 'auto';
  /** Local is free and private. Auto only escalates when explicitly selected by a caller. */
  provider?: 'local' | 'auto' | 'firecrawl';
  timeoutMs?: number;
  userAgent?: string;
  maxRetries?: number;
  proxy?: string;
}

export interface ScrapeResult {
  success: true;
  markdown?: string;
  html?: string;
  links?: string[];
  chunks?: ContentChunk[];
  metadata: ExtractMetadata & {
    statusCode: number;
    sourceUrl: string;
    finalUrl: string;
    redirectChain: string[];
    engine: 'http' | 'playwright' | 'firecrawl';
    charset?: string;
    proxy?: boolean;
  };
  warnings: string[];
  timing: { ttfbMs: number; totalMs: number };
}

export const DEFAULT_FORMATS: Format[] = ['markdown', 'links', 'metadata'];
export const DEFAULT_USER_AGENT = 'SmartCrawl/1.0';
export const DEFAULT_TIMEOUT_MS = 15000;
