import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { SlackReporter } from './alerts.js';
import { AuditStore } from './audit.js';
import { AccountStore, type Account } from './accounts.js';
import type { CrawledPage, CrawlResult, DiscoverRequest, MapResult, CrawlCheckpointV1 } from './crawl.js';
import { classifyError } from './errors.js';
import { exportJobAsJsonl, type JobStore } from './jobs.js';
import { bearerToken, safeEqualToken, utcDay, type AuthKey, type KeyStore } from './keys.js';
import { Metrics } from './metrics.js';
import { OidcClient } from './oidc.js';
import type { ScrapeRequest, ScrapeResult } from './types.js';
import { InvalidUrlError, validateHttpUrl } from './url.js';

export interface CrawlHooks {
  onPage?: (page: CrawledPage, index: number, limit: number) => void;
  checkpoint?: CrawlCheckpointV1;
  onCheckpoint?: (checkpoint: CrawlCheckpointV1) => void | Promise<void>;
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
  firecrawlLocal?: boolean;
  proxyConfigured?: boolean;
  browserConfigured?: boolean;
  /** Checkpoint writes are opt-in: HTML/Markdown may contain sensitive content. */
  enableCrawlCheckpoints?: boolean;
  /** Requires admin token and explicit acknowledgement of at-least-once requests. */
  enableCheckpointResume?: boolean;
  /** CIDRs for reverse proxies that may legitimately supply X-Forwarded-For. */
  trustedProxies?: string[];
}

export function getClientIp(req: Request): string {
  // Express resolves req.ip from the socket and explicitly trusted proxy hops.
  // Never read an untrusted X-Forwarded-For header directly.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function trustedProxyCidrs(input: string[]): string[] {
  const values = input.map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    const parts = value.split('/');
    const address = parts[0] ?? '';
    const family = isIP(address);
    const prefix = parts.length === 2 ? Number(parts[1]) : undefined;
    const max = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (!family || parts.length > 2 || (parts.length === 2 &&
      (!Number.isInteger(prefix) || prefix! < 1 || prefix! > max))) {
      throw new Error('SMARTCRAWL_TRUSTED_PROXIES must contain explicit IP addresses or non-zero CIDRs');
    }
  }
  return values;
}

