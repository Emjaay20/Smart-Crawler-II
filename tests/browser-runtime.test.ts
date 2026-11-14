import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playwrightMock = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: playwrightMock.launch } }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeBrowser(onGoto: (url: string) => Promise<void> = async () => undefined) {
  let connected = true;
  const close = vi.fn(async () => { connected = false; });
  const contextClose = vi.fn(async () => undefined);
  const newContext = vi.fn(async () => ({
    newPage: async () => {
      let currentUrl = '';
      return {
        route: async () => undefined,
        goto: async (url: string) => {
          currentUrl = url;
          await onGoto(url);
          return { status: () => 200 };
        },
        waitForLoadState: async () => undefined,
        evaluate: async () => undefined,
        content: async () => '<html><body><h1>Rendered</h1></body></html>',
        url: () => currentUrl,
      };
    },
    close: contextClose,
  }));
  return { isConnected: () => connected, close, newContext, contextClose };
}

const request = {
  userAgent: 'SmartCrawl-Browser-Test/1.0',
  timeoutMs: 1000,
} as never;

describe('Playwright browser lifecycle and resource isolation', () => {
  let closeRuntime: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('SMARTCRAWL_BROWSER_EGRESS_ISOLATED', 'true');
    vi.stubEnv('SMARTCRAWL_BROWSER_CONCURRENCY', '2');
    vi.stubEnv('SMARTCRAWL_BROWSER_MAX_PENDING', '1');
    playwrightMock.launch.mockReset();
    closeRuntime = undefined;
  });

  afterEach(async () => {
    await closeRuntime?.();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shares one Chromium launch while rendering in independent contexts', async () => {
    const instance = fakeBrowser();
    playwrightMock.launch.mockResolvedValue(instance);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    const results = await Promise.all([
      runtime.renderWithPlaywright('https://example.com/one', request),
      runtime.renderWithPlaywright('https://example.com/two', request),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.finalUrl).toBe('https://example.com/one');
    expect(results[1]?.finalUrl).toBe('https://example.com/two');
    expect(playwrightMock.launch).toHaveBeenCalledTimes(1);
    expect(instance.newContext).toHaveBeenCalledTimes(2);
    expect(instance.contextClose).toHaveBeenCalledTimes(2);
    await runtime.closeBrowser();
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it('retires failed browser instances and recovers on the next task', async () => {
    const crashed = fakeBrowser(async () => { throw new Error('Browser process exited'); });
    const recovered = fakeBrowser();
    playwrightMock.launch.mockResolvedValueOnce(crashed).mockResolvedValueOnce(recovered);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    await expect(runtime.renderWithPlaywright('https://example.com/crash', request))
      .rejects.toThrow('Browser process exited');
    const next = await runtime.renderWithPlaywright('https://example.com/recovered', request);
    expect(next.finalUrl).toBe('https://example.com/recovered');
    expect(playwrightMock.launch).toHaveBeenCalledTimes(2);
    expect(crashed.close).toHaveBeenCalledTimes(1);
    await runtime.closeBrowser();
    expect(recovered.close).toHaveBeenCalledTimes(1);
  });

  it('retries a failed Chromium launch instead of keeping a rejected startup promise', async () => {
    const healthy = fakeBrowser();
    playwrightMock.launch.mockRejectedValueOnce(new Error('Browser startup failed'))
      .mockResolvedValueOnce(healthy);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    await expect(runtime.renderWithPlaywright('https://example.com/first', request))
      .rejects.toThrow('Browser startup failed');
    expect((await runtime.renderWithPlaywright('https://example.com/second', request)).finalUrl)
      .toBe('https://example.com/second');
    expect(playwrightMock.launch).toHaveBeenCalledTimes(2);
  });

  it('does not close a retired browser while a sibling context is still working', async () => {
    const bothStarted = deferred();
    const finishSlowTask = deferred();
    let started = 0;
    const instance = fakeBrowser(async (url) => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await bothStarted.promise;
      if (url.endsWith('/fail')) throw new Error('A context failed');
      await finishSlowTask.promise;
    });
    playwrightMock.launch.mockResolvedValue(instance);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    const failing = runtime.renderWithPlaywright('https://example.com/fail', request);
    const succeeding = runtime.renderWithPlaywright('https://example.com/slow', request);
    await bothStarted.promise;
    await expect(failing).rejects.toThrow('A context failed');
    expect(instance.close).not.toHaveBeenCalled();
    finishSlowTask.resolve();
    expect((await succeeding).finalUrl).toBe('https://example.com/slow');
    expect(instance.close).toHaveBeenCalledTimes(1);
    expect(playwrightMock.launch).toHaveBeenCalledTimes(1);
  });

  it('rejects excess queued requests and keeps other render tasks alive', async () => {
    vi.stubEnv('SMARTCRAWL_BROWSER_CONCURRENCY', '1');
    const gate = deferred();
    const instance = fakeBrowser(async () => gate.promise);
    playwrightMock.launch.mockResolvedValue(instance);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    const first = runtime.renderWithPlaywright('https://example.com/one', request);
    const second = runtime.renderWithPlaywright('https://example.com/two', request);
    expect(runtime.browserPoolSnapshot()).toMatchObject({ active: 1, queued: 1 });
    await expect(runtime.renderWithPlaywright('https://example.com/three', request))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    gate.resolve();
    expect((await first).finalUrl).toBe('https://example.com/one');
    expect((await second).finalUrl).toBe('https://example.com/two');
    expect(playwrightMock.launch).toHaveBeenCalledTimes(1);
  });

  it('waits for in-flight tasks to finish before closing Chromium', async () => {
    vi.stubEnv('SMARTCRAWL_BROWSER_CONCURRENCY', '1');
    const gate = deferred();
    const instance = fakeBrowser(async () => gate.promise);
    playwrightMock.launch.mockResolvedValue(instance);
    const runtime = await import('../src/browser.js');
    closeRuntime = runtime.closeBrowser;

    const task = runtime.renderWithPlaywright('https://example.com/task', request);
    const closing = runtime.closeBrowser();
    await expect(runtime.renderWithPlaywright('https://example.com/late', request))
      .rejects.toThrow('shutting down');
    expect(instance.close).not.toHaveBeenCalled();
    gate.resolve();
    await task;
    await closing;
    expect(instance.close).toHaveBeenCalledTimes(1);
    expect(runtime.browserPoolSnapshot()).toMatchObject({ active: 0, queued: 0, stopping: true });
  });
});
