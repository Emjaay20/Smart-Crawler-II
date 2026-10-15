export interface ScrapeObservation {
  ok: boolean;
  engine?: 'http' | 'playwright';
  durationMs: number;
}

export interface MetricsSnapshot {
  scrapeCompleted: number;
  scrapeFailed: number;
  engineHttp: number;
  enginePlaywright: number;
  durationCount: number;
  durationAvgMs: number;
  durationP95Ms: number;
  mapLinks: number;
  crawlPages: number;
}

const RING = 200;

export class Metrics {
  private scrapeCompleted = 0;
  private scrapeFailed = 0;
  private engineHttp = 0;
  private enginePlaywright = 0;
  private durations: number[] = [];
  private mapLinks = 0;
  private crawlPages = 0;

  recordScrape(obs: ScrapeObservation): void {
    if (obs.ok) this.scrapeCompleted += 1;
    else this.scrapeFailed += 1;
    if (obs.engine === 'http') this.engineHttp += 1;
    if (obs.engine === 'playwright') this.enginePlaywright += 1;
    this.durations.push(obs.durationMs);
    if (this.durations.length > RING) this.durations.shift();
  }

  recordMap(linkCount: number): void {
    this.mapLinks += linkCount;
  }

  recordCrawl(pageCount: number): void {
    this.crawlPages += pageCount;
  }

  snapshot(): MetricsSnapshot {
    const durationCount = this.durations.length;
    return {
      scrapeCompleted: this.scrapeCompleted,
      scrapeFailed: this.scrapeFailed,
      engineHttp: this.engineHttp,
      enginePlaywright: this.enginePlaywright,
      durationCount,
      durationAvgMs: durationCount ? Math.round(this.durations.reduce((sum, value) => sum + value, 0) / durationCount) : 0,
      durationP95Ms: percentile(this.durations, 0.95),
      mapLinks: this.mapLinks,
      crawlPages: this.crawlPages,
    };
  }

  renderPrometheus(): string {
    const s = this.snapshot();
    return [
      `# HELP scrape_jobs_total Scrape jobs by terminal status`,
      `# TYPE scrape_jobs_total counter`,
      `scrape_jobs_total{status="completed"} ${s.scrapeCompleted}`,
      `scrape_jobs_total{status="failed"} ${s.scrapeFailed}`,
      `# HELP scrape_engine_total Pages rendered by engine`,
      `# TYPE scrape_engine_total counter`,
      `scrape_engine_total{engine="http"} ${s.engineHttp}`,
      `scrape_engine_total{engine="playwright"} ${s.enginePlaywright}`,
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
      '',
    ].join('\n');
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}
