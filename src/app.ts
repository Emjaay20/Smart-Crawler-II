import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { SlackReporter } from './alerts.js';
import { AccountStore, type Account } from './accounts.js';
import type { CrawledPage, CrawlResult, DiscoverRequest, MapResult } from './crawl.js';
import { classifyError } from './errors.js';
import { exportJobAsJsonl, type JobStore } from './jobs.js';
import { bearerToken, safeEqualToken, utcDay, type AuthKey, type KeyStore } from './keys.js';
import { Metrics } from './metrics.js';
import { OidcClient } from './oidc.js';
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
  accounts?: AccountStore;
  oidc?: OidcClient;
  freeDailyLimit?: number;
  guestDemoLimit?: number;
  firecrawlConfigured?: boolean;
  proxyConfigured?: boolean;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

export function createApp(deps: AppDeps): Express {
  const metrics = deps.metrics ?? new Metrics();
  const alerts = deps.alerts ?? new SlackReporter();
  const maxConcurrent = Math.max(1, deps.maxConcurrentJobs ?? (Number(process.env.MAX_CONCURRENT_JOBS) || 4));
  const guestDemoLimit = Math.max(
    0,
    deps.guestDemoLimit !== undefined
      ? deps.guestDemoLimit
      : process.env.SMARTCRAWL_GUEST_DEMO_LIMIT !== undefined
      ? Number(process.env.SMARTCRAWL_GUEST_DEMO_LIMIT)
      : 0,
  );
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
  const freeDailyLimit = Math.max(1, deps.freeDailyLimit ?? (Number(process.env.SMARTCRAWL_FREE_DAILY_LIMIT) || 25));

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
    const token = bearerToken(req.headers.authorization);
    if (token && deps.keys) {
      const key = deps.keys.authenticate(token);
      if (key) {
        res.locals.apiKey = key;
        return next();
      }
      return res.status(401).json({ error: 'Invalid API key', code: 'unauthorized' });
    }

    if (!authOn || !deps.keys) {
      return next();
    }

    if (guestDemoLimit > 0) {
      const clientIp = getClientIp(req);
      const day = utcDay(new Date());
      const guestUsage = deps.keys.getGuestUsage(clientIp, day, guestDemoLimit);

      if (guestUsage.allowed) {
        res.locals.isGuestDemo = true;
        res.locals.guestIp = clientIp;
        res.locals.guestDay = day;
        return next();
      }

      return res.status(401).json({
        error: `Free demo limit reached (${guestUsage.used}/${guestDemoLimit}). Please sign in to create an account for 25 daily scrapes.`,
        code: 'demo_quota_exceeded',
        guestLimit: guestDemoLimit,
        guestRemaining: 0,
      });
    }

    return res.status(401).json({ error: 'API key required', code: 'unauthorized' });
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

  const currentAccount = (req: Request): Account | null => {
    if (!deps.accounts) return null;
    return deps.accounts.getSessionUser(readCookie(req.headers.cookie, 'smartcrawl_session'));
  };

  const requireAccount = (req: Request, res: Response, next: NextFunction) => {
    const account = currentAccount(req);
    if (!account) return res.status(401).json({ error: 'Sign in required', code: 'unauthorized' });
    res.locals.account = account;
    next();
  };

  app.get('/auth/login', async (_req, res) => {
    if (!deps.accounts || !deps.oidc) {
      return res.status(501).json({ error: 'Account sign-in is not configured' });
    }
    try {
      const attempt = deps.accounts.createLoginAttempt();
      res.redirect(302, await deps.oidc.authorizationUrl(attempt));
    } catch (err) {
      res.status(503).json({ error: publicAuthError(err) });
    }
  });

  app.get('/auth/callback', async (req, res) => {
    if (!deps.accounts || !deps.oidc) {
      return res.status(501).json({ error: 'Account sign-in is not configured' });
    }
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const attempt = deps.accounts.consumeLoginAttempt(state);
    if (!code || !attempt) return res.status(400).json({ error: 'This sign-in request has expired or is invalid' });
    try {
      const identity = await deps.oidc.exchangeCode({ code, ...attempt });
      const account = deps.accounts.upsertUser(identity);
      const session = deps.accounts.createSession(account.id);
      res.setHeader('set-cookie', sessionCookie(session, deps.oidc.config.redirectUri));
      res.redirect(302, '/app');
    } catch (err) {
      res.status(401).json({ error: publicAuthError(err) });
    }
  });

  app.post('/auth/logout', (req, res) => {
    deps.accounts?.revokeSession(readCookie(req.headers.cookie, 'smartcrawl_session'));
    res.setHeader('set-cookie', 'smartcrawl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.status(204).end();
  });

  app.get('/auth/me', (req, res) => {
    const account = currentAccount(req);
    res.json({
      configured: Boolean(deps.accounts && deps.oidc),
      authenticated: Boolean(account),
      user: account ? serializeAccount(account) : null,
    });
  });

  const consumeQuotaOrReject = (res: Response): boolean => {
    if (!deps.keys) return true;
    const key = res.locals.apiKey as AuthKey | undefined;
    if (!key) {
      if (res.locals.isGuestDemo && deps.keys) {
        const clientIp = res.locals.guestIp as string;
        const day = res.locals.guestDay as string;
        const result = deps.keys.consumeGuest(clientIp, day, guestDemoLimit);
        res.setHeader('x-demo-limit', String(guestDemoLimit));
        res.setHeader('x-demo-remaining', String(result.remaining));
        res.setHeader('x-ratelimit-limit', String(guestDemoLimit));
        res.setHeader('x-ratelimit-remaining', String(result.remaining));
        if (!result.ok) {
          res.status(401).json({
            error: `Free demo limit reached (${guestDemoLimit}/${guestDemoLimit}). Please sign in to create an account for 25 daily scrapes.`,
            code: 'demo_quota_exceeded',
            guestLimit: guestDemoLimit,
            guestRemaining: 0,
          });
          return false;
        }
        res.locals.quotaRemaining = result.remaining;
        return true;
      }
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

  app.get('/v1/providers', (_req, res) => {
    res.json({
      firecrawl: { configured: Boolean(deps.firecrawlConfigured) },
      proxy: { configured: Boolean(deps.proxyConfigured) },
    });
  });

  app.get('/v1/me', (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (token) {
      if (!deps.keys) return res.status(401).json({ error: 'Invalid API key', code: 'unauthorized' });
      const key = deps.keys.authenticate(token);
      if (!key) return res.status(401).json({ error: 'Invalid API key', code: 'unauthorized' });
      const usage = deps.keys.getUsage(key.id, utcDay(new Date()));
      return res.json({
        authenticated: Boolean(usage),
        authRequired: authOn,
        key: usage,
      });
    }

    if (authOn && guestDemoLimit === 0) {
      return res.status(401).json({ error: 'API key required', code: 'unauthorized' });
    }

    const clientIp = getClientIp(req);
    const guestUsage = deps.keys && guestDemoLimit > 0
      ? deps.keys.getGuestUsage(clientIp, utcDay(new Date()), guestDemoLimit)
      : null;

    res.json({
      authenticated: false,
      authRequired: authOn,
      key: null,
      guest: guestUsage ? {
        limit: guestDemoLimit,
        used: guestUsage.used,
        remaining: guestUsage.remaining,
        allowed: guestUsage.allowed,
      } : undefined,
    });
  });

  app.get('/v1/account', requireAccount, (_req, res) => {
    const account = res.locals.account as Account;
    res.json({
      user: serializeAccount(account),
      apiKeys: deps.keys?.listKeysForUser(account.id) ?? [],
    });
  });

  app.post('/v1/account/keys', requireAccount, (req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    const account = res.locals.account as Account;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : 'default';
    const issued = deps.keys.createKey(name, freeDailyLimit, account.id);
    res.status(201).json({
      id: issued.id,
      name: issued.name,
      key: issued.key,
      prefix: issued.prefix,
      dailyLimit: issued.dailyLimit,
    });
  });

  app.delete('/v1/account/keys/:id', requireAccount, (req, res) => {
    if (!deps.keys) return res.status(501).json({ error: 'Key store is not configured' });
    const account = res.locals.account as Account;
    if (!deps.keys.keyBelongsToUser(req.params.id, account.id)) {
      return res.status(404).json({ error: 'API key not found', code: 'not_found' });
    }
    deps.keys.revoke(req.params.id);
    res.json({ id: req.params.id, revoked: true });
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
          tokens: data.metadata.estimatedTokens,
          url: request.url,
          jobId,
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
    const request = { ...parsed.value, provider: 'local' as const };
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
    const request = { ...parsed.value, provider: 'local' as const };
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
        const totalTokens = data.pages.reduce((sum, p) => sum + (p.estimatedTokens ?? 0), 0);
        metrics.recordCrawl(data.pages.length, totalTokens);
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
    const guestIp = res.locals.guestIp as string | undefined;
    const jobs = deps.store.listJobs({ keyId: key?.id, userId: key?.userId, guestIp, authOn, limit }).map(serializeJobSummary);
    res.json({ jobs });
  });

  app.get('/v1/jobs/:jobId', requireUser, (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job || !canReadJob(job.options, res, authOn)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(serializeJob(job));
  });

  app.get('/v1/jobs/:jobId/export.jsonl', requireUser, (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job || !canReadJob(job.options, res, authOn)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Job is not completed yet' });
    }
    const jsonl = exportJobAsJsonl(job);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="smartcrawl_${job.id}.jsonl"`);
    res.send(jsonl);
  });

  app.get('/status/:jobId', requireUser, (req, res) => {
    const job = deps.store.getJob(req.params.jobId);
    if (!job || !canReadJob(job.options, res, authOn)) {
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
        || req.path.startsWith('/auth')
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
  if (key) {
    return { keyId: key.id, ...(key.userId ? { userId: key.userId } : {}) };
  }
  if (res.locals.isGuestDemo) {
    return { guestIp: res.locals.guestIp, isGuest: true };
  }
  return {};
}

function canReadJob(options: Record<string, unknown>, res: Response, authOn: boolean): boolean {
  if (!authOn) return true;
  const key = res.locals.apiKey as AuthKey | undefined;
  const owner = typeof options.keyId === 'string' ? options.keyId : null;
  const ownerUser = typeof options.userId === 'string' ? options.userId : null;
  if (key) {
    if (key.userId && ownerUser) return key.userId === ownerUser;
    return Boolean(owner && owner === key.id);
  }
  if (options.isGuest && options.guestIp) {
    const currentGuestIp = (res.locals.guestIp as string | undefined) ?? getClientIp(res.req as Request);
    return options.guestIp === currentGuestIp;
  }
  return false;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

function sessionCookie(token: string, redirectUri: string): string {
  const secure = redirectUri.startsWith('https://') ? '; Secure' : '';
  return `smartcrawl_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secure}`;
}

function serializeAccount(account: Account) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    plan: account.plan,
    createdAt: account.createdAt,
  };
}

function publicAuthError(_err: unknown): string {
  return 'Could not complete sign-in. Please try again.';
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
  if (record.provider === 'local' || record.provider === 'auto' || record.provider === 'firecrawl') {
    request.provider = record.provider;
  }
  if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)) request.timeoutMs = record.timeoutMs;
  if (typeof record.userAgent === 'string' && record.userAgent.trim()) request.userAgent = record.userAgent.trim();
  if (typeof record.maxRetries === 'number' && Number.isFinite(record.maxRetries)) request.maxRetries = record.maxRetries;
  if (typeof record.proxy === 'string' && record.proxy.trim()) {
    try {
      validateHttpUrl(record.proxy.trim());
      request.proxy = record.proxy.trim();
    } catch (err) {
      if (err instanceof InvalidUrlError) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: 'Invalid proxy URL' };
    }
  }
  return { ok: true, value: request };
}

function parseAndValidateDiscoverBody(body: unknown): ParseResult<DiscoverRequest> {
  const base = parseAndValidateScrapeBody(body);
  if (!base.ok) return base;
  const record = body as Record<string, unknown>;
  const request: DiscoverRequest = { ...base.value };
  if (typeof record.limit === 'number' && Number.isFinite(record.limit)) request.limit = record.limit;
  if (typeof record.crawlDelayMs === 'number' && Number.isFinite(record.crawlDelayMs)) {
    request.crawlDelayMs = Math.max(0, record.crawlDelayMs);
  }
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
      url,
      jobId,
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
