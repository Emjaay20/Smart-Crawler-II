import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SmartCrawl, SmartCrawlError } from '../src/client.js';
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

describe('SmartCrawl client', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  it('waits for a scrape job and returns markdown', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const app = createApp({ store, scrape: async () => sample });
    const started = await listen(app);
    server = started.server;

    const sc = new SmartCrawl({ baseUrl: started.base });
    const result = await sc.scrape('https://example.com');
    expect(result.markdown).toBe('# Hello');
    expect(result.metadata.engine).toBe('http');

    const listed = await sc.listJobs(5);
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]?.url).toBe('https://example.com');
  });

  it('throws SmartCrawlError on 401', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      keys,
      adminToken: 'admin-secret',
      scrape: async () => sample,
    });
    const started = await listen(app);
    server = started.server;

    const sc = new SmartCrawl({ baseUrl: started.base });
    await expect(sc.scrape('https://example.com')).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<SmartCrawlError>);
  });

  it('sends the API key, maps a site, and inspects quota via me()', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const keys = new KeyStore(store.db);
    const issued = keys.createKey('sdk', 10);
    const app = createApp({
      store,
      keys,
      adminToken: 'admin-secret',
      scrape: async () => sample,
      map: async () => ({ success: true as const, sourceUrl: 'https://example.com/', links: ['https://example.com/a'] }),
    });
    const started = await listen(app);
    server = started.server;

    const sc = new SmartCrawl({ baseUrl: started.base, apiKey: issued.key });
    const mapped = await sc.map('https://example.com');
    expect(mapped.links).toEqual(['https://example.com/a']);

    const me = await sc.me();
    expect(me.authenticated).toBe(true);
    expect(me.key?.usedToday).toBe(1);
    expect(me.key?.remaining).toBe(9);
  });
});
