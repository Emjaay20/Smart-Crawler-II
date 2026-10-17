import type { ErrorCode } from './errors.js';
import type { MetricsSnapshot } from './metrics.js';

export interface FailureAlertContext {
  jobId: string;
  url: string;
  errorCode: ErrorCode;
  errorMessage: string;
  snapshot: MetricsSnapshot;
}

export interface OperationalReport {
  generatedAt: string;
  status: 'healthy' | 'degraded' | 'critical';
  summary: string;
  metrics: MetricsSnapshot;
}

export interface SlackReporterOptions {
  webhookUrl?: string;
  failureThreshold?: number;
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class SlackReporter {
  private readonly webhookUrl?: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private lastAlertAt = 0;

  constructor(options: SlackReporterOptions = {}) {
    this.webhookUrl = options.webhookUrl?.trim() || process.env.SMARTCRAWL_SLACK_WEBHOOK_URL?.trim() || undefined;
    const envThreshold = Number(process.env.SMARTCRAWL_ALERT_FAILURE_THRESHOLD);
    this.failureThreshold = Math.max(
      1,
      options.failureThreshold ?? (Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : 3),
    );
    const envCooldown = Number(process.env.SMARTCRAWL_ALERT_COOLDOWN_MS);
    this.cooldownMs = Math.max(
      0,
      options.cooldownMs ?? (Number.isFinite(envCooldown) && envCooldown >= 0 ? envCooldown : 300_000),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  buildOperationalReport(snapshot: MetricsSnapshot): OperationalReport {
    const total = snapshot.scrapeCompleted + snapshot.scrapeFailed;
    const successRatePct = total > 0 ? Math.round((snapshot.scrapeCompleted / total) * 100) : 100;
    const status: OperationalReport['status'] =
      snapshot.consecutiveFailures >= this.failureThreshold
        ? 'critical'
        : snapshot.errorRate > 0.25 && total >= 4
          ? 'degraded'
          : 'healthy';

    const topErrors = Object.entries(snapshot.errorsByCode)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code}:${count}`)
      .join(', ') || 'none';

    const summary = [
      `*[SmartCrawl Operational Digest]* status=\`${status.toUpperCase()}\``,
      `• *Jobs:* ${snapshot.scrapeCompleted} ok / ${snapshot.scrapeFailed} failed (${successRatePct}% success)`,
      `• *Engines:* HTTP=${snapshot.engineHttp} | Playwright=${snapshot.enginePlaywright}`,
      `• *Latency:* avg=${snapshot.durationAvgMs}ms | p95=${snapshot.durationP95Ms}ms`,
      `• *Discovery:* map_links=${snapshot.mapLinks} | crawl_pages=${snapshot.crawlPages}`,
      `• *Workers:* active=${snapshot.activeWorkers} | queued=${snapshot.queueDepth}`,
      `• *Errors by code:* ${topErrors}`,
    ].join('\n');

    return {
      generatedAt: new Date(this.now()).toISOString(),
      status,
      summary,
      metrics: snapshot,
    };
  }

  async sendOperationalReport(
    snapshot: MetricsSnapshot,
    overrideWebhookUrl?: string,
  ): Promise<{ sent: boolean; report: OperationalReport }> {
    const report = this.buildOperationalReport(snapshot);
    const targetUrl = overrideWebhookUrl?.trim() || this.webhookUrl;
    if (!targetUrl) {
      return { sent: false, report };
    }
    const sent = await this.postSlack(targetUrl, {
      text: report.summary,
    });
    return { sent, report };
  }

  async notifyFailureIfThresholdMet(ctx: FailureAlertContext): Promise<boolean> {
    if (!this.webhookUrl) return false;
    if (ctx.snapshot.consecutiveFailures < this.failureThreshold) return false;

    const currentTime = this.now();
    if (this.lastAlertAt > 0 && currentTime - this.lastAlertAt < this.cooldownMs) {
      return false;
    }

    this.lastAlertAt = currentTime;
    const text = [
      `:rotating_light: *[SmartCrawl Alert]* ${ctx.snapshot.consecutiveFailures} consecutive job failures`,
      `• *Last Job:* \`${ctx.jobId}\` (${ctx.url})`,
      `• *Error:* \`${ctx.errorCode}\` — ${ctx.errorMessage}`,
      `• *Error Rate:* ${Math.round(ctx.snapshot.errorRate * 100)}% (${ctx.snapshot.scrapeFailed} failed / ${ctx.snapshot.scrapeCompleted} ok)`,
      `• *Latency p95:* ${ctx.snapshot.durationP95Ms}ms | *Queue depth:* ${ctx.snapshot.queueDepth}`,
    ].join('\n');

    return this.postSlack(this.webhookUrl, { text });
  }

  private async postSlack(url: string, payload: { text: string }): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
