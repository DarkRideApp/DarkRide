import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { getDataRoot, absoluteLocalPath, toRelativeLocalPath } from './paths';

describe('backend/config/paths', () => {
  const originalEnv = process.env.DATA_ROOT;

  beforeEach(() => {
    delete process.env.DATA_ROOT;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = originalEnv;
  });

  it('getDataRoot resolves ./data against cwd by default', () => {
    expect(getDataRoot()).toBe(path.resolve(process.cwd(), './data'));
  });

  it('getDataRoot honours DATA_ROOT env var when set', () => {
    process.env.DATA_ROOT = '/tmp/darkride-test-data';
    expect(getDataRoot()).toBe(path.resolve('/tmp/darkride-test-data'));
  });

  it('toRelativeLocalPath returns relative paths unchanged', () => {
    expect(toRelativeLocalPath('apks/pkg/v1.apk')).toBe('apks/pkg/v1.apk');
  });

  it('toRelativeLocalPath strips DATA_ROOT from absolute paths under it', () => {
    const abs = path.join(getDataRoot(), 'apks', 'pkg', 'v1.apk');
    expect(toRelativeLocalPath(abs)).toBe(path.join('apks', 'pkg', 'v1.apk'));
  });

  it('toRelativeLocalPath rejects absolute paths outside DATA_ROOT', () => {
    expect(() => toRelativeLocalPath('/var/log/something.log')).toThrow(/outside DATA_ROOT/);
  });

  it('absoluteLocalPath joins relative values against DATA_ROOT', () => {
    expect(absoluteLocalPath('apks/pkg/v1.apk')).toBe(path.join(getDataRoot(), 'apks/pkg/v1.apk'));
  });

  it('absoluteLocalPath returns absolute values as-is (legacy rows)', () => {
    expect(absoluteLocalPath('/opt/darkride/data/apks/pkg/v1.apk')).toBe(
      '/opt/darkride/data/apks/pkg/v1.apk',
    );
  });
});
