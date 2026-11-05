export interface CircuitState {
  failures: number;
  openUntil: number;
  lastCode?: string;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export class DomainCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(1000, options.cooldownMs ?? 60_000);
    this.now = options.now ?? (() => Date.now());
  }

  isOpen(origin: string): { open: boolean; remainingMs: number } {
    const key = normalizeOrigin(origin);
    const state = this.states.get(key);
    if (!state) return { open: false, remainingMs: 0 };

    const current = this.now();
    if (state.openUntil > current) {
      return { open: true, remainingMs: state.openUntil - current };
    }
    return { open: false, remainingMs: 0 };
  }

  isBroken(origin: string): boolean {
    return this.isOpen(origin).open;
  }

  getState(origin: string): { status: 'closed' | 'open' | 'half-open'; consecutiveFailures: number; openUntil: number } {
    const key = normalizeOrigin(origin);
    const state = this.states.get(key);
    if (!state) return { status: 'closed', consecutiveFailures: 0, openUntil: 0 };

    const current = this.now();
    if (state.openUntil > current) {
      return { status: 'open', consecutiveFailures: state.failures, openUntil: state.openUntil };
    }
    if (state.openUntil > 0) {
      return { status: 'half-open', consecutiveFailures: state.failures, openUntil: 0 };
    }
    return { status: 'closed', consecutiveFailures: state.failures, openUntil: 0 };
  }

  recordSuccess(origin: string): void {
    const key = normalizeOrigin(origin);
    this.states.delete(key);
  }

  recordFailure(origin: string, code = 'unknown'): { tripped: boolean } {
    const key = normalizeOrigin(origin);
    const current = this.now();
    const existing = this.states.get(key) ?? { failures: 0, openUntil: 0 };

    existing.failures += 1;
    existing.lastCode = code;

    if (existing.failures >= this.threshold) {
      existing.openUntil = current + this.cooldownMs;
      this.states.set(key, existing);
      return { tripped: true };
    }

    this.states.set(key, existing);
    return { tripped: false };
  }

  reset(origin?: string): void {
    if (origin) {
      this.states.delete(normalizeOrigin(origin));
    } else {
      this.states.clear();
    }
  }
}

export interface PolitenessLimiterOptions {
  defaultDelayMs?: number;
  jitterFactor?: number;
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class DomainPolitenessLimiter {
  private readonly lastAccess = new Map<string, number>();
  private readonly defaultDelayMs: number;
  private readonly jitterFactor: number;
  private readonly jitterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(optionsOrNow?: PolitenessLimiterOptions | (() => number)) {
    if (typeof optionsOrNow === 'function') {
      this.defaultDelayMs = 250;
      this.jitterFactor = 0;
      this.jitterMs = 100;
      this.sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      this.now = optionsOrNow;
    } else {
      const opts = optionsOrNow ?? {};
      this.defaultDelayMs = opts.defaultDelayMs ?? 250;
      this.jitterFactor = opts.jitterFactor ?? 0;
      this.jitterMs = opts.jitterMs ?? 100;
      this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      this.now = opts.now ?? (() => Date.now());
    }
  }

  async acquire(origin: string, minDelayMs?: number, jitterMs?: number): Promise<number> {
    const key = normalizeOrigin(origin);
    const current = this.now();
    const previous = this.lastAccess.get(key) ?? 0;

    const baseDelay = minDelayMs ?? this.defaultDelayMs;
    const computedJitter = this.jitterFactor > 0
      ? Math.floor((Math.random() * 2 - 1) * this.jitterFactor * baseDelay)
      : Math.floor(Math.random() * Math.max(0, jitterMs ?? this.jitterMs));

    const targetInterval = Math.max(0, baseDelay + computedJitter);
    const elapsed = current - previous;

    let waitTime = 0;
    if (elapsed < targetInterval && previous > 0) {
      waitTime = targetInterval - elapsed;
      await this.sleep(waitTime);
    }

    this.lastAccess.set(key, this.now());
    return waitTime;
  }

  async wait(origin: string, explicitDelayMs?: number): Promise<number> {
    return this.acquire(origin, explicitDelayMs);
  }

  clear(): void {
    this.lastAccess.clear();
  }
}

function normalizeOrigin(urlOrOrigin: string): string {
  try {
    return new URL(urlOrOrigin).origin.toLowerCase();
  } catch {
    return urlOrOrigin.trim().toLowerCase();
  }
}
