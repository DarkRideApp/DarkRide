import { describe, expect, it, vi } from 'vitest';
import { onceEvery } from './throttle';

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
