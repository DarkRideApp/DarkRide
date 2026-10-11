import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBurstLog, onceEvery } from './throttle';

describe('onceEvery', () => {
  it('runs the first call and drops calls inside the interval', () => {
    let clock = 1000;
    const fn = vi.fn();
    const throttled = onceEvery(30_000, fn, () => clock);
    throttled('a');
    clock += 29_999;
    throttled('b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('runs again once the interval has passed', () => {
    let clock = 0;
    const fn = vi.fn();
    const throttled = onceEvery(1000, fn, () => clock);
    throttled(1);
    clock = 1000;
    throttled(2);
    expect(fn.mock.calls).toEqual([[1], [2]]);
  });

  it('runs the very first call even when the clock starts at zero', () => {
    const fn = vi.fn();
    onceEvery(1000, fn, () => 0)();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createBurstLog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the first event of an interval at once, in full', () => {
    const emit = vi.fn();
    createBurstLog(1000, 'probe', emit).log('first detail');
    expect(emit.mock.calls).toEqual([['first detail']]);
  });

  it('counts the rest of the interval and emits one summary line when it ends', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    for (let i = 0; i < 50; i++) burst.log(`event ${i}`);
    expect(emit.mock.calls).toEqual([['event 0']]);
    vi.advanceTimersByTime(999);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls).toEqual([['event 0'], ['49 more probe events suppressed']]);
  });

  it('says nothing more when nothing was suppressed, and the next event after the interval is emitted at once', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    vi.advanceTimersByTime(1000);
    expect(emit.mock.calls).toEqual([['a']]);
    burst.log('b');
    expect(emit.mock.calls).toEqual([['a'], ['b']]);
  });

  it('counts, without logging, in the interval after a hot one, and makes that interval twice as long', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    vi.advanceTimersByTime(1000);
    expect(emit.mock.calls).toEqual([['a'], ['1 more probe events suppressed']]);
    burst.log('c');
    burst.log('d');
    burst.log('e');
    vi.advanceTimersByTime(1999);
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls).toEqual([['a'], ['1 more probe events suppressed'], ['3 more probe events suppressed']]);
  });

  it('doubles the interval while events keep coming, up to 60 times the base, with an exact count in each summary', () => {
    const lines: string[] = [];
    const stamps: number[] = [];
    const burst = createBurstLog(1000, 'probe', (line) => {
      lines.push(line);
      stamps.push(Date.now());
    });
    const start = Date.now();
    let events = 0;
    for (let elapsed = 0; elapsed < 300_000; elapsed += 10) {
      burst.log(`event ${events}`);
      events++;
      vi.advanceTimersByTime(10);
    }

    expect(lines[0]).toBe('event 0');
    expect(stamps.slice(1).map((stamp) => stamp - start)).toEqual([1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000, 243000]);
    burst.stop();
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(vi.getTimerCount()).toBe(0);
    const counted = lines.slice(1).reduce((sum, line) => sum + Number(line.split(' ')[0]), 0);
    expect(1 + counted).toBe(events);
    expect(events).toBe(30_000);
  });

  it('goes back to the base interval after an interval with no events at all', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    vi.advanceTimersByTime(1000);
    burst.log('c');
    vi.advanceTimersByTime(2000);
    expect(emit.mock.calls).toEqual([['a'], ['1 more probe events suppressed'], ['1 more probe events suppressed']]);
    vi.advanceTimersByTime(4000);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    burst.log('x');
    burst.log('y');
    expect(emit).toHaveBeenLastCalledWith('x');
    vi.advanceTimersByTime(999);
    expect(emit).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenLastCalledWith('1 more probe events suppressed');
    expect(emit).toHaveBeenCalledTimes(5);
  });

  it('stop() during a longer interval flushes its count and clears the timer', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    vi.advanceTimersByTime(1000);
    burst.log('c');
    burst.log('d');
    burst.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(emit.mock.calls).toEqual([['a'], ['1 more probe events suppressed'], ['2 more probe events suppressed']]);
    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('keeps no timer while idle', () => {
    const burst = createBurstLog(1000, 'probe', vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    burst.log('a');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() clears the timer and emits the pending summary once', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    burst.log('c');
    burst.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(emit.mock.calls).toEqual([['a'], ['2 more probe events suppressed']]);
    burst.stop();
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('stop() with nothing suppressed emits nothing', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.stop();
    expect(emit.mock.calls).toEqual([['a']]);
  });

  it('emits directly and starts no timer after stop()', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.stop();
    burst.log('late');
    burst.log('later');
    expect(emit.mock.calls).toEqual([['late'], ['later']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an emit that throws escape from the timer', () => {
    const emit = vi.fn((line: string) => {
      if (line.includes('suppressed')) throw new Error('subscriber failed');
    });
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    burst.log('c');
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    vi.advanceTimersByTime(4000);
    burst.log('d');
    expect(emit).toHaveBeenLastCalledWith('d');
  });
});
