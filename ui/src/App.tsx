import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchMe,
  fetchOpsStats,
  fetchRecentJobs,
  useSmartCrawl,
  type JobMode,
  type JobSummaryItem,
  type MeInfo,
  type OpsStats,
} from './hooks/useSmartCrawl';
import {
  Terminal,
  Settings,
  Download,
  Copy,
  Play,
  CheckCircle,
  Wifi,
  Activity,
  ChevronDown,
  Link2,
  FileText,
  Clock,
  KeyRound,
  ArrowUpRight,
} from 'lucide-react';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

type EngineMode = 'auto' | 'http' | 'playwright';

interface CrawledPageItem {
  url: string;
  title?: string;
  markdown?: string;
  statusCode: number;
}

interface ScrapePayload {
  markdown?: string;
  links?: string[];
  pages?: CrawledPageItem[];
  sourceUrl?: string;
  metadata?: {
    title?: string;
    description?: string;
    engine?: string;
    statusCode?: number;
    finalUrl?: string;
  };
  timing?: { ttfbMs?: number; totalMs?: number };
}

function jsFromEngine(mode: EngineMode): boolean | 'auto' {
  if (mode === 'http') return false;
  if (mode === 'playwright') return true;
  return 'auto';
}

export default function CrawlerInterface() {
  const { status, activeJobId, startJob, loadJob, data, logs, error } = useSmartCrawl();
  const [url, setUrl] = useState('https://example.com');
  const [activeTab, setActiveTab] = useState<'markdown' | 'links' | 'data' | 'console'>('console');
  const [selectedPageIdx, setSelectedPageIdx] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [userAgent, setUserAgent] = useState('SmartCrawl/1.0');
  const [engine, setEngine] = useState<EngineMode>('auto');
  const [mode, setMode] = useState<JobMode>('scrape');
  const [limit, setLimit] = useState(5);
  const [excludePathsInput, setExcludePathsInput] = useState('');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('smartcrawl.apiKey') ?? '');
  const [online, setOnline] = useState<boolean | null>(null);
  const [ops, setOps] = useState<OpsStats | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummaryItem[]>([]);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const refreshTelemetry = useCallback(() => {
    const key = apiKey.trim() || undefined;
    void fetchOpsStats(key).then(setOps);
    void fetchMe(key).then(setMe);
    void fetchRecentJobs(key, 10).then(setRecentJobs);
  }, [apiKey]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const payload = data as ScrapePayload | null;
  const crawlPages = payload?.pages ?? [];
  const activeMarkdown =
    payload?.markdown ?? crawlPages[selectedPageIdx]?.markdown ?? '';
  const discoveredLinks = payload?.links ?? [];

  useEffect(() => {
    setSelectedPageIdx(0);
    if (status === 'success' && payload) {
      if (payload.markdown || (payload.pages && payload.pages.length > 0)) {
        setActiveTab('markdown');
      } else if (payload.links && payload.links.length > 0) {
        setActiveTab('links');
      } else {
        setActiveTab('data');
      }
    } else if (status === 'error') {
      setActiveTab('console');
    }
  }, [status, payload]);

  useEffect(() => {
    const api = import.meta.env.VITE_API_URL ?? '';
    fetch(`${api}/health`)
      .then((res) => setOnline(res.ok))
      .catch(() => setOnline(false));
    refreshTelemetry();
    const id = setInterval(refreshTelemetry, 5000);
    return () => clearInterval(id);
  }, [refreshTelemetry]);

  const handleRun = (targetUrl = url, targetMode = mode) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    const excludePaths = excludePathsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void startJob(
      trimmed,
      {
        timeoutMs,
        userAgent,
        js: jsFromEngine(engine),
        mode: targetMode,
        limit,
        excludePaths,
        apiKey: apiKey.trim() || undefined,
      },
      refreshTelemetry,
    );
  };

  const copyContent = () => {
    const text =
      activeTab === 'markdown' && activeMarkdown
        ? activeMarkdown
        : JSON.stringify(data, null, 2);
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = () => {
    const isMd = activeTab === 'markdown' && Boolean(activeMarkdown);
    const content = isMd ? activeMarkdown : JSON.stringify(data, null, 2);
    const blob = new Blob([content], {
      type: isMd ? 'text/markdown;charset=utf-8' : 'application/json',
    });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `smartcrawl_${Date.now()}.${isMd ? 'md' : 'json'}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-200 flex flex-col font-mono">
      {/* Top Bar */}
      <header className="border-b border-slate-800/90 bg-slate-950/90 px-6 py-3 flex items-center justify-between select-none">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
            <Terminal size={15} className="text-emerald-400" />
            SmartCrawl
          </span>
          <span className="text-[11px] bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-slate-400">
            v3.0
          </span>
          <a
            href="/openapi.yaml"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-slate-400 hover:text-emerald-400 flex items-center gap-0.5 transition-colors ml-2"
          >
            OpenAPI <ArrowUpRight size={11} />
          </a>
        </div>

        <div className="flex items-center gap-4 text-xs">
          {me?.key ? (
            <span className="flex items-center gap-1.5 bg-emerald-950/50 border border-emerald-800/60 text-emerald-300 px-2.5 py-0.5 rounded">
              <KeyRound size={12} />
              {me.key.name} ({me.key.remaining}/{me.key.dailyLimit} left today)
            </span>
          ) : me?.authRequired ? (
            <button
              type="button"
              onClick={() => setShowConfig(true)}
              className="flex items-center gap-1.5 bg-amber-950/50 border border-amber-800/60 text-amber-300 px-2.5 py-0.5 rounded hover:bg-amber-900/40"
            >
              <KeyRound size={12} />
              API key required
            </button>
          ) : (
            <span className="text-slate-500">open mode</span>
          )}

          <div className="flex items-center gap-1.5 text-slate-400">
            <Wifi size={12} className={online ? 'text-emerald-400' : 'text-rose-500'} />
            <span>{online === null ? 'CHECKING' : online ? 'ONLINE' : 'OFFLINE'}</span>
          </div>

          <div className="flex items-center gap-1.5 text-slate-400">
            <Activity
              size={12}
              className={status === 'crawling' ? 'text-emerald-400 animate-pulse' : 'text-slate-600'}
            />
            <span>{status === 'crawling' ? 'RUNNING' : 'IDLE'}</span>
          </div>
        </div>
      </header>

      {/* Main Workbench Grid */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
        {/* Left Column: Controls + Recent Jobs */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-4 space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Target URL</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && url.trim() && status !== 'crawling') {
                      handleRun();
                    }
                  }}
                  disabled={status === 'crawling'}
                  placeholder="https://example.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
            </div>

            {/* Mode Pills */}
            <div className="grid grid-cols-3 gap-1.5 bg-slate-950 p-1 rounded border border-slate-800 select-none">
              {(['scrape', 'map', 'crawl'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`py-1.5 text-xs rounded font-medium capitalize transition-colors ${
                    mode === m
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => handleRun()}
              disabled={status === 'crawling' || !url.trim()}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 px-4 rounded font-semibold text-xs flex items-center justify-center gap-2 transition-colors select-none"
            >
              {status === 'crawling' ? (
                <>
                  <Activity className="animate-spin" size={14} /> Running {mode}…
                </>
              ) : (
                <>
                  <Play size={14} /> Run {mode}
                </>
              )}
            </button>

            <div className="pt-2 border-t border-slate-800/80">
              <button
                type="button"
                onClick={() => setShowConfig(!showConfig)}
                className="w-full text-xs text-slate-400 hover:text-slate-200 flex items-center justify-between py-1 transition-colors select-none"
              >
                <span className="flex items-center gap-1.5">
                  <Settings size={12} /> Options & API Key
                </span>
                <ChevronDown
                  size={13}
                  className={`transition-transform ${showConfig ? 'rotate-180' : ''}`}
                />
              </button>

              {showConfig && (
                <div className="space-y-3 pt-3 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Bearer API Key (optional in open mode)
                    </label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        localStorage.setItem('smartcrawl.apiKey', e.target.value);
                      }}
                      placeholder="sc_live_…"
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Engine</label>
                      <select
                        value={engine}
                        onChange={(e) => setEngine(e.target.value as EngineMode)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                      >
                        <option value="auto">Auto (HTTP → PW)</option>
                        <option value="http">HTTP only</option>
                        <option value="playwright">Playwright</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Limit (map/crawl)
                      </label>
                      <input
                        type="number"
                        value={limit}
                        min={1}
                        max={50}
                        onChange={(e) => setLimit(Number(e.target.value) || 5)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Timeout (ms)</label>
                      <input
                        type="number"
                        value={timeoutMs}
                        min={1000}
                        step={1000}
                        onChange={(e) => setTimeoutMs(Number(e.target.value) || 15000)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">User-Agent</label>
                      <select
                        value={userAgent}
                        onChange={(e) => setUserAgent(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                      >
                        <option value="SmartCrawl/1.0">SmartCrawl/1.0</option>
                        <option value={CHROME_UA}>Chrome Desktop</option>
                        <option value={GOOGLEBOT_UA}>Googlebot</option>
                      </select>
                    </div>
                  </div>

                  {mode !== 'scrape' && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Exclude path prefixes (comma-separated)
                      </label>
                      <input
                        type="text"
                        value={excludePathsInput}
                        onChange={(e) => setExcludePathsInput(e.target.value)}
                        placeholder="/admin, /login"
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Recent Jobs List */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-4 flex-1 flex flex-col min-h-[220px]">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-3 select-none">
              <span className="flex items-center gap-1.5 font-medium text-slate-300">
                <Clock size={13} /> Recent Jobs
              </span>
              <span className="text-[11px] text-slate-500">{recentJobs.length} stored</span>
            </div>

            <div className="flex-1 overflow-auto space-y-1.5 custom-scrollbar pr-1">
              {recentJobs.length === 0 ? (
                <p className="text-xs text-slate-600 italic py-4">
                  No jobs recorded yet. Run scrape, map, or crawl above.
                </p>
              ) : (
                recentJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => void loadJob(job.id, apiKey.trim() || undefined)}
                    className={`w-full text-left px-2.5 py-2 rounded border text-xs transition-colors flex items-center justify-between gap-2 ${
                      activeJobId === job.id
                        ? 'bg-slate-800/90 border-emerald-500/50 text-white'
                        : 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="uppercase text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                          {job.kind}
                        </span>
                        <span className="truncate text-xs">{job.url}</span>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] uppercase shrink-0 ${
                        job.status === 'completed'
                          ? 'text-emerald-400'
                          : job.status === 'failed'
                            ? 'text-rose-400'
                            : 'text-amber-400'
                      }`}
                    >
                      {job.status}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Output Workbench */}
        <section className="lg:col-span-8 bg-slate-900/70 border border-slate-800 rounded-lg flex flex-col min-h-[540px] overflow-hidden">
          <div className="flex items-center border-b border-slate-800 bg-slate-950/70 px-2 select-none">
            <button
              type="button"
              onClick={() => setActiveTab('markdown')}
              disabled={!activeMarkdown}
              className={`px-3.5 py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors disabled:opacity-30 ${
                activeTab === 'markdown'
                  ? 'text-white border-emerald-500'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              <FileText size={13} /> Markdown
              {crawlPages.length > 0 && (
                <span className="text-[10px] bg-slate-800 px-1.5 rounded text-emerald-300">
                  {crawlPages.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('links')}
              disabled={discoveredLinks.length === 0}
              className={`px-3.5 py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors disabled:opacity-30 ${
                activeTab === 'links'
                  ? 'text-white border-emerald-500'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              <Link2 size={13} /> Links
              {discoveredLinks.length > 0 && (
                <span className="text-[10px] bg-slate-800 px-1.5 rounded text-emerald-300">
                  {discoveredLinks.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('data')}
              disabled={data == null}
              className={`px-3.5 py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors disabled:opacity-30 ${
                activeTab === 'data'
                  ? 'text-white border-emerald-500'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              <CheckCircle size={13} /> JSON
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('console')}
              className={`px-3.5 py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                activeTab === 'console'
                  ? 'text-white border-emerald-500'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              <Terminal size={13} /> Logs ({logs.length})
            </button>

            <div className="ml-auto flex items-center gap-1.5 pr-2">
              {data != null && (
                <>
                  <button
                    type="button"
                    onClick={copyContent}
                    className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 rounded text-slate-300 flex items-center gap-1"
                    title="Copy current view"
                  >
                    <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 rounded text-slate-300 flex items-center gap-1"
                    title="Download file"
                  >
                    <Download size={12} /> Export
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Crawl Multi-Page Selector Bar */}
          {activeTab === 'markdown' && crawlPages.length > 1 && (
            <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 flex items-center gap-2 overflow-x-auto custom-scrollbar select-none">
              <span className="text-[11px] text-slate-400 shrink-0">Pages:</span>
              {crawlPages.map((p, idx) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => setSelectedPageIdx(idx)}
                  className={`px-2.5 py-1 rounded text-xs truncate max-w-[220px] border transition-colors ${
                    selectedPageIdx === idx
                      ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {idx + 1}. {p.title || p.url}
                </button>
              ))}
            </div>
          )}

          {/* Output Body */}
          <div className="flex-1 overflow-auto p-4 custom-scrollbar">
            {activeTab === 'console' && (
              <div className="text-xs space-y-1.5">
                {logs.length === 0 && (
                  <p className="text-slate-500">
                    Ready. Jobs persist in SQLite; select scrape, map, or crawl and click Run.
                  </p>
                )}
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="text-slate-500 shrink-0">[{log.time.slice(11, 19)}]</span>
                    <span
                      className={
                        log.level === 'error'
                          ? 'text-rose-400'
                          : log.level === 'success'
                            ? 'text-emerald-400'
                            : 'text-slate-300'
                      }
                    >
                      {log.msg}
                    </span>
                  </div>
                ))}
                {error && (
                  <div className="mt-2 p-2.5 rounded bg-rose-950/40 border border-rose-800/60 text-rose-300">
                    Error: {error}
                  </div>
                )}
                <div ref={logsEndRef} />
              </div>
            )}

            {activeTab === 'markdown' && (
              <div className="space-y-3">
                {crawlPages[selectedPageIdx] && (
                  <div className="text-xs text-slate-400 pb-2 border-b border-slate-800 flex items-center justify-between">
                    <span className="truncate">{crawlPages[selectedPageIdx].url}</span>
                    <span className="text-emerald-400">
                      HTTP {crawlPages[selectedPageIdx].statusCode}
                    </span>
                  </div>
                )}
                <pre className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {activeMarkdown}
                </pre>
              </div>
            )}

            {activeTab === 'links' && (
              <div className="space-y-1.5">
                {discoveredLinks.map((href) => (
                  <div
                    key={href}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-slate-950/60 border border-slate-800/80 text-xs"
                  >
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-300 hover:underline truncate"
                    >
                      {href}
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setUrl(href);
                        setMode('scrape');
                        handleRun(href, 'scrape');
                      }}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-emerald-600 text-slate-200 hover:text-white text-[11px] shrink-0 transition-colors select-none"
                    >
                      Scrape URL
                    </button>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'data' && (
              <pre className="text-xs text-emerald-300/90 leading-relaxed">
                {JSON.stringify(data, null, 2)}
              </pre>
            )}
          </div>

          {/* Footer Telemetry Bar */}
          <footer className="border-t border-slate-800 bg-slate-950/80 px-4 py-2 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2 select-none">
            <span>
              {ops
                ? `Jobs: ${ops.scrapeCompleted} ok / ${ops.scrapeFailed} failed · Engine: ${ops.engineHttp} http / ${ops.enginePlaywright} playwright`
                : payload?.metadata?.engine
                  ? `Engine: ${payload.metadata.engine}`
                  : 'Engine: fetch-first (HTTP + Readability)'}
            </span>
            <span>
              {ops
                ? `p95: ${ops.durationP95Ms}ms · Map links: ${ops.mapLinks} · Crawl pages: ${ops.crawlPages}`
                : payload?.timing?.totalMs != null
                  ? `${payload.timing.totalMs}ms`
                  : 'Idle'}
            </span>
          </footer>
        </section>
      </main>
    </div>
  );
}
