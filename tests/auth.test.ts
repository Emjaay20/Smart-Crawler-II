import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';
import type { ScrapeResult } from '../src/types.js';

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

describe('api keys', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  function boot() {
    const store = new JobStore(':memory:');
    stores.push(store);
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      keys,
      adminToken: 'admin-secret',
      scrape: async () => sample,
    });
    return { app, keys };
  }

  it('keeps /health public and rejects scrape without a key', async () => {
    const { app } = boot();
    const started = await listen(app);
    server = started.server;

    expect((await fetch(`${started.base}/health`)).status).toBe(200);
    const scrape = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(scrape.status).toBe(401);
  });

  it('lets an admin mint a key that can scrape until the daily cap', async () => {
    const { app } = boot();
    const started = await listen(app);
    server = started.server;

    const minted = await fetch(`${started.base}/v1/admin/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ name: 'alice', dailyLimit: 1 }),
    });
    expect(minted.status).toBe(201);
    const body = await minted.json() as { key: string };
    expect(body.key.startsWith('sc_live_')).toBe(true);

    const first = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.key}` },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.key}` },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(second.status).toBe(429);
  });

  it('rejects a bad admin token', async () => {
    const { app } = boot();
    const started = await listen(app);
    server = started.server;
    const minted = await fetch(`${started.base}/v1/admin/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ name: 'alice' }),
    });
    expect(minted.status).toBe(401);
  });
});
