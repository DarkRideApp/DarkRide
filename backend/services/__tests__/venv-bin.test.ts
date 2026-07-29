import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { resolveVenvBin } from '../venv-bin';

// Python lays a venv out differently per platform: `.venv/bin/<tool>` on POSIX,
// `.venv/Scripts/<tool>.exe` on Windows. The fixture has to match the host or
// the lookup misses and every assertion falls through to the bare-name
// fallback — which is what made this suite fail on Windows.
const isWindows = process.platform === 'win32';
const VENV_SUBDIR = isWindows ? 'Scripts' : 'bin';
const EXE_SUFFIX = isWindows ? '.exe' : '';

describe('resolveVenvBin', () => {
  let tmpRoot: string;
  let origCwd: string;
  let binDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'darkride-venv-bin-test-'));
    origCwd = process.cwd();
    binDir = join(tmpRoot, '.venv', VENV_SUBDIR);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, `mitmdump${EXE_SUFFIX}`), '#!/bin/sh\necho fake', { mode: 0o755 });
    process.chdir(tmpRoot);
  });

  afterAll(() => {
    process.chdir(origCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the absolute path when the venv binary exists', () => {
    const r = resolveVenvBin('mitmdump');
    expect(r).toBe(resolve(tmpRoot, '.venv', VENV_SUBDIR, `mitmdump${EXE_SUFFIX}`));
  });

  it('falls back to the bare name when the venv binary is missing', () => {
    const r = resolveVenvBin('not-installed-tool');
    expect(r).toBe('not-installed-tool');
  });

  it.runIf(isWindows)('prefers the .exe over an extensionless sibling', () => {
    // pip drops both `foo.exe` and a `foo` shim in Scripts/ for some packages;
    // only the .exe is directly spawnable on Windows.
    writeFileSync(join(binDir, 'bothways.exe'), 'exe', { mode: 0o755 });
    writeFileSync(join(binDir, 'bothways'), 'shim', { mode: 0o755 });

    expect(resolveVenvBin('bothways')).toBe(resolve(binDir, 'bothways.exe'));
  });

  it.runIf(isWindows)('accepts an extensionless Scripts entry when there is no .exe', () => {
    writeFileSync(join(binDir, 'shimonly'), 'shim', { mode: 0o755 });

    expect(resolveVenvBin('shimonly')).toBe(resolve(binDir, 'shimonly'));
  });
});
