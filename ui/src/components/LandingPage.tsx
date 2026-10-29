import type { FC } from 'react';
import { ArrowRight, Braces, Check, FileText, Globe2, Layers3, Map, ShieldCheck, Sparkles } from 'lucide-react';

interface LandingPageProps {
  onOpenWorkbench: () => void;
  onOpenDocs: () => void;
  signInHref?: string;
}

const steps = [
  { icon: FileText, title: 'Scrape a page', body: 'Get clean Markdown, HTML, links, and page metadata from a single URL.' },
  { icon: Map, title: 'Map a site', body: 'Discover useful pages before you spend time or credits crawling them.' },
  { icon: Layers3, title: 'Build a dataset', body: 'Crawl a focused set of pages and keep the results ready for your workflow.' },
];

export const LandingPage: FC<LandingPageProps> = ({ onOpenWorkbench, onOpenDocs, signInHref }) => (
  <main className="sc-landing">
    <section className="sc-hero">
      <div className="sc-hero-copy">
        <p className="sc-eyebrow"><Sparkles size={13} /> Web data, made usable</p>
        <h1>Turn the web into <em>clean</em>, usable data.</h1>
        <p className="sc-hero-lede">
          SmartCrawl gives builders a calm place to scrape, map, and crawl public web pages—then returns structured results your product, research, or AI workflow can use.
        </p>
        <div className="sc-hero-actions">
          {signInHref ? (
            <a className="sc-button sc-button--hero" href={signInHref}>Start free <ArrowRight size={15} /></a>
          ) : (
            <button type="button" className="sc-button sc-button--hero" onClick={onOpenWorkbench}>Open workbench <ArrowRight size={15} /></button>
          )}
          <button type="button" className="sc-secondary-button" onClick={onOpenWorkbench}>Try a URL <ArrowRight size={14} /></button>
        </div>
        <div className="sc-proof-line">
          <span><Check size={13} /> No browser extension</span>
          <span><Check size={13} /> API-ready output</span>
          <span><Check size={13} /> Your jobs stay yours</span>
        </div>
      </div>

      <div className="sc-hero-demo" aria-label="SmartCrawl workbench preview">
        <div className="sc-demo-topline"><span className="sc-status-dot" /> Workbench preview <span>ready</span></div>
        <div className="sc-demo-url"><span>https://</span><strong>example.com/features</strong></div>
        <div className="sc-demo-output">
          <div className="sc-demo-tabs"><span className="active">Markdown</span><span>Links</span><span>JSON</span></div>
          <div className="sc-demo-copy">
            <span className="sc-label">EXTRACTED CONTENT</span>
            <h2>A page, without the noise.</h2>
            <p>Readable content, useful links, and metadata—ready for the next step.</p>
          </div>
          <div className="sc-demo-lines"><i /><i /><i /><i /></div>
        </div>
      </div>
    </section>

    <section className="sc-section sc-section--intro">
      <p className="sc-eyebrow">A practical web-data workbench</p>
      <h2>One clear path from URL to useful result.</h2>
      <div className="sc-step-grid">
        {steps.map(({ icon: Icon, title, body }, index) => (
          <article className="sc-step" key={title}>
            <span className="sc-step-number">0{index + 1}</span>
            <span className="sc-step-icon"><Icon size={18} /></span>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>

    <section className="sc-section sc-split-section">
      <div>
        <p className="sc-eyebrow">Built with judgment</p>
        <h2>Local first. Escalate thoughtfully.</h2>
        <p className="sc-section-copy">Fast HTTP extraction handles the ordinary case. JavaScript rendering is there when a page needs it. An optional managed provider can be enabled by the operator for a single-page job when it makes sense—without exposing its credentials to users.</p>
        <button type="button" className="sc-text-link" onClick={onOpenDocs}>See the architecture <ArrowRight size={14} /></button>
      </div>
      <div className="sc-principles">
        <div><ShieldCheck size={19} /><span><strong>Responsible by default</strong><small>URL validation and robots checks stay in the pipeline.</small></span></div>
        <div><Globe2 size={19} /><span><strong>Designed for real work</strong><small>Map before crawl and keep a visible job history.</small></span></div>
        <div><Braces size={19} /><span><strong>Built for integration</strong><small>Use the workbench or call the same API from your product.</small></span></div>
      </div>
    </section>

    <section className="sc-cta-section">
      <p className="sc-eyebrow">Ready when you are</p>
      <h2>Bring one URL. Leave with usable data.</h2>
      <p>Start with the workbench, create your own API key, and make the web part of your product.</p>
      <button type="button" className="sc-button sc-button--hero" onClick={onOpenWorkbench}>Open SmartCrawl <ArrowRight size={15} /></button>
    </section>
  </main>
);
