import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ElapsedTimer } from '../ElapsedTimer';

describe('ElapsedTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders elapsed seconds for short durations', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Started 30 seconds ago
    const since = new Date(now - 30_000).toISOString();
    render(<ElapsedTimer since={since} />);
    expect(screen.getByText('30s')).toBeInTheDocument();
  });

  it('renders minutes and seconds for medium durations', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Started 5 min 15 seconds ago
    const since = new Date(now - (5 * 60_000 + 15_000)).toISOString();
    render(<ElapsedTimer since={since} />);
    expect(screen.getByText('5m 15s')).toBeInTheDocument();
  });

  it('renders hours and minutes for long durations', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Started 2h 30m ago
    const since = new Date(now - (2 * 3600_000 + 30 * 60_000)).toISOString();
    render(<ElapsedTimer since={since} />);
    expect(screen.getByText('2h 30m')).toBeInTheDocument();
  });

  it('ticks every second', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const since = new Date(now - 10_000).toISOString();
    render(<ElapsedTimer since={since} />);
    expect(screen.getByText('10s')).toBeInTheDocument();

    // Advance 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('15s')).toBeInTheDocument();
  });

  it('accepts numeric epoch timestamp', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // toMs converts number by multiplying by 1000 (unix epoch seconds)
    const sinceEpochSec = (now - 45_000) / 1000;
    render(<ElapsedTimer since={sinceEpochSec} />);
    expect(screen.getByText('45s')).toBeInTheDocument();
  });
});
