import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { basename } from 'path';
import { SCRCPY_VERSION, getScrcpyServerJar } from './vendor-manager';

/**
 * Regression guard for the Android 16 (API 36) SIGABRT crash.
 *
 * scrcpy < 3.3.3 crashes at stream start on Android 16 with:
 *   AbstractMethodError: IDisplayWindowListener.onDisplayAnimationsDisabledChanged
 * because Android 16 added new methods to the hidden IDisplayWindowListener
 * interface that older scrcpy servers don't implement. Fixed in scrcpy 3.3.3+.
 * Never regress the bundled server below that floor.
 */
function versionTuple(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10));
}
function gte(a: string, b: string): boolean {
  const ta = versionTuple(a), tb = versionTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const da = ta[i] ?? 0, db = tb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return true;
}

describe('scrcpy server version', () => {
  it('is at least 3.3.3 (Android 16 / API 36 IDisplayWindowListener fix floor)', () => {
    expect(gte(SCRCPY_VERSION, '3.3.3')).toBe(true);
  });

  it('resolves to an existing jar whose filename matches SCRCPY_VERSION', () => {
    const jar = getScrcpyServerJar();
    expect(existsSync(jar)).toBe(true);
    expect(basename(jar)).toBe(`scrcpy-server-v${SCRCPY_VERSION}.jar`);
  });
});
