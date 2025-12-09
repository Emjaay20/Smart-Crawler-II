import { useState } from 'react';
import { useSmartCrawl } from './hooks/useSmartCrawl';
import { motion } from 'framer-motion';
export default function CrawlerInterface() {
    const { status, progress, startJob, data } = useSmartCrawl();
    const [url, setUrl] = useState('');
    const [showData, setShowData] = useState(false);
    return (<div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center font-mono p-4">
      <div className="w-full max-w-2xl p-8 bg-slate-800 rounded-xl shadow-2xl border border-slate-700">

        {/* Header */}
        <div className="flex items-center gap-2 mb-6">
          <div className="w-3 h-3 rounded-full bg-red-500"/>
          <div className="w-3 h-3 rounded-full bg-yellow-500"/>
          <div className="w-3 h-3 rounded-full bg-green-500"/>
          <span className="ml-4 text-sm text-slate-400">root@crawler:~</span>
        </div>

        <h1 className="text-2xl font-bold mb-2">SmartPlaywright <span className="text-green-400">CLI-GUI</span></h1>
        <p className="text-sm text-slate-400 mb-6">Enter a URL to extract structured JSON data.</p>

        {/* Input Area */}
        <div className="flex gap-2">
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} disabled={status === 'crawling'} placeholder="https://example.com" className="flex-1 bg-slate-900 border border-slate-700 rounded px-4 py-2 focus:outline-none focus:border-green-500 transition-colors"/>
          <button onClick={() => startJob(url)} disabled={status === 'crawling' || !url} className="bg-green-600 hover:bg-green-500 text-white px-6 py-2 rounded font-bold disabled:opacity-50 transition-all">
            {status === 'crawling' ? 'RUNNING' : 'EXEC'}
          </button>
        </div>

        {/* Progress Bar Area */}
        {status === 'crawling' && (<div className="mt-6">
            <div className="flex justify-between text-xs text-green-400 mb-1">
              <span>Scanning DOM...</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-2 bg-slate-700 rounded overflow-hidden">
              <motion.div className="h-full bg-green-500" initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 0.5 }}/>
            </div>
          </div>)}

        {/* Status Messages */}
        <div className="mt-6 min-h-[50px]">
          {status === 'success' && (<div className="space-y-4">
              <div className="p-3 bg-green-900/30 border border-green-500/30 rounded text-green-300 text-sm flex justify-between items-center">
                <span>✅ **Success:** Payload downloaded to local disk.</span>
                <button onClick={() => setShowData(!showData)} className="text-xs underline hover:text-green-200">
                  {showData ? 'Hide Data' : 'View Data'}
                </button>
              </div>

              {showData && data && (<div className="p-4 bg-slate-900 rounded border border-slate-700 overflow-auto max-h-96 text-xs">
                  <pre>{JSON.stringify(data, null, 2)}</pre>
                </div>)}
            </div>)}
          {status === 'timeout' && (<div className="p-3 bg-yellow-900/30 border border-yellow-500/30 rounded text-yellow-300 text-sm">
              ⚠️ **Timeout:** The target is responding slowly. Job is queued.
            </div>)}
          {status === 'error' && (<div className="p-3 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
              ❌ **Error:** Failed to connect to target.
            </div>)}
        </div>

      </div>
    </div>);
}
