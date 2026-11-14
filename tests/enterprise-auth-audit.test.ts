import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { AuditStore } from '../src/audit.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';

describe('enterprise foundation: fail-closed authentication and audit events', () => {
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

  async function boot(withAdmin: boolean) {
    store = new JobStore(':memory:');
    const keys = new KeyStore(store.db);
    const app = createApp({
      store,
      keys,
      ...(withAdmin ? { adminToken: 'test-admin-only' } : {}),
      guestDemoLimit: 0,
      scrape: async () => { throw new Error('No scrape should be invoked'); },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    return { base: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, keys };
  }

  it('requires an API key whenever the key store exists even if admin token is unconfigured', async () => {
    const { base } = await boot(false);
    const unauthenticated = await fetch(base + '/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as { code: string }).code).toBe('unauthorized');

    const missingAdmin = await fetch(base + '/v1/admin/audit');
    expect(missingAdmin.status).toBe(501);
  });

  it('records admin key lifecycle with opaque references, without storing secrets', async () => {
    const { base } = await boot(true);
    const headers = {
      authorization: 'Bearer test-admin-only',
      'content-type': 'application/json',
    };
    const issued = await fetch(base + '/v1/admin/keys', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'staging-key', dailyLimit: 3 }),
    });
    expect(issued.status).toBe(201);
    const issuedKey = await issued.json() as { id: string; key: string };

    const revoked = await fetch(base + '/v1/admin/keys/' + issuedKey.id, {
      method: 'DELETE', headers,
    });
    expect(revoked.status).toBe(200);

    const unauthorized = await fetch(base + '/v1/admin/audit');
    expect(unauthorized.status).toBe(401);
    const auditResponse = await fetch(base + '/v1/admin/audit?limit=20', { headers });
    expect(auditResponse.status).toBe(200);
    expect(auditResponse.headers.get('cache-control')).toBe('no-store');
    const result = await auditResponse.json() as { events: Array<{
      action: string; resourceRef: string; actorType: string;
    }> };
    expect(result.events.map((event) => event.action)).toEqual([
      'admin.key.revoked',
      'admin.key.created',
    ]);
    expect(result.events[0]).toMatchObject({
      actorType: 'admin', resourceRef: issuedKey.id,
    });
    expect(JSON.stringify(result)).not.toContain(issuedKey.key);
    expect(JSON.stringify(result)).not.toContain('test-admin-only');
  });

  it('rejects secrets in audit identifiers and bounds the history page size', async () => {
    const { base } = await boot(true);
    const audit = new AuditStore(store!.db);
    expect(() => audit.record('admin.key.revoked', 'admin', 'https://secret@example.com')).toThrow();
    for (let i = 0; i < 105; i++) {
      audit.record('admin.key.created', 'admin', i.toString(16));
    }
    const response = await fetch(base + '/v1/admin/audit?limit=100000', {
      headers: { authorization: 'Bearer test-admin-only' },
    });
    const data = await response.json() as { events: unknown[] };
    expect(data.events).toHaveLength(100);
  });
});
