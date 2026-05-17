import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  isSlotInspectorEnabled,
  setSlotInspectorEnabled,
  useSlotInspectorEnabled,
  installSlotInspectorShortcut,
} from '../dev-tools';

const KEY = 'darkride:devtools:slotInspector';

describe('dev-tools slotInspector', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('isSlotInspectorEnabled returns false when key is absent', () => {
    expect(isSlotInspectorEnabled()).toBe(false);
  });

  it('isSlotInspectorEnabled returns true when key is "1"', () => {
    localStorage.setItem(KEY, '1');
    expect(isSlotInspectorEnabled()).toBe(true);
  });

  it('setSlotInspectorEnabled(true) stores "1"', () => {
    setSlotInspectorEnabled(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('setSlotInspectorEnabled(false) removes the key', () => {
    localStorage.setItem(KEY, '1');
    setSlotInspectorEnabled(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('setSlotInspectorEnabled dispatches a darkride:devtools-changed event', () => {
    const handler = vi.fn();
    window.addEventListener('darkride:devtools-changed', handler);
    setSlotInspectorEnabled(true);
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('darkride:devtools-changed', handler);
  });

  it('useSlotInspectorEnabled reflects current state and updates on toggle', () => {
    const { result } = renderHook(() => useSlotInspectorEnabled());
    expect(result.current).toBe(false);
    act(() => setSlotInspectorEnabled(true));
    expect(result.current).toBe(true);
    act(() => setSlotInspectorEnabled(false));
    expect(result.current).toBe(false);
  });

  it('useSlotInspectorEnabled responds to cross-tab storage events', () => {
    const { result } = renderHook(() => useSlotInspectorEnabled());
    expect(result.current).toBe(false);
    act(() => {
      localStorage.setItem(KEY, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '1' }));
    });
    expect(result.current).toBe(true);
  });
});

describe('installSlotInspectorShortcut', () => {
  beforeEach(() => { localStorage.clear(); });

  function fireKey(key: string, opts: { shift?: boolean; alt?: boolean } = {}) {
    const ev = new KeyboardEvent('keydown', {
      key,
      shiftKey: opts.shift ?? false,
      altKey: opts.alt ?? false,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    return ev;
  }

  it('toggles on Shift+Alt+S', () => {
    const uninstall = installSlotInspectorShortcut();
    expect(isSlotInspectorEnabled()).toBe(false);
    fireKey('S', { shift: true, alt: true });
    expect(isSlotInspectorEnabled()).toBe(true);
    fireKey('S', { shift: true, alt: true });
    expect(isSlotInspectorEnabled()).toBe(false);
    uninstall();
  });

  it('ignores plain S key', () => {
    const uninstall = installSlotInspectorShortcut();
    fireKey('S');
    expect(isSlotInspectorEnabled()).toBe(false);
    uninstall();
  });

  it('ignores Shift+S without Alt', () => {
    const uninstall = installSlotInspectorShortcut();
    fireKey('S', { shift: true });
    expect(isSlotInspectorEnabled()).toBe(false);
    uninstall();
  });

  it('uninstall removes the listener', () => {
    const uninstall = installSlotInspectorShortcut();
    fireKey('S', { shift: true, alt: true });
    expect(isSlotInspectorEnabled()).toBe(true);
    uninstall();
    fireKey('S', { shift: true, alt: true });
    expect(isSlotInspectorEnabled()).toBe(true); // no more toggling
  });

  it('prevents default on the matched keystroke', () => {
    const uninstall = installSlotInspectorShortcut();
    const ev = fireKey('S', { shift: true, alt: true });
    expect(ev.defaultPrevented).toBe(true);
    uninstall();
  });
});