export function createApp(deps: AppDeps): Express {
  const metrics = deps.metrics ?? new Metrics();
  const audit = new AuditStore(deps.store.db);
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
  const trustedProxies = trustedProxyCidrs(
    deps.trustedProxies ?? (process.env.SMARTCRAWL_TRUSTED_PROXIES?.split(',') ?? []),
  );
  if (trustedProxies.length > 0) app.set('trust proxy', trustedProxies);
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    next();
  });

  // API-key verification must not depend on a separately configured admin token.
  // Missing admin credentials disable admin routes, never public API authentication.
  const authOn = Boolean(deps.keys);

  const ensureGuestSession = (req: Request, res: Response): string => {
    const known = deps.keys?.authenticateGuestSession(readCookie(req.headers.cookie, 'smartcrawl_guest'));
    if (known) return known.id;
    const issued = deps.keys!.createGuestSession();
    res.cookie('smartcrawl_guest', issued.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: req.secure || process.env.SMARTCRAWL_COOKIE_SECURE === 'true' ||
        process.env.NODE_ENV === 'production',
    });
    return issued.id;
  };
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
      // Job reads remain available after daily quota exhaustion. Only new
      // work consumes the per-source-IP allowance.
      res.locals.isGuestDemo = true;
      res.locals.guestIp = getClientIp(req);
      res.locals.guestDay = utcDay(new Date());
      res.locals.guestSessionId = ensureGuestSession(req, res);
      return next();
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
      firecrawl: {
        configured: Boolean(deps.firecrawlConfigured),
        isLocal: Boolean(deps.firecrawlLocal),
      },
      proxy: { configured: Boolean(deps.proxyConfigured) },
      browser: { configured: Boolean(deps.browserConfigured) },
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
    if (guestUsage) ensureGuestSession(req, res);

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
    audit.record('account.key.created', 'account', issued.id, account.id);
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
    audit.record('account.key.revoked', 'account', req.params.id, account.id);
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
    audit.record('admin.key.created', 'admin', issued.id);
    res.status(201).json({
      id: issued.id,
      name: issued.name,
      key: issued.key,
      prefix: issued.prefix,
      dailyLimit: issued.dailyLimit,
    });
  });

  app.get('/v1/admin/audit', requireAdmin, (req, res) => {
    const requested = Number(req.query.limit ?? 50);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: audit.list(requested) });
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
    audit.record('admin.key.revoked', 'admin', req.params.id);
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
    const job = enqueue(
      deps,
      metrics,
      alerts,
      runWithConcurrency,
      'crawl',
      request.url,
      request,
      {
        ...keyOptions(res),
        // Only never-claimed, local, proxy-free crawls are eligible for
        // replay after process restart. An in-flight job is never replayed.
        ...(!request.proxy ? { recoveryVersion: 1, pendingRecoveryAttempts: 0 } : {}),
      },
      makeCrawlWork(deps, metrics, request),
    );
    res.json({ jobId: job.id });
  });

  app.post('/v1/admin/jobs/:id/resume', requireAdmin, (req, res) => {
    if (!deps.enableCrawlCheckpoints || !deps.enableCheckpointResume || !deps.crawl) {
      return res.status(403).json({ error: 'Checkpoint resumption is disabled', code: 'forbidden' });
    }
    if (req.body?.acknowledgePossibleRefetch !== true) {
      return res.status(400).json({
        error: 'Explicitly acknowledge that interrupted HTTP requests may be repeated',
        code: 'resume_acknowledgement_required',
      });
    }
    try {
      const resumed = deps.store.createManualCrawlResume(req.params.id);
      if (!resumed) return res.status(409).json({
        error: 'Job is not an interrupted crawl with a valid committed checkpoint',
        code: 'resume_not_allowed',
      });
      if (resumed.created) {
        audit.record('admin.crawl.resumed', 'admin', resumed.job.id);
        const parsed = parseAndValidateDiscoverBody(resumed.job.options);
        if (!parsed.ok || parsed.value.url !== resumed.job.url || parsed.value.proxy) {
          deps.store.failUnclaimed(resumed.job.id, 'Invalid persisted crawl resume request');
          return res.status(409).json({ error: 'Persisted crawl request is invalid', code: 'resume_not_allowed' });
        }
        const request = { ...parsed.value, provider: 'local' as const };
        void runWithConcurrency(() => runJob(
          deps, metrics, alerts, resumed.job.id, resumed.job.url,
          makeCrawlWork(deps, metrics, request),
        ));
      }
      return res.status(resumed.created ? 201 : 200).json({
        jobId: resumed.job.id,
        parentJobId: req.params.id,
        created: resumed.created,
        warning: 'Uncheckpointed in-flight HTTP requests may be repeated',
      });
    } catch {
      return res.status(409).json({
        error: 'Crawl checkpoint failed integrity validation',
        code: 'invalid_checkpoint',
      });
    }
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
    const guestSessionId = res.locals.guestSessionId as string | undefined;
    const jobs = deps.store.listJobs({ keyId: key?.id, userId: key?.userId, guestSessionId, authOn, limit }).map(serializeJobSummary);
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

  // Explicit startup hook. The server calls this only after the SQLite
  // recovery policy has classified stale rows. Tests may invoke it directly.
  // Replays use the same application-wide admission queue as new jobs.
  app.locals.resumePendingCrawls = (): number => {
    const pending = deps.store.listRecoverablePendingCrawls();
    let scheduled = 0;
    for (const job of pending) {
      const parsed = parseAndValidateDiscoverBody(job.options);
      if (!deps.crawl || !parsed.ok || parsed.value.url !== job.url ||
          parsed.value.proxy || job.options.provider !== 'local' ||
          job.options.recoveryVersion !== 1) {
        deps.store.failUnclaimed(job.id, 'Saved crawl request cannot be safely replayed');
        continue;
      }
      const request = { ...parsed.value, provider: 'local' as const };
      scheduled += 1;
      void runWithConcurrency(() => runJob(
        deps, metrics, alerts, job.id, job.url, makeCrawlWork(deps, metrics, request),
      ));
    }
    return scheduled;
  };

  return app;
}

function keyOptions(res: Response): Record<string, unknown> {
  const key = res.locals.apiKey as AuthKey | undefined;
  if (key) {
    return { keyId: key.id, ...(key.userId ? { userId: key.userId } : {}) };
  }
  if (res.locals.isGuestDemo) {
    return { guestSessionId: res.locals.guestSessionId, isGuest: true };
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
  if (options.isGuest && typeof options.guestSessionId === 'string') {
    return options.guestSessionId === res.locals.guestSessionId;
  }
  return false;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); }
      catch { return undefined; }
    }
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
    const target = validateHttpUrl(record.url.trim());
    if (target.username || target.password) {
      return { ok: false, error: 'Destination URLs may not contain credentials' };
    }
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
    request.crawlDelayMs = Math.min(60_000, Math.max(0, record.crawlDelayMs));
  }
  if (record.concurrency !== undefined) {
    if (typeof record.concurrency !== 'number' ||
        !Number.isInteger(record.concurrency) ||
        record.concurrency < 1 || record.concurrency > 4) {
      return { ok: false, error: 'Crawl concurrency must be an integer from 1 to 4' };
    }
    request.concurrency = record.concurrency;
  }
  if (Array.isArray(record.includePaths)) {
    request.includePaths = record.includePaths.filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(record.excludePaths)) {
    request.excludePaths = record.excludePaths.filter((value): value is string => typeof value === 'string');
  }
  return { ok: true, value: request };
}

