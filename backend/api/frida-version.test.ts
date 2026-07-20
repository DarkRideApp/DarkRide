import { describe, it, expect } from 'vitest';
import { fridaServerNeedsRepush } from './frida-version';

describe('fridaServerNeedsRepush', () => {
  it('returns false when responsive and versions match', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '16.7.19',
      targetVersion: '16.7.19',
    })).toBe(false);
  });

  it('returns true when responsive but versions mismatch', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '16.7.18',
      targetVersion: '16.7.19',
    })).toBe(true);
  });

  it('returns true when responsive but deviceVersion is null', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: null,
      targetVersion: '16.7.19',
    })).toBe(true);
  });

  it('returns true when responsive but targetVersion is null', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '16.7.19',
      targetVersion: null,
    })).toBe(true);
  });

  it('returns true when unresponsive even if versions match', () => {
    expect(fridaServerNeedsRepush({
      responsive: false,
      deviceVersion: '16.7.19',
      targetVersion: '16.7.19',
    })).toBe(true);
  });

  it('returns false when device version has surrounding whitespace/newline but matches after trim', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '  16.7.19\n',
      targetVersion: '16.7.19',
    })).toBe(false);
  });

  it('returns true when both versions are null', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: null,
      targetVersion: null,
    })).toBe(true);
  });

  it('returns true when deviceVersion is empty/whitespace only', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '   ',
      targetVersion: '16.7.19',
    })).toBe(true);
  });

  it('trims the target version defensively too', () => {
    expect(fridaServerNeedsRepush({
      responsive: true,
      deviceVersion: '16.7.19',
      targetVersion: ' 16.7.19 ',
    })).toBe(false);
  });
});
