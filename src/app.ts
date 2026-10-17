import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { SlackReporter } from './alerts.js';
import type { CrawledPage, CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import { classifyError } from './errors.js';
import type { JobStore } from './jobs.js';
import { bearerToken, safeEqualToken, utcDay, type AuthKey, type KeyStore } from './keys.js';
import { Metrics } from './metrics.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';
import { InvalidUrlError, validateHttpUrl } from './url.js';

export interface CrawlHooks {
  onPage?: (page: CrawledPage, index: number, limit: number) => void;
}

export interface AppDeps {
  store: JobStore;
  scrape: (request: ScrapeRequest) => Promise<ScrapeResult>;
  map?: (request: DiscoverRequest) => Promise<MapResult>;
  crawl?: (request: DiscoverRequest, hooks?: CrawlHooks) => Promise<CrawlResult>;
  metrics?: Metrics;
  alerts?: SlackReporter;
  publicDir?: string;
  keys?: KeyStore;
  adminToken?: string;
  maxConcurrentJobs?: number;
}

export function createApp(deps: AppDeps): Express {
  const metrics = deps.metrics ?? new Metrics();
  const alerts = deps.alerts ?? new SlackReporter();
  const maxConcurrent = Math.max(1, deps.maxConcurrentJobs ?? (Number(process.env.MAX_CONCURRENT_JOBS) || 4));
  let activeJobs = 0;
  const pendingTasks: Array<() => void> = [];

  const syncWorkerState = () => {
    metrics.setWorkerState(activeJobs, pendingTasks.length);
  };

  const runWithConcurrency = async (fn: () => Promise<void>): Promise<void> => {
    if (activeJobs >= maxConcurrent) {
      await new Promise<void>((resolve) => {
        pendingTasks.push(resolve);
        syncWorkerState();
      });
    }
    activeJobs += 1;
    syncWorkerState();
    try {
      await fn();
    } finally {
      activeJobs -= 1;
      const next = pendingTasks.shift();
      syncWorkerState();
      if (next) next();
    }
  };

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    next();
  });

  const authOn = Boolean(deps.adminToken && deps.keys);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/ready', (_req, res) => {
    try {
      deps.store.getJob('__ready__');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    if (!authOn || !deps.keys) {
      const token = bearerToken(req.headers.authorization);
      if (token && deps.keys) {
        const key = deps.keys.authenticate(token);
        if (key) res.locals.apiKey = key;
      }
      return next();
    }
    const token = bearerToken(req.headers.authorization);
    const key = token ? deps.keys.authenticate(token) : null;
    if (!key) {
      return res.status(401).json({ error: 'API key required', code: 'unauthorized' });
    }
    res.locals.apiKey = key;
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!deps.adminToken) {
      return res.status(501).json({ error: 'Admin token is not configured' });
    }
    const token = bearerToken(req.headers.authorization);
    if (!safeEqualToken(token, deps.adminToken)) {
      return res.status(401).json({ error: 'Admin token required', code: 'unauthorized' });
    }
    next();
  };

  const consumeQuotaOrReject = (res: Response): boolean => {
    if (!deps.keys) return true;
    const key = res.locals.apiKey as AuthKey | undefined;
    if (!key) {
      if (!authOn) return true;
      res.status(401).json({ error: 'API key required', code: 'unauthorized' });
      return false;
    }
    const used = deps.keys.consume(key.id, utcDay(new Date()));
    res.setHeader('x-ratelimit-limit', String(key.dailyLimit));
    res.setHeader('x-ratelimit-remaining', String(used.remaining));
    if (!used.ok) {
      res.status(429).json({ error: 'Daily quota exceeded', code: 'quota_exceeded', remaining: 0 });
      return false;
    }
    res.locals.quotaRemaining = used.remaining;
    return true;
  };

  app.get('/metrics', requireUser, (_req, res) => {
    res.type('text/plain').send(metrics.renderPrometheus());
  });

  app.get('/v1/stats', requireUser, (_req, res) => {
    res.json(metrics.snapshot());
  });

  app.get('/v1/me', requireUser, (_req, res) => {
    const key = res.locals.apiKey as AuthKey | undefined;
    const usage = key && deps.keys ? deps.keys.getUsage(key.id, utcDay(new Date())) : null;
    res.json({
      authenticated: Boolean(usage),
      authRequired: authOn,
      key: usage,
    });
  });

  app.post('/v1/keys/demo', (req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    if (authOn && process.env.SMARTCRAWL_ALLOW_DEMO_KEYS !== 'true') {
      return res.status(403).json({
        error: 'Self-serve demo keys are disabled when admin auth is enforced; use POST /v1/admin/keys',
        code: 'forbidden',
      });
    }
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 32) : 'playground-demo';
    const issued = deps.keys.createKey(name, 25);
    res.status(201).json({
      id: issued.id,
      name: issued.name,
      key: issued.key,
      prefix: issued.prefix,
      dailyLimit: issued.dailyLimit,
    });
  });

  app.post('/v1/admin/keys', requireAdmin, (req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    const body = req.body as { name?: unknown; dailyLimit?: unknown };
    const name = typeof body.name === 'string' ? body.name : 'unnamed';
    const dailyLimit = typeof body.dailyLimit === 'number' ? body.dailyLimit : 50;
    const issued = deps.keys.createKey(name, dailyLimit);
    res.status(201).json({
      id: issued.id,
      name: issued.name,
      key: issued.key,
      prefix: issued.prefix,
      dailyLimit: issued.dailyLimit,
    });
  });

  app.get('/v1/admin/keys', requireAdmin, (_req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    res.json({ keys: deps.keys.listKeys() });
  });

  app.delete('/v1/admin/keys/:id', requireAdmin, (req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    const ok = deps.keys.revoke(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'API key not found', code: 'not_found' });
    }
    res.json({ id: req.params.id, revoked: true });
  });

  app.get('/v1/report', requireUser, (_req, res) => {
    res.json(alerts.buildOperationalReport(metrics.snapshot()));
  });

  app.post('/v1/admin/report', requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as { webhookUrl?: unknown };
    const overrideUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined;
    const result = await alerts.sendOperationalReport(metrics.snapshot(), overrideUrl);
    res.json(result);
  });

  app.post('/v1/scrape', requireUser, (req, res) => {
    const parsed = parseAndValidateScrapeBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_url' });
    }
    if (!consumeQuotaOrReject(res)) return;
    const request = parsed.value;
    const job = enqueue(
      deps,
      metrics,
      alerts,
      runWithConcurrency,
      'scrape',
      request.url,
      request,
      keyOptions(res),
      async (jobId) => {
        deps.store.appendLog(jobId, { level: 'info', msg: `Fetching ${request.url}` });
        const data = await deps.scrape(request);
        deps.store.appendLog(jobId, {
          level: 'success',
          msg: `Extracted via ${data.metadata.engine} in ${data.timing.totalMs}ms`,
        });
        metrics.recordScrape({
          ok: true,
          engine: data.metadata.engine,
          durationMs: data.timing.totalMs,
        });
        return data;
      },
    );
    res.json({ jobId: job.id });
  });

  app.post('/v1/map', requireUser, (req, res) => {
    if (!deps.map) return res.status(501).json({ error: 'Map is not configured' });
    const parsed = parseAndValidateDiscoverBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_url' });
    }
    if (!consumeQuotaOrReject(res)) return;
    const request = parsed.value;
    const mapper = deps.map;
    const job = enqueue(
      deps,
      metrics,
      alerts,
      runWithConcurrency,
      'map',
      request.url,
      request,
      keyOptions(res),
      async (jobId) => {
        deps.store.appendLog(jobId, { level: 'info', msg: `Mapping ${request.url} (HTML + sitemap.xml)` });
        const data = await mapper(request);
        deps.store.appendLog(jobId, { level: 'success', msg: `Discovered ${data.links.length} links` });
        metrics.recordMap(data.links.length);
        return data;
      },
    );
    res.json({ jobId: job.id });
  });

  app.post('/v1/crawl', requireUser, (req, res) => {
    if (!deps.crawl) return res.status(501).json({ error: 'Crawl is not configured' });
    const parsed = parseAndValidateDiscoverBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_url' });
    }
    if (!consumeQuotaOrReject(res)) return;
    const request = parsed.value;
    const crawler = deps.crawl;
    const limit = request.limit ?? 5;
    const job = enqueue(
      deps,
      metrics,
      alerts,
      runWithConcurrency,
      'crawl',
      request.url,
      request,
      keyOptions(res),
      async (jobId) => {
        deps.store.appendLog(jobId, { level: 'info', msg: `Crawling ${request.url} (limit ${limit})` });
        const data = await crawler(request, {
          onPage: (page, idx, max) => {
            deps.store.appendLog(jobId, {
              level: 'info',
              msg: `[${idx}/${max}] Scraped ${page.url} (${page.statusCode})`,
            });
          },
        });
        deps.store.appendLog(jobId, { level: 'success', msg: `Crawled ${data.pages.length} pages` });
        metrics.recordCrawl(data.pages.length);
        return data;
      },
    );
    res.json({ jobId: job.id });
  });

  app.post('/crawl', requireUser, (req, res) => {
    const parsed = parseAndValidateScrapeBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_url' });
    }
    if (!consumeQuotaOrReject(res)) return;
    const request = parsed.value;
    const job = enqueue(
      deps,
      metrics,
      alerts,
      runWithConcurrency,
      'scrape',
      request.url,
      request,
      keyOptions(res),
      async (jobId) => {
        deps.store.appendLog(jobId, { level: 'info', msg: `Fetching ${request.url}` });
        const data = await deps.scrape(request);
        metrics.recordScrape({ ok: true, engine: data.metadata.engine, durationMs: data.timing.totalMs });
        return data;
      },
    );
    res.json({ jobId: job.id });
  });

  app.get('/v1/jobs', requireUser, (req, res) => {
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const key = res.locals.apiKey as AuthKey | undefined;
    const jobs = deps.store.listJobs({ keyId: key?.id, authOn, limit }).map(serializeJobSummary);
    res.json({ jobs });
  });

  app.get('/v1/jobs/:jobId', requireUser, (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job || !canReadJob(job.options, res.locals.apiKey as AuthKey | undefined, authOn)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(serializeJob(job));
  });

  app.get('/status/:jobId', requireUser, (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job || !canReadJob(job.options, res.locals.apiKey as AuthKey | undefined, authOn)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(serializeJob(job));
  });

  const publicDir = deps.publicDir;
  if (publicDir && fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (
        req.path.startsWith('/v1')
        || req.path.startsWith('/status')
        || req.path === '/crawl'
        || req.path === '/health'
        || req.path === '/ready'
        || req.path === '/metrics'
      ) {
        return next();
      }
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  return app;
}

