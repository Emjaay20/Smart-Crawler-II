import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crawlRequestKey, crawlSite, validateCrawlCheckpoint, type DiscoverRequest } from '../src/crawl.js';
import { JobStore } from '../src/jobs.js';

const ROOT = 'https://checkpoint.example/';
const REQUEST: DiscoverRequest = { url: ROOT, limit: 3, concurrency: 1, crawlDelayMs: 0, js: false };

function page(title: string, links: string[] = []) {
  return '<!doctype html><html><head><title>' + title + '</title></head><body><article>' +
    '<h1>' + title + '</h1><p>Controlled fixture content for reliable resume.</p>' +
    links.map((url) => '<a href="' + url + '">next</a>').join('') +
    '</article></body></html>';
}
function fixtureFetch(requests: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
    requests.push(url);
    const links = url === ROOT ? [ROOT + 'child-one', ROOT + 'child-two'] : [];
    return new Response(page('Fixture', links), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

describe('durable, explicit crawl checkpoint replay', () => {
  it('resumes after a completed batch without refetching previously committed pages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-crawl-cp-'));
    const db = join(dir, 'jobs.sqlite');
    try {
      const first = new JobStore(db);
      const job = first.createJob(ROOT, {
        ...REQUEST, kind: 'crawl', provider: 'local', recoveryVersion: 1,
        pendingRecoveryAttempts: 0,
      });
      expect(first.claimPending(job.id)).toBe(true);
      const initialRequests: string[] = [];
      const partial = await crawlSite(REQUEST, {
        fetch: fixtureFetch(initialRequests),
        onCheckpoint(cp) {
          if (!first.saveCrawlCheckpoint(job.id, cp)) throw Error('Lost claim');
        },
      });
      expect(partial.pages).toHaveLength(3);
      const cp = first.getCrawlCheckpoint(job.id)!;
      expect(cp.pages).toHaveLength(3);
      // Simulate an interrupted completion after the final checkpoint was saved.
      first.close();

      const recovered = new JobStore(db);
      expect(recovered.prepareRestartRecovery().markedFailed).toBe(1);
      const resumed = recovered.createManualCrawlResume(job.id);
      expect(resumed?.created).toBe(true);
      const childId = resumed!.job.id;
      expect(recovered.createManualCrawlResume(job.id)?.job.id).toBe(childId);
      expect(recovered.claimPending(childId)).toBe(true);
      const replayRequests: string[] = [];
      const result = await crawlSite(REQUEST, {
        checkpoint: recovered.getCrawlCheckpoint(childId)!,
        fetch: fixtureFetch(replayRequests),
        onCheckpoint: (state) => {
          if (!recovered.saveCrawlCheckpoint(childId, state)) throw Error('Lost claim');
        },
      });
      expect(replayRequests).toEqual([]);
      expect(result.pages).toHaveLength(3);
      expect(recovered.completeClaimed(childId, result)).toBe(true);
      expect(recovered.getJob(job.id)?.status).toBe('failed');
      expect(recovered.getJob(childId)?.status).toBe('completed');
      recovered.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects modified request fingerprints and non-public/malformed frontier records', () => {
    const cp = {
      version: 1 as const,
      seed: ROOT,
      requestKey: crawlRequestKey(REQUEST),
      pages: [{ url: ROOT, statusCode: 200 }],
      queue: [ROOT + 'child-one'],
      seen: [ROOT],
    };
    expect(validateCrawlCheckpoint(REQUEST, cp)).toEqual(cp);
    expect(() => validateCrawlCheckpoint({ ...REQUEST, limit: 5 }, cp)).toThrow();
    expect(() => validateCrawlCheckpoint(REQUEST, {
      ...cp, queue: ['http://127.0.0.1/private'],
    })).toThrow();
    expect(() => validateCrawlCheckpoint(REQUEST, {
      ...cp, queue: [ROOT, ROOT],
    })).toThrow();
  });

  it.skipIf(process.platform === 'win32')('preserves WAL checkpoint after SIGKILL and resumes from last committed frontier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-kill-crawl-'));
    const db = join(dir, 'jobs.sqlite');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const first = new JobStore(db);
      const parent = first.createJob(ROOT, {
        ...REQUEST, kind: 'crawl', provider: 'local',
        recoveryVersion: 1, pendingRecoveryAttempts: 0,
      });
      first.close();

      child = spawn(process.execPath, [
        '--import', 'tsx', 'tests/fixtures/killable-crawl.ts', db, parent.id,
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      const proc = child;
      let stderr = '';
      proc.stderr!.on('data', (buf: Buffer) => { stderr += buf.toString(); });
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        const timeout = setTimeout(() => reject(new Error('No checkpoint emitted: ' + stderr)), 12_000);
        proc.stdout!.on('data', (buf: Buffer) => {
          stdout += buf.toString();
          if (stdout.includes('CHECKPOINT_READY')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        proc.once('error', (err) => { clearTimeout(timeout); reject(err); });
        proc.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error('Worker exited before checkpoint: ' + code + ' ' + stderr));
        });
      });
      const exit = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      expect(proc.kill('SIGKILL')).toBe(true);
      await exit;

      const recovered = new JobStore(db);
      const committed = recovered.getCrawlCheckpoint(parent.id)!;
      expect(committed.pages).toHaveLength(1);
      expect(committed.queue).toEqual([ROOT + 'child-one', ROOT + 'child-two']);
      expect(recovered.getJob(parent.id)?.status).toBe('crawling');
      expect(recovered.recoverStaleJobs(undefined, 'restart_interrupted')).toBe(1);
      expect(recovered.getJob(parent.id)?.error?.code).toBe('restart_interrupted');

      const retry = recovered.createManualCrawlResume(parent.id)!;
      expect(retry.created).toBe(true);
      expect(recovered.claimPending(retry.job.id)).toBe(true);
      const fetched: string[] = [];
      const result = await crawlSite(REQUEST, {
        checkpoint: recovered.getCrawlCheckpoint(retry.job.id)!,
        fetch: fixtureFetch(fetched),
        onCheckpoint: (cp) => {
          if (!recovered.saveCrawlCheckpoint(retry.job.id, cp)) throw Error('Lost claim');
        },
      });
      expect(fetched).toEqual([ROOT + 'child-one', ROOT + 'child-two']);
      expect(result.pages.map((page) => page.url)).toEqual([
        ROOT, ROOT + 'child-one', ROOT + 'child-two',
      ]);
      expect(recovered.completeClaimed(retry.job.id, result)).toBe(true);
      expect(recovered.getJob(retry.job.id)?.status).toBe('completed');
      recovered.close();
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
