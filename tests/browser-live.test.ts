import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { expect, it, vi } from 'vitest';

// Opt in explicitly: only synthetic loopback fixtures are opened in this suite.
it.skipIf(process.env.SMARTCRAWL_TEST_REAL_BROWSER !== 'true')('isolates real Chromium contexts and recovers after a process crash', async () => {
  let markStalled!: () => void;
  const stalled = new Promise<void>((resolve) => { markStalled = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/stall') { markStalled(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><h1>Fixture</h1><script>' +
      'document.body.dataset.previous = localStorage.getItem("seen") || "empty";' +
      'localStorage.setItem("seen", "yes");</script></body></html>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const originalLaunch = chromium.launch.bind(chromium);
  const browsers: Browser[] = [];
  const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
    const instance = await originalLaunch(options);
    browsers.push(instance);
    return instance;
  });
  vi.stubEnv('SMARTCRAWL_BROWSER_EGRESS_ISOLATED', 'true');
  vi.stubEnv('SMARTCRAWL_BROWSER_CONCURRENCY', '2');
  const runtime = await import('../src/browser.js');
  const request = { userAgent: 'SmartCrawl-Controlled-Fixture', timeoutMs: 3000 } as never;
  try {
    const pages = await Promise.all([1, 2].map(() => runtime.renderWithPlaywright(url, request)));
    for (const page of pages) expect(page.html).toContain('data-previous="empty"');
    expect(browsers).toHaveLength(1);
    const pending = runtime.renderWithPlaywright(url + '/stall', request);
    const rejected = expect(pending).rejects.toThrow();
    await stalled;
    const session = await browsers[0]!.newBrowserCDPSession();
    await session.send('Browser.crash').catch(() => undefined);
    await rejected;
    const recovered = await runtime.renderWithPlaywright(url, request);
    expect(recovered.statusCode).toBe(200);
    expect(browsers).toHaveLength(2);
    expect(runtime.browserPoolSnapshot().active).toBe(0);
  } finally {
    await runtime.closeBrowser();
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
    spy.mockRestore();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30000);
