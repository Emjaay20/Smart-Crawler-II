import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type JobStatus = 'pending' | 'crawling' | 'completed' | 'failed';

export interface JobLog {
  time: string;
  level: 'info' | 'error' | 'success';
  msg: string;
}

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  url: string;
  options: Record<string, unknown>;
  data?: unknown;
  error?: JobError;
  logs: JobLog[];
  createdAt: number;
  updatedAt: number;
}

interface JobRow {
  id: string;
  status: string;
  url: string;
  options_json: string;
  data_json: string | null;
  error_json: string | null;
  logs_json: string;
  created_at: number;
  updated_at: number;
}

export class JobStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        url TEXT NOT NULL,
        options_json TEXT NOT NULL,
        data_json TEXT,
        error_json TEXT,
        logs_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  createJob(url: string, options: Record<string, unknown> = {}): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      status: 'pending',
      url,
      options,
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO jobs (id, status, url, options_json, data_json, error_json, logs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(job.id, job.status, job.url, JSON.stringify(job.options), JSON.stringify(job.logs), now, now);
    return job;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listJobs(opts: { keyId?: string; userId?: string; guestIp?: string; authOn?: boolean; limit?: number } = {}): Job[] {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit * 3) as unknown as JobRow[];

    const jobs: Job[] = [];
    for (const row of rows) {
      const job = this.fromRow(row);
      if (opts.authOn) {
        const owner = typeof job.options.keyId === 'string' ? job.options.keyId : null;
        const ownerUser = typeof job.options.userId === 'string' ? job.options.userId : null;
        const ownerGuestIp = typeof job.options.guestIp === 'string' ? job.options.guestIp : null;
        const permitted = opts.userId
          ? ownerUser === opts.userId
          : opts.keyId
          ? Boolean(owner && opts.keyId === owner)
          : opts.guestIp
          ? Boolean(ownerGuestIp && opts.guestIp === ownerGuestIp)
          : false;
        if (!permitted) {
          continue;
        }
      }
      jobs.push(job);
      if (jobs.length >= limit) break;
    }
    return jobs;
  }

  recoverStaleJobs(reason = 'Server restarted before job completed'): number {
    const stale = this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('pending', 'crawling')")
      .all() as unknown as JobRow[];
    if (!stale.length) return 0;

    const now = Date.now();
    const iso = new Date(now).toISOString();
    const errorJson = JSON.stringify({ code: 'unknown', message: reason } satisfies JobError);
    const update = this.db.prepare(`
      UPDATE jobs SET status = 'failed', error_json = ?, logs_json = ?, updated_at = ? WHERE id = ?
    `);

    for (const row of stale) {
      const logs = JSON.parse(row.logs_json) as JobLog[];
      logs.push({ time: iso, level: 'error', msg: reason });
      update.run(errorJson, JSON.stringify(logs), now, row.id);
    }

    return stale.length;
  }

  setStatus(id: string, status: JobStatus): void {
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  appendLog(id: string, entry: Omit<JobLog, 'time'> & { time?: string }): void {
    const job = this.getJob(id);
    if (!job) return;
    job.logs.push({
      time: entry.time ?? new Date().toISOString(),
      level: entry.level,
      msg: entry.msg,
    });
    this.db.prepare('UPDATE jobs SET logs_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(job.logs), Date.now(), id);
  }

  complete(id: string, data: unknown): void {
    this.db.prepare(`
      UPDATE jobs SET status = 'completed', data_json = ?, error_json = NULL, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(data), Date.now(), id);
  }

  fail(id: string, error: JobError): void {
    this.db.prepare(`
      UPDATE jobs SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(error), Date.now(), id);
  }

  close(): void {
    this.db.close();
  }

  private fromRow(row: JobRow): Job {
    return {
      id: row.id,
      status: row.status as JobStatus,
      url: row.url,
      options: JSON.parse(row.options_json) as Record<string, unknown>,
      data: row.data_json ? JSON.parse(row.data_json) : undefined,
      error: row.error_json ? JSON.parse(row.error_json) as JobError : undefined,
      logs: JSON.parse(row.logs_json) as JobLog[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function exportJobAsJsonl(job: Job): string {
  const exportedAt = new Date(job.updatedAt || Date.now()).toISOString();
  const payload = (job.data ?? {}) as Record<string, unknown>;

  if (Array.isArray(payload.pages)) {
    return payload.pages
      .map((page) => {
        const p = page as Record<string, unknown>;
        return JSON.stringify({
          jobId: job.id,
          kind: 'crawl',
          url: p.url ?? job.url,
          title: p.title,
          statusCode: p.statusCode ?? 200,
          engine: p.engine ?? 'http',
          contentHash: p.contentHash,
          wordCount: p.wordCount,
          estimatedTokens: p.estimatedTokens,
          markdown: p.markdown ?? '',
          chunks: Array.isArray(p.chunks) ? p.chunks : [],
          exportedAt,
        });
      })
      .join('\n') + '\n';
  }

  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    jobId: job.id,
    kind: typeof job.options.kind === 'string' ? job.options.kind : 'scrape',
    url: metadata.finalUrl ?? metadata.sourceUrl ?? job.url,
    title: metadata.title,
    description: metadata.description,
    statusCode: metadata.statusCode ?? 200,
    engine: metadata.engine ?? 'http',
    contentHash: metadata.contentHash,
    wordCount: metadata.wordCount,
    estimatedTokens: metadata.estimatedTokens,
    markdown: typeof payload.markdown === 'string' ? payload.markdown : '',
    links: Array.isArray(payload.links) ? payload.links : [],
    chunks: Array.isArray(payload.chunks) ? payload.chunks : [],
    exportedAt,
  }) + '\n';
}