function keyOptions(res: Response): Record<string, unknown> {
  const key = res.locals.apiKey as AuthKey | undefined;
  return key ? { keyId: key.id } : {};
}

function canReadJob(options: Record<string, unknown>, key: AuthKey | undefined, authOn: boolean): boolean {
  if (!authOn) return true;
  const owner = typeof options.keyId === 'string' ? options.keyId : null;
  if (!owner || !key) return false;
  return owner === key.id;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseAndValidateScrapeBody(body: unknown): ParseResult<ScrapeRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'URL is required' };
  const record = body as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url.trim()) {
    return { ok: false, error: 'URL is required' };
  }

  try {
    validateHttpUrl(record.url.trim());
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Invalid URL' };
  }

  const request: ScrapeRequest = { url: record.url.trim() };
  if (Array.isArray(record.formats)) {
    const formats = record.formats.filter(
      (value): value is NonNullable<ScrapeRequest['formats']>[number] =>
        value === 'markdown' || value === 'links' || value === 'metadata' || value === 'html',
    );
    if (formats.length) request.formats = formats;
  }
  if (typeof record.onlyMainContent === 'boolean') request.onlyMainContent = record.onlyMainContent;
  if (record.js === true || record.js === false || record.js === 'auto') request.js = record.js;
  if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)) request.timeoutMs = record.timeoutMs;
  if (typeof record.userAgent === 'string' && record.userAgent.trim()) request.userAgent = record.userAgent.trim();
  return { ok: true, value: request };
}

