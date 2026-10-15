import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';

describe('Metrics', () => {
  it('counts scrape outcomes, engines, and durations', () => {
    const metrics = new Metrics();
    metrics.recordScrape({ ok: true, engine: 'http', durationMs: 100 });
    metrics.recordScrape({ ok: true, engine: 'playwright', durationMs: 400 });
    metrics.recordScrape({ ok: false, durationMs: 50 });

    const snap = metrics.snapshot();
    expect(snap.scrapeCompleted).toBe(2);
    expect(snap.scrapeFailed).toBe(1);
    expect(snap.engineHttp).toBe(1);
    expect(snap.enginePlaywright).toBe(1);
    expect(snap.durationCount).toBe(3);
    expect(snap.durationAvgMs).toBe(183);
    expect(snap.durationP95Ms).toBeGreaterThanOrEqual(400);
  });

  it('renders prometheus text', () => {
    const metrics = new Metrics();
    metrics.recordScrape({ ok: true, engine: 'http', durationMs: 10 });
    metrics.recordMap(4);
    metrics.recordCrawl(3);

    const text = metrics.renderPrometheus();
    expect(text).toMatch(/scrape_jobs_total\{status="completed"\} 1/);
    expect(text).toMatch(/scrape_engine_total\{engine="http"\} 1/);
    expect(text).toMatch(/map_links_total 4/);
    expect(text).toMatch(/crawl_pages_total 3/);
  });
});
