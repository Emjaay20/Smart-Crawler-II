/**
 * Reproducible, offline concurrency benchmark.
 *
 * Measures fixture latency for a 16-page crawl with a synthetic 45ms response
 * time per HTML page. It is not a production latency or throughput claim.
 *
 * npm run bench:crawl
 */
import { performance } from 'node:perf_hooks';
import { crawlSite } from '../src/crawl.js';

const ORIGIN = 'https://bench.example';
const CHILDREN = 15;
const FIXTURE_DELAY_MS = 45;
const TRIALS = 3;

function fixtureFetch(metrics: { active: number; peak: number; requests: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
    metrics.active += 1;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    metrics.requests += 1;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, FIXTURE_DELAY_MS));
      const links = url === ORIGIN + '/'
        ? Array.from({ length: CHILDREN }, (_, idx) => ORIGIN + '/page-' + (idx + 1))
        : [];
      const anchors = links.map((href) => '<a href="' + href + '">Page</a>').join('');
      const html = '<!doctype html><html><head><title>Fixture</title></head>' +
        '<body><article><h1>Benchmark fixture</h1>' +
        '<p>Controlled text for repeatable extraction measurements.</p>' +
        anchors + '</article></body></html>';
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    } finally {
      metrics.active -= 1;
    }
  }) as typeof fetch;
}

function quantile(values: number[], quant: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quant) - 1)]!;
}

async function main() {
  const results = [];
  for (const concurrency of [1, 2, 4]) {
    const samples: number[] = [];
    let maxObservedConcurrent = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const metrics = { active: 0, peak: 0, requests: 0 };
      const start = performance.now();
      const result = await crawlSite({
        url: ORIGIN + '/',
        limit: CHILDREN + 1,
        crawlDelayMs: 0,
        concurrency,
      }, { fetch: fixtureFetch(metrics) });
      const elapsedMs = performance.now() - start;

      if (result.pages.length !== CHILDREN + 1 || metrics.requests !== CHILDREN + 1) {
        throw new Error('Benchmark fixture produced an incorrect number of pages');
      }
      if (metrics.peak > concurrency) {
        throw new Error('Crawl exceeded its concurrency limit');
      }
      maxObservedConcurrent = Math.max(maxObservedConcurrent, metrics.peak);
      samples.push(elapsedMs);
    }

    results.push({
      concurrency,
      requestedPages: CHILDREN + 1,
      trials: TRIALS,
      syntheticResponseMs: FIXTURE_DELAY_MS,
      peakConcurrent: maxObservedConcurrent,
      meanMs: Number((samples.reduce((a, b) => a + b, 0) / TRIALS).toFixed(2)),
      p50Ms: Number(quantile(samples, 0.50).toFixed(2)),
      p95Ms: Number(quantile(samples, 0.95).toFixed(2)),
      rawDurationsMs: samples.map((ms) => Number(ms.toFixed(2))),
    });
  }

  console.log(JSON.stringify({
    benchmark: 'smartcrawl-synthetic-bfs-v1',
    dataSource: 'owned deterministic HTTP fixtures; no external network',
    node: process.version,
    results,
  }, null, 2));
}

await main();
