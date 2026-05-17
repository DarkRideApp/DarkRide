import { describe, it, expect } from 'vitest';
import { isNewer } from './version-compare';

describe('isNewer', () => {
  it('returns true when latest patch > current patch', () => {
    expect(isNewer('1.0.2', '1.0.1')).toBe(true);
  });

  it('returns true when latest minor > current minor', () => {
    expect(isNewer('1.1.0', '1.0.5')).toBe(true);
  });

  it('returns true when latest major > current major', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when latest is older', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  it('ignores pre-release suffixes for the comparison', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0.1-rc.1')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    expect(isNewer('not-a-version', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'garbage')).toBe(false);
    expect(isNewer('1.0', '1.0.0')).toBe(false);
    expect(isNewer('1.x.0', '1.0.0')).toBe(false);
  });

  it('returns false for missing inputs', () => {
    expect(isNewer('', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '')).toBe(false);
  });
});
