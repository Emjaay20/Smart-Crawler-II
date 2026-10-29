import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';

describe('Metrics', () => {
  it('counts scrape outcomes, engines, error codes, consecutive failures, and durations', () => {
    const metrics = new Metrics();
    metrics.recordScrape({ ok: true, engine: 'http', durationMs: 100 });
    metrics.recordScrape({ ok: false, durationMs: 50, errorCode: 'timeout' });
    metrics.recordScrape({ ok: false, durationMs: 60, errorCode: 'robots_blocked' });

    let snap = metrics.snapshot();
    expect(snap.scrapeCompleted).toBe(1);
    expect(snap.scrapeFailed).toBe(2);
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.errorRate).toBeCloseTo(0.6667, 3);
    expect(snap.errorsByCode).toEqual({ timeout: 1, robots_blocked: 1 });

    // A successful scrape resets consecutiveFailures
    metrics.recordScrape({ ok: true, engine: 'playwright', durationMs: 400 });
    snap = metrics.snapshot();
    expect(snap.scrapeCompleted).toBe(2);
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.engineHttp).toBe(1);
    expect(snap.enginePlaywright).toBe(1);
    expect(snap.engineFirecrawl).toBe(0);
    expect(snap.durationCount).toBe(4);
    expect(snap.durationP95Ms).toBeGreaterThanOrEqual(400);
  });

  it('renders prometheus text with error codes and worker state gauges', () => {
    const metrics = new Metrics();
    metrics.recordScrape({ ok: true, engine: 'http', durationMs: 10 });
    metrics.recordScrape({ ok: true, engine: 'firecrawl', durationMs: 11 });
    metrics.recordScrape({ ok: false, durationMs: 25, errorCode: 'http_5xx' });
    metrics.recordMap(4);
    metrics.recordCrawl(3);
    metrics.setWorkerState(2, 5);

    const text = metrics.renderPrometheus();
    expect(text).toMatch(/scrape_jobs_total\{status="completed"\} 2/);
    expect(text).toMatch(/scrape_jobs_total\{status="failed"\} 1/);
    expect(text).toMatch(/scrape_errors_total\{code="http_5xx"\} 1/);
    expect(text).toMatch(/scrape_consecutive_failures 1/);
    expect(text).toMatch(/scrape_engine_total\{engine="http"\} 1/);
    expect(text).toMatch(/scrape_engine_total\{engine="firecrawl"\} 1/);
    expect(text).toMatch(/map_links_total 4/);
    expect(text).toMatch(/crawl_pages_total 3/);
    expect(text).toMatch(/worker_active_jobs 2/);
    expect(text).toMatch(/worker_queue_depth 5/);
  });
});
