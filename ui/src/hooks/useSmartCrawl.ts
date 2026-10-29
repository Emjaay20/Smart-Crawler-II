import { useState, useRef } from 'react';

export interface JobLog {
  time: string;
  level: 'info' | 'error' | 'success';
  msg: string;
}

export interface CrawlResult {
  id?: string;
  url?: string;
  status: 'completed' | 'failed' | 'pending' | 'crawling';
  data?: unknown;
  error?: string;
  errorCode?: string;
  logs?: JobLog[];
}

export type JobMode = 'scrape' | 'map' | 'crawl';

export interface ScrapeOptions {
  timeoutMs: number;
  userAgent: string;
  js: boolean | 'auto';
  mode: JobMode;
  limit?: number;
  includePaths?: string[];
  excludePaths?: string[];
  provider?: 'local' | 'auto' | 'firecrawl';
  apiKey?: string;
}

export interface OpsStats {
  scrapeCompleted: number;
  scrapeFailed: number;
  engineHttp: number;
  enginePlaywright: number;
  engineFirecrawl: number;
  durationAvgMs: number;
  durationP95Ms: number;
  mapLinks: number;
  crawlPages: number;
}

export interface MeInfo {
  authenticated: boolean;
  authRequired: boolean;
  key: {
    id: string;
    name: string;
    prefix: string;
    dailyLimit: number;
    usedToday: number;
    remaining: number;
  } | null;
}

export interface JobSummaryItem {
  id: string;
  status: 'pending' | 'crawling' | 'completed' | 'failed';
  url: string;
  kind: string;
  error?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountUser {
  id: string;
  email?: string;
  name?: string;
  plan: string;
  createdAt: number;
}

export interface AccountSession {
  configured: boolean;
  authenticated: boolean;
  user: AccountUser | null;
}

export interface AccountKey {
  id: string;
  name: string;
  prefix: string;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  revoked: boolean;
  createdAt: number;
}

export interface ProviderStatus {
  firecrawl: { configured: boolean };
}

const apiBase = () => import.meta.env.VITE_API_URL ?? '';

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export const useSmartCrawl = () => {
  const [status, setStatus] = useState<'idle' | 'crawling' | 'success' | 'error' | 'timeout'>('idle');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [data, setData] = useState<unknown>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const attempts = useRef(0);

  const clearPoll = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const loadJob = async (jobId: string, apiKey?: string) => {
    clearPoll();
    setActiveJobId(jobId);
    try {
      const res = await fetch(`${apiBase()}/v1/jobs/${jobId}`, {
        headers: authHeaders(apiKey),
      });
      if (!res.ok) return;
      const result = await res.json() as CrawlResult;
      setLogs(result.logs ?? []);
      if (result.status === 'completed') {
        setData(result.data);
        setError(null);
        setStatus('success');
      } else if (result.status === 'failed') {
        setData(null);
        setError(result.error || 'Job failed');
        setStatus('error');
      } else {
        setStatus('crawling');
      }
    } catch {
      // ignore transient error
    }
  };

  const startJob = async (url: string, options: ScrapeOptions, onDone?: () => void) => {
    clearPoll();
    setStatus('crawling');
    setData(null);
    setError(null);
    setLogs([{ time: new Date().toISOString(), level: 'info', msg: `Queued ${options.mode} ${url}` }]);
    attempts.current = 0;
    const maxAttempts = Math.max(30, Math.ceil(options.timeoutMs / 1000) + 10);

    try {
      const path = options.mode === 'map' ? '/v1/map' : options.mode === 'crawl' ? '/v1/crawl' : '/v1/scrape';
      const res = await fetch(`${apiBase()}${path}`, {
        method: 'POST',
        headers: authHeaders(options.apiKey),
        body: JSON.stringify({
          url,
          timeoutMs: options.timeoutMs,
          userAgent: options.userAgent,
          js: options.js,
          provider: options.provider,
          limit: options.limit,
          includePaths: options.includePaths?.length ? options.includePaths : undefined,
          excludePaths: options.excludePaths?.length ? options.excludePaths : undefined,
          formats: ['markdown', 'links', 'metadata', 'html'],
          onlyMainContent: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((body as { error?: string }).error || 'Failed to start job');
      }
      const { jobId } = await res.json() as { jobId: string };
      setActiveJobId(jobId);

      pollTimer.current = setInterval(async () => {
        attempts.current += 1;
        if (attempts.current > maxAttempts) {
          clearPoll();
          setStatus('timeout');
          setError('Timed out waiting for job');
          onDone?.();
          return;
        }
        try {
          const statusRes = await fetch(`${apiBase()}/v1/jobs/${jobId}`, {
            headers: authHeaders(options.apiKey),
          });
          const result = await statusRes.json() as CrawlResult;
          if (result.logs) setLogs(result.logs);
          if (result.status === 'crawling' || result.status === 'pending') {
            return;
          }
          clearPoll();
          if (result.status === 'completed') {
            setData(result.data);
            setStatus('success');
          } else {
            setStatus('error');
            setError(result.error || 'Job failed');
          }
          onDone?.();
        } catch (err) {
          console.error('Polling error', err);
        }
      }, 600);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start job');
      onDone?.();
    }
  };

  return { status, activeJobId, startJob, loadJob, data, logs, error };
};

export async function fetchOpsStats(apiKey?: string): Promise<OpsStats | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/stats`, { headers: authHeaders(apiKey) });
    if (!res.ok) return null;
    return await res.json() as OpsStats;
  } catch {
    return null;
  }
}

export async function fetchMe(apiKey?: string): Promise<MeInfo | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/me`, { headers: authHeaders(apiKey) });
    if (!res.ok) return null;
    return await res.json() as MeInfo;
  } catch {
    return null;
  }
}

export async function fetchProviderStatus(): Promise<ProviderStatus | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/providers`);
    if (!res.ok) return null;
    return await res.json() as ProviderStatus;
  } catch {
    return null;
  }
}

export async function fetchRecentJobs(apiKey?: string, limit = 10): Promise<JobSummaryItem[]> {
  try {
    const res = await fetch(`${apiBase()}/v1/jobs?limit=${limit}`, { headers: authHeaders(apiKey) });
    if (!res.ok) return [];
    const body = await res.json() as { jobs?: JobSummaryItem[] };
    return body.jobs ?? [];
  } catch {
    return [];
  }
}

export async function mintDemoKey(name = 'playground-demo'): Promise<{ key: string; dailyLimit: number } | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/keys/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return await res.json() as { key: string; dailyLimit: number };
  } catch {
    return null;
  }
}

export async function fetchAccountSession(): Promise<AccountSession | null> {
  try {
    const res = await fetch(`${apiBase()}/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json() as AccountSession;
  } catch {
    return null;
  }
}

export async function createAccountKey(name = 'default'): Promise<{ key: string; dailyLimit: number } | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/account/keys`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return await res.json() as { key: string; dailyLimit: number };
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  await fetch(`${apiBase()}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
}

export function signInUrl(): string {
  return `${apiBase()}/auth/login`;
}
