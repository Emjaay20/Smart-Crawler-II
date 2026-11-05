import { describe, expect, it } from 'vitest';
import { DomainCircuitBreaker, DomainPolitenessLimiter } from '../src/circuit.js';

describe('DomainCircuitBreaker', () => {
  it('opens circuit after threshold failures and recovers after cooldown', () => {
    let now = 1000;
    const breaker = new DomainCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 5000,
      now: () => now,
    });

    const url = 'https://bot-blocked.domain.org/feed';

    expect(breaker.isBroken(url)).toBe(false);

    breaker.recordFailure(url);
    expect(breaker.isBroken(url)).toBe(false);
    expect(breaker.getState(url)?.consecutiveFailures).toBe(1);

    breaker.recordFailure(url);
    expect(breaker.isBroken(url)).toBe(false);

    // 3rd failure trips the breaker
    breaker.recordFailure(url);
    expect(breaker.isBroken(url)).toBe(true);
    expect(breaker.isOpen(url).remainingMs).toBe(5000);
    expect(breaker.getState(url)?.status).toBe('open');

    // Different domain is NOT affected (per-domain isolation)
    expect(breaker.isBroken('https://other.domain.org/feed')).toBe(false);

    // Still open before cooldown expires
    now += 4000;
    expect(breaker.isBroken(url)).toBe(true);

    // Cooldown elapsed -> half-open probe allowed
    now += 2000; // now = 7000 (> 1000 + 5000)
    expect(breaker.isBroken(url)).toBe(false);
    expect(breaker.getState(url)?.status).toBe('half-open');

    // If probe succeeds, breaker transitions back to closed
    breaker.recordSuccess(url);
    expect(breaker.isBroken(url)).toBe(false);
    expect(breaker.getState(url)?.status).toBe('closed');
    expect(breaker.getState(url)?.consecutiveFailures).toBe(0);
  });

  it('resets failure count on intermediate success', () => {
    const breaker = new DomainCircuitBreaker({ failureThreshold: 3, cooldownMs: 10000 });
    const url = 'https://api.example.com/items';

    breaker.recordFailure(url);
    breaker.recordFailure(url);
    expect(breaker.getState(url)?.consecutiveFailures).toBe(2);

    breaker.recordSuccess(url);
    expect(breaker.getState(url)?.consecutiveFailures).toBe(0);
    expect(breaker.isBroken(url)).toBe(false);
  });
});

describe('DomainPolitenessLimiter', () => {
  it('spaces requests to the same origin with jitter and respects delays', async () => {
    let currentTime = 1000;
    const mockSleep = async (ms: number) => {
      currentTime += ms;
    };

    const limiter = new DomainPolitenessLimiter({
      defaultDelayMs: 200,
      jitterFactor: 0.1, // +/- 10%
      sleep: mockSleep,
      now: () => currentTime,
    });

    const url1 = 'https://crawl.example.com/page1';
    const url2 = 'https://crawl.example.com/page2';
    const urlOther = 'https://other-site.com/index';

    // First request has no preceding request, proceeds with minimal or no delay
    const waited1 = await limiter.wait(url1);
    expect(waited1).toBe(0);
    expect(currentTime).toBe(1000);

    // Second request to same origin immediately after must wait roughly 200ms
    const waited2 = await limiter.wait(url2);
    expect(waited2).toBeGreaterThanOrEqual(180);
    expect(waited2).toBeLessThanOrEqual(220);
    expect(currentTime).toBeGreaterThanOrEqual(1180);

    // Request to a different origin does not wait on crawl.example.com
    const waitedOther = await limiter.wait(urlOther);
    expect(waitedOther).toBe(0);

    // Explicit delay override
    const waited3 = await limiter.wait(url1, 500);
    expect(waited3).toBeGreaterThanOrEqual(450);
  });
});
