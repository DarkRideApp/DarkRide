import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('returns the current time and moves it on once a second', () => {
    const { result, unmount } = renderHook(() => useNow());
    expect(result.current).toBe(Date.parse('2026-10-12T10:00:00Z'));

    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(Date.parse('2026-10-12T10:00:01Z'));
    act(() => { vi.advanceTimersByTime(4000); });
    expect(result.current).toBe(Date.parse('2026-10-12T10:00:05Z'));
    unmount();
  });

  it('runs one timer for any number of users and stops it with the last one', () => {
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    const c = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(1);

    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(1);
    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts from the current time after a long idle gap, not the last time it ticked', () => {
    const first = renderHook(() => useNow());
    first.unmount();

    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const second = renderHook(() => useNow());
    expect(second.result.current).toBe(Date.parse('2026-10-12T12:00:00Z'));
    second.unmount();
  });
});
