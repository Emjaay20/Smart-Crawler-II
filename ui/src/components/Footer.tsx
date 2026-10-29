import React from 'react';
import {
  Github,
  ArrowUpRight,
  Wifi,
} from 'lucide-react';
import type { OpsStats } from '../hooks/useSmartCrawl';

interface FooterProps {
  ops: OpsStats | null;
  online: boolean | null;
  onOpenDocs?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ ops, online, onOpenDocs }) => {
  return (
    <footer className="border-t border-slate-800/90 bg-slate-950/80 text-slate-400 text-xs px-4 sm:px-6 py-4 select-none">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Left: Author + Source Link */}
        <div className="flex flex-wrap items-center gap-3 text-slate-400">
          <a
            href="https://yusufsaka.dev"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-slate-300 hover:text-emerald-400 font-medium transition-colors group"
          >
            <span>Built by <strong className="text-white group-hover:text-emerald-400 transition-colors">Yusuf</strong></span>
            <ArrowUpRight size={12} className="text-slate-500 group-hover:text-emerald-400 transition-colors" />
          </a>

          <span className="text-slate-700 hidden sm:inline">|</span>

          <a
            href="https://github.com/Emjaay20/Smart-Crawler-II"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors"
          >
            <Github size={13} />
            <span>GitHub</span>
            <ArrowUpRight size={11} className="text-slate-500" />
          </a>

          {onOpenDocs && (
            <>
              <span className="text-slate-700 hidden sm:inline">|</span>
              <button
                type="button"
                onClick={onOpenDocs}
                className="hover:text-emerald-400 text-slate-400 transition-colors cursor-pointer"
              >
                Architecture & Trade-offs
              </button>
            </>
          )}
        </div>

        {/* Center/Right: Live Telemetry & API Links */}
        <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-500">
          <div className="flex items-center gap-1.5">
            <Wifi size={11} className={online ? 'text-emerald-400' : 'text-rose-500'} />
            <span className={online ? 'text-emerald-400' : 'text-slate-500'}>
              {online ? 'ONLINE' : online === false ? 'OFFLINE' : 'CHECKING'}
            </span>
          </div>

          {ops && (
            <div className="hidden md:flex items-center gap-3">
              <span>Jobs: {ops.scrapeCompleted} ok / {ops.scrapeFailed} fail</span>
              <span>p95: {ops.durationP95Ms}ms</span>
              <span>HTTP: {ops.engineHttp} | PW: {ops.enginePlaywright} | Cloud: {ops.engineFirecrawl}</span>
            </div>
          )}

          <div className="flex items-center gap-3">
            <a
              href="/openapi.yaml"
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              OpenAPI
            </a>
            <a
              href="/metrics"
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              /metrics
            </a>
            <a
              href="/v1/report"
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              /report
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

