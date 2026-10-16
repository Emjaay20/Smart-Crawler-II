import { useState, useEffect, useRef } from 'react';
import { fetchOpsStats, useSmartCrawl, type JobMode, type OpsStats } from './hooks/useSmartCrawl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal, Settings, Download, Copy, Play,
  CheckCircle, Wifi, Activity, ChevronDown
} from 'lucide-react';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

type EngineMode = 'auto' | 'http' | 'playwright';

function jsFromEngine(mode: EngineMode): boolean | 'auto' {
  if (mode === 'http') return false;
  if (mode === 'playwright') return true;
  return 'auto';
}

export default function CrawlerInterface() {
  const { status, progress, startJob, data, logs, error } = useSmartCrawl();
  const [url, setUrl] = useState('');
  const [activeTab, setActiveTab] = useState<'console' | 'data' | 'markdown'>('console');
  const [showConfig, setShowConfig] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [userAgent, setUserAgent] = useState('SmartCrawl/1.0');
  const [engine, setEngine] = useState<EngineMode>('auto');
  const [mode, setMode] = useState<JobMode>('scrape');
  const [limit, setLimit] = useState(5);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('smartcrawl.apiKey') ?? '');
  const [online, setOnline] = useState<boolean | null>(null);
  const [ops, setOps] = useState<OpsStats | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (status === 'success') {
      const result = data as { markdown?: string } | null;
      setActiveTab(result?.markdown ? 'markdown' : 'data');
    }
  }, [status, data]);

  useEffect(() => {
    const api = import.meta.env.VITE_API_URL ?? '';
    fetch(`${api}/health`)
      .then((res) => setOnline(res.ok))
      .catch(() => setOnline(false));
    const tick = () => { void fetchOpsStats(apiKey || undefined).then(setOps); };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [apiKey]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  };

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `crawl_${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const payload = data as {
    markdown?: string;
    metadata?: { engine?: string; statusCode?: number };
    timing?: { totalMs?: number };
  } | null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center font-mono p-4 selection:bg-green-500/30">
      <div className="w-full max-w-4xl bg-slate-900/80 backdrop-blur-md rounded-xl shadow-2xl border border-slate-800 overflow-hidden flex flex-col h-[85vh]">

        <div className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5 mr-4">
              <div className="w-3 h-3 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80 shadow-[0_0_8px_rgba(234,179,8,0.6)]" />
              <div className="w-3 h-3 rounded-full bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
            </div>
            <span className="text-xs text-slate-500 font-semibold flex items-center gap-2">
              <Terminal size={14} /> root@smart-crawler:~
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <div className="flex items-center gap-1">
              <Wifi size={12} className={online ? 'text-green-500' : 'text-slate-600'} />
              {online === null ? 'CHECKING' : online ? 'ONLINE' : 'OFFLINE'}
            </div>
            <div className="flex items-center gap-1">
              <Activity size={12} className={status === 'crawling' ? 'text-blue-400 animate-pulse' : ''} />
              {status === 'crawling' ? 'RUNNING' : 'IDLE'}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col p-6 gap-6 relative">
          <div className="space-y-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white mb-1">
                Smart<span className="text-green-500">Crawl</span> <span className="text-xs align-top bg-slate-800 px-2 py-0.5 rounded text-slate-400 font-normal">v3.0.0</span>
              </h1>
              <p className="text-slate-400 text-sm">URL in. Clean markdown and structured JSON out.</p>
            </div>

            <div className="flex gap-2 relative z-10">
              <div className="relative flex-1 group">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={status === 'crawling'}
                  placeholder="https://example.com/blog/post"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-4 pr-10 py-3 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/50 transition-all text-sm placeholder:text-slate-600"
                />
                <div className="absolute right-3 top-3 text-slate-600 group-focus-within:text-green-500 transition-colors">
                  <Wifi size={16} />
                </div>
              </div>
              <button
                onClick={() => startJob(url, { timeoutMs, userAgent, js: jsFromEngine(engine), mode, limit, apiKey: apiKey || undefined })}
                disabled={status === 'crawling' || !url}
                className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 rounded-lg font-bold transition-all shadow-[0_0_15px_rgba(22,163,74,0.3)] flex items-center gap-2"
              >
                {status === 'crawling' ? <Activity className="animate-spin" size={18} /> : <Play size={18} />}
                {status === 'crawling' ? 'RUNNING' : 'EXEC'}
              </button>
            </div>

            <div className="border-b border-slate-800 pb-4">
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="text-xs text-slate-500 hover:text-green-400 flex items-center gap-1 transition-colors"
              >
                <Settings size={12} />
                {showConfig ? 'Hide Configuration' : 'Configuration'}
                <ChevronDown size={12} className={`transition-transform ${showConfig ? 'rotate-180' : ''}`} />
              </button>

              <AnimatePresence>
                {showConfig && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1 pt-4">
                      <label className="text-xs text-slate-500">API key</label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          localStorage.setItem('smartcrawl.apiKey', e.target.value);
                        }}
                        placeholder="sc_live_…"
                        className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-4 pt-4">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Mode</label>
                        <select
                          value={mode}
                          onChange={(e) => setMode(e.target.value as JobMode)}
                          className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                        >
                          <option value="scrape">scrape (one page)</option>
                          <option value="map">map (discover URLs)</option>
                          <option value="crawl">crawl (multi-page)</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Limit (map/crawl)</label>
                        <input
                          type="number"
                          value={limit}
                          min={1}
                          max={20}
                          onChange={(e) => setLimit(Number(e.target.value) || 5)}
                          className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Engine</label>
                        <select
                          value={engine}
                          onChange={(e) => setEngine(e.target.value as EngineMode)}
                          className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                        >
                          <option value="auto">Auto (HTTP, Playwright if needed)</option>
                          <option value="http">HTTP only</option>
                          <option value="playwright">Always Playwright</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Timeout (ms)</label>
                        <input
                          type="number"
                          value={timeoutMs}
                          min={1000}
                          onChange={(e) => setTimeoutMs(Number(e.target.value) || 15000)}
                          className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">User Agent</label>
                        <select
                          value={userAgent}
                          onChange={(e) => setUserAgent(e.target.value)}
                          className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none"
                        >
                          <option value="SmartCrawl/1.0">SmartCrawl/1.0</option>
                          <option value={CHROME_UA}>Chrome / Desktop</option>
                          <option value={GOOGLEBOT_UA}>Googlebot</option>
                        </select>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <AnimatePresence>
            {status === 'crawling' && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="bg-slate-900/50 rounded-lg p-3 border border-slate-800"
              >
                <div className="flex justify-between text-xs text-green-400 mb-2">
                  <span className="flex items-center gap-2"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> Job running</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-green-600 to-green-400"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ ease: 'easeOut' }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex-1 flex flex-col min-h-0 bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            <div className="flex border-b border-slate-800 bg-slate-900/50">
              <button
                onClick={() => setActiveTab('console')}
                className={`px-4 py-2 text-xs font-medium flex items-center gap-2 transition-colors ${activeTab === 'console' ? 'text-white bg-slate-800 border-t-2 border-green-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <Terminal size={12} /> Job logs
              </button>
              <button
                onClick={() => setActiveTab('markdown')}
                disabled={!payload?.markdown}
                className={`px-4 py-2 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-30 ${activeTab === 'markdown' ? 'text-white bg-slate-800 border-t-2 border-green-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <CheckCircle size={12} /> Markdown
              </button>
              <button
                onClick={() => setActiveTab('data')}
                disabled={data == null}
                className={`px-4 py-2 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-30 ${activeTab === 'data' ? 'text-white bg-slate-800 border-t-2 border-green-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                JSON
              </button>

              <div className="ml-auto flex items-center gap-2 px-2">
                {data != null && activeTab === 'data' && (
                  <>
                    <button onClick={copyToClipboard} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white" title="Copy JSON">
                      <Copy size={14} />
                    </button>
                    <button onClick={handleDownload} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white" title="Download JSON">
                      <Download size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
              {activeTab === 'console' ? (
                <div className="font-mono text-xs space-y-1">
                  {logs.length === 0 && <span className="text-slate-600 italic">Ready. Jobs persist in SQLite; logs come from the worker.</span>}
                  {logs.map((log, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="text-slate-600">[{log.time}]</span>
                      <span className={`${log.level === 'error' ? 'text-red-400' :
                        log.level === 'success' ? 'text-green-400' : 'text-slate-300'
                        }`}>
                        {log.level === 'info' && '> '}
                        {log.msg}
                      </span>
                    </div>
                  ))}
                  {error && <div className="text-red-400">{error}</div>}
                  <div ref={logsEndRef} />
                </div>
              ) : activeTab === 'markdown' ? (
                <pre className="text-xs text-green-300/90 font-mono leading-relaxed whitespace-pre-wrap">
                  {payload?.markdown || ''}
                </pre>
              ) : (
                <pre className="text-xs text-green-300/90 font-mono leading-relaxed">
                  {JSON.stringify(data, null, 2)}
                </pre>
              )}
            </div>
          </div>

          <div className="text-[10px] text-slate-600 flex justify-between uppercase tracking-wider">
            <span>{ops ? `ok ${ops.scrapeCompleted} / fail ${ops.scrapeFailed} · http ${ops.engineHttp} · pw ${ops.enginePlaywright}` : (payload?.metadata?.engine ? `engine: ${payload.metadata.engine}` : 'engine: —')}</span>
            <span>{ops ? `p95 ${ops.durationP95Ms}ms · map ${ops.mapLinks} · crawl ${ops.crawlPages}` : (payload?.timing?.totalMs != null ? `${payload.timing.totalMs}ms` : status === 'error' ? (error ?? 'error') : 'idle')}</span>
          </div>

        </div>
      </div>
    </div>
  );
}
