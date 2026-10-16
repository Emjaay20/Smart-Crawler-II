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
