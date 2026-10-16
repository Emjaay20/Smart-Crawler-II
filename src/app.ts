import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import { classifyError } from './errors.js';
import type { JobStore } from './jobs.js';
import { bearerToken, utcDay, type AuthKey, type KeyStore } from './keys.js';
import { Metrics } from './metrics.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';

export interface AppDeps {
  store: JobStore;
  scrape: (request: ScrapeRequest) => Promise<ScrapeResult>;
  map?: (request: DiscoverRequest) => Promise<MapResult>;
  crawl?: (request: DiscoverRequest) => Promise<CrawlResult>;
  metrics?: Metrics;
  publicDir?: string;
  keys?: KeyStore;
  adminToken?: string;
}

export function createApp(deps: AppDeps): Express {
  const metrics = deps.metrics ?? new Metrics();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

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
    if (!authOn || !deps.keys) return next();
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
    if (token !== deps.adminToken) {
      return res.status(401).json({ error: 'Admin token required', code: 'unauthorized' });
    }
    next();
  };

  const takeQuota = (req: Request, res: Response, next: NextFunction) => {
    if (!authOn || !deps.keys) return next();
    const key = res.locals.apiKey as AuthKey | undefined;
    if (!key) return res.status(401).json({ error: 'API key required', code: 'unauthorized' });
    const used = deps.keys.consume(key.id, utcDay(new Date()));
    if (!used.ok) {
      return res.status(429).json({ error: 'Daily quota exceeded', code: 'quota_exceeded', remaining: 0 });
    }
    res.locals.quotaRemaining = used.remaining;
    next();
  };

  app.get('/metrics', requireUser, (_req, res) => {
    res.type('text/plain').send(metrics.renderPrometheus());
  });

  app.get('/v1/stats', requireUser, (_req, res) => {
    res.json(metrics.snapshot());
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

  app.post('/v1/scrape', requireUser, takeQuota, (req, res) => {
    const request = parseScrapeBody(req.body);
    if (!request) {
      return res.status(400).json({ error: 'URL is required' });
    }
    const job = enqueue(deps, metrics, 'scrape', request.url, request, keyOptions(res), async (jobId) => {
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
    });
    res.json({ jobId: job.id });
  });

  app.post('/v1/map', requireUser, takeQuota, (req, res) => {
    if (!deps.map) return res.status(501).json({ error: 'Map is not configured' });
    const request = parseDiscoverBody(req.body);
    if (!request) return res.status(400).json({ error: 'URL is required' });
    const mapper = deps.map;
    const job = enqueue(deps, metrics, 'map', request.url, request, keyOptions(res), async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Mapping ${request.url}` });
      const data = await mapper(request);
      deps.store.appendLog(jobId, { level: 'success', msg: `Discovered ${data.links.length} links` });
      metrics.recordMap(data.links.length);
      return data;
    });
    res.json({ jobId: job.id });
  });

  app.post('/v1/crawl', requireUser, takeQuota, (req, res) => {
    if (!deps.crawl) return res.status(501).json({ error: 'Crawl is not configured' });
    const request = parseDiscoverBody(req.body);
    if (!request) return res.status(400).json({ error: 'URL is required' });
    const crawler = deps.crawl;
    const job = enqueue(deps, metrics, 'crawl', request.url, request, keyOptions(res), async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Crawling ${request.url} (limit ${request.limit ?? 5})` });
      const data = await crawler(request);
      deps.store.appendLog(jobId, { level: 'success', msg: `Crawled ${data.pages.length} pages` });
      metrics.recordCrawl(data.pages.length);
      return data;
    });
    res.json({ jobId: job.id });
  });

  app.post('/crawl', requireUser, takeQuota, (req, res) => {
    const request = parseScrapeBody(req.body);
    if (!request) {
      return res.status(400).json({ error: 'URL is required' });
    }
    const job = enqueue(deps, metrics, 'scrape', request.url, request, keyOptions(res), async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Fetching ${request.url}` });
      const data = await deps.scrape(request);
      metrics.recordScrape({ ok: true, engine: data.metadata.engine, durationMs: data.timing.totalMs });
      return data;
    });
    res.json({ jobId: job.id });
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

function parseScrapeBody(body: unknown): ScrapeRequest | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url.trim()) return null;

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
  return request;
}

function parseDiscoverBody(body: unknown): DiscoverRequest | null {
  const base = parseScrapeBody(body);
  if (!base) return null;
  const record = body as Record<string, unknown>;
  const request: DiscoverRequest = { ...base };
  if (typeof record.limit === 'number' && Number.isFinite(record.limit)) request.limit = record.limit;
  if (Array.isArray(record.includePaths)) {
    request.includePaths = record.includePaths.filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(record.excludePaths)) {
    request.excludePaths = record.excludePaths.filter((value): value is string => typeof value === 'string');
  }
  return request;
}

function enqueue(
  deps: AppDeps,
  metrics: Metrics,
  kind: string,
  url: string,
  options: Record<string, unknown> | ScrapeRequest | DiscoverRequest,
  extra: Record<string, unknown>,
  work: (jobId: string) => Promise<unknown>,
) {
  const job = deps.store.createJob(url, { kind, ...(options as Record<string, unknown>), ...extra });
  void runJob(deps, metrics, job.id, work);
  return job;
}

async function runJob(
  deps: AppDeps,
  metrics: Metrics,
  jobId: string,
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
    metrics.recordScrape({ ok: false, durationMs: Date.now() - started });
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
  };
}
