export interface SchedulerSnapshot {
  active: number;
  queued: number;
  concurrency: number;
  maxPending: number;
  stopping: boolean;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function browserSchedulerLimits(env: NodeJS.ProcessEnv = process.env): {
  concurrency: number;
  maxPending: number;
} {
  return {
    concurrency: boundedInteger(env.SMARTCRAWL_BROWSER_CONCURRENCY, 1, 1, 4),
    maxPending: boundedInteger(env.SMARTCRAWL_BROWSER_MAX_PENDING, 24, 1, 128),
  };
}

/**
 * Bounded in-process task scheduler. No task executes more than once and
 * individual failures do not strand subsequent requests. This is not a
 * distributed queue and its pending jobs are not durable across restarts.
 */
export class BoundedTaskScheduler {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  private stopping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    readonly concurrency: number,
    readonly maxPending: number,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
        !Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new RangeError('Scheduler limits must be positive integers');
    }
  }

  snapshot(): SchedulerSnapshot {
    return {
      active: this.active,
      queued: this.pending.length,
      concurrency: this.concurrency,
      maxPending: this.maxPending,
      stopping: this.stopping,
    };
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Browser scheduler is shutting down'));
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('Browser scheduling capacity exceeded'));
    }

    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          this.active -= 1;
          const next = this.pending.shift();
          if (next) next();
          this.notifyIdle();
        });
      };

      if (this.active < this.concurrency) start();
      else this.pending.push(start);
    });
  }

  async drain(): Promise<void> {
    this.stopping = true;
    if (this.active === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.active !== 0 || this.pending.length !== 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const done of waiters) done();
  }
}
