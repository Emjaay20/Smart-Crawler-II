import { useState, useRef } from 'react';

export interface JobLog {
  time: string;
  level: 'info' | 'error' | 'success';
  msg: string;
}

export interface CrawlResult {
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
}

export interface OpsStats {
  scrapeCompleted: number;
  scrapeFailed: number;
  engineHttp: number;
  enginePlaywright: number;
  durationAvgMs: number;
  durationP95Ms: number;
  mapLinks: number;
  crawlPages: number;
}

const apiBase = () => import.meta.env.VITE_API_URL ?? '';

export const useSmartCrawl = () => {
  const [status, setStatus] = useState<'idle' | 'crawling' | 'success' | 'error' | 'timeout'>('idle');
  const [progress, setProgress] = useState(0);
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

  const startJob = async (url: string, options: ScrapeOptions) => {
    clearPoll();
    setStatus('crawling');
    setProgress(15);
    setData(null);
    setError(null);
    setLogs([{ time: new Date().toISOString(), level: 'info', msg: `Queued ${options.mode} ${url}` }]);
    attempts.current = 0;
    const maxAttempts = Math.max(30, Math.ceil(options.timeoutMs / 2000) + 5);

    try {
      const path = options.mode === 'map' ? '/v1/map' : options.mode === 'crawl' ? '/v1/crawl' : '/v1/scrape';
      const res = await fetch(`${apiBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          timeoutMs: options.timeoutMs,
          userAgent: options.userAgent,
          js: options.js,
          limit: options.limit,
          formats: ['markdown', 'links', 'metadata', 'html'],
          onlyMainContent: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((body as { error?: string }).error || 'Failed to start job');
      }
      const { jobId } = await res.json() as { jobId: string };

      pollTimer.current = setInterval(async () => {
        attempts.current += 1;
        if (attempts.current > maxAttempts) {
          clearPoll();
          setStatus('timeout');
          setError('Timed out waiting for job');
          return;
        }
        try {
          const statusRes = await fetch(`${apiBase()}/v1/jobs/${jobId}`);
          const result = await statusRes.json() as CrawlResult;
          if (result.logs) setLogs(result.logs);
          if (result.status === 'crawling' || result.status === 'pending') {
            setProgress(result.status === 'pending' ? 20 : 55);
            return;
          }
          clearPoll();
          if (result.status === 'completed') {
            setProgress(100);
            setData(result.data);
            setStatus('success');
          } else {
            setStatus('error');
            setError(result.error || 'Job failed');
            setProgress(0);
          }
        } catch (err) {
          console.error('Polling error', err);
        }
      }, 1000);
    } catch (err) {
      console.error(err);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start job');
      setProgress(0);
    }
  };

  return { status, progress, startJob, data, logs, error };
};

export async function fetchOpsStats(): Promise<OpsStats | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/stats`);
    if (!res.ok) return null;
    return await res.json() as OpsStats;
  } catch {
    return null;
  }
}
