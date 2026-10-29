import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchMe,
  fetchProviderStatus,
  fetchAccountSession,
  fetchOpsStats,
  fetchRecentJobs,
  mintDemoKey,
  createAccountKey,
  signInUrl,
  signOut,
  useSmartCrawl,
  type JobMode,
  type JobSummaryItem,
  type MeInfo,
  type AccountSession,
  type OpsStats,
} from './hooks/useSmartCrawl';
import { DocsView } from './components/DocsView';
import { Footer } from './components/Footer';
import { LandingPage } from './components/LandingPage';
import {
  Terminal,
  Settings,
  Download,
  Copy,
  Play,
  Activity,
  ChevronDown,
  Link2,
  FileText,
  Clock,
  KeyRound,
  BookOpen,
  ArrowRight,
  Braces,
  Github,
  Globe2,
  Network,
} from 'lucide-react';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

type EngineMode = 'auto' | 'http' | 'playwright';
type ProviderMode = 'local' | 'auto' | 'firecrawl';
type MainView = 'landing' | 'workbench' | 'docs';

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

function viewFromLocation(): MainView {
  if (typeof window === 'undefined') return 'landing';
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/app') return 'workbench';
  if (pathname === '/docs' || window.location.hash === '#docs') return 'docs';
  return 'landing';
}

