import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyframeTrigger } from './keyframe-trigger';

describe('KeyframeTrigger', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not fire when gap < 2', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('gap', 0)).toBe(false);
    expect(t.maybeFire('gap', 1)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('fires when gap ≥ 2', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('gap', 2)).toBe(true);
    expect(send).toHaveBeenCalledWith('gap');
  });

  it('decode-error always passes the threshold check', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('decode-error')).toBe(true);
    expect(send).toHaveBeenCalledWith('decode-error');
  });

  it('debounces a second fire within 250ms', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('gap', 5)).toBe(true);
    vi.setSystemTime(100);
    expect(t.maybeFire('gap', 5)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows a fire after the debounce window', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    t.maybeFire('gap', 5);
    vi.setSystemTime(250);
    expect(t.maybeFire('gap', 5)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('decode-error is also subject to debounce', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('decode-error')).toBe(true);
    vi.setSystemTime(100);
    expect(t.maybeFire('decode-error')).toBe(false);
  });

  it('reset() clears the debounce window', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    t.maybeFire('gap', 5);
    t.reset();
    vi.setSystemTime(1);
    expect(t.maybeFire('gap', 5)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('respects custom debounceMs', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send, 100);
    t.maybeFire('gap', 5);
    vi.setSystemTime(50);
    expect(t.maybeFire('gap', 5)).toBe(false);
    vi.setSystemTime(100);
    expect(t.maybeFire('gap', 5)).toBe(true);
  });

  it('watchdog reason bypasses the gap threshold but still respects debounce', () => {
    const send = vi.fn();
    const t = new KeyframeTrigger(send);
    expect(t.maybeFire('watchdog')).toBe(true);
    expect(send).toHaveBeenCalledWith('watchdog');
    vi.setSystemTime(100);
    expect(t.maybeFire('watchdog')).toBe(false);
    vi.setSystemTime(250);
    expect(t.maybeFire('watchdog')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
