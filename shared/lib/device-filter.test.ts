import { describe, it, expect } from 'vitest';
import { evaluateRule, matchesDeviceFilter, getFilterWarnings, migrateDeviceFilter } from './device-filter';
import type { DeviceFilter } from '../types/api';

describe('evaluateRule', () => {
  describe('eq operator', () => {
    it('matches equal booleans', () => {
      expect(evaluateRule(true, 'eq', true)).toBe(true);
      expect(evaluateRule(false, 'eq', false)).toBe(true);
      expect(evaluateRule(true, 'eq', false)).toBe(false);
    });

    it('matches equal numbers', () => {
      expect(evaluateRule(30, 'eq', 30)).toBe(true);
      expect(evaluateRule(30, 'eq', 31)).toBe(false);
    });

    it('matches strings case-insensitively', () => {
      expect(evaluateRule('Samsung', 'eq', 'samsung')).toBe(true);
      expect(evaluateRule('samsung', 'eq', 'SAMSUNG')).toBe(true);
      expect(evaluateRule('Samsung', 'eq', 'Google')).toBe(false);
    });

    it('returns false for null device value', () => {
      expect(evaluateRule(null, 'eq', true)).toBe(false);
      expect(evaluateRule(undefined, 'eq', 'test')).toBe(false);
    });
  });

  describe('neq operator', () => {
    it('matches non-equal values', () => {
      expect(evaluateRule(true, 'neq', false)).toBe(true);
      expect(evaluateRule(true, 'neq', true)).toBe(false);
    });

    it('is case-insensitive for strings', () => {
      expect(evaluateRule('Samsung', 'neq', 'samsung')).toBe(false);
      expect(evaluateRule('Samsung', 'neq', 'Google')).toBe(true);
    });
  });

  describe('comparison operators', () => {
    it('gt works', () => {
      expect(evaluateRule(31, 'gt', 30)).toBe(true);
      expect(evaluateRule(30, 'gt', 30)).toBe(false);
    });

    it('gte works', () => {
      expect(evaluateRule(30, 'gte', 30)).toBe(true);
      expect(evaluateRule(29, 'gte', 30)).toBe(false);
    });

    it('lt works', () => {
      expect(evaluateRule(29, 'lt', 30)).toBe(true);
      expect(evaluateRule(30, 'lt', 30)).toBe(false);
    });

    it('lte works', () => {
      expect(evaluateRule(30, 'lte', 30)).toBe(true);
      expect(evaluateRule(31, 'lte', 30)).toBe(false);
    });
  });

  describe('in operator', () => {
    it('matches when value is in array', () => {
      expect(evaluateRule('arm64-v8a', 'in', ['arm64-v8a', 'armeabi-v7a'])).toBe(true);
    });

    it('fails when value not in array', () => {
      expect(evaluateRule('x86', 'in', ['arm64-v8a', 'armeabi-v7a'])).toBe(false);
    });

    it('is case-insensitive for strings', () => {
      expect(evaluateRule('ARM64-V8A', 'in', ['arm64-v8a'])).toBe(true);
    });

    it('returns false for non-array filterValue', () => {
      expect(evaluateRule('test', 'in', 'test')).toBe(false);
    });
  });

  describe('contains operator', () => {
    it('matches substring', () => {
      expect(evaluateRule('Pixel 7 Pro', 'contains', 'pixel')).toBe(true);
    });

    it('fails on non-match', () => {
      expect(evaluateRule('Pixel 7', 'contains', 'samsung')).toBe(false);
    });
  });

  it('returns false for unknown operator', () => {
    expect(evaluateRule('test', 'unknown' as any, 'test')).toBe(false);
  });
});

