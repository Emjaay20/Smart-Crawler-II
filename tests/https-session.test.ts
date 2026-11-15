import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';

it('issues production guest cookies over certificate-verified HTTPS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smartcrawl-https-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const store = new JobStore(':memory:');
  vi.stubEnv('NODE_ENV', 'production');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    const certificate = readFileSync(cert);
    const app = createApp({ store, keys: new KeyStore(store.db), adminToken: 'fixture-admin',
      guestDemoLimit: 2, scrape: async () => { throw new Error('Fixture does not scrape'); } });
    server = createServer({ key: readFileSync(key), cert: certificate }, app);
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const response = await new Promise<{ status: number; cookies: string[] }>((done, reject) => {
      get(`https://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/me`,
        { ca: certificate }, (result) => {
          result.resume();
          result.on('end', () => done({ status: result.statusCode!, cookies: result.headers['set-cookie'] ?? [] }));
        }).on('error', reject);
    });
    expect(response.status).toBe(200);
    const cookie = response.cookies.join(';');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  } finally {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
