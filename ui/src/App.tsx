import { useState, useEffect, useRef } from 'react';
import { useSmartCrawl } from './hooks/useSmartCrawl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal, Settings, Download, Copy, Play,
  CheckCircle, Wifi, Activity, ChevronDown
} from 'lucide-react';

interface LogEntry {
  type: string;
  msg: string;
  time: string;
}

export default function CrawlerInterface() {
  const { status, progress, startJob, data } = useSmartCrawl();
  const [url, setUrl] = useState('');
  const [activeTab, setActiveTab] = useState('console'); // 'console' | 'data'
  const [showConfig, setShowConfig] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);



  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Simulate live logs when crawling starts
  useEffect(() => {
    if (status === 'crawling') {
      setLogs(prev => [...prev, { type: 'info', msg: `Initiating crawl on ${url}...`, time: new Date().toLocaleTimeString() }]);
      const interval = setInterval(() => {
        const msgs = ['Resolving DNS...', 'Handshaking...', 'Parsing DOM tree...', 'Extracting metadata...'];
        const randomMsg = msgs[Math.floor(Math.random() * msgs.length)];
        setLogs(prev => [...prev, { type: 'info', msg: randomMsg, time: new Date().toLocaleTimeString() }]);
      }, 800);
      return () => clearInterval(interval);
    }
    if (status === 'success') {
      setLogs(prev => [...prev, { type: 'success', msg: 'Payload extracted successfully.', time: new Date().toLocaleTimeString() }]);
      setActiveTab('data');
    }
    if (status === 'error') {
      setLogs(prev => [...prev, { type: 'error', msg: 'Connection failed.', time: new Date().toLocaleTimeString() }]);
    }
  }, [status, url]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    // Add toast notification logic here
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center font-mono p-4 selection:bg-green-500/30">
      <div className="w-full max-w-4xl bg-slate-900/80 backdrop-blur-md rounded-xl shadow-2xl border border-slate-800 overflow-hidden flex flex-col h-[800px]">

        {/* --- Top Bar (Window Controls & Stats) --- */}
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
            <div className="flex items-center gap-1"><Wifi size={12} className="text-green-500" /> ONLINE</div>
            <div className="flex items-center gap-1"><Activity size={12} className={status === 'crawling' ? 'text-blue-400 animate-pulse' : ''} /> IDLE</div>
          </div>
        </div>

        {/* --- Main Content Area --- */}
        <div className="flex-1 overflow-hidden flex flex-col p-6 gap-6 relative">

          {/* Header & Input */}
          <div className="space-y-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white mb-1">
                Smart<span className="text-green-500">Crawl</span> <span className="text-xs align-top bg-slate-800 px-2 py-0.5 rounded text-slate-400 font-normal">v2.0.1</span>
              </h1>
              <p className="text-slate-400 text-sm">Target a URL to extract structured entities via Headless DOM.</p>
            </div>

            <div className="flex gap-2 relative z-10">
              <div className="relative flex-1 group">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={status === 'crawling'}
                  placeholder="https://target-site.com/resource"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-4 pr-10 py-3 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/50 transition-all text-sm placeholder:text-slate-600"
                />
                <div className="absolute right-3 top-3 text-slate-600 group-focus-within:text-green-500 transition-colors">
                  <Wifi size={16} />
                </div>
              </div>
              <button
                onClick={() => startJob(url)}
                disabled={status === 'crawling' || !url}
                className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 rounded-lg font-bold transition-all shadow-[0_0_15px_rgba(22,163,74,0.3)] flex items-center gap-2"
              >
                {status === 'crawling' ? <Activity className="animate-spin" size={18} /> : <Play size={18} />}
                {status === 'crawling' ? 'RUNNING' : 'EXEC'}
              </button>
            </div>

            {/* Config Toggle */}
            <div className="border-b border-slate-800 pb-4">
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="text-xs text-slate-500 hover:text-green-400 flex items-center gap-1 transition-colors"
              >
                <Settings size={12} />
                {showConfig ? 'Hide Configuration' : 'Advanced Configuration'}
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
                    <div className="grid grid-cols-3 gap-4 pt-4">
                      {/* Fake Inputs for visual effect */}
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Crawl Depth</label>
                        <select className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none">
                          <option>Level 1 (Single Page)</option>
                          <option>Level 2 (Links)</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">Timeout (ms)</label>
                        <input type="number" defaultValue={3000} className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">User Agent</label>
                        <select className="w-full bg-slate-800/50 border border-slate-700 rounded p-1 text-xs outline-none">
                          <option>Chrome / Desktop</option>
                          <option>Googlebot</option>
                        </select>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Progress Bar (Only visible when active) */}
          <AnimatePresence>
            {status === 'crawling' && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="bg-slate-900/50 rounded-lg p-3 border border-slate-800"
              >
                <div className="flex justify-between text-xs text-green-400 mb-2">
                  <span className="flex items-center gap-2"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> Live Scanning</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-green-600 to-green-400"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ ease: "easeOut" }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Output Area (Tabs) */}
          <div className="flex-1 flex flex-col min-h-0 bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            {/* Tab Header */}
            <div className="flex border-b border-slate-800 bg-slate-900/50">
              <button
                onClick={() => setActiveTab('console')}
                className={`px-4 py-2 text-xs font-medium flex items-center gap-2 transition-colors ${activeTab === 'console' ? 'text-white bg-slate-800 border-t-2 border-green-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <Terminal size={12} /> Console Output
              </button>
              <button
                onClick={() => setActiveTab('data')}
                disabled={!data}
                className={`px-4 py-2 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-30 ${activeTab === 'data' ? 'text-white bg-slate-800 border-t-2 border-green-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <CheckCircle size={12} /> Data Payload {data ? `(${Object.keys(data).length} keys)` : ''}
              </button>

              <div className="ml-auto flex items-center gap-2 px-2">
                {data && activeTab === 'data' && (
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

            {/* Tab Content */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
              {activeTab === 'console' ? (
                <div className="font-mono text-xs space-y-1">
                  {logs.length === 0 && <span className="text-slate-600 italic">Ready for input...</span>}
                  {logs.map((log, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="text-slate-600">[{log.time}]</span>
                      <span className={`${log.type === 'error' ? 'text-red-400' :
                        log.type === 'success' ? 'text-green-400' : 'text-slate-300'
                        }`}>
                        {log.type === 'info' && '> '}
                        {log.msg}
                      </span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              ) : (
                <div className="relative group">
                  <pre className="text-xs text-green-300/90 font-mono leading-relaxed">
                    {JSON.stringify(data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* Footer Status */}
          <div className="text-[10px] text-slate-600 flex justify-between uppercase tracking-wider">
            <span>Memory: 124MB / 1024MB</span>
            <span>Latency: 42ms</span>
          </div>

        </div>
      </div>
    </div>
  );
}