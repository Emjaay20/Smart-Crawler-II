import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import type { DiscoverRequest } from '../src/crawl.js';
import { JobStore } from '../src/jobs.js';

describe('crawl concurrency API contract', () => {
  let server: Server | undefined;
  let store: JobStore | undefined;

  afterEach(async () => {
    if (server) {
      const current = server;
      await new Promise<void>((resolve, reject) =>
        current.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    store?.close();
    store = undefined;
  });

  async function boot(onCrawl: (request: DiscoverRequest) => void) {
    store = new JobStore(':memory:');
    const app = createApp({
      store,
      scrape: async () => {
        throw new Error('not used in crawl contract test');
      },
      crawl: async (request) => {
        onCrawl(request);
        return { success: true, pages: [] };
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    return 'http://127.0.0.1:' + port;
  }

  async function post(base: string, options: Record<string, unknown>) {
    return fetch(base + '/v1/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://docs.example/', ...options }),
    });
  }

  it('passes bounded concurrency to the crawler without changing default behavior', async () => {
    let captured: DiscoverRequest | undefined;
    const base = await boot((request) => { captured = request; });
    const response = await post(base, { concurrency: 3, crawlDelayMs: 500 });
    expect(response.status).toBe(200);
    const { jobId } = await response.json() as { jobId: string };
    for (let n = 0; n < 30 && !captured; n++) await new Promise((r) => setTimeout(r, 5));
    expect(captured).toMatchObject({ concurrency: 3, crawlDelayMs: 500 });
    expect(store!.getJob(jobId)?.status).toBe('completed');
  });

  it('rejects values outside 1–4 or non-integers before creating a job', async () => {
    const base = await boot(() => undefined);
    for (const concurrency of [0, -1, 2.5, 5, '4', null]) {
      const res = await post(base, { concurrency });
      expect(res.status, 'concurrency=' + String(concurrency)).toBe(400);
    }
    expect(store!.listJobs()).toHaveLength(0);
  });
});