export default function CrawlerInterface() {
  const { status, activeJobId, startJob, loadJob, data, logs, error } = useSmartCrawl();
  const [mainView, setMainView] = useState<MainView>(viewFromLocation);
  const [url, setUrl] = useState('https://example.com');
  const [activeTab, setActiveTab] = useState<'markdown' | 'links' | 'data' | 'console'>('console');
  const [selectedPageIdx, setSelectedPageIdx] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [userAgent, setUserAgent] = useState('SmartCrawl/1.0');
  const [engine, setEngine] = useState<EngineMode>('auto');
  const [provider, setProvider] = useState<ProviderMode>('local');
  const [mode, setMode] = useState<JobMode>('scrape');
  const [limit, setLimit] = useState(5);
  const [excludePathsInput, setExcludePathsInput] = useState('');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('smartcrawl.apiKey') ?? '');
  const [mintingKey, setMintingKey] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [ops, setOps] = useState<OpsStats | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [account, setAccount] = useState<AccountSession | null>(null);
  const [firecrawlConfigured, setFirecrawlConfigured] = useState(false);
  const [creatingAccountKey, setCreatingAccountKey] = useState(false);
  const [recentJobs, setRecentJobs] = useState<JobSummaryItem[]>([]);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onLocationChange = () => setMainView(viewFromLocation());
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  const switchView = (v: MainView) => {
    setMainView(v);
    const destination = v === 'landing' ? '/' : v === 'workbench' ? '/app' : '/docs';
    window.history.pushState(null, '', destination);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const refreshTelemetry = useCallback((overrideKey?: string) => {
    const key = (overrideKey ?? apiKey).trim() || undefined;
    void fetchOpsStats(key).then(setOps);
    void fetchMe(key).then(setMe);
    void fetchRecentJobs(key, 10).then(setRecentJobs);
    void fetchAccountSession().then(setAccount);
    void fetchProviderStatus().then((providers) => setFirecrawlConfigured(Boolean(providers?.firecrawl.configured)));
  }, [apiKey]);

  const handleMintDemoKey = async () => {
    setMintingKey(true);
    try {
      const issued = await mintDemoKey('playground-demo');
      if (issued?.key) {
        setApiKey(issued.key);
        localStorage.setItem('smartcrawl.apiKey', issued.key);
        setShowConfig(true);
        refreshTelemetry(issued.key);
      }
    } finally {
      setMintingKey(false);
    }
  };

  const handleCreateAccountKey = async () => {
    setCreatingAccountKey(true);
    try {
      const issued = await createAccountKey('default');
      if (issued?.key) {
        setApiKey(issued.key);
        localStorage.setItem('smartcrawl.apiKey', issued.key);
        setShowConfig(true);
        refreshTelemetry(issued.key);
      }
    } finally {
      setCreatingAccountKey(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setAccount((current) => current ? { ...current, authenticated: false, user: null } : current);
  };

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
    const id = setInterval(() => refreshTelemetry(), 5000);
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
        provider: targetMode === 'scrape' ? provider : 'local',
        mode: targetMode,
        limit,
        excludePaths,
        apiKey: apiKey.trim() || undefined,
      },
      () => refreshTelemetry(),
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

  const modeDetails: Record<
    JobMode,
    { title: string; description: string; shortcut: string; icon: typeof FileText }
  > = {
    scrape: {
      title: 'Scrape',
      description: 'One page into clean Markdown',
      shortcut: 'S',
      icon: FileText,
    },
    map: {
      title: 'Map',
      description: 'Discover a site’s useful links',
      shortcut: 'M',
      icon: Network,
    },
    crawl: {
      title: 'Crawl',
      description: 'Collect multiple pages as a dataset',
      shortcut: 'C',
      icon: Globe2,
    },
  };

  return (
    <div className="smartcrawl-ui min-h-dvh flex flex-col justify-between">
      {/* Top Bar */}
      <header className="sc-header px-4 sm:px-6 flex flex-wrap items-center justify-between gap-3 select-none sticky top-0 z-40 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <button
            type="button"
            onClick={() => switchView('landing')}
            className="sc-wordmark shrink-0 hover:opacity-70"
          >
            <span>SmartCrawl</span>
          </button>
          <span className="sc-kicker hidden sm:inline">
            v3.0 — workbench
          </span>

          <nav className="hidden md:flex items-center gap-5 self-stretch" aria-label="Workspace navigation">
            <button
              type="button"
              onClick={() => switchView('workbench')}
              className={`sc-nav-link ${mainView === 'workbench' ? 'sc-nav-link--active' : ''}`}
            >
              Workbench
            </button>
            <button
              type="button"
              onClick={() => switchView('docs')}
              className={`sc-nav-link ${mainView === 'docs' ? 'sc-nav-link--active' : ''}`}
            >
              Architecture
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 text-xs">
          <a
            href="https://github.com/Emjaay20/Smart-Crawler-II"
            target="_blank"
            rel="noreferrer"
            className="hidden lg:inline-flex items-center gap-1 text-[12px] text-[var(--ink-2)] hover:text-[var(--ink)]"
          >
            <Github size={13} /> GitHub <ArrowRight size={12} />
          </a>
          {account?.configured && account.authenticated && account.user ? (
            <>
              <span className="hidden lg:inline text-[var(--ink-2)]">
                {account.user.name || account.user.email || 'Signed in'}
              </span>
              {me?.key ? (
                <span className="hidden sm:flex items-center gap-1.5 bg-emerald-950/50 border border-emerald-800/60 text-emerald-300 px-2.5 py-1 rounded-[10px] font-code">
                  <KeyRound size={12} />
                  {me.key.remaining}/{me.key.dailyLimit} credits today
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleCreateAccountKey}
                  disabled={creatingAccountKey}
                  className="sc-button sc-button--compact disabled:opacity-60"
                >
                  <KeyRound size={12} />
                  {creatingAccountKey ? 'Creating…' : 'Create API Key'}
                </button>
              )}
              <button type="button" onClick={() => void handleSignOut()} className="hidden sm:inline text-[var(--ink-2)] hover:text-[var(--ink)]">
                Sign out
              </button>
            </>
          ) : account?.configured ? (
            <a
              href={signInUrl()}
              className="sc-button sc-button--compact"
            >
              Start free <ArrowRight size={13} />
            </a>
          ) : me?.key ? (
            <span className="hidden sm:flex items-center gap-1.5 bg-emerald-950/50 border border-emerald-800/60 text-emerald-300 px-2.5 py-1 rounded-[10px] font-code">
              <KeyRound size={12} />
              {me.key.name} ({me.key.remaining}/{me.key.dailyLimit} left today)
            </span>
          ) : me?.authRequired ? (
            <button
              type="button"
              onClick={() => setShowConfig(true)}
              className="flex items-center gap-1.5 bg-[#fbf2e5] border border-[#e7cfae] text-[#8a542d] px-2.5 py-1 rounded-[10px]"
            >
              <KeyRound size={12} />
              API key required
            </button>
          ) : (
            <button
              type="button"
              onClick={handleMintDemoKey}
              disabled={mintingKey}
              className="sc-button sc-button--compact"
              title="Mint a free 25/day sc_live_… key to test quota tracking"
            >
              <KeyRound size={12} />
              {mintingKey ? 'Minting…' : 'Open Mode · Get Demo Key'}
            </button>
          )}

          <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-code text-[var(--ink-2)]">
            <span className={online ? 'sc-status-dot' : 'h-1.5 w-1.5 rounded-[3px] bg-[var(--clay)]'} />
            <span>{online === null ? 'Checking' : online ? 'Online' : 'Offline'}</span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      {mainView === 'landing' ? (
        <LandingPage
          onOpenWorkbench={() => switchView('workbench')}
          onOpenDocs={() => switchView('docs')}
          signInHref={account?.configured ? signInUrl() : undefined}
        />
      ) : mainView === 'docs' ? (
        <main className="flex-1 w-full">
          <DocsView />
        </main>
      ) : (
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6 sm:px-6 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 min-h-0">
        {/* Left Column: Controls + Recent Jobs */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div className="sc-card p-5 sm:p-6 space-y-5">
            <div>
              <label className="sc-label block mb-2">Target URL</label>
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
                  className="sc-input h-[52px] w-full px-3.5 text-[13px]"
                />
              </div>
            </div>

            <div>
              <span className="sc-label block mb-2">Mode</span>
              <div className="space-y-2 select-none">
              {(['scrape', 'map', 'crawl'] as const).map((m) => (
                (() => {
                  const detail = modeDetails[m];
                  const Icon = detail.icon;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`sc-mode ${mode === m ? 'sc-mode--active' : ''}`}
                    >
                      <span className="sc-mode-icon"><Icon size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium">{detail.title}</span>
                        <span className="block truncate text-[12px] text-[var(--ink-2)]">{detail.description}</span>
                      </span>
                      <span className="font-code text-[11px] text-[var(--ink-3)]">{detail.shortcut}</span>
                    </button>
                  );
                })()
              ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleRun()}
              disabled={status === 'crawling' || !url.trim()}
              className="sc-button w-full min-h-12 disabled:cursor-not-allowed select-none"
            >
              {status === 'crawling' ? (
                <>
                  <Activity className="animate-spin" size={15} /> Running {mode}…
                </>
              ) : (
                <>
                  <Play size={14} fill="currentColor" /> Run {mode} <ArrowRight size={14} />
                </>
              )}
            </button>

            <div className="pt-2 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setShowConfig(!showConfig)}
                className="w-full text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] flex items-center justify-between py-1 select-none"
              >
                <span className="flex items-center gap-1.5">
                  <Settings size={14} /> Options & API key
                </span>
                <ChevronDown
                  size={13}
                  className={`transition-transform ${showConfig ? 'rotate-180' : ''}`}
                />
              </button>

              {showConfig && (
                <div className="space-y-3 pt-3 text-xs">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] text-slate-400">
                        Bearer API Key {me?.authRequired ? '(required)' : '(optional in open mode)'}
                      </label>
                      {!me?.authRequired && (
                        <button
                          type="button"
                          onClick={handleMintDemoKey}
                          disabled={mintingKey}
                          className="text-[11px] text-emerald-400 hover:text-emerald-300 underline cursor-pointer"
                        >
                          {mintingKey ? 'Minting…' : '+ Generate Demo Key (25/day)'}
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        localStorage.setItem('smartcrawl.apiKey', e.target.value);
                      }}
                      placeholder="sc_live_… (leave blank in open mode)"
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {mode === 'scrape' && (
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Content provider</label>
                        <select
                          value={provider}
                          onChange={(e) => setProvider(e.target.value as ProviderMode)}
                          className="sc-select w-full px-2 py-1.5 text-xs outline-none"
                        >
                          <option value="local">Local engines only</option>
                          <option value="auto" disabled={!firecrawlConfigured}>Auto fallback {firecrawlConfigured ? '' : '(not enabled)'}</option>
                          <option value="firecrawl" disabled={!firecrawlConfigured}>Managed provider {firecrawlConfigured ? '' : '(not enabled)'}</option>
                        </select>
                      </div>
                    )}
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

                  {mode === 'scrape' && !firecrawlConfigured && (
                    <p className="text-[11px] leading-relaxed text-[var(--ink-2)]">
                      Managed fallback is not enabled on this deployment yet. Local HTTP and browser engines remain available.
                    </p>
                  )}

                  {mode === 'scrape' && provider !== 'local' && firecrawlConfigured && (
                    <p className="text-[11px] leading-relaxed text-[var(--ink-2)]">
                      Managed requests use the server’s configured provider account. Its key is never sent to your browser.
                    </p>
                  )}

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
          <div className="sc-card p-5 sm:p-6 flex-1 flex flex-col min-h-[220px]">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-4 select-none">
              <span className="flex items-center gap-2 font-medium text-[var(--ink)]">
                <Clock size={13} /> Recent Jobs
              </span>
              <span className="font-code text-[11px] text-[var(--ink-3)]">{recentJobs.length} stored</span>
            </div>

            <div className="flex-1 overflow-auto space-y-1.5 custom-scrollbar pr-1">
              {recentJobs.length === 0 ? (
                <div className="m-auto max-w-[220px] text-center py-6">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--paper-soft)] text-[var(--ink-2)]"><Clock size={17} /></div>
                  <p className="font-display text-[19px] text-[var(--ink)]">Nothing here yet</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-2)]">Your recent scrapes, maps, and crawls will be saved here.</p>
                </div>
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
        <section className="sc-card lg:col-span-8 flex flex-col min-h-[540px] lg:min-h-[620px] overflow-hidden">
          <div className="flex items-center border-b border-[var(--border)] bg-[rgba(255,254,252,0.76)] px-2 sm:px-3 overflow-x-auto select-none">
            <button
              type="button"
              onClick={() => setActiveTab('markdown')}
              disabled={!activeMarkdown}
              className={`sc-tab shrink-0 px-3 sm:px-3.5 py-3.5 text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-30 ${
                activeTab === 'markdown'
                  ? 'sc-tab--active'
                  : ''
              }`}
            >
              <FileText size={13} /> Markdown
              {crawlPages.length > 0 && (
                <span className="font-code text-[11px] text-[var(--ink-3)]">
                  {crawlPages.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('links')}
              disabled={discoveredLinks.length === 0}
              className={`sc-tab shrink-0 px-3 sm:px-3.5 py-3.5 text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-30 ${
                activeTab === 'links'
                  ? 'sc-tab--active'
                  : ''
              }`}
            >
              <Link2 size={13} /> Links
              {discoveredLinks.length > 0 && (
                <span className="font-code text-[11px] text-[var(--ink-3)]">
                  {discoveredLinks.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('data')}
              disabled={data == null}
              className={`sc-tab shrink-0 px-3 sm:px-3.5 py-3.5 text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-30 ${
                activeTab === 'data'
                  ? 'sc-tab--active'
                  : ''
              }`}
            >
              <Braces size={13} /> JSON
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('console')}
              className={`sc-tab shrink-0 px-3 sm:px-3.5 py-3.5 text-[13px] font-medium flex items-center gap-1.5 ${
                activeTab === 'console'
                  ? 'sc-tab--active'
                  : ''
              }`}
            >
              <Terminal size={13} /> Logs <span className="font-code text-[11px] text-[var(--ink-3)]">({logs.length})</span>
            </button>

            <div className="ml-auto flex items-center gap-1.5 pr-2 shrink-0">
              {data != null && (
                <>
                  <button
                    type="button"
                    onClick={copyContent}
                    className="px-2.5 py-1.5 text-[11px] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--paper-soft)] rounded-[8px] text-[var(--ink-2)] flex items-center gap-1"
                    title="Copy current view"
                  >
                    <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="px-2.5 py-1.5 text-[11px] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--paper-soft)] rounded-[8px] text-[var(--ink-2)] flex items-center gap-1"
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
            <div className="border-b border-[var(--border)] bg-[var(--paper-soft)] px-4 py-2 flex items-center gap-2 overflow-x-auto custom-scrollbar select-none">
              <span className="font-code text-[11px] text-[var(--ink-2)] shrink-0">Pages:</span>
              {crawlPages.map((p, idx) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => setSelectedPageIdx(idx)}
                  className={`px-2.5 py-1 rounded-[8px] text-xs truncate max-w-[220px] border transition-colors ${
                    selectedPageIdx === idx
                      ? 'bg-[var(--surface)] border-[var(--ink)] text-[var(--ink)]'
                      : 'bg-transparent border-[var(--border)] text-[var(--ink-2)] hover:text-[var(--ink)]'
                  }`}
                >
                  {idx + 1}. {p.title || p.url}
                </button>
              ))}
            </div>
          )}

          {/* Output Body */}
          <div className="flex-1 overflow-auto p-5 sm:p-7 custom-scrollbar">
            {activeTab === 'console' && (
              <div className="h-full text-xs space-y-1.5">
                {logs.length === 0 && (
                  <div className="mx-auto flex min-h-[360px] max-w-md flex-col justify-center text-center">
                    <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-[12px] border border-[var(--border)] bg-[var(--paper-soft)] text-[var(--ink)]"><Globe2 size={21} /></div>
                    <h1 className="sc-empty-title">Ready to crawl</h1>
                    <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-[var(--ink-2)]">Enter a URL, choose a mode, and SmartCrawl will fetch, render when necessary, and return content you can use.</p>
                    <div className="mt-7 space-y-2 text-left">
                      <button type="button" onClick={() => { setUrl('https://example.com'); setMode('scrape'); }} className="sc-suggestion"><ArrowRight size={14} /><span className="font-medium text-[var(--ink)]">Try a single page</span><span className="ml-auto truncate font-code text-[11px]">example.com</span></button>
                      <button type="button" onClick={() => switchView('docs')} className="sc-suggestion"><BookOpen size={14} /><span className="font-medium text-[var(--ink)]">See how it works</span><span className="ml-auto font-code text-[11px]">Architecture</span></button>
                      <button type="button" onClick={() => setShowConfig(true)} className="sc-suggestion"><KeyRound size={14} /><span className="font-medium text-[var(--ink)]">Connect an API key</span><span className="ml-auto font-code text-[11px]">Optional</span></button>
                    </div>
                  </div>
                )}
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-3 font-code text-[12px]">
                    <span className="text-[var(--ink-3)] shrink-0">[{log.time.slice(11, 19)}]</span>
                    <span
                      className={
                        log.level === 'error'
                          ? 'text-rose-400'
                          : log.level === 'success'
                            ? 'text-emerald-400'
                            : 'text-[var(--ink)]'
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
                ? `Jobs: ${ops.scrapeCompleted} ok / ${ops.scrapeFailed} failed · Engine: ${ops.engineHttp} http / ${ops.enginePlaywright} playwright / ${ops.engineFirecrawl} cloud`
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
      )}

      {/* Global Responsive Footer */}
      <Footer ops={ops} online={online} onOpenDocs={() => switchView('docs')} />
    </div>
  );
}
