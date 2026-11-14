import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';
import { scrape } from '../src/scrape.js';

const page = '<!doctype html><html><head><title>Safe Page</title></head><body><article><h1>Sample Article</h1><p>A controlled response that demonstrates successful extraction.</p></article></body></html>';

describe('combined security controls: guest sessions and safe HTTP egress', () => {
  let server: Server | undefined;
  let store: JobStore | undefined;
  afterEach(async () => {
    if (server) {
      const current = server;
      await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    store?.close();
    store = undefined;
  });

  it('enforces guest ownership while rejecting redirected internal HTTP destinations', async () => {
    store = new JobStore(':memory:');
    const keys = new KeyStore(store.db);
    const attempted: string[] = [];
    const controlledFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      attempted.push(url);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      if (url.endsWith('/redirect')) return new Response(null, {
        status: 302, headers: { location: 'http://127.0.0.1/private' },
      });
      return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const app = createApp({
      store, keys, adminToken: 'integration-admin', guestDemoLimit: 2,
      scrape: (request) => scrape({ ...request, js: false }, { fetch: controlledFetch }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = 'http://127.0.0.1:' + port;

    const register = await fetch(base + '/v1/me');
    const ownerCookie = register.headers.get('set-cookie')!.split(';')[0]!;
    const created = await fetch(base + '/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ url: 'https://example.com/start' }),
    });
    expect(created.status).toBe(200);
    const { jobId } = await created.json() as { jobId: string };
    let jobStatus = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await fetch(base + '/v1/jobs/' + jobId, { headers: { cookie: ownerCookie } });
      const data = await status.json() as { status: string };
      jobStatus = data.status;
      if (jobStatus === 'completed' || jobStatus === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(jobStatus).toBe('completed');

    const secondVisitor = await fetch(base + '/v1/me');
    const otherCookie = secondVisitor.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(base + '/v1/jobs/' + jobId, { headers: { cookie: otherCookie } })).status).toBe(404);

    const redirect = await fetch(base + '/v1/scrape', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ url: 'https://example.com/redirect' }),
    });
    expect(redirect.status).toBe(200);
    const { jobId: redirectJobId } = await redirect.json() as { jobId: string };
    let redirectedStatus = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await fetch(base + '/v1/jobs/' + redirectJobId, { headers: { cookie: ownerCookie } });
      const data = await result.json() as { status: string };
      redirectedStatus = data.status;
      if (redirectedStatus === 'completed' || redirectedStatus === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(redirectedStatus).toBe('failed');
    expect(attempted).toContain('https://example.com/redirect');
    expect(attempted.some((url) => url.includes('127.0.0.1/private'))).toBe(false);
  });
});
