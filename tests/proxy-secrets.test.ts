import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import type { ScrapeRequest, ScrapeResult } from '../src/types.js';

const sample: ScrapeResult = {
  success: true,
  markdown: '# Example',
  metadata: {
    title: 'Example',
    sourceUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    redirectChain: [],
    statusCode: 200,
    engine: 'http',
  },
  warnings: [],
  timing: { ttfbMs: 1, totalMs: 5 },
};

describe('job configuration confidentiality', () => {
  const stores: JobStore[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  it('executes an in-memory proxy request but never stores or returns its credential URL', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    let received: ScrapeRequest | undefined;
    const app = createApp({ store, scrape: async (request) => {
      received = request;
      return sample;
    } });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = 'http://127.0.0.1:' + port;
    const proxy = 'http://proxy-user:private-pass@proxy.example:8080';

    const created = await fetch(base + '/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', proxy }),
    });
    expect(created.status).toBe(200);
    const { jobId } = await created.json() as { jobId: string };

    let status: { status: string; options: Record<string, unknown> } | undefined;
    for (let index = 0; index < 20; index++) {
      const result = await fetch(base + '/v1/jobs/' + jobId);
      status = await result.json() as typeof status;
      if (status?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status?.status).toBe('completed');
    expect(received?.proxy).toBe(proxy);
    expect(status?.options).not.toHaveProperty('proxy');
    expect(JSON.stringify(status)).not.toContain('private-pass');
    expect(store.getJob(jobId)?.options).not.toHaveProperty('proxy');
  });

  it('rejects destination URLs with embedded credentials before creating a job', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await fetch('http://127.0.0.1:' + port + '/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://alice:secret@example.com/page' }),
    });
    expect(result.status).toBe(400);
    expect(store.listJobs()).toHaveLength(0);
  });

  it('rejects broad or malformed trusted-proxy configuration', () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    expect(() => createApp({
      store,
      trustedProxies: ['*'],
      scrape: async () => sample,
    })).toThrow(/TRUSTED_PROXIES/);
    expect(() => createApp({
      store,
      trustedProxies: ['0.0.0.0/0'],
      scrape: async () => sample,
    })).toThrow(/TRUSTED_PROXIES/);
  });
});
