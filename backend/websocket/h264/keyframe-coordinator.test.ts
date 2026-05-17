import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyframeCoordinator } from './keyframe-coordinator';

describe('KeyframeCoordinator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('first request sends immediately', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send);
    expect(c.request()).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('second request within the window coalesces and fires once at the boundary', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send);
    c.request();              // t=0 → sent
    vi.advanceTimersByTime(100);
    expect(c.request()).toBe('coalesced'); // t=100, pending scheduled at t=500
    vi.advanceTimersByTime(399);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2); // pending fired at t=500
  });

  it('multiple requests within the window collapse into a single coalesced fire', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send);
    c.request();
    vi.advanceTimersByTime(50);
    c.request();
    vi.advanceTimersByTime(50);
    c.request();
    vi.advanceTimersByTime(50);
    c.request();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(2); // initial + one coalesced
  });

  it('request after the window sends immediately', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send);
    c.request();
    vi.advanceTimersByTime(500);
    expect(c.request()).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reset() cancels a pending fire and clears the rate-limit', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send);
    c.request();
    c.request();          // schedules pending
    c.reset();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1); // pending was cancelled
    expect(c.request()).toBe('sent');      // reset cleared lastSent → immediate
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('respects the configured interval', () => {
    const send = vi.fn();
    const c = new KeyframeCoordinator(send, 1000);
    c.request();
    vi.advanceTimersByTime(500);
    c.request();
    vi.advanceTimersByTime(499);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not advance the rate-limit window when send() throws', () => {
    let throwNext = true;
    const send = vi.fn(() => { if (throwNext) { throwNext = false; throw new Error('socket gone'); } });
    const c = new KeyframeCoordinator(send);
    expect(() => c.request()).toThrow('socket gone');
    // Subsequent request must not be suppressed by a phantom lastSentMs.
    expect(c.request()).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
