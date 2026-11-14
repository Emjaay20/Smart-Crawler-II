import { describe, expect, it } from 'vitest';
import { shouldRecycleBrowser, renderWithPlaywright } from '../src/browser.js';

describe('shouldRecycleBrowser', () => {
  it('recycles after max pages or any failure', () => {
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 19, failed: false, maxPages: 20 })).toBe(false);
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 20, failed: false, maxPages: 20 })).toBe(true);
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 1, failed: true, maxPages: 20 })).toBe(true);
  });
  it('refuses browser navigation without network-isolated egress', async () => {
    const previous = process.env.SMARTCRAWL_BROWSER_EGRESS_ISOLATED;
    delete process.env.SMARTCRAWL_BROWSER_EGRESS_ISOLATED;
    try {
      await expect(renderWithPlaywright('https://example.com', {} as never))
        .rejects.toMatchObject({ code: 'provider_unavailable' });
    } finally {
      if (previous === undefined) delete process.env.SMARTCRAWL_BROWSER_EGRESS_ISOLATED;
      else process.env.SMARTCRAWL_BROWSER_EGRESS_ISOLATED = previous;
    }
  });

});
