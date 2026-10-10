import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState } from 'react';
import { useUrlText } from './useUrlText';

afterEach(() => vi.useRealTimers());

/** A stand-in for the router: writes land in `url` only after `delay` ms, like a transition. */
function setup(delay = 50) {
  const writes: string[] = [];
  const { result, rerender } = renderHook(
    ({ url }: { url: string }) => {
      const [value, setValue] = useUrlText(url, v => writes.push(v));
      return { value, setValue };
    },
    { initialProps: { url: '' } },
  );
  const echo = (url: string) => rerender({ url });
  return { result, writes, echo, delay };
}

describe('useUrlText', () => {
  it('starts from the URL value', () => {
    const { result } = renderHook(() => useUrlText('maps', () => {}));
    expect(result.current[0]).toBe('maps');
  });

  it('shows what you type at once and writes it to the URL', () => {
    const { result, writes } = setup();
    act(() => result.current.setValue('ab'));
    expect(result.current.value).toBe('ab');
    expect(writes).toEqual(['ab']);
  });

  it('keeps fast typing when the URL echoes an earlier value late', () => {
    const { result, echo } = setup();
    act(() => result.current.setValue('a'));
    act(() => result.current.setValue('ab'));
    act(() => result.current.setValue('abc'));
    // The router catches up one write at a time; each stale echo must not rewind the box.
    act(() => echo('a'));
    expect(result.current.value).toBe('abc');
    act(() => echo('ab'));
    expect(result.current.value).toBe('abc');
    act(() => echo('abc'));
    expect(result.current.value).toBe('abc');
  });

  it('copes with echoes that skip intermediate values', () => {
    const { result, echo } = setup();
    act(() => result.current.setValue('a'));
    act(() => result.current.setValue('ab'));
    act(() => echo('ab'));
    expect(result.current.value).toBe('ab');
    act(() => result.current.setValue('abc'));
    act(() => echo('abc'));
    expect(result.current.value).toBe('abc');
  });

  it('follows a change that did not come from typing (Back, a link, Clear)', () => {
    const { result, echo } = setup();
    act(() => result.current.setValue('maps'));
    act(() => echo('maps'));
    act(() => echo('frida'));
    expect(result.current.value).toBe('frida');
  });

  it('a Clear after typing wins over echoes still on the way', () => {
    const { result, echo } = setup();
    act(() => result.current.setValue('zzz'));
    act(() => result.current.setValue(''));
    act(() => echo('zzz'));
    expect(result.current.value).toBe('');
    act(() => echo(''));
    expect(result.current.value).toBe('');
  });
});
