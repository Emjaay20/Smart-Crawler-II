import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountStore } from '../src/accounts.js';
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
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('SmartCrawl accounts', () => {
  let server: Server | undefined;
  const stores: JobStore[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
    while (stores.length) stores.pop()?.close();
  });

  it('keeps the external OIDC identity stable even if email changes', () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const accounts = new AccountStore(store.db);

    const first = accounts.upsertUser({
      issuer: 'https://auth.example.test/tenants/smartcrawl/',
      subject: 'user-123',
      email: 'first@example.test',
      name: 'Ada',
    });
    const updated = accounts.upsertUser({
      issuer: 'https://auth.example.test/tenants/smartcrawl',
      subject: 'user-123',
      email: 'new@example.test',
    });

    expect(updated.id).toBe(first.id);
    expect(updated.email).toBe('new@example.test');
    expect(updated.name).toBe('Ada');
  });

  it('issues a user-owned key through the account API and shares jobs across that user’s keys', async () => {
    const store = new JobStore(':memory:');
    stores.push(store);
    const accounts = new AccountStore(store.db);
    const account = accounts.upsertUser({ issuer: 'https://auth.example.test', subject: 'user-123' });
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      accounts,
      keys,
      adminToken: 'admin-secret',
      scrape: async () => sample,
      freeDailyLimit: 7,
    });
    const started = await listen(app);
    server = started.server;
    const session = accounts.createSession(account.id);

    const createKey = await fetch(`${started.base}/v1/account/keys`, {
      method: 'POST',
      headers: { cookie: `smartcrawl_session=${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'production' }),
    });
    expect(createKey.status).toBe(201);
    const issued = await createKey.json() as { key: string; id: string; dailyLimit: number };
    expect(issued.dailyLimit).toBe(7);

    const second = keys.createKey('staging', 7, account.id);
    const created = await fetch(`${started.base}/v1/scrape`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    const { jobId } = await created.json() as { jobId: string };

    let job: { status: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${started.base}/v1/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${second.key}` },
      });
      job = await response.json() as { status: string };
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.status).toBe('completed');

    const accountResponse = await fetch(`${started.base}/v1/account`, {
      headers: { cookie: `smartcrawl_session=${session}` },
    });
    const accountData = await accountResponse.json() as { user: { id: string }; apiKeys: Array<{ id: string }> };
    expect(accountData.user.id).toBe(account.id);
    expect(accountData.apiKeys.map((key) => key.id)).toContain(issued.id);
  });
});
