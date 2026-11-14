import type { OperationalReport } from './alerts.js';
import type { CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import type { KeyUsage } from './keys.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';

export interface SmartCrawlOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request network deadline, default 15 seconds (50–120000 ms). */
  requestTimeoutMs?: number;
  /** Job polling interval, default 250 milliseconds (50–5000 ms). */
  pollIntervalMs?: number;
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
  private guestCookie?: string;
  private guestSessionInit?: Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: SmartCrawlOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = positiveMs(options.requestTimeoutMs, 15_000, 50, 120_000);
    this.pollIntervalMs = positiveMs(options.pollIntervalMs, 250, 50, 5_000);
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

  async exportJsonl(jobId: string): Promise<string> {
    await this.ensureNodeGuestSession();
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (!this.apiKey && this.guestCookie && isNodeRuntime()) headers.Cookie = this.guestCookie;
    const res = await this.fetchWithDeadline(`${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/export.jsonl`, {
      method: 'GET',
      headers,
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = text ? (jsonParse(text) as { error?: string; code?: string }) : {};
      throw new SmartCrawlError(res.status, parsed.error || res.statusText, parsed.code);
    }
    return text;
  }

  async listJobs(limit = 20): Promise<{ jobs: JobSummary[] }> {
    return this.request('GET', `/v1/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  async waitForJob(jobId: string, timeoutMs = 60_000): Promise<JobView> {
    const deadline = Date.now() + positiveMs(timeoutMs, 60_000, 1, 24 * 60 * 60 * 1000);
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const current = await this.request<JobView>(
        'GET', `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, remaining,
      );
      if (current.status === 'completed' || current.status === 'failed') return current;
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
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
    await this.ensureNodeGuestSession();
    return this.request('POST', path, body);
  }

  /**
   * Browsers preserve same-origin cookies automatically. Node fetch has no
   * cookie jar, so bootstrap exactly one guest session before the first
   * concurrent job submission and retain its cookie on this client instance.
   */
  private async ensureNodeGuestSession(): Promise<void> {
    if (this.apiKey || !isNodeRuntime() || this.guestCookie) return;
    if (!this.guestSessionInit) {
      this.guestSessionInit = (async () => {
        const res = await this.fetchWithDeadline(`${this.baseUrl}/v1/me`, {
          method: 'GET',
        });
        this.captureGuestCookie(res);
        await res.body?.cancel();
      })().finally(() => {
        this.guestSessionInit = undefined;
      });
    }
    await this.guestSessionInit;
  }

  private captureGuestCookie(res: Response): void {
    if (this.apiKey || !isNodeRuntime()) return;
    // A final redirect must never make us accept a cookie from another origin.
    if (res.url && new URL(res.url).origin !== new URL(this.baseUrl).origin) return;
    const raw = res.headers.get('set-cookie');
    if (!raw) return;
    const match = /(?:^|[;,]\s*)smartcrawl_guest=(sc_guest_[A-Za-z0-9_-]{43})(?=;|,|$)/.exec(raw);
    if (match) this.guestCookie = 'smartcrawl_guest=' + match[1];
  }

  private async fetchWithDeadline(url: string, init: RequestInit, deadlineMs = this.requestTimeoutMs): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, Math.max(1, deadlineMs))),
      });
    } catch (err) {
      if (err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new SmartCrawlError(408, 'SmartCrawl request timed out', 'timeout');
      }
      throw err;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, deadlineMs?: number): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (!this.apiKey && this.guestCookie && isNodeRuntime()) headers.Cookie = this.guestCookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchWithDeadline(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, deadlineMs);
    this.captureGuestCookie(res);
    const text = await res.text();
    const parsed = text ? jsonParse(text) : {};
    if (!res.ok) {
      const err = parsed as { error?: string; code?: string };
      throw new SmartCrawlError(res.status, err.error || res.statusText, err.code);
    }
    return parsed as T;
  }
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
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

/** Require valid, bounded time budgets instead of silently accepting NaN or infinity. */
function positiveMs(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Timeout/interval must be between ${min} and ${max} milliseconds`);
  }
  return Math.floor(value);
}
