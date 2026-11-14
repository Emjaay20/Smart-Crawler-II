import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smartcrawl-jobs-'));
  dirs.push(dir);
  return join(dir, 'jobs.sqlite');
}

describe('JobStore', () => {
  it('creates a pending job and reads it back', () => {
    const store = new JobStore(':memory:');
    const job = store.createJob('https://example.com', { timeoutMs: 5000 });

    expect(job.status).toBe('pending');
    expect(job.url).toBe('https://example.com');
    expect(job.logs).toEqual([]);
    expect(store.getJob(job.id)?.id).toBe(job.id);
    expect(store.getJob('missing')).toBeNull();
    store.close();
  });

  it('appends logs and completes with data', () => {
    const store = new JobStore(':memory:');
    const job = store.createJob('https://example.com', {});

    store.setStatus(job.id, 'crawling');
    store.appendLog(job.id, { level: 'info', msg: 'Fetching' });
    store.complete(job.id, { markdown: '# Hi' });

    const loaded = store.getJob(job.id);
    expect(loaded?.status).toBe('completed');
    expect(loaded?.data).toEqual({ markdown: '# Hi' });
    expect(loaded?.logs).toHaveLength(1);
    expect(loaded?.logs[0]?.msg).toBe('Fetching');
    store.close();
  });

  it('records failures with an error code', () => {
    const store = new JobStore(':memory:');
    const job = store.createJob('https://example.com', {});
    store.fail(job.id, { code: 'timeout', message: 'timed out' });

    const loaded = store.getJob(job.id);
    expect(loaded?.status).toBe('failed');
    expect(loaded?.error).toEqual({ code: 'timeout', message: 'timed out' });
    store.close();
  });

  it('survives process restart via the sqlite file and recovers stale in-flight jobs', () => {
    const path = tempDbPath();
    const first = new JobStore(path);
    const created = first.createJob('https://example.com/a', { userAgent: 'test' });
    first.setStatus(created.id, 'crawling');
    first.appendLog(created.id, { level: 'info', msg: 'started' });
    first.close();

    const second = new JobStore(path);
    const recovered = second.recoverStaleJobs('Worker restarted');
    expect(recovered).toBe(1);

    const loaded = second.getJob(created.id);
    expect(loaded?.url).toBe('https://example.com/a');
    expect(loaded?.status).toBe('failed');
    expect(loaded?.error?.message).toBe('Worker restarted');
    expect(loaded?.logs).toHaveLength(2);
    second.close();
  });

  it('lists recent jobs scoped by keyId when authOn is true', () => {
    const store = new JobStore(':memory:');
    store.createJob('https://example.com/1', { keyId: 'key-a', kind: 'scrape' });
    store.createJob('https://example.com/2', { keyId: 'key-b', kind: 'map' });

    const keyAJobs = store.listJobs({ keyId: 'key-a', authOn: true, limit: 10 });
    expect(keyAJobs).toHaveLength(1);
    expect(keyAJobs[0]?.url).toBe('https://example.com/1');

    const allPublic = store.listJobs({ authOn: false, limit: 10 });
    expect(allPublic).toHaveLength(2);
    store.close();
  });
  it('does not persist proxy credentials in new jobs', () => {
    const store = new JobStore(':memory:');
    const proxy = 'http://operator:sample-password@proxy.example:8080';
    const job = store.createJob('https://example.com', { kind: 'scrape', proxy });
    expect(job.options).not.toHaveProperty('proxy');
    expect(store.getJob(job.id)?.options).not.toHaveProperty('proxy');
    const raw = store.db.prepare('SELECT options_json FROM jobs WHERE id = ?')
      .get(job.id) as { options_json: string };
    expect(raw.options_json).not.toContain('sample-password');
    store.close();
  });

  it('scrubs previously persisted proxy URLs when reopening the job database', () => {
    const path = tempDbPath();
    const first = new JobStore(path);
    const legacy = first.createJob('https://example.com', { kind: 'scrape' });
    first.db.prepare('UPDATE jobs SET options_json = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'scrape', proxy: 'http://operator:legacy-password@proxy.example:8080' }), legacy.id);
    first.close();

    const reopened = new JobStore(path);
    const stored = reopened.db.prepare('SELECT options_json FROM jobs WHERE id = ?')
      .get(legacy.id) as { options_json: string };
    expect(stored.options_json).not.toContain('legacy-password');
    expect(reopened.getJob(legacy.id)?.options).not.toHaveProperty('proxy');
    reopened.close();
  });

});
