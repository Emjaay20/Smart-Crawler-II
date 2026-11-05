import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Flame,
  Gauge,
  RefreshCw,
  Server,
  ShieldAlert,
  Terminal,
  Zap,
} from 'lucide-react';
import {
  fetchOperationalReport,
  fetchPrometheusMetrics,
  type OperationalReport,
  type OpsStats,
} from '../hooks/useSmartCrawl';

interface ObservabilityViewProps {
  ops: OpsStats | null;
  firecrawlConfigured: boolean;
  proxyConfigured?: boolean;
  apiKey?: string;
  onRefresh: () => void;
}

export const ObservabilityView: React.FC<ObservabilityViewProps> = ({
  ops,
  firecrawlConfigured,
  proxyConfigured = false,
  apiKey,
  onRefresh,
}) => {
  const [report, setReport] = useState<OperationalReport | null>(null);
  const [promText, setPromText] = useState<string>('');
  const [copiedProm, setCopiedProm] = useState(false);
  const [copiedDigest, setCopiedDigest] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadTelemetry = async () => {
    setLoading(true);
    try {
      const [rep, prom] = await Promise.all([
        fetchOperationalReport(apiKey),
        fetchPrometheusMetrics(apiKey),
      ]);
      if (rep) setReport(rep);
      if (prom) setPromText(prom);
      onRefresh();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTelemetry();
    const id = setInterval(() => void loadTelemetry(), 5000);
    return () => clearInterval(id);
  }, [apiKey]);

  const metrics = report?.metrics ?? ops;
  const totalJobs = (metrics?.scrapeCompleted ?? 0) + (metrics?.scrapeFailed ?? 0);
  const successRatePct =
    totalJobs > 0 ? Math.round(((metrics?.scrapeCompleted ?? 0) / totalJobs) * 100) : 100;
  const healthStatus = report?.status ?? 'healthy';

  const totalEngines =
    (metrics?.engineHttp ?? 0) +
    (metrics?.enginePlaywright ?? 0) +
    (metrics?.engineFirecrawl ?? 0);
  const pct = (value: number) =>
    totalEngines > 0 ? Math.round((value / totalEngines) * 100) : 0;

  const errorEntries = Object.entries(metrics?.errorsByCode ?? {}).sort((a, b) => b[1] - a[1]);
  const recentEvents = metrics?.recentEvents ?? [];

  const copyPrometheus = () => {
    if (!promText) return;
    void navigator.clipboard.writeText(promText);
    setCopiedProm(true);
    setTimeout(() => setCopiedProm(false), 1500);
  };

  const copyDigest = () => {
    if (!report?.summary) return;
    void navigator.clipboard.writeText(report.summary);
    setCopiedDigest(true);
    setTimeout(() => setCopiedDigest(false), 1500);
  };

  return (
    <div className="docs-theme max-w-7xl mx-auto w-full px-4 sm:px-6 py-8 space-y-8 text-slate-200">
      {/* Top Banner */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className={`px-2.5 py-0.5 rounded text-xs font-mono font-semibold uppercase flex items-center gap-1.5 border ${
                healthStatus === 'healthy'
                  ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/80'
                  : healthStatus === 'degraded'
                    ? 'bg-amber-950/80 text-amber-400 border-amber-800/80'
                    : 'bg-rose-950/80 text-rose-400 border-rose-800/80'
              }`}
            >
              {healthStatus === 'healthy' ? (
                <CheckCircle2 size={13} />
              ) : (
                <AlertTriangle size={13} />
              )}
              System {healthStatus}
            </span>
            <span className="px-2.5 py-0.5 rounded text-xs font-mono bg-slate-900 text-slate-300 border border-slate-800">
              Prometheus + OpenObserve / Datadog Ready
            </span>
            <span
              className={`px-2.5 py-0.5 rounded text-xs font-mono border flex items-center gap-1.5 ${
                firecrawlConfigured
                  ? 'bg-orange-950/60 text-orange-300 border-orange-800/60'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
            >
              <Flame size={12} />
              Firecrawl API: {firecrawlConfigured ? 'ENABLED' : 'LOCAL ONLY'}
            </span>
            <span
              className={`px-2.5 py-0.5 rounded text-xs font-mono border flex items-center gap-1.5 ${
                proxyConfigured
                  ? 'bg-purple-950/60 text-purple-300 border-purple-800/60'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
            >
              <Server size={12} />
              Proxy Routing: {proxyConfigured ? 'ACTIVE' : 'DIRECT'}
            </span>
            <span className="px-2.5 py-0.5 rounded text-xs font-mono bg-emerald-950/40 text-emerald-300 border border-emerald-800/60 flex items-center gap-1.5">
              <ShieldAlert size={12} />
              WAF Circuit Breaker: ENFORCED
            </span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-medium text-white tracking-tight">
            Production Observability & Telemetry Dashboard
          </h1>
          <p className="text-xs sm:text-sm text-slate-400">
            Real-time worker pool saturation, latency percentiles (p50/p95/p99), multi-engine routing (HTTP / Playwright / Firecrawl), proxy egress, WAF challenge classification, and Slack incident digests.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadTelemetry()}
          disabled={loading}
          className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors cursor-pointer"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin text-emerald-400' : ''} />
          Refresh Telemetry
        </button>
      </header>

      {/* Primary KPI Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Scrape Success Rate</span>
            <Activity size={14} className="text-emerald-400" />
          </div>
          <div className="text-2xl font-mono font-bold text-white">{successRatePct}%</div>
          <div className="text-[11px] font-mono text-slate-400">
            {metrics?.scrapeCompleted ?? 0} ok · {metrics?.scrapeFailed ?? 0} failed ·{' '}
            {metrics?.retriesTotal ?? 0} retries
          </div>
        </div>

        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Latency (p50 / p95 / p99)</span>
            <Gauge size={14} className="text-cyan-400" />
          </div>
          <div className="text-2xl font-mono font-bold text-white">
            {metrics?.durationP50Ms ?? 0}
            <span className="text-sm text-slate-500"> / </span>
            <span className="text-emerald-400">{metrics?.durationP95Ms ?? 0}</span>
            <span className="text-sm text-slate-500"> / </span>
            <span className="text-amber-300">{metrics?.durationP99Ms ?? 0}</span>
            <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            Rolling avg: {metrics?.durationAvgMs ?? 0}ms ({metrics?.durationCount ?? 0} samples)
          </div>
        </div>

        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>AI Dataset Volume</span>
            <Database size={14} className="text-purple-400" />
          </div>
          <div className="text-2xl font-mono font-bold text-white">
            {(metrics?.tokensExtractedTotal ?? 0).toLocaleString()}{' '}
            <span className="text-xs font-normal text-slate-400">tokens</span>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {metrics?.crawlPages ?? 0} crawl pages · {metrics?.mapLinks ?? 0} mapped links
          </div>
        </div>

        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Worker Pool & Queue</span>
            <Server size={14} className="text-amber-400" />
          </div>
          <div className="text-2xl font-mono font-bold text-white">
            {metrics?.activeWorkers ?? 0}{' '}
            <span className="text-xs font-normal text-slate-400">active</span> /{' '}
            {metrics?.queueDepth ?? 0}{' '}
            <span className="text-xs font-normal text-slate-400">queued</span>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            Consecutive failures: {metrics?.consecutiveFailures ?? 0}
          </div>
        </div>
      </section>

      {/* Engine Distribution + Error Taxonomy */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Engine Breakdown */}
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Zap size={16} className="text-emerald-400" />
              Extraction Engine Routing Breakdown
            </h2>
            <span className="text-xs font-mono text-slate-400">{totalEngines} total dispatches</span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="space-y-1">
              <div className="flex justify-between font-mono">
                <span className="text-slate-300">1. HTTP + Readability (Fetch-First)</span>
                <span className="text-emerald-400">
                  {metrics?.engineHttp ?? 0} ({pct(metrics?.engineHttp ?? 0)}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.max(2, pct(metrics?.engineHttp ?? 0))}%` }}
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between font-mono">
                <span className="text-slate-300">2. Playwright Headless Chromium (SPA Fallback)</span>
                <span className="text-cyan-400">
                  {metrics?.enginePlaywright ?? 0} ({pct(metrics?.enginePlaywright ?? 0)}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${Math.max(2, pct(metrics?.enginePlaywright ?? 0))}%` }}
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between font-mono">
                <span className="text-slate-300 flex items-center gap-1.5">
                  3. Firecrawl Cloud API (Managed Escalation)
                  {firecrawlConfigured && (
                    <span className="px-1.5 py-0.2 rounded bg-orange-950 text-orange-300 text-[10px]">
                      ACTIVE
                    </span>
                  )}
                </span>
                <span className="text-orange-400">
                  {metrics?.engineFirecrawl ?? 0} ({pct(metrics?.engineFirecrawl ?? 0)}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className="h-full bg-orange-500 transition-all"
                  style={{ width: `${Math.max(2, pct(metrics?.engineFirecrawl ?? 0))}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Classified Error Taxonomy */}
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <ShieldAlert size={16} className="text-rose-400" />
              Classified Error Taxonomy (<code className="text-xs font-mono">scrape_errors_total</code>)
            </h2>
            <span className="text-xs font-mono text-slate-400">
              Error rate: {((metrics?.errorRate ?? 0) * 100).toFixed(1)}%
            </span>
          </div>

          {errorEntries.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-lg">
              Zero classified errors recorded in current window.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {errorEntries.map(([code, count]) => (
                <div
                  key={code}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-800 font-mono text-xs"
                >
                  <span className="text-rose-300">{code}</span>
                  <span className="px-2 py-0.5 rounded bg-rose-950/70 text-rose-200 font-semibold">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Structured Event Stream + Slack Operational Digest & Raw Prometheus */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Structured Event Log Stream */}
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-5 space-y-3 flex flex-col">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Terminal size={16} className="text-cyan-400" />
              Structured JSON Telemetry Stream
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              {recentEvents.length} recent events
            </span>
          </div>

          <div className="flex-1 max-h-[260px] overflow-auto space-y-1.5 font-mono text-[11px] bg-slate-900/60 p-3 rounded-lg border border-slate-800/80 custom-scrollbar">
            {recentEvents.length === 0 ? (
              <div className="text-slate-500 py-8 text-center">
                Run a scrape, map, or crawl job in the Workbench to stream live telemetry events.
              </div>
            ) : (
              recentEvents.map((ev, idx) => (
                <div
                  key={`${ev.ts}-${idx}`}
                  className="py-1 border-b border-slate-800/60 last:border-none text-slate-300 break-all"
                >
                  <span className="text-slate-500">[{ev.ts.slice(11, 19)}]</span>{' '}
                  <span
                    className={
                      ev.event === 'scrape.completed'
                        ? 'text-emerald-400'
                        : ev.event === 'scrape.retry'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                    }
                  >
                    {ev.event}
                  </span>{' '}
                  {ev.engine && <span className="text-cyan-300">engine={ev.engine}</span>}{' '}
                  {ev.durationMs !== undefined && (
                    <span className="text-slate-400">duration={ev.durationMs}ms</span>
                  )}{' '}
                  {ev.tokens !== undefined && (
                    <span className="text-purple-300">tokens={ev.tokens}</span>
                  )}{' '}
                  {ev.errorCode && <span className="text-rose-300">code={ev.errorCode}</span>}{' '}
                  {ev.url && <span className="text-slate-400">url={ev.url}</span>}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Slack Operational Digest + Raw Prometheus Exposition */}
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Cpu size={16} className="text-emerald-400" />
              Slack Digest (<code className="text-xs font-mono">/v1/report</code>) & Prometheus (<code className="text-xs font-mono">/metrics</code>)
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyDigest}
                className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center gap-1 cursor-pointer"
              >
                <Copy size={11} /> {copiedDigest ? 'Copied Digest' : 'Copy Slack Digest'}
              </button>
              <button
                type="button"
                onClick={copyPrometheus}
                className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center gap-1 cursor-pointer"
              >
                <Copy size={11} /> {copiedProm ? 'Copied /metrics' : 'Copy /metrics'}
              </button>
            </div>
          </div>

          {report?.summary && (
            <pre className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] font-mono text-emerald-300 whitespace-pre-wrap leading-relaxed">
              {report.summary}
            </pre>
          )}

          <pre className="max-h-[150px] overflow-auto p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] font-mono text-slate-300 leading-relaxed custom-scrollbar">
            {promText || '# Fetching /metrics...'}
          </pre>
        </div>
      </section>
    </div>
  );
};
