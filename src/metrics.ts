import type { ErrorCode } from './errors.js';

export interface ScrapeObservation {
  ok: boolean;
  engine?: 'http' | 'playwright' | 'firecrawl';
  durationMs: number;
  errorCode?: ErrorCode;
  tokens?: number;
  url?: string;
  jobId?: string;
}

export interface TelemetryEvent {
  ts: string;
  event: 'scrape.completed' | 'scrape.failed' | 'scrape.retry';
  jobId?: string;
  url?: string;
  engine?: 'http' | 'playwright' | 'firecrawl';
  durationMs?: number;
  errorCode?: ErrorCode;
  tokens?: number;
}

export interface MetricsSnapshot {
  scrapeCompleted: number;
  scrapeFailed: number;
  errorRate: number;
  consecutiveFailures: number;
  errorsByCode: Record<string, number>;
  engineHttp: number;
  enginePlaywright: number;
  engineFirecrawl: number;
  durationCount: number;
  durationAvgMs: number;
  durationP50Ms: number;
  durationP95Ms: number;
  durationP99Ms: number;
  mapLinks: number;
  crawlPages: number;
  retriesTotal: number;
  tokensExtractedTotal: number;
  activeWorkers: number;
  queueDepth: number;
  recentEvents: TelemetryEvent[];
}

const RING = 200;
const EVENT_RING = 50;

export class Metrics {
  private scrapeCompleted = 0;
  private scrapeFailed = 0;
  private consecutiveFailures = 0;
  private errorsByCode: Record<string, number> = {};
  private engineHttp = 0;
  private enginePlaywright = 0;
  private engineFirecrawl = 0;
  private durations: number[] = [];
  private mapLinks = 0;
  private crawlPages = 0;
  private retriesTotal = 0;
  private tokensExtractedTotal = 0;
  private activeWorkers = 0;
  private queueDepth = 0;
  private recentEvents: TelemetryEvent[] = [];

  recordScrape(obs: ScrapeObservation): void {
    if (obs.ok) {
      this.scrapeCompleted += 1;
      this.consecutiveFailures = 0;
      if (obs.tokens && obs.tokens > 0) {
        this.tokensExtractedTotal += obs.tokens;
      }
    } else {
      this.scrapeFailed += 1;
      this.consecutiveFailures += 1;
      const code = obs.errorCode ?? 'unknown';
      this.errorsByCode[code] = (this.errorsByCode[code] ?? 0) + 1;
    }
    if (obs.engine === 'http') this.engineHttp += 1;
    if (obs.engine === 'playwright') this.enginePlaywright += 1;
    if (obs.engine === 'firecrawl') this.engineFirecrawl += 1;
    this.durations.push(obs.durationMs);
    if (this.durations.length > RING) this.durations.shift();

    this.pushEvent({
      ts: new Date().toISOString(),
      event: obs.ok ? 'scrape.completed' : 'scrape.failed',
      ...(obs.jobId ? { jobId: obs.jobId } : {}),
      ...(obs.url ? { url: obs.url } : {}),
      ...(obs.engine ? { engine: obs.engine } : {}),
      durationMs: obs.durationMs,
      ...(obs.errorCode ? { errorCode: obs.errorCode } : {}),
      ...(obs.tokens ? { tokens: obs.tokens } : {}),
    });
  }

  recordRetry(url?: string, jobId?: string): void {
    this.retriesTotal += 1;
    this.pushEvent({
      ts: new Date().toISOString(),
      event: 'scrape.retry',
      ...(jobId ? { jobId } : {}),
      ...(url ? { url } : {}),
    });
  }

  recordMap(linkCount: number): void {
    this.mapLinks += linkCount;
  }

  recordCrawl(pageCount: number, tokens = 0): void {
    this.crawlPages += pageCount;
    if (tokens > 0) {
      this.tokensExtractedTotal += tokens;
    }
  }

  setWorkerState(activeWorkers: number, queueDepth: number): void {
    this.activeWorkers = Math.max(0, activeWorkers);
    this.queueDepth = Math.max(0, queueDepth);
  }

