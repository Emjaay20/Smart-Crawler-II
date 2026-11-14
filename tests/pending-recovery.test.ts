import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { JobStore, MAX_PENDING_RECOVERY_ATTEMPTS } from '../src/jobs.js';
import type { DiscoverRequest } from '../src/crawl.js';

const dirs: string[] = [];
const activeStores: JobStore[] = [];
afterEach(() => {
  while (activeStores.length) activeStores.pop()?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smartcrawl-recovery-'));
  dirs.push(dir);
  return join(dir, 'jobs.sqlite');
}
function open(path: string): JobStore {
  const store = new JobStore(path);
  activeStores.push(store);
  return store;
}
function close(store: JobStore) {
  store.close();
  const index = activeStores.indexOf(store);
  if (index >= 0) activeStores.splice(index, 1);
}
function eligible(url: string) {
  return { kind: 'crawl', url, provider: 'local', limit: 5,
    recoveryVersion: 1, pendingRecoveryAttempts: 0 };
}
async function waitUntil(test: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for recovered crawl');
}

describe('safe pending crawl restart recovery', () => {
  it('recovers explicitly eligible pending crawls, but never automatically replays an in-flight crawl', () => {
    const path = dbPath();
    const first = open(path);
    const pending = first.createJob('https://docs.example/pending', eligible('https://docs.example/pending'));
    const running = first.createJob('https://docs.example/running', eligible('https://docs.example/running'));
    expect(first.claimPending(running.id)).toBe(true);
    const old = first.createJob('https://docs.example/legacy', { kind: 'crawl', provider: 'local' });
    const proxy = first.createJob('https://docs.example/proxy', {
      kind: 'crawl', provider: 'local', proxy: 'https://secret@proxy.example:8443',
    });
    close(first);

    const rebooted = open(path);
    expect(rebooted.prepareRestartRecovery()).toEqual({
      recoverablePending: 1, markedFailed: 3,
    });
    expect(rebooted.listRecoverablePendingCrawls().map((job) => job.id)).toEqual([pending.id]);
    expect(rebooted.getJob(pending.id)?.status).toBe('pending');
    expect(rebooted.getJob(pending.id)?.options.pendingRecoveryAttempts).toBe(1);
    expect(rebooted.getJob(running.id)?.status).toBe('failed');
    expect(rebooted.getJob(running.id)?.error?.code).toBe('restart_interrupted');
    expect(rebooted.getJob(old.id)?.status).toBe('failed');
    expect(rebooted.getJob(proxy.id)?.status).toBe('failed');
  });

  it('limits repeated unclaimed restarts to prevent endless pending recovery', () => {
    const path = dbPath();
    const first = open(path);
    const job = first.createJob('https://docs.example/', eligible('https://docs.example/'));
    close(first);
    for (let count = 1; count <= MAX_PENDING_RECOVERY_ATTEMPTS; count++) {
      const restart = open(path);
      const summary = restart.prepareRestartRecovery();
      expect(summary.recoverablePending).toBe(1);
      expect(restart.getJob(job.id)?.options.pendingRecoveryAttempts).toBe(count);
      close(restart);
    }
    const exhausted = open(path);
    expect(exhausted.prepareRestartRecovery()).toMatchObject({
      recoverablePending: 0, markedFailed: 1,
    });
    expect(exhausted.getJob(job.id)?.status).toBe('failed');
  });

  it('uses atomic claiming and prevents a second worker from taking the same job', () => {
    const path = dbPath();
    const first = open(path);
    const job = first.createJob('https://docs.example/', eligible('https://docs.example/'));
    const other = open(path);
    expect(first.claimPending(job.id)).toBe(true);
    expect(other.claimPending(job.id)).toBe(false);
    expect(first.completeClaimed(job.id, { pages: [] })).toBe(true);
    expect(other.failClaimed(job.id, { code: 'timeout', message: 'late' })).toBe(false);
    expect(other.completeClaimed(job.id, { pages: ['duplicate'] })).toBe(false);
    expect(first.getJob(job.id)?.data).toEqual({ pages: [] });
  });

  it('resumes a pending crawl using its original ID and stored options, only once', async () => {
    const path = dbPath();
    const first = open(path);
    const job = first.createJob('https://docs.example/', eligible('https://docs.example/'));
    close(first);
    const second = open(path);
    second.prepareRestartRecovery();
    const calls: DiscoverRequest[] = [];
    const app = createApp({
      store: second,
      scrape: async () => { throw new Error('not used'); },
      crawl: async (request) => {
        calls.push(request);
        return { success: true, pages: [] };
      },
    });
    expect((app.locals.resumePendingCrawls as () => number)()).toBe(1);
    expect((app.locals.resumePendingCrawls as () => number)()).toBe(0);
    await waitUntil(() => second.getJob(job.id)?.status === 'completed');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://docs.example/', limit: 5, provider: 'local' });
    expect(second.getJob(job.id)?.logs.some((entry) => entry.msg.includes('Resuming'))).toBe(true);
    expect(second.getJob(job.id)?.status).toBe('completed');
    expect(second.listJobs()).toHaveLength(1);
  });

  it('fails a corrupted replay manifest instead of running a different target', () => {
    const path = dbPath();
    const store = open(path);
    const job = store.createJob('https://docs.example/safe', eligible('https://docs.example/safe'));
    store.db.prepare('UPDATE jobs SET options_json = ? WHERE id = ?').run(
      JSON.stringify({ ...eligible('https://docs.example/safe'),
        url: 'http://127.0.0.1/internal' }),
      job.id,
    );
    store.prepareRestartRecovery();
    let invoked = 0;
    const app = createApp({
      store,
      scrape: async () => { throw new Error('not used'); },
      crawl: async () => { invoked++; return { success: true, pages: [] }; },
    });
    expect((app.locals.resumePendingCrawls as () => number)()).toBe(0);
    expect(invoked).toBe(0);
    expect(store.getJob(job.id)?.status).toBe('failed');
    expect(store.getJob(job.id)?.error?.code).toBe('restart_invalid_manifest');
  });
});