function parseAndValidateDiscoverBody(body: unknown): ParseResult<DiscoverRequest> {
  const base = parseAndValidateScrapeBody(body);
  if (!base.ok) return base;
  const record = body as Record<string, unknown>;
  const request: DiscoverRequest = { ...base.value };
  if (typeof record.limit === 'number' && Number.isFinite(record.limit)) request.limit = record.limit;
  if (Array.isArray(record.includePaths)) {
    request.includePaths = record.includePaths.filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(record.excludePaths)) {
    request.excludePaths = record.excludePaths.filter((value): value is string => typeof value === 'string');
  }
  return { ok: true, value: request };
}

function enqueue(
  deps: AppDeps,
  metrics: Metrics,
  alerts: SlackReporter,
  runWithConcurrency: (fn: () => Promise<void>) => Promise<void>,
  kind: string,
  url: string,
  options: Record<string, unknown> | ScrapeRequest | DiscoverRequest,
  extra: Record<string, unknown>,
  work: (jobId: string) => Promise<unknown>,
) {
  const job = deps.store.createJob(url, { kind, ...(options as Record<string, unknown>), ...extra });
  void runWithConcurrency(() => runJob(deps, metrics, alerts, job.id, url, work));
  return job;
}

async function runJob(
  deps: AppDeps,
  metrics: Metrics,
  alerts: SlackReporter,
  jobId: string,
  url: string,
  work: (jobId: string) => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  try {
    deps.store.setStatus(jobId, 'crawling');
    const data = await work(jobId);
    deps.store.complete(jobId, data);
  } catch (err) {
    const classified = classifyError(err);
    deps.store.appendLog(jobId, { level: 'error', msg: classified.message });
    deps.store.fail(jobId, classified);
    metrics.recordScrape({
      ok: false,
      durationMs: Date.now() - started,
      errorCode: classified.code,
    });
    void alerts.notifyFailureIfThresholdMet({
      jobId,
      url,
      errorCode: classified.code,
      errorMessage: classified.message,
      snapshot: metrics.snapshot(),
    });
  }
}

function serializeJob(job: NonNullable<ReturnType<JobStore['getJob']>>) {
  return {
    id: job.id,
    status: job.status,
    url: job.url,
    options: job.options,
    data: job.data,
    error: job.error?.message,
    errorCode: job.error?.code,
    logs: job.logs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function serializeJobSummary(job: NonNullable<ReturnType<JobStore['getJob']>>) {
  return {
    id: job.id,
    status: job.status,
    url: job.url,
    kind: typeof job.options.kind === 'string' ? job.options.kind : 'scrape',
    error: job.error?.message,
    errorCode: job.error?.code,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