  snapshot(): MetricsSnapshot {
    const durationCount = this.durations.length;
    const totalScrapes = this.scrapeCompleted + this.scrapeFailed;
    const errorRate = totalScrapes > 0 ? Number((this.scrapeFailed / totalScrapes).toFixed(4)) : 0;
    return {
      scrapeCompleted: this.scrapeCompleted,
      scrapeFailed: this.scrapeFailed,
      errorRate,
      consecutiveFailures: this.consecutiveFailures,
      errorsByCode: { ...this.errorsByCode },
      engineHttp: this.engineHttp,
      enginePlaywright: this.enginePlaywright,
      engineFirecrawl: this.engineFirecrawl,
      durationCount,
      durationAvgMs: durationCount ? Math.round(this.durations.reduce((sum, value) => sum + value, 0) / durationCount) : 0,
      durationP50Ms: percentile(this.durations, 0.5),
      durationP95Ms: percentile(this.durations, 0.95),
      durationP99Ms: percentile(this.durations, 0.99),
      mapLinks: this.mapLinks,
      crawlPages: this.crawlPages,
      retriesTotal: this.retriesTotal,
      tokensExtractedTotal: this.tokensExtractedTotal,
      activeWorkers: this.activeWorkers,
      queueDepth: this.queueDepth,
      recentEvents: [...this.recentEvents],
    };
  }

  renderPrometheus(): string {
    const s = this.snapshot();
    const lines = [
      `# HELP scrape_jobs_total Scrape jobs by terminal status`,
      `# TYPE scrape_jobs_total counter`,
      `scrape_jobs_total{status="completed"} ${s.scrapeCompleted}`,
      `scrape_jobs_total{status="failed"} ${s.scrapeFailed}`,
      `# HELP scrape_errors_total Failed jobs by classified error code`,
      `# TYPE scrape_errors_total counter`,
    ];

    const codes = Object.entries(s.errorsByCode).sort(([a], [b]) => a.localeCompare(b));
    if (codes.length === 0) {
      lines.push(`scrape_errors_total{code="none"} 0`);
    } else {
      for (const [code, count] of codes) {
        lines.push(`scrape_errors_total{code="${code}"} ${count}`);
      }
    }

    lines.push(
      `# HELP scrape_consecutive_failures Consecutive failed jobs since last success`,
      `# TYPE scrape_consecutive_failures gauge`,
      `scrape_consecutive_failures ${s.consecutiveFailures}`,
      `# HELP scrape_engine_total Pages rendered by engine`,
      `# TYPE scrape_engine_total counter`,
      `scrape_engine_total{engine="http"} ${s.engineHttp}`,
      `scrape_engine_total{engine="playwright"} ${s.enginePlaywright}`,
      `scrape_engine_total{engine="firecrawl"} ${s.engineFirecrawl}`,
      `# HELP scrape_duration_ms_avg Average scrape duration`,
      `# TYPE scrape_duration_ms_avg gauge`,
      `scrape_duration_ms_avg ${s.durationAvgMs}`,
      `# HELP scrape_duration_ms_p50 Median scrape duration`,
      `# TYPE scrape_duration_ms_p50 gauge`,
      `scrape_duration_ms_p50 ${s.durationP50Ms}`,
      `# HELP scrape_duration_ms_p95 95th percentile scrape duration`,
      `# TYPE scrape_duration_ms_p95 gauge`,
      `scrape_duration_ms_p95 ${s.durationP95Ms}`,
      `# HELP scrape_duration_ms_p99 99th percentile scrape duration`,
      `# TYPE scrape_duration_ms_p99 gauge`,
      `scrape_duration_ms_p99 ${s.durationP99Ms}`,
      `# HELP scrape_retries_total Transient HTTP retries executed`,
      `# TYPE scrape_retries_total counter`,
      `scrape_retries_total ${s.retriesTotal}`,
      `# HELP scrape_tokens_extracted_total Estimated LLM tokens extracted`,
      `# TYPE scrape_tokens_extracted_total counter`,
      `scrape_tokens_extracted_total ${s.tokensExtractedTotal}`,
      `# HELP map_links_total Links discovered by map`,
      `# TYPE map_links_total counter`,
      `map_links_total ${s.mapLinks}`,
      `# HELP crawl_pages_total Pages scraped by crawl`,
      `# TYPE crawl_pages_total counter`,
      `crawl_pages_total ${s.crawlPages}`,
      `# HELP worker_active_jobs Currently executing background jobs`,
      `# TYPE worker_active_jobs gauge`,
      `worker_active_jobs ${s.activeWorkers}`,
      `# HELP worker_queue_depth Jobs waiting for a worker slot`,
      `# TYPE worker_queue_depth gauge`,
      `worker_queue_depth ${s.queueDepth}`,
      '',
    );

    return lines.join('\n');
  }

  private pushEvent(ev: TelemetryEvent): void {
    this.recentEvents.unshift(ev);
    if (this.recentEvents.length > EVENT_RING) {
      this.recentEvents.pop();
    }
    if (process.env.SMARTCRAWL_LOG_FORMAT === 'json') {
      console.log(JSON.stringify({ service: 'smartcrawl', ...ev }));
    }
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}
