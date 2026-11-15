# Firecrawl application materials — Yusuf Abubakar Saka

Prepared 2026-11-15 from the two supplied Ashby job descriptions, verified SmartCrawl
engineering evidence, and Yusuf Abubakar Saka's CV (`Yusuf_Abubakar_Saka_CV.pdf` and
`Yusuf_Saka_Modern_Tech_CV.pdf`). No application has been submitted automatically.

## Candidate profile summary (from CV)

- **Name:** Yusuf Abubakar Saka
- **Contact:** `youngmj2010@gmail.com` | `+234 816 2625 860`
- **Links:** [GitHub (`Emjaay20`)](https://github.com/Emjaay20) | [LinkedIn (`yusuf-saka`)](https://linkedin.com/in/yusuf-saka) | [Portfolio](https://dev-emjaay.pantheonsite.io) | [Live SmartCrawl](https://smart-crawler.aetherhost.app)
- **Education:**
  - **M.Eng., Computer Engineering (Software Engineering)** — Baze University, Abuja (2024), CGPA 4.9/5.0
  - **B.Eng., Computer Engineering** — Federal University of Technology, Minna (2019)
- **Experience:**
  - **Freelance Full-Stack Software Engineer & Web Developer** (2019 – Present, Abuja / Remote): 5+ years delivering 30+ production web systems and full-stack TypeScript/React/Next.js/Node.js and WordPress applications across government, e-commerce, and nonprofit clients, plus building and operating **SmartCrawl** and **AetherHost** (`aetherhost.app`).
  - **Web Support Engineer — Rooah LLC, Delaware** (2020): Built and QA'd client web applications, resolved production issues, and maintained server uptime.
- **Location & work authorization note:** Based in Abuja, Nigeria. Both Ashby postings list hybrid work in San Francisco or Toronto (3+ days onsite/week) with case-by-case Canadian work permit sponsorship or US O-1/TN/H-1B transfer paths, plus a paid remote work-trial evaluation. Explicitly note location in Nigeria and openness to the remote work trial and Canadian/US sponsorship pathways when submitting.

## Role fit

| Role | Evidence to lead with | Boundaries to state honestly |
| --- | --- | --- |
| [Product Engineer – Scrape](https://jobs.ashbyhq.com/firecrawl/83249105-3b1e-41fc-a991-4fd41670ffca) | 5+ years full-stack web engineering (M.Eng. Software Engineering, CGPA 4.9/5.0); built SmartCrawl's HTTP-first extraction pipeline, TypeScript SDK deadlines/typed errors, session-bound guest ownership, concurrent BFS crawling, SQLite WAL checkpoints/backups, and Aetherhost production deployment | SmartCrawl is an independent engineering project and portfolio platform, not a high-volume commercial scraping fleet |
| [Web Automation Engineer](https://jobs.ashbyhq.com/firecrawl/5a7ce67e-0b71-428a-b774-e7c05e7841b6) | Bounded Playwright context scheduler, real Chromium CDP crash-injection and recovery regression, DNS-pinned outbound socket validation, per-redirect SSRF guards, and TLS cookie verification | Strongest evidence is browser lifecycle, context isolation, and crawler reliability rather than large-scale anti-bot reverse engineering |

Product Engineer – Scrape is the primary match to both the CV background (5+ years full-stack Node.js/TypeScript/React web systems) and the SmartCrawl architecture.

## Product Engineer – Scrape: tailored application note

Hi Firecrawl team — I'm Yusuf Abubakar Saka, a software engineer (M.Eng. Software Engineering, CGPA 4.9/5.0) with 5+ years of experience building and operating full-stack web systems in TypeScript, Node.js, and React.

I'm applying for the Product Engineer – Scrape role because I've spent my recent engineering work tackling the exact reliability and developer-experience challenges at the core of web extraction in **SmartCrawl** ([GitHub](https://github.com/Emjaay20/Smart-Crawler-II), [live on AetherHost](https://smart-crawler.aetherhost.app)):

- **HTTP-first extraction & SDK ergonomics:** Built a Readability-based extraction pipeline with optional Playwright fallback and a TypeScript SDK featuring per-request network deadlines (`AbortSignal`), bounded polling budgets, typed error classes, and explicit redirect refusal.
- **Safe outbound networking & tenant isolation:** Implemented DNS-aware public-destination validation with socket IP pinning across redirects, opaque `HttpOnly`/`Secure` guest session cookies, atomic quota enforcement, and credential redaction.
- **Deterministic concurrent crawling & durability:** Built a bounded breadth-first scheduler (concurrency 1–4) with per-origin pacing, versioned SQLite WAL checkpoints, explicit admin resume from the last committed frontier (verified across `SIGKILL` worker crashes), and online `VACUUM INTO` snapshot backups.
- **Verification:** Backed by 146 passing automated tests, a separate real-Chromium CDP crash-recovery test, zero npm audit vulnerabilities across server and UI, and live deployment on my self-hosted PaaS ([AetherHost](https://smart-crawler.aetherhost.app)).

I am currently based in Abuja, Nigeria, available immediately for the remote work trial, and open to relocation/work-authorization pathways for Toronto or San Francisco. I would love to walk through the architecture, failure modes, and test suite with you.

## Web Automation Engineer: tailored application note

Hi Firecrawl team — I'm Yusuf Abubakar Saka (M.Eng. Software Engineering; 5+ years in Node.js/TypeScript and web systems). I'm applying for the Web Automation Engineer role because I enjoy engineering predictable behavior at the boundary between HTTP extraction, headless browser execution, and unreliable targets.

In **SmartCrawl** ([GitHub](https://github.com/Emjaay20/Smart-Crawler-II), [live deployment](https://smart-crawler.aetherhost.app)), I focused on making browser automation and outbound networking bounded and recoverable:

- **Playwright lifecycle & crash recovery:** Built a bounded browser scheduler with isolated Playwright contexts, queue backpressure, and automatic browser replacement. Added a real Chromium test that verifies `localStorage` isolation across concurrent contexts, injects a browser crash over CDP (`Browser.crash`), and proves subsequent renders launch a healthy replacement cleanly.
- **Network & protocol controls:** Implemented DNS-resolved public IP validation with pinned sockets (`lookup` override), per-hop redirect verification, local TLS certificate-verified `Secure` cookie tests, and `SIGKILL`-resilient SQLite WAL crawl checkpoints.

My strongest evidence today is browser lifecycle management, context isolation, and crawler resilience rather than operating a massive browser fleet or commercial anti-bot evasion, and I'm eager to go deeper on those problems during a work trial. I'm based in Abuja, Nigeria and open to Toronto/SF relocation pathways.

## Tailored CV section (ready to paste into `Yusuf_Abubakar_Saka_CV`)

### Summary
Software Engineer (M.Eng. Computer Engineering — Software Engineering, CGPA 4.9/5.0) with 5+ years of experience building full-stack TypeScript, Node.js, React/Next.js, and Go web platforms, extraction pipelines, and container deployment infrastructure. Experienced in HTTP-first web scraping, headless browser lifecycle management (Playwright), outbound network security (SSRF/DNS pinning), and durable SQLite/PostgreSQL job systems.

### Selected Engineering Projects

**SmartCrawl — Web Extraction API, SDK & Crawler Runtime** | *TypeScript, Node.js, Playwright, SQLite (WAL), React, Docker*  
Live: `https://smart-crawler.aetherhost.app` | Repo: `https://github.com/Emjaay20/Smart-Crawler-II`
- Engineered an HTTP-first web extraction API and TypeScript SDK converting arbitrary URLs into clean Markdown and structured JSON via Mozilla Readability with bounded Playwright fallback.
- Hardened outbound fetching against SSRF and DNS rebinding by validating resolved IPv4/IPv6 addresses, pinning direct HTTP/HTTPS sockets, re-validating every redirect hop, and isolating guest jobs via `HttpOnly`/`Secure` session cookies.
- Implemented a deterministic breadth-first crawl scheduler (concurrency 1–4) with per-origin pacing, versioned SQLite WAL checkpoints, idempotent administrator resume after worker `SIGKILL`, and online `VACUUM INTO` database backups.
- Built a 146-test automated Vitest suite plus opt-in real-Chromium CDP crash-injection recovery, local HTTPS cookie verification, and zero-vulnerability lockfiles across backend and UI.

**AetherHost — Multi-Tenant Container Deployment Platform** | *Go, TypeScript, Next.js, Docker Compose, Traefik, PostgreSQL, Redis*  
Repo & Platform: `https://aetherhost.app`
- Built a self-hosted PaaS control plane and Go provisioning agent (`agent-go`) that builds, deploys, and monitors containerized GitHub and Docker workloads behind Traefik v3 Let's Encrypt TLS ingress with automated readiness probing and rollback diagnostics.

**Secure Remote Patient Monitoring System (M.Eng. Thesis)** | *React, Node.js, IoT (MAX30100/DHT11), Python (LSTM/Regression), Ethereum*  
Live: `https://project-3-frontend-urxv.vercel.app/`
- Integrated real-time IoT physiological telemetry with predictive ML models and smart-contract auditability on an interactive clinical dashboard.

## Demo outline for interviews

1. Run a live scrape and inspect health/readiness on `https://smart-crawler.aetherhost.app`.
2. Show SDK deadline enforcement (`SmartCrawlTimeoutError`) and redirect refusal in `src/sdk.ts`.
3. Run `npm run test:browser` locally to demonstrate real Chromium context isolation and CDP `Browser.crash` recovery.
4. Run `tests/crawl-checkpoint.test.ts` to show `SIGKILL` worker interruption and resume from the last committed SQLite WAL batch.
5. Run `npm run db:backup` and show online `VACUUM INTO` backup and integrity check.
