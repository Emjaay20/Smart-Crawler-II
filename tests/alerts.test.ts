import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SlackReporter } from '../src/alerts.js';
import { createApp } from '../src/app.js';
import { ScrapeError } from '../src/errors.js';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';
import { Metrics } from '../src/metrics.js';

describe('SlackReporter & operational alerting', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length) {
      await closers.pop()!();
    }
  });

  it('fires Slack alert when consecutive failures hit threshold and respects cooldown', async () => {
    const sentPayloads: Array<{ url: string; text: string }> = [];
    let currentClock = 1_000_000;

    const reporter = new SlackReporter({
      webhookUrl: 'https://hooks.slack.test/services/T00/B00/X00',
      failureThreshold: 2,
      cooldownMs: 60_000,
      now: () => currentClock,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
        sentPayloads.push({ url: String(url), text: body.text });
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });

    const metrics = new Metrics();

    // 1st failure: below threshold (threshold = 2)
    metrics.recordScrape({ ok: false, durationMs: 120, errorCode: 'timeout' });
    const first = await reporter.notifyFailureIfThresholdMet({
      jobId: 'job-1',
      url: 'https://example.com/slow',
      errorCode: 'timeout',
      errorMessage: 'Request timed out',
      snapshot: metrics.snapshot(),
    });
    expect(first).toBe(false);
    expect(sentPayloads).toHaveLength(0);

    // 2nd failure: reaches threshold -> posts Slack alert
    metrics.recordScrape({ ok: false, durationMs: 140, errorCode: 'http_5xx' });
    const second = await reporter.notifyFailureIfThresholdMet({
      jobId: 'job-2',
      url: 'https://example.com/down',
      errorCode: 'http_5xx',
      errorMessage: 'Upstream 503',
      snapshot: metrics.snapshot(),
    });
    expect(second).toBe(true);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.text).toContain('2 consecutive job failures');
    expect(sentPayloads[0]?.text).toContain('http_5xx');

    // 3rd failure 10s later: suppressed by 60s cooldown
    currentClock += 10_000;
    metrics.recordScrape({ ok: false, durationMs: 150, errorCode: 'http_5xx' });
    const third = await reporter.notifyFailureIfThresholdMet({
      jobId: 'job-3',
      url: 'https://example.com/down',
      errorCode: 'http_5xx',
      errorMessage: 'Upstream 503',
      snapshot: metrics.snapshot(),
    });
    expect(third).toBe(false);
    expect(sentPayloads).toHaveLength(1);

    // 4th failure after cooldown expires -> posts again
    currentClock += 60_000;
    metrics.recordScrape({ ok: false, durationMs: 160, errorCode: 'http_5xx' });
    const fourth = await reporter.notifyFailureIfThresholdMet({
      jobId: 'job-4',
      url: 'https://example.com/down',
      errorCode: 'http_5xx',
      errorMessage: 'Upstream 503',
      snapshot: metrics.snapshot(),
    });
    expect(fourth).toBe(true);
    expect(sentPayloads).toHaveLength(2);
  });

  it('exposes GET /v1/report and dispatches Slack digest via POST /v1/admin/report', async () => {
    const slackMessages: string[] = [];
    const store = new JobStore(':memory:');
    const keys = new KeyStore(store.db);
    const metrics = new Metrics();
    const alerts = new SlackReporter({
      webhookUrl: 'https://hooks.slack.test/services/T11/B11/X11',
      failureThreshold: 2,
      cooldownMs: 0,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { text: string };
        slackMessages.push(parsed.text);
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });

    const app = createApp({
      store,
      keys,
      adminToken: 'admin-secret',
      metrics,
      alerts,
      scrape: async () => {
        throw new ScrapeError('timeout', 'Timed out after 15000ms');
      },
    });

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            store.close();
            resolve();
          });
        }),
    );

    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const userKey = keys.createKey('ops-user', 20).key;

    // Trigger 2 failing jobs to trip the threshold alert
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/v1/scrape`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com/fail' }),
      });
      const { jobId } = (await res.json()) as { jobId: string };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const poll = await fetch(`${base}/v1/jobs/${jobId}`, {
          headers: { authorization: `Bearer ${userKey}` },
        });
        const job = (await poll.json()) as { status: string };
        if (job.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    // Automatic failure alert was sent to Slack
    expect(slackMessages.length).toBeGreaterThanOrEqual(1);
    expect(slackMessages[0]).toContain('[SmartCrawl Alert]');

    // Inspect GET /v1/report
    const reportRes = await fetch(`${base}/v1/report`, {
      headers: { authorization: `Bearer ${userKey}` },
    });
    expect(reportRes.status).toBe(200);
    const reportBody = (await reportRes.json()) as { status: string; metrics: { errorsByCode: Record<string, number> } };
    expect(reportBody.status).toBe('critical');
    expect(reportBody.metrics.errorsByCode.timeout).toBe(2);

    // Trigger POST /v1/admin/report
    const adminRes = await fetch(`${base}/v1/admin/report`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(adminRes.status).toBe(200);
    const adminReport = (await adminRes.json()) as { sent: boolean; report: { summary: string } };
    expect(adminReport.sent).toBe(true);
    expect(adminReport.report.summary).toContain('[SmartCrawl Operational Digest]');
  });
});