function makeCrawlWork(
  deps: AppDeps,
  metrics: Metrics,
  request: DiscoverRequest,
): (jobId: string) => Promise<CrawlResult> {
  return async (jobId) => {
    if (!deps.crawl) throw new Error('Crawl worker is not configured');
    const limit = request.limit ?? 5;
    deps.store.appendLog(jobId, { level: 'info', msg: `Crawling ${request.url} (limit ${limit})` });
    const checkpointing = deps.enableCrawlCheckpoints === true && !request.proxy;
    const savedCheckpoint = checkpointing ? deps.store.getCrawlCheckpoint(jobId) : null;
    const data = await deps.crawl(request, {
      ...(checkpointing ? {
        ...(savedCheckpoint ? { checkpoint: savedCheckpoint } : {}),
        onCheckpoint: (state: CrawlCheckpointV1) => {
          if (!deps.store.saveCrawlCheckpoint(jobId, state)) {
            throw new Error('Checkpoint owner job is no longer running');
          }
        },
      } : {}),
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
  };
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
    if (!deps.store.claimPending(jobId)) return;
    const data = await work(jobId);
    deps.store.completeClaimed(jobId, data);
  } catch (err) {
    const classified = classifyError(err);
    deps.store.appendLog(jobId, { level: 'error', msg: classified.message });
    if (!deps.store.failClaimed(jobId, classified)) return;
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
    options: publicJobOptions(job.options),
    data: job.data,
    error: job.error?.message,
    errorCode: job.error?.code,
    logs: job.logs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function publicJobOptions(options: Record<string, unknown>): Record<string, unknown> {
  const { proxy: _proxy, keyId: _keyId, userId: _userId,
    guestIp: _guestIp, guestSessionId: _guestSessionId,
    isGuest: _isGuest, resumeSourceId: _resumeSourceId,
    recoveryVersion: _recoveryVersion,
    pendingRecoveryAttempts: _pendingRecoveryAttempts, ...publicOptions } = options;
  return publicOptions;
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
