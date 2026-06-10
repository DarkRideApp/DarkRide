import { describe, it, expect } from 'vitest';
import { formatBytes, formatDate, formatDateRelative, formatDuration, toMs } from './format';

describe('format utils', () => {
  it('formatBytes handles null, zero, and scales', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(148897792)).toBe('142.0 MB');
  });

  it('formatDuration scales s/m/h', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });

  it('toMs converts unix seconds and ISO strings', () => {
    expect(toMs(1700000000)).toBe(1700000000000);
    expect(toMs('2026-03-02T00:00:00.000Z')).toBe(Date.parse('2026-03-02T00:00:00.000Z'));
  });

  it('formatDateRelative buckets recent times', () => {
    const now = Date.now();
    expect(formatDateRelative(new Date(now - 30_000).toISOString())).toBe('Just now');
    expect(formatDateRelative(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(formatDateRelative(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(formatDateRelative(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('formatDate renders a short date', () => {
    expect(formatDate('2026-03-02T12:00:00.000Z')).toMatch(/Mar/);
  });
});
