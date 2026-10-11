import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBudgetLog, onceEvery } from './throttle';

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

describe('createBudgetLog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SUMMARY = / more events suppressed \(/;
  const isSummary = (line: string) => SUMMARY.test(line);
  /** The per-kind counts of a summary line, e.g. "35 more events suppressed (9 b, 8 a)". */
  const countsOf = (line: string) =>
    [...line.slice(line.indexOf('(')).matchAll(/(\d+) ([^,)]+)/g)].map((m) => [m[2], Number(m[1])] as const);

  it('emits events in full, at once, up to the budget', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 3, emit });
    budget.log('a', 'first');
    budget.log('b', 'second');
    budget.log('a', 'third');
    expect(emit.mock.calls).toEqual([['first'], ['second'], ['third']]);
  });

  it('counts events past the budget and ends the window with one summary listing the count per kind', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 2, emit });
    budget.log('a', 'a1');
    budget.log('b', 'b1');
    budget.log('a', 'a2');
    budget.log('b', 'b2');
    budget.log('b', 'b3');
    expect(emit.mock.calls).toEqual([['a1'], ['b1']]);
    vi.advanceTimersByTime(999);
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls).toEqual([['a1'], ['b1'], ['3 more events suppressed (1 a, 2 b)']]);
  });

  it('goes idle after a window: no timer, no summary when nothing was suppressed', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 3, emit });
    expect(vi.getTimerCount()).toBe(0);
    budget.log('a', 'a1');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(emit.mock.calls).toEqual([['a1']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes idle after a summary, and the next event opens a new window with a fresh budget', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 1, emit });
    budget.log('a', 'a1');
    budget.log('a', 'a2');
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    budget.log('a', 'a3');
    budget.log('a', 'a4');
    vi.advanceTimersByTime(1000);
    expect(emit.mock.calls).toEqual([['a1'], ['1 more events suppressed (1 a)'], ['a3'], ['1 more events suppressed (1 a)']]);
  });

  it('logs a single event in full after a quiet gap longer than the window', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 1, emit });
    for (let i = 0; i < 20; i++) budget.log('a', `burst ${i}`);
    vi.advanceTimersByTime(10_000);
    budget.log('a', 'after the gap');
    expect(emit).toHaveBeenLastCalledWith('after the gap');
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('shares one budget across kinds, so interleaved kinds cannot each draw their own', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 5, emit });
    const kinds = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 40; i++) budget.log(kinds[i % 4], `event ${i}`);
    expect(emit.mock.calls.map(([line]) => line)).toEqual(['event 0', 'event 1', 'event 2', 'event 3', 'event 4']);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenLastCalledWith('35 more events suppressed (9 b, 9 c, 9 d, 8 a)');
    expect(emit).toHaveBeenCalledTimes(6);
  });

  it('bounds a peer that sends one event per interval forever: at most maxDetail + 1 lines per window, counts exact', () => {
    const windowMs = 60_000;
    const lines: string[] = [];
    const budget = createBudgetLog({ windowMs, maxDetail: 5, emit: (line) => lines.push(line) });
    const gap = windowMs / 50 + 1;
    const kinds = ['unauthenticated close', 'approval request', 'blocked key', 'approval flood-drop'];
    let events = 0;
    for (let elapsed = 0; elapsed < 10 * windowMs; elapsed += gap) {
      budget.log(kinds[events % kinds.length], `event ${events}`);
      events++;
      vi.advanceTimersByTime(gap);
    }
    budget.stop();

    expect(events).toBeGreaterThan(450);
    expect(lines.length).toBeLessThanOrEqual(70);
    const groups: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
      current.push(line);
      if (isSummary(line)) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length > 0) groups.push(current);
    expect(groups.length).toBeGreaterThanOrEqual(9);
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(6);
    const counted = lines.filter(isSummary).flatMap(countsOf).reduce((sum, [, n]) => sum + n, 0);
    expect(lines.filter((line) => !isSummary(line)).length + counted).toBe(events);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() clears the timer and emits the pending summary once', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 1, emit });
    budget.log('a', 'a1');
    budget.log('a', 'a2');
    budget.log('b', 'b1');
    budget.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(emit.mock.calls).toEqual([['a1'], ['2 more events suppressed (1 a, 1 b)']]);
    budget.stop();
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('stop() with nothing suppressed emits nothing', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 3, emit });
    budget.log('a', 'a1');
    budget.stop();
    expect(emit.mock.calls).toEqual([['a1']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits directly and starts no timer after stop()', () => {
    const emit = vi.fn();
    const budget = createBudgetLog({ windowMs: 1000, maxDetail: 1, emit });
    budget.stop();
    budget.log('a', 'late');
    budget.log('a', 'later');
    expect(emit.mock.calls).toEqual([['late'], ['later']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps counting and closes the window when the detail emit throws, reporting the failure once per window', () => {
    const emitted: string[] = [];
    let failing = true;
    const onError = vi.fn();
    const budget = createBudgetLog({
      windowMs: 1000,
      maxDetail: 2,
      emit: (line) => {
        if (failing) throw new Error('subscriber failed');
        emitted.push(line);
      },
      onError,
    });

    expect(() => {
      for (let i = 0; i < 5; i++) budget.log('a', `event ${i}`);
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    failing = false;
    budget.log('a', 'next window');
    expect(emitted).toEqual(['next window']);
    vi.advanceTimersByTime(1000);

    failing = true;
    budget.log('a', 'failing again');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('survives a summary emit that throws and an error report that throws', () => {
    const emit = vi.fn((line: string) => {
      if (isSummary(line)) throw new Error('subscriber failed');
    });
    const budget = createBudgetLog({
      windowMs: 1000,
      maxDetail: 1,
      emit,
      onError: () => {
        throw new Error('report failed');
      },
    });
    budget.log('a', 'a1');
    budget.log('a', 'a2');
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(() => budget.stop()).not.toThrow();
    budget.log('a', 'late');
    expect(emit).toHaveBeenLastCalledWith('late');
  });
});
