import { describe, it, expect } from 'vitest';
import { formatDuration, getDurationColor, normalizeTimings } from './trafficUtils';

describe('formatDuration', () => {
  it('renders sub-second values in ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(142)).toBe('142ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders values >= 1s as seconds with one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(3400)).toBe('3.4s');
  });

  it('drops the decimal for large second values', () => {
    expect(formatDuration(12000)).toBe('12s');
  });

  it('renders an em-dash for null/undefined/negative', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});

describe('getDurationColor', () => {
  it('is undefined for missing timing', () => {
    expect(getDurationColor(null)).toBeUndefined();
    expect(getDurationColor(undefined)).toBeUndefined();
  });

  it('is neutral for fast requests, amber >1s, red >3s', () => {
    expect(getDurationColor(200)).toBe('#8b95b0');
    expect(getDurationColor(1500)).toBe('#ffb95f');
    expect(getDurationColor(4000)).toBe('#fca5a5');
  });
});

describe('normalizeTimings', () => {
  it('parses a JSON string breakdown', () => {
    const t = normalizeTimings(JSON.stringify({ dns: null, connect: 50, tls: 100, ttfb: 300, download: 100 }));
    expect(t).toEqual({ dns: null, connect: 50, tls: 100, ttfb: 300, download: 100 });
  });

  it('accepts an already-parsed object', () => {
    const t = normalizeTimings({ dns: null, connect: 10, tls: null, ttfb: 20, download: 30 } as any);
    expect(t?.connect).toBe(10);
    expect(t?.tls).toBeNull();
  });

  it('returns null for null/garbage/empty breakdown', () => {
    expect(normalizeTimings(null)).toBeNull();
    expect(normalizeTimings('not-json')).toBeNull();
    expect(normalizeTimings({ dns: null, connect: null, tls: null, ttfb: null, download: null } as any)).toBeNull();
  });
});