describe('matchesDeviceFilter', () => {
  const device = {
    id: 'dev1',
    isRooted: true,
    bootloaderLocked: false,
    manufacturer: 'Google',
    model: 'Pixel 7',
    apiLevel: 33,
    batteryLevel: 85,
    cpuAbi: 'arm64-v8a',
  };

  it('matches with empty rules', () => {
    expect(matchesDeviceFilter(device, { rules: [] })).toBe(true);
  });

  it('matches deviceIds', () => {
    expect(matchesDeviceFilter(device, { rules: [], deviceIds: ['dev1', 'dev2'] })).toBe(true);
    expect(matchesDeviceFilter(device, { rules: [], deviceIds: ['dev2'] })).toBe(false);
  });

  it('matches single rule', () => {
    expect(matchesDeviceFilter(device, { rules: [{ field: 'isRooted', operator: 'eq', value: true }] })).toBe(true);
    expect(matchesDeviceFilter(device, { rules: [{ field: 'isRooted', operator: 'eq', value: false }] })).toBe(false);
  });

  it('requires all rules to match (AND logic)', () => {
    const filter: DeviceFilter = {
      rules: [
        { field: 'isRooted', operator: 'eq', value: true },
        { field: 'apiLevel', operator: 'gte', value: 30 },
        { field: 'manufacturer', operator: 'eq', value: 'google' },
      ],
    };
    expect(matchesDeviceFilter(device, filter)).toBe(true);

    const failFilter: DeviceFilter = {
      rules: [
        { field: 'isRooted', operator: 'eq', value: true },
        { field: 'apiLevel', operator: 'gte', value: 34 }, // fails
      ],
    };
    expect(matchesDeviceFilter(device, failFilter)).toBe(false);
  });

  it('combines deviceIds and rules', () => {
    const filter: DeviceFilter = {
      rules: [{ field: 'isRooted', operator: 'eq', value: true }],
      deviceIds: ['dev1'],
    };
    expect(matchesDeviceFilter(device, filter)).toBe(true);

    const wrongDevice: DeviceFilter = {
      rules: [{ field: 'isRooted', operator: 'eq', value: true }],
      deviceIds: ['dev99'],
    };
    expect(matchesDeviceFilter(device, wrongDevice)).toBe(false);
  });
});

describe('getFilterWarnings', () => {
  it('returns empty array for matching device', () => {
    const device = { id: 'dev1', isRooted: true };
    const filter: DeviceFilter = { rules: [{ field: 'isRooted', operator: 'eq', value: true }] };
    expect(getFilterWarnings(device, filter)).toEqual([]);
  });

  it('returns warnings for non-matching rules', () => {
    const device = { id: 'dev1', isRooted: false, apiLevel: 28 };
    const filter: DeviceFilter = {
      rules: [
        { field: 'isRooted', operator: 'eq', value: true },
        { field: 'apiLevel', operator: 'gte', value: 30 },
      ],
    };
    const warnings = getFilterWarnings(device, filter);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('isRooted');
    expect(warnings[1]).toContain('apiLevel');
  });

  it('warns about deviceIds mismatch', () => {
    const device = { id: 'dev1' };
    const filter: DeviceFilter = { rules: [], deviceIds: ['dev2'] };
    expect(getFilterWarnings(device, filter)).toEqual(['Not in allowed device list']);
  });
});

describe('migrateDeviceFilter', () => {
  it('passes through new format unchanged', () => {
    const filter: DeviceFilter = {
      rules: [{ field: 'isRooted', operator: 'eq', value: true }],
      deviceIds: ['dev1'],
    };
    expect(migrateDeviceFilter(filter)).toEqual(filter);
  });

  it('converts old rooted filter', () => {
    const result = migrateDeviceFilter({ rooted: true });
    expect(result.rules).toEqual([{ field: 'isRooted', operator: 'eq', value: true }]);
  });

  it('converts old minBattery filter', () => {
    const result = migrateDeviceFilter({ minBattery: 20 });
    expect(result.rules).toEqual([{ field: 'batteryLevel', operator: 'gte', value: 20 }]);
  });

  it('converts old bootloaderLocked filter', () => {
    const result = migrateDeviceFilter({ bootloaderLocked: true });
    expect(result.rules).toEqual([{ field: 'bootloaderLocked', operator: 'eq', value: true }]);
  });

  it('converts old minApiLevel filter', () => {
    const result = migrateDeviceFilter({ minApiLevel: 30 });
    expect(result.rules).toEqual([{ field: 'apiLevel', operator: 'gte', value: 30 }]);
  });

  it('converts old deviceIds', () => {
    const result = migrateDeviceFilter({ deviceIds: ['dev1', 'dev2'] });
    expect(result.deviceIds).toEqual(['dev1', 'dev2']);
    expect(result.rules).toEqual([]);
  });

  it('converts combined old filter', () => {
    const result = migrateDeviceFilter({
      rooted: true,
      minBattery: 20,
      bootloaderLocked: false,
      minApiLevel: 30,
      deviceIds: ['dev1'],
    });
    expect(result.rules).toHaveLength(4);
    expect(result.deviceIds).toEqual(['dev1']);
  });

  it('handles null/undefined gracefully', () => {
    expect(migrateDeviceFilter(null)).toEqual({ rules: [] });
    expect(migrateDeviceFilter(undefined)).toEqual({ rules: [] });
  });

  it('ignores rooted: false in old format (was a no-op)', () => {
    const result = migrateDeviceFilter({ rooted: false });
    expect(result.rules).toEqual([]);
  });

  it('ignores zero minBattery', () => {
    const result = migrateDeviceFilter({ minBattery: 0 });
    expect(result.rules).toEqual([]);
  });
});
