import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { crawlRequestKey, crawlSite, type DiscoverRequest } from '../src/crawl.js';
import { JobStore } from '../src/jobs.js';

const ROOT = 'https://resume.example/';
const options: DiscoverRequest = { url: ROOT, limit: 2, concurrency: 1, crawlDelayMs: 0 };

describe('explicit administrator checkpoint resumption', () => {
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

  it('requires feature opt-in, administrator token and explicit possible-refetch consent', async () => {
    store = new JobStore(':memory:');
    const parent = store.createJob(ROOT, {
      ...options, kind: 'crawl', provider: 'local', recoveryVersion: 1,
    });
    expect(store.claimPending(parent.id)).toBe(true);
    expect(store.saveCrawlCheckpoint(parent.id, {
      version: 1, seed: ROOT, requestKey: crawlRequestKey(options),
      pages: [{ url: ROOT, statusCode: 200 }],
      queue: [ROOT + 'next'], seen: [ROOT],
    })).toBe(true);
    store.failClaimed(parent.id, { code: 'restart_interrupted', message: 'Interrupted' });

    const requested: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      requested.push(url);
      return new Response(
        '<html><head><title>Next</title></head><body><article><h1>Next</h1>' +
        '<p>Resume a previous crawl using controlled fixtures.</p></article></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;

    const app = createApp({
      store, adminToken: 'secret-admin',
      enableCrawlCheckpoints: true, enableCheckpointResume: true,
      scrape: async () => { throw new Error('not used'); },
      crawl: (request, hooks) => crawlSite(request, { ...hooks, fetch: fetchImpl }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const endpoint = base + '/v1/admin/jobs/' + parent.id + '/resume';
    const post = (token: string | undefined, acknowledged: boolean) => fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ acknowledgePossibleRefetch: acknowledged }),
    });

    expect((await post(undefined, true)).status).toBe(401);
    expect((await post('secret-admin', false)).status).toBe(400);

    const first = await post('secret-admin', true);
    expect(first.status).toBe(201);
    const body = await first.json() as { jobId: string; created: boolean; parentJobId: string };
    expect(body.created).toBe(true);
    expect(body.parentJobId).toBe(parent.id);
    expect(body.jobId).not.toBe(parent.id);

    const again = await post('secret-admin', true);
    expect(again.status).toBe(200);
    expect((await again.json() as { jobId: string; created: boolean })).toMatchObject({
      jobId: body.jobId, created: false,
    });

    for (let attempt = 0; attempt < 100; attempt++) {
      if (store!.getJob(body.jobId)?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getJob(body.jobId)?.status).toBe('completed');
    expect((store.getJob(body.jobId)?.data as { pages: unknown[] }).pages).toHaveLength(2);
    expect(requested).toEqual([ROOT + 'next']);
    expect(store.getJob(parent.id)?.status).toBe('failed');
  });
});
