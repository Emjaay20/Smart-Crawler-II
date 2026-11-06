import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';
import type { ScrapeResult } from '../src/types.js';

const sample: ScrapeResult = {
  success: true,
  markdown: '# Demo Page Content',
  metadata: {
    title: 'Demo',
    statusCode: 200,
    sourceUrl: 'https://example.com/demo',
    finalUrl: 'https://example.com/demo',
    redirectChain: [],
    engine: 'http',
  },
  warnings: [],
  timing: { ttfbMs: 5, totalMs: 15 },
};

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe('guest demo tier rate-limiting', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  function boot(guestDemoLimit = 2) {
    const store = new JobStore(':memory:');
    stores.push(store);
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      keys,
      adminToken: 'admin-secret',
      guestDemoLimit,
      scrape: async () => sample,
    });
    return { app, keys, store };
  }

  it('exposes guest quota on /v1/me and permits 2 free demo runs before gating behind sign-in', async () => {
    const { app } = boot(2);
    const started = await listen(app);
    server = started.server;

    // 1. Initial state: /v1/me reports 2 remaining demo runs
    const me1 = await (await fetch(`${started.base}/v1/me`, {
      headers: { 'x-forwarded-for': '203.0.113.195' },
    })).json() as any;
    expect(me1.authenticated).toBe(false);
    expect(me1.authRequired).toBe(true);
    expect(me1.guest).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
      allowed: true,
    });

    // 2. First demo scrape from IP 203.0.113.195 -> SUCCESS
    const run1 = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.195',
      },
      body: JSON.stringify({ url: 'https://example.com/demo1' }),
    });
    expect(run1.status).toBe(200);
    expect(run1.headers.get('x-demo-limit')).toBe('2');
    expect(run1.headers.get('x-demo-remaining')).toBe('1');
    const { jobId: job1Id } = await run1.json() as { jobId: string };

    // Guest can poll their own job status without an API key
    const poll1 = await fetch(`${started.base}/v1/jobs/${job1Id}`, {
      headers: { 'x-forwarded-for': '203.0.113.195' },
    });
    expect(poll1.status).toBe(200);

    // 3. Second demo scrape from same IP -> SUCCESS
    const run2 = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.195',
      },
      body: JSON.stringify({ url: 'https://example.com/demo2' }),
    });
    expect(run2.status).toBe(200);
    expect(run2.headers.get('x-demo-remaining')).toBe('0');

    // /v1/me now reports 0 remaining and allowed: false
    const me2 = await (await fetch(`${started.base}/v1/me`, {
      headers: { 'x-forwarded-for': '203.0.113.195' },
    })).json() as any;
    expect(me2.guest.used).toBe(2);
    expect(me2.guest.remaining).toBe(0);
    expect(me2.guest.allowed).toBe(false);

    // 4. Third demo scrape from same IP -> REJECTED with 401 and demo_quota_exceeded
    const run3 = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.195',
      },
      body: JSON.stringify({ url: 'https://example.com/demo3' }),
    });
    expect(run3.status).toBe(401);
    const body3 = await run3.json() as any;
    expect(body3.code).toBe('demo_quota_exceeded');
    expect(body3.error).toContain('Free demo limit reached');

    // 5. A different IP is isolated and still has its full 2 demo scrapes
    const otherIpRun = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.42',
      },
      body: JSON.stringify({ url: 'https://example.com/other-user' }),
    });
    expect(otherIpRun.status).toBe(200);
    expect(otherIpRun.headers.get('x-demo-remaining')).toBe('1');
  });
});
