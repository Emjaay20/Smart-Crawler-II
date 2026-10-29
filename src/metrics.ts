import type { ErrorCode } from './errors.js';

export interface ScrapeObservation {
  ok: boolean;
  engine?: 'http' | 'playwright' | 'firecrawl';
  durationMs: number;
  errorCode?: ErrorCode;
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
  durationP95Ms: number;
  mapLinks: number;
  crawlPages: number;
  activeWorkers: number;
  queueDepth: number;
}

const RING = 200;

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
  private activeWorkers = 0;
  private queueDepth = 0;

  recordScrape(obs: ScrapeObservation): void {
    if (obs.ok) {
      this.scrapeCompleted += 1;
      this.consecutiveFailures = 0;
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
  }

  recordMap(linkCount: number): void {
    this.mapLinks += linkCount;
  }

  recordCrawl(pageCount: number): void {
    this.crawlPages += pageCount;
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
      durationP95Ms: percentile(this.durations, 0.95),
      mapLinks: this.mapLinks,
      crawlPages: this.crawlPages,
      activeWorkers: this.activeWorkers,
      queueDepth: this.queueDepth,
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
      `# HELP scrape_duration_ms_p95 95th percentile scrape duration`,
      `# TYPE scrape_duration_ms_p95 gauge`,
      `scrape_duration_ms_p95 ${s.durationP95Ms}`,
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
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}
