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

  it('rejects scrape requests without a url', async () => {
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
  });

  it('runs a scrape job and returns durable status with real logs', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({
      store,
      scrape: async () => sample,
    });
    const started = await listen(app);
    server = started.server;

    const created = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', timeoutMs: 3000, userAgent: 'test-ua' }),
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
    expect(payload.data).toEqual(sample);
    expect(Array.isArray(payload.logs)).toBe(true);
    expect((payload.logs as { msg: string }[]).some((line) => /https:\/\/example.com/.test(line.msg))).toBe(true);

    const legacy = await (await fetch(`${started.base}/status/${jobId}`)).json() as Record<string, unknown>;
    expect(legacy.status).toBe('completed');
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

    const page = await fetch(`${started.base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/SmartCrawl/);
    expect((await fetch(`${started.base}/health`)).status).toBe(200);
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
});
