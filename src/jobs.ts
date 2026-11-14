import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateCrawlCheckpoint, type CrawlCheckpointV1, type DiscoverRequest } from './crawl.js';

export type JobStatus = 'pending' | 'crawling' | 'completed' | 'failed';
/** Only never-started, explicitly tagged, local crawl jobs may be replayed. */
export const MAX_PENDING_RECOVERY_ATTEMPTS = 3;
export interface RestartRecoverySummary {
  recoverablePending: number;
  markedFailed: number;
}

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
    // Migrate legacy job metadata without retaining proxy URLs that may contain
    // username/password credentials. Existing data/results remain unchanged.
    this.db.exec("UPDATE jobs SET options_json = json_remove(options_json, '$.proxy') WHERE json_valid(options_json) = 1 AND json_type(options_json, '$.proxy') IS NOT NULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_checkpoints (
        job_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS crawl_resume_links (
        source_job_id TEXT PRIMARY KEY,
        child_job_id TEXT NOT NULL UNIQUE
      );
    `);
  }

  createJob(url: string, options: Record<string, unknown> = {}): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      status: 'pending',
      url,
      options: sanitizeJobOptions(options),
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

  listJobs(opts: { keyId?: string; userId?: string; guestSessionId?: string; authOn?: boolean; limit?: number } = {}): Job[] {
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
        const ownerGuestSession = typeof job.options.guestSessionId === 'string' ? job.options.guestSessionId : null;
        const permitted = opts.userId
          ? ownerUser === opts.userId
          : opts.keyId
          ? Boolean(owner && opts.keyId === owner)
          : opts.guestSessionId
          ? Boolean(ownerGuestSession && opts.guestSessionId === ownerGuestSession)
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

  /**
   * Startup-only preparation for a single-writer SQLite deployment.
   * Already-running work is NEVER automatically replayed. Untagged pending jobs
   * and work with incomplete/unsafe replay metadata fail visibly.
   *
   * Each restart increments the pending-recovery counter, so repeated startup
   * crashes cannot leave indefinitely retryable queue entries.
   */
  prepareRestartRecovery(reason = 'Worker interrupted by process restart'): RestartRecoverySummary {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    let recoverablePending = 0;
    let markedFailed = 0;
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('pending', 'crawling') ORDER BY created_at, rowid")
      .all() as unknown as JobRow[];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        let options: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.options_json) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            options = parsed as Record<string, unknown>;
          }
        } catch {
          // A malformed or legacy manifest is not safe to replay.
        }

        const attempts = Number.isInteger(options.pendingRecoveryAttempts)
          && Number(options.pendingRecoveryAttempts) >= 0
          ? Number(options.pendingRecoveryAttempts) : 0;
        const eligible = row.status === 'pending'
          && options.kind === 'crawl'
          && options.provider === 'local'
          && options.recoveryVersion === 1
          && !('proxy' in options)
          && attempts < MAX_PENDING_RECOVERY_ATTEMPTS;

        const logs = JSON.parse(row.logs_json) as JobLog[];
        if (eligible) {
          logs.push({ time: timestamp, level: 'info', msg: 'Resuming unclaimed crawl after restart' });
          options.pendingRecoveryAttempts = attempts + 1;
          const updated = this.db.prepare(
            "UPDATE jobs SET options_json = ?, logs_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
          ).run(JSON.stringify(options), JSON.stringify(logs), now, row.id);
          recoverablePending += Number(updated.changes);
        } else {
          const message = row.status === 'crawling'
            ? reason + '; in-flight crawl not replayed to avoid duplicated requests'
            : 'Pending job cannot be safely replayed or exceeded restart attempt limit';
          logs.push({ time: timestamp, level: 'error', msg: message });
          const updated = this.db.prepare(
            "UPDATE jobs SET status = 'failed', error_json = ?, logs_json = ?, updated_at = ? WHERE id = ? AND status = ?"
          ).run(JSON.stringify({ code: 'restart_interrupted', message }), JSON.stringify(logs), now, row.id, row.status);
          markedFailed += Number(updated.changes);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { recoverablePending, markedFailed };
  }

  /** Result is bounded; this query is not an ownership authorization mechanism. */
  listRecoverablePendingCrawls(limit = 250): Job[] {
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'pending'
        AND json_valid(options_json) = 1
        AND json_extract(options_json, '$.kind') = 'crawl'
        AND json_extract(options_json, '$.provider') = 'local'
        AND json_extract(options_json, '$.recoveryVersion') = 1
      ORDER BY created_at, rowid LIMIT ?
    `).all(Math.min(1000, Math.max(1, Math.floor(limit)))) as unknown as JobRow[];
    return rows.map((row) => this.fromRow(row));
  }

  /** Atomic pending → running transition; a second worker cannot claim it. */
  claimPending(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE jobs SET status = 'crawling', updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(Date.now(), id);
    return Number(result.changes) === 1;
  }

  /** Ignore a late completion after another terminal state was recorded. */
  completeClaimed(id: string, data: unknown): boolean {
    const updated = this.db.prepare(
      "UPDATE jobs SET status = 'completed', data_json = ?, error_json = NULL, updated_at = ? WHERE id = ? AND status = 'crawling'"
    ).run(JSON.stringify(data), Date.now(), id);
    return Number(updated.changes) === 1;
  }

  /** Ignore late failure writes for jobs already completed or failed. */
  failClaimed(id: string, error: JobError): boolean {
    const updated = this.db.prepare(
      "UPDATE jobs SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ? AND status = 'crawling'"
    ).run(JSON.stringify(error), Date.now(), id);
    return Number(updated.changes) === 1;
  }

  failUnclaimed(id: string, message: string): boolean {
    const updated = this.db.prepare(
      "UPDATE jobs SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(JSON.stringify({ code: 'restart_invalid_manifest', message }), Date.now(), id);
    return Number(updated.changes) === 1;
  }

  /**
   * Commit a completed BFS batch only while this job remains claimed.
   * A process kill before this transaction commits leaves the prior checkpoint
   * intact; a kill after commit makes the new checkpoint durable.
   */
  saveCrawlCheckpoint(jobId: string, checkpoint: CrawlCheckpointV1): boolean {
    const content = JSON.stringify(checkpoint);
    if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) {
      throw new Error('Crawl checkpoint exceeds the 8 MiB storage budget');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT status FROM jobs WHERE id = ?')
        .get(jobId) as { status: string } | undefined;
      if (current?.status !== 'crawling') {
        this.db.exec('COMMIT');
        return false;
      }
      this.db.prepare(`
        INSERT INTO crawl_checkpoints (job_id, checkpoint_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          checkpoint_json = excluded.checkpoint_json,
          updated_at = excluded.updated_at
      `).run(jobId, content, Date.now());
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getCrawlCheckpoint(jobId: string): CrawlCheckpointV1 | null {
    const row = this.db.prepare('SELECT checkpoint_json FROM crawl_checkpoints WHERE job_id = ?')
      .get(jobId) as { checkpoint_json: string } | undefined;
    return row ? JSON.parse(row.checkpoint_json) as CrawlCheckpointV1 : null;
  }

  /**
   * Operator-confirmed *at-least-once* retry after an interrupted running crawl.
   * Creates a new job, copies only the last committed batch checkpoint, and
   * leaves the original failed job intact. Repeated calls are idempotent.
   */
  createManualCrawlResume(sourceId: string): { job: Job; created: boolean } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const link = this.db.prepare('SELECT child_job_id FROM crawl_resume_links WHERE source_job_id = ?')
        .get(sourceId) as { child_job_id: string } | undefined;
      if (link) {
        const job = this.getJob(link.child_job_id);
        this.db.exec('COMMIT');
        return job ? { job, created: false } : null;
      }
      const parent = this.getJob(sourceId);
      if (!parent || parent.status !== 'failed' ||
          parent.error?.code !== 'restart_interrupted' ||
          parent.options.kind !== 'crawl' ||
          parent.options.provider !== 'local' ||
          parent.options.recoveryVersion !== 1 ||
          'proxy' in parent.options) {
        this.db.exec('COMMIT');
        return null;
      }
      const checkpoint = this.getCrawlCheckpoint(sourceId);
      if (!checkpoint) {
        this.db.exec('COMMIT');
        return null;
      }
      // Persisted job data is untrusted input until its origin and fingerprint
      // match the request we intend to execute.
      validateCrawlCheckpoint(
        { ...parent.options, url: parent.url } as DiscoverRequest, checkpoint
      );
      if (checkpoint.pages.length === 0) {
        this.db.exec('COMMIT');
        return null;
      }
      const child = this.createJob(parent.url, {
        ...parent.options,
        resumeSourceId: sourceId,
        pendingRecoveryAttempts: 0,
      });
      this.db.prepare(`
        INSERT INTO crawl_checkpoints (job_id, checkpoint_json, updated_at)
        VALUES (?, ?, ?)
      `).run(child.id, JSON.stringify(checkpoint), Date.now());
      this.db.prepare(`
        INSERT INTO crawl_resume_links (source_job_id, child_job_id) VALUES (?, ?)
      `).run(sourceId, child.id);
      this.db.exec('COMMIT');
      return { job: child, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
      options: sanitizeJobOptions(JSON.parse(row.options_json) as Record<string, unknown>),
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

/** Persist safe job configuration only. The live request retains its proxy value in memory. */
function sanitizeJobOptions(options: Record<string, unknown>): Record<string, unknown> {
  const { proxy: _proxy, ...safe } = options;
  return safe;
}
