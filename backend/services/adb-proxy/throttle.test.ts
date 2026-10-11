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

  it('starts a fresh count after a summary', () => {
    const emit = vi.fn();
    const burst = createBurstLog(1000, 'probe', emit);
    burst.log('a');
    burst.log('b');
    vi.advanceTimersByTime(1000);
    burst.log('c');
    burst.log('d');
    burst.log('e');
    vi.advanceTimersByTime(1000);
    expect(emit.mock.calls).toEqual([['a'], ['1 more probe events suppressed'], ['c'], ['2 more probe events suppressed']]);
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
    expect(emit).toHaveBeenLastCalledWith('c');
  });
});
