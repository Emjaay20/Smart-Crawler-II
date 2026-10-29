import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { JobStore } from '../src/jobs.js';
import { createApp } from '../src/app.js';
import type { ScrapeResult } from '../src/types.js';

const playgroundDirs: string[] = [];
afterEach(() => {
  while (playgroundDirs.length) {
    const dir = playgroundDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempPublicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smartcrawl-ui-'));
  playgroundDirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SmartCrawl</title>');
  return dir;
}

const sample: ScrapeResult = {
  success: true,
  markdown: '# Hello',
  metadata: {
    title: 'Hello',
    statusCode: 200,
    sourceUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    redirectChain: [],
    engine: 'http',
  },
  warnings: [],
  timing: { ttfbMs: 1, totalMs: 2 },
};

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe('http api', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  it('reports health and readiness', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample });
    const started = await listen(app);
    server = started.server;

    const health = await (await fetch(`${started.base}/health`)).json();
    const ready = await fetch(`${started.base}/ready`);
    expect(health).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
  });

  it('rejects scrape requests without a url or with SSRF targets', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample });
    const started = await listen(app);
    server = started.server;

    const res = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const ssrf = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:3000/health' }),
    });
    expect(ssrf.status).toBe(400);
  });

  it('runs a scrape job and returns durable status with real logs', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    let receivedProvider: unknown;
    const app = createApp({
      store,
      scrape: async (request) => {
        receivedProvider = request.provider;
        return sample;
      },
    });
    const started = await listen(app);
    server = started.server;

    const created = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', timeoutMs: 3000, userAgent: 'test-ua', provider: 'auto' }),
    });
    expect(created.status).toBe(200);
    const { jobId } = await created.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    let payload: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      const statusRes = await fetch(`${started.base}/v1/jobs/${jobId}`);
      payload = await statusRes.json() as Record<string, unknown>;
      if (payload.status === 'completed' || payload.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(payload.status).toBe('completed');
    expect(receivedProvider).toBe('auto');
    expect(payload.data).toEqual(sample);
    expect(Array.isArray(payload.logs)).toBe(true);
    expect((payload.logs as { msg: string }[]).some((line) => /https:\/\/example.com/.test(line.msg))).toBe(true);

    const legacy = await (await fetch(`${started.base}/status/${jobId}`)).json() as Record<string, unknown>;
    expect(legacy.status).toBe('completed');

    const jobsList = await (await fetch(`${started.base}/v1/jobs?limit=5`)).json() as { jobs: Array<{ id: string }> };
    expect(jobsList.jobs.some((j) => j.id === jobId)).toBe(true);
  });

  it('serves the playground without breaking Express 5 routing', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({
      store,
      scrape: async () => sample,
      publicDir: tempPublicDir(),
    });
    const started = await listen(app);
    server = started.server;

    for (const route of ['/', '/app', '/docs']) {
      const page = await fetch(`${started.base}${route}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/SmartCrawl/);
    }
    expect((await fetch(`${started.base}/health`)).status).toBe(200);
  });

  it('reports only whether the optional provider is configured', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample, firecrawlConfigured: true });
    const started = await listen(app);
    server = started.server;

    const providers = await (await fetch(`${started.base}/v1/providers`)).json();
    expect(providers).toEqual({ firecrawl: { configured: true } });
  });

  it('exposes prometheus metrics after a scrape job', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample });
    const started = await listen(app);
    server = started.server;

    await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    for (let i = 0; i < 20; i++) {
      const stats = await (await fetch(`${started.base}/v1/stats`)).json() as { scrapeCompleted: number };
      if (stats.scrapeCompleted >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const text = await (await fetch(`${started.base}/metrics`)).text();
    expect(text).toMatch(/scrape_jobs_total\{status="completed"\} 1/);
  });

  it('maps a site through /v1/map', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({
      store,
      scrape: async () => sample,
      map: async () => ({ success: true as const, sourceUrl: 'https://example.com', links: ['https://example.com/a'] }),
    });
    const started = await listen(app);
    server = started.server;

    const created = await fetch(`${started.base}/v1/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', limit: 10 }),
    });
    const { jobId } = await created.json() as { jobId: string };
    let payload: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      payload = await (await fetch(`${started.base}/v1/jobs/${jobId}`)).json() as Record<string, unknown>;
      if (payload.status === 'completed' || payload.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(payload.status).toBe('completed');
    expect(payload.data).toEqual({ success: true, sourceUrl: 'https://example.com', links: ['https://example.com/a'] });
  });

  it('bounds concurrent job execution and records per-page crawl logs', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    let inFlight = 0;
    let maxObserved = 0;

    const app = createApp({
      store,
      maxConcurrentJobs: 2,
      scrape: async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return sample;
      },
      crawl: async (_req, hooks) => {
        hooks?.onPage?.({ url: 'https://example.com/1', title: 'One', markdown: '# 1', statusCode: 200 }, 1, 2);
        hooks?.onPage?.({ url: 'https://example.com/2', title: 'Two', markdown: '# 2', statusCode: 200 }, 2, 2);
        return {
          success: true as const,
          pages: [
            { url: 'https://example.com/1', title: 'One', markdown: '# 1', statusCode: 200 },
            { url: 'https://example.com/2', title: 'Two', markdown: '# 2', statusCode: 200 },
          ],
        };
      },
    });
    const started = await listen(app);
    server = started.server;

    const ids = await Promise.all(
      [1, 2, 3, 4].map(async (n) => {
        const res = await fetch(`${started.base}/v1/scrape`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://example.com/p/${n}` }),
        });
        const body = await res.json() as { jobId: string };
        return body.jobId;
      }),
    );

    const crawlRes = await fetch(`${started.base}/v1/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', limit: 2 }),
    });
    const { jobId: crawlJobId } = await crawlRes.json() as { jobId: string };

    for (let i = 0; i < 40; i++) {
      const done = await Promise.all(
        [...ids, crawlJobId].map(async (id) => {
          const j = await (await fetch(`${started.base}/v1/jobs/${id}`)).json() as { status: string };
          return j.status === 'completed';
        }),
      );
      if (done.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(maxObserved).toBeLessThanOrEqual(2);
    const crawlJob = await (await fetch(`${started.base}/v1/jobs/${crawlJobId}`)).json() as {
      logs: Array<{ msg: string }>;
    };
    expect(crawlJob.logs.some((l) => l.msg.includes('[1/2] Scraped https://example.com/1'))).toBe(true);
  });
});
