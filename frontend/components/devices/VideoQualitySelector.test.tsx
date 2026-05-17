import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VideoQualitySelector } from './VideoQualitySelector';

describe('VideoQualitySelector', () => {
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    localStorageData = {};
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      (key: string) => localStorageData[key] ?? null,
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      (key: string, value: string) => { localStorageData[key] = value; },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to "auto" when localStorage is empty and calls onChange with null on mount', () => {
    const onChange = vi.fn();
    render(<VideoQualitySelector onChange={onChange} />);
    // onChange(null) called on mount for 'auto'
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders all 6 options', () => {
    const onChange = vi.fn();
    const { container } = render(<VideoQualitySelector onChange={onChange} />);
    const options = container.querySelectorAll('option');
    expect(options).toHaveLength(6);
    const values = Array.from(options).map(o => o.getAttribute('value'));
    expect(values).toEqual(['auto', '0', '1', '2', '3', '4']);
  });

  it('persists selected tier to localStorage on change', () => {
    const onChange = vi.fn();
    const { container } = render(<VideoQualitySelector onChange={onChange} />);
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: '3' } });
    expect(localStorageData['darkride.video.tier']).toBe('3');
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it('reads persisted tier from localStorage on mount and calls onChange with that tier', () => {
    localStorageData['darkride.video.tier'] = '2';
    const onChange = vi.fn();
    render(<VideoQualitySelector onChange={onChange} />);
    // Should call onChange(2) because localStorage has tier '2'
    expect(onChange).toHaveBeenCalledWith(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows autoTier in the Auto option label when provided', () => {
    const onChange = vi.fn();
    const { container } = render(<VideoQualitySelector onChange={onChange} autoTier={3} />);
    const autoOption = container.querySelector('option[value="auto"]');
    expect(autoOption?.textContent).toContain('tier 3');
  });

  it('calls onChange(null) when switching back to auto', () => {
    localStorageData['darkride.video.tier'] = '2';
    const onChange = vi.fn();
    const { container } = render(<VideoQualitySelector onChange={onChange} />);
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'auto' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(localStorageData['darkride.video.tier']).toBe('auto');
  });
});
