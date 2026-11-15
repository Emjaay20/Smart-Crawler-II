import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JobStore } from '../src/jobs.js';
import { backupJobDatabase } from '../src/backup.js';

it('restores committed WAL jobs and preserves an existing backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smartcrawl-backup-'));
  const source = join(directory, 'jobs.sqlite');
  const backup = join(directory, 'snapshot.sqlite');
  const store = new JobStore(source);
  try {
    const job = store.createJob('https://example.com/', { kind: 'crawl' });
    backupJobDatabase(source, backup);
    store.createJob('https://example.com/later');
    expect(() => backupJobDatabase(source, backup)).toThrow();
    expect(() => backupJobDatabase(source, source)).toThrow('different path');
    const restored = new JobStore(backup);
    try {
      expect(restored.getJob(job.id)).toEqual(job);
      expect(restored.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n).toBe(1);
      if (process.platform !== 'win32') expect(statSync(backup).mode & 0o777).toBe(0o600);
    } finally { restored.close(); }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
