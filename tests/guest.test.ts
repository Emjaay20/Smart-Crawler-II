import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';
import type { ScrapeResult } from '../src/types.js';

const sample: ScrapeResult = {
  success: true,
  markdown: '# Guest Demo',
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
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return { server, base: 'http://127.0.0.1:' + address.port };
}

function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toContain('smartcrawl_guest=');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  return header!.split(';', 1)[0]!;
}

describe('guest demo identity and quotas', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  async function boot(limit = 2) {
    const store = new JobStore(':memory:');
    stores.push(store);
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      keys,
      adminToken: 'admin-test-token',
      guestDemoLimit: limit,
      scrape: async () => sample,
    });
    const started = await listen(app);
    server = started.server;
    return { ...started, keys, store };
  }

  async function submit(base: string, cookie?: string, forwardedIp?: string) {
    return fetch(base + '/v1/scrape', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(forwardedIp ? { 'x-forwarded-for': forwardedIp } : {}),
      },
      body: JSON.stringify({ url: 'https://example.com/demo' }),
    });
  }

  it('uses a private cookie to identify the guest and protect job access', async () => {
    const { base, store } = await boot();
    const meA = await fetch(base + '/v1/me');
    const cookieA = cookieFrom(meA);
    const meB = await fetch(base + '/v1/me');
    const cookieB = cookieFrom(meB);
    expect(cookieA).not.toEqual(cookieB);

    const created = await submit(base, cookieA, '203.0.113.10');
    expect(created.status).toBe(200);
    const { jobId } = await created.json() as { jobId: string };
    const stored = store.getJob(jobId)!;
    expect(stored.options.isGuest).toBe(true);
    expect(stored.options.guestSessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.options.guestIp).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(cookieA.split('=')[1]);

    const owned = await fetch(base + '/v1/jobs/' + jobId, { headers: { cookie: cookieA } });
    expect(owned.status).toBe(200);
    const ownedBody = await owned.json() as { options: Record<string, unknown> };
    expect(ownedBody.options).not.toHaveProperty('guestSessionId');
    expect(ownedBody.options).not.toHaveProperty('isGuest');

    const foreign = await fetch(base + '/v1/jobs/' + jobId, {
      headers: { cookie: cookieB, 'x-forwarded-for': '203.0.113.10' },
    });
    expect(foreign.status).toBe(404);

    const foreignExport = await fetch(base + '/v1/jobs/' + jobId + '/export.jsonl', { headers: { cookie: cookieB } });
    expect(foreignExport.status).toBe(404);

    const listedA = (await (await fetch(base + '/v1/jobs', { headers: { cookie: cookieA } })).json()) as { jobs: Array<{ id: string }> };
    const listedB = (await (await fetch(base + '/v1/jobs', { headers: { cookie: cookieB } })).json()) as { jobs: Array<{ id: string }> };
    expect(listedA.jobs.map((job) => job.id)).toContain(jobId);
    expect(listedB.jobs.map((job) => job.id)).not.toContain(jobId);

    const noCookie = await fetch(base + '/v1/jobs/' + jobId, {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(noCookie.status).toBe(404);
  });

  it('does not trust arbitrary forwarded-IP headers for guest quotas', async () => {
    const { base } = await boot(2);
    const me = await fetch(base + '/v1/me', { headers: { 'x-forwarded-for': '203.0.113.1' } });
    const cookie = cookieFrom(me);
    const first = await submit(base, cookie, '203.0.113.1');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-demo-remaining')).toBe('1');
    const { jobId } = await first.json() as { jobId: string };

    const second = await submit(base, cookie, '198.51.100.2');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-demo-remaining')).toBe('0');

    const third = await submit(base, undefined, '192.0.2.3');
    expect(third.status).toBe(401);
    expect((await third.json() as { code: string }).code).toBe('demo_quota_exceeded');

    // Quota exhaustion must not lock users out of their already-created results.
    expect((await fetch(base + '/v1/jobs/' + jobId, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(base + '/v1/jobs/' + jobId + '/export.jsonl', { headers: { cookie } })).status).toBe(200);
    const usage = (await (await fetch(base + '/v1/me', { headers: { cookie } })).json()) as { guest: { used: number; remaining: number; allowed: boolean } };
    expect(usage.guest).toMatchObject({ used: 2, remaining: 0, allowed: false });
  });

  it('does not grant legacy IP-owned guest jobs to a different session', async () => {
    const { base, store } = await boot();
    const legacy = store.createJob('https://example.com/old', {
      kind: 'scrape', isGuest: true, guestIp: '203.0.113.70',
    });
    const response = await fetch(base + '/v1/jobs/' + legacy.id, {
      headers: { 'x-forwarded-for': '203.0.113.70' },
    });
    expect(response.status).toBe(404);
  });

  it('ignores malformed guest cookies and issues a new valid session', async () => {
    const { base } = await boot();
    const res = await fetch(base + '/v1/me', {
      headers: { cookie: 'smartcrawl_guest=%E0%A4%A' },
    });
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toMatch(/smartcrawl_guest=sc_guest_/);
  });
});
