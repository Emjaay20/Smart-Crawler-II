import type { OperationalReport } from './alerts.js';
import type { CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import type { KeyUsage } from './keys.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';

export interface SmartCrawlOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface JobView {
  id: string;
  status: 'pending' | 'crawling' | 'completed' | 'failed';
  url: string;
  options?: Record<string, unknown>;
  data?: unknown;
  error?: string;
  errorCode?: string;
  logs?: Array<{ time: string; level: string; msg: string }>;
  createdAt?: number;
  updatedAt?: number;
}

export interface JobSummary {
  id: string;
  status: 'pending' | 'crawling' | 'completed' | 'failed';
  url: string;
  kind: string;
  error?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MeResponse {
  authenticated: boolean;
  authRequired: boolean;
  key: KeyUsage | null;
}

export class SmartCrawlError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SmartCrawlError';
  }
}

export class SmartCrawl {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SmartCrawlOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<{ status: string }> {
    return this.request('GET', '/health');
  }

  async me(): Promise<MeResponse> {
    return this.request('GET', '/v1/me');
  }

  async report(): Promise<OperationalReport> {
    return this.request('GET', '/v1/report');
  }

  async sendSlackReport(webhookUrl?: string): Promise<{ sent: boolean; report: OperationalReport }> {
    return this.request('POST', '/v1/admin/report', webhookUrl ? { webhookUrl } : {});
  }

  async scrape(url: string, request: Omit<ScrapeRequest, 'url'> = {}): Promise<ScrapeResult> {
    const job = await this.start('/v1/scrape', { ...request, url });
    return this.waitForData<ScrapeResult>(job.jobId);
  }

  async map(url: string, request: Omit<DiscoverRequest, 'url'> = {}): Promise<MapResult> {
    const job = await this.start('/v1/map', { ...request, url });
    return this.waitForData<MapResult>(job.jobId);
  }

  async crawl(url: string, request: Omit<DiscoverRequest, 'url'> = {}): Promise<CrawlResult> {
    const job = await this.start('/v1/crawl', { ...request, url });
    return this.waitForData<CrawlResult>(job.jobId);
  }

  async job(jobId: string): Promise<JobView> {
    return this.request('GET', `/v1/jobs/${jobId}`);
  }

  async listJobs(limit = 20): Promise<{ jobs: JobSummary[] }> {
    return this.request('GET', `/v1/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  async waitForJob(jobId: string, timeoutMs = 60_000): Promise<JobView> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const current = await this.job(jobId);
      if (current.status === 'completed' || current.status === 'failed') return current;
      await sleep(50);
    }
    throw new SmartCrawlError(408, `Timed out waiting for job ${jobId}`, 'timeout');
  }

  private async waitForData<T>(jobId: string): Promise<T> {
    const job = await this.waitForJob(jobId);
    if (job.status === 'failed') {
      throw new SmartCrawlError(500, job.error || 'Job failed', job.errorCode);
    }
    return job.data as T;
  }

  private async start(path: string, body: unknown): Promise<{ jobId: string }> {
    return this.request('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? jsonParse(text) : {};
    if (!res.ok) {
      const err = parsed as { error?: string; code?: string };
      throw new SmartCrawlError(res.status, err.error || res.statusText, err.code);
    }
    return parsed as T;
  }
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
