import cors from 'cors';
import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import { classifyError } from './errors.js';
import type { JobStore } from './jobs.js';
import { Metrics } from './metrics.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';

export interface AppDeps {
  store: JobStore;
  scrape: (request: ScrapeRequest) => Promise<ScrapeResult>;
  map?: (request: DiscoverRequest) => Promise<MapResult>;
  crawl?: (request: DiscoverRequest) => Promise<CrawlResult>;
  metrics?: Metrics;
  publicDir?: string;
}

export function createApp(deps: AppDeps): Express {
  const metrics = deps.metrics ?? new Metrics();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

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

  app.get('/metrics', (_req, res) => {
    res.type('text/plain').send(metrics.renderPrometheus());
  });

  app.get('/v1/stats', (_req, res) => {
    res.json(metrics.snapshot());
  });

  app.post('/v1/scrape', (req, res) => {
    const request = parseScrapeBody(req.body);
    if (!request) {
      return res.status(400).json({ error: 'URL is required' });
    }
    const job = enqueue(deps, metrics, 'scrape', request.url, request, async (jobId) => {
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

  app.post('/v1/map', (req, res) => {
    if (!deps.map) return res.status(501).json({ error: 'Map is not configured' });
    const request = parseDiscoverBody(req.body);
    if (!request) return res.status(400).json({ error: 'URL is required' });
    const mapper = deps.map;
    const job = enqueue(deps, metrics, 'map', request.url, request, async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Mapping ${request.url}` });
      const data = await mapper(request);
      deps.store.appendLog(jobId, { level: 'success', msg: `Discovered ${data.links.length} links` });
      metrics.recordMap(data.links.length);
      return data;
    });
    res.json({ jobId: job.id });
  });

  app.post('/v1/crawl', (req, res) => {
    if (!deps.crawl) return res.status(501).json({ error: 'Crawl is not configured' });
    const request = parseDiscoverBody(req.body);
    if (!request) return res.status(400).json({ error: 'URL is required' });
    const crawler = deps.crawl;
    const job = enqueue(deps, metrics, 'crawl', request.url, request, async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Crawling ${request.url} (limit ${request.limit ?? 5})` });
      const data = await crawler(request);
      deps.store.appendLog(jobId, { level: 'success', msg: `Crawled ${data.pages.length} pages` });
      metrics.recordCrawl(data.pages.length);
      return data;
    });
    res.json({ jobId: job.id });
  });

  app.post('/crawl', (req, res) => {
    const request = parseScrapeBody(req.body);
    if (!request) {
      return res.status(400).json({ error: 'URL is required' });
    }
    const job = enqueue(deps, metrics, 'scrape', request.url, request, async (jobId) => {
      deps.store.appendLog(jobId, { level: 'info', msg: `Fetching ${request.url}` });
      const data = await deps.scrape(request);
      metrics.recordScrape({ ok: true, engine: data.metadata.engine, durationMs: data.timing.totalMs });
      return data;
    });
    res.json({ jobId: job.id });
  });

  app.get('/v1/jobs/:jobId', (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(serializeJob(job));
  });

  app.get('/status/:jobId', (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
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
  work: (jobId: string) => Promise<unknown>,
) {
  const job = deps.store.createJob(url, { kind, ...(options as Record<string, unknown>) });
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
