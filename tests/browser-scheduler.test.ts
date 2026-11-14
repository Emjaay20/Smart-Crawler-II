import { describe, expect, it } from 'vitest';
import { BoundedTaskScheduler, browserSchedulerLimits } from '../src/browser-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('bounded browser task scheduling', () => {
  it('bounds concurrency and pending queue without dropping accepted jobs', async () => {
    const gate = deferred<void>();
    const scheduler = new BoundedTaskScheduler(2, 1);
    let active = 0;
    let peak = 0;
    const work = async (number: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return number;
    };

    const first = scheduler.run(() => work(1));
    const second = scheduler.run(() => work(2));
    const third = scheduler.run(() => work(3));
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 1 });
    await expect(scheduler.run(() => work(4)))
      .rejects.toThrow('Browser scheduling capacity exceeded');

    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(peak).toBe(2);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('continues after a task throws and does not leak queue capacity', async () => {
    const scheduler = new BoundedTaskScheduler(1, 1);
    const failed = scheduler.run(async (): Promise<string> => { throw new Error('browser crashed'); });
    const good = scheduler.run(async () => 'recovered');
    await expect(failed).rejects.toThrow('browser crashed');
    await expect(good).resolves.toBe('recovered');
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('drains work before shutting down and rejects newly scheduled requests', async () => {
    const scheduler = new BoundedTaskScheduler(1, 2);
    const gate = deferred<void>();
    const first = scheduler.run(() => gate.promise);
    const second = scheduler.run(async () => 'queued');
    const drained = scheduler.drain();
    expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 1, stopping: true });
    await expect(scheduler.run(async () => 'not accepted'))
      .rejects.toThrow('shutting down');
    gate.resolve();
    await first;
    await expect(second).resolves.toBe('queued');
    await drained;
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, stopping: true });
  });

  it('clamps invalid and excessive environment values', () => {
    expect(browserSchedulerLimits({})).toEqual({ concurrency: 1, maxPending: 24 });
    expect(browserSchedulerLimits({
      SMARTCRAWL_BROWSER_CONCURRENCY: '100',
      SMARTCRAWL_BROWSER_MAX_PENDING: '10000',
    })).toEqual({ concurrency: 4, maxPending: 128 });
    expect(browserSchedulerLimits({
      SMARTCRAWL_BROWSER_CONCURRENCY: 'abc',
      SMARTCRAWL_BROWSER_MAX_PENDING: '-3',
    })).toEqual({ concurrency: 1, maxPending: 24 });
    expect(() => new BoundedTaskScheduler(0, 2)).toThrow(RangeError);
  });
});
