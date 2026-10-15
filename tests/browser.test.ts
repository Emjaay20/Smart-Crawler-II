import { describe, expect, it } from 'vitest';
import { shouldRecycleBrowser } from '../src/browser.js';

describe('shouldRecycleBrowser', () => {
  it('recycles after max pages or any failure', () => {
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 19, failed: false, maxPages: 20 })).toBe(false);
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 20, failed: false, maxPages: 20 })).toBe(true);
    expect(shouldRecycleBrowser({ pagesSinceLaunch: 1, failed: true, maxPages: 20 })).toBe(true);
  });
});
